import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Prompts } from '../../prompts';

export interface VFSStorageAdapter {
  write(filename: string, content: string): void | Promise<void>;
  read(filename: string): string | null | Promise<string | null>;
  /** Optional. Required for Offloader.cleanup() / reconcile(). Returns all stored filenames. */
  list?(): string[] | Promise<string[]>;
  /** Optional. Required for Offloader.cleanup(). Must be idempotent (no-op on missing files). */
  delete?(filename: string): void | Promise<void>;
}

export class FileSystemAdapter implements VFSStorageAdapter {
  private storageDir: string;

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  write(filename: string, content: string): void {
    const filepath = path.join(this.storageDir, filename);
    fs.writeFileSync(filepath, content, 'utf8');
  }

  read(filename: string): string | null {
    const filepath = path.join(this.storageDir, filename);
    if (fs.existsSync(filepath)) {
      return fs.readFileSync(filepath, 'utf8');
    }
    return null;
  }

  list(): string[] {
    if (!fs.existsSync(this.storageDir)) return [];
    return fs.readdirSync(this.storageDir).filter((f) => f.startsWith('vfs_'));
  }

  delete(filename: string): void {
    const filepath = path.join(this.storageDir, filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  }
}

/** Per-entry metadata tracked by the Offloader's in-memory index. */
export interface VFSEntryMeta {
  filename: string;
  uri: string;
  /** Date.now() at the moment of offload (or parsed from filename for reconciled orphans). */
  createdAt: number;
  /** Date.now() at last successful resolve(). Drives LRU eviction order. */
  accessedAt: number;
  /** UTF-8 byte length of stored content (Buffer.byteLength). */
  bytes: number;
}

export type VFSEvictionReason = 'maxAge' | 'maxFiles' | 'maxBytes';

export interface VFSCleanupResult {
  evicted: VFSEntryMeta[];
  evictedBytes: number;
  evictedByAge: number;
  evictedByCount: number;
  evictedByBytes: number;
  failed: { entry: VFSEntryMeta; error: Error }[];
}

export interface CleanupOptions {
  /** Override config maxAge for this call. Pass Infinity to disable for this call. Omit to use configured value. */
  maxAge?: number;
  /** Override config maxFiles for this call. Pass Infinity to disable for this call. Omit to use configured value. */
  maxFiles?: number;
  /** Override config maxBytes for this call. Pass Infinity to disable for this call. Omit to use configured value. */
  maxBytes?: number;
}

export class VFSCleanupNotSupportedError extends Error {
  readonly missing: ('list' | 'delete')[];

  constructor(missing: ('list' | 'delete')[]) {
    super(
      `Offloader.cleanup() requires the adapter to implement: ${missing.join(', ')}. The configured VFSStorageAdapter does not.`,
    );
    this.name = 'VFSCleanupNotSupportedError';
    this.missing = missing;
  }
}

export interface VFSConfig {
  /** Maximum length of content before it gets offloaded (e.g. 5000 characters) */
  threshold: number;
  /** Directory to store offloaded files (used by default FileSystemAdapter). Ignored if adapter is provided. */
  storageDir?: string;
  /** Custom URI prefix scheme, e.g. 'context://' */
  uriScheme?: string;
  /** Custom storage adapter. If provided, overrides storageDir and filesystem operations. */
  adapter?: VFSStorageAdapter;
  /** Max age in ms (since createdAt) before an entry is eligible for cleanup. Undefined = no age cap. */
  maxAge?: number;
  /** Max number of stored entries. Undefined = no count cap. 0 = evict all in cleanup(). */
  maxFiles?: number;
  /** Max total UTF-8 bytes of stored content. Undefined = no byte cap. 0 = evict all in cleanup(). */
  maxBytes?: number;
  /** Per-entry eviction notification. Errors thrown by the hook are logged via console.warn and swallowed. */
  onVFSEvicted?: (entry: VFSEntryMeta, reason: VFSEvictionReason) => void | Promise<void>;
}

export interface VFSResult {
  isOffloaded: boolean;
  content: string;
  uri?: string;
}

export interface OffloadOptions {
  /** Allows overriding the instance threshold for a specific call */
  threshold?: number;
  /** Number of characters to preserve from the head of the content (default: 0) */
  headChars?: number;
  /** Number of characters to preserve from the tail of the content (default: 2000) */
  tailChars?: number;
}

const ORPHAN_FILENAME_RE = /^vfs_(\d+)_[a-f0-9]+\.txt$/;

export class Offloader {
  private config: VFSConfig;
  private adapter: VFSStorageAdapter;
  private _index = new Map<string, VFSEntryMeta>();
  private _cleanupInFlight: Promise<VFSCleanupResult> | null = null;

  constructor(config: Partial<VFSConfig> = {}) {
    if (config.maxAge != null && config.maxAge < 0) {
      throw new Error(`VFSConfig.maxAge must be non-negative, got ${config.maxAge}`);
    }
    if (config.maxFiles != null && config.maxFiles < 0) {
      throw new Error(`VFSConfig.maxFiles must be non-negative, got ${config.maxFiles}`);
    }
    if (config.maxBytes != null && config.maxBytes < 0) {
      throw new Error(`VFSConfig.maxBytes must be non-negative, got ${config.maxBytes}`);
    }

    const storageDir = config.storageDir ?? path.join(process.cwd(), '.context_vfs');
    this.config = {
      threshold: config.threshold ?? 5000,
      storageDir,
      uriScheme: config.uriScheme ?? 'context://vfs/',
      maxAge: config.maxAge,
      maxFiles: config.maxFiles,
      maxBytes: config.maxBytes,
      onVFSEvicted: config.onVFSEvicted,
    };

    this.adapter = config.adapter ?? new FileSystemAdapter(storageDir);
  }

  /**
   * Snaps a character index to the nearest line boundary.
   * For head: snaps backward to include the last complete line.
   * For tail: snaps forward to start at the beginning of a line.
   */
  private _snapToLineBoundary(
    content: string,
    charIndex: number,
    direction: 'head' | 'tail',
  ): number {
    if (charIndex <= 0) return 0;
    if (charIndex >= content.length) return content.length;

    if (direction === 'head') {
      const lastNewline = content.lastIndexOf('\n', charIndex);
      return lastNewline === -1 ? charIndex : lastNewline + 1;
    }
    const nextNewline = content.indexOf('\n', charIndex);
    return nextNewline === -1 ? charIndex : nextNewline + 1;
  }

  private _prepareOffload(content: string, headChars: number, tailChars: number) {
    const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
    const filename = `vfs_${Date.now()}_${hash}.txt`;
    const uri = `${this.config.uriScheme}${filename}`;

    const totalLines = content.split('\n').length;
    const totalChars = content.length;

    const headEnd = headChars > 0 ? this._snapToLineBoundary(content, headChars, 'head') : 0;
    const tailStart =
      tailChars > 0
        ? this._snapToLineBoundary(content, content.length - tailChars, 'tail')
        : content.length;

    const headStr = headEnd > 0 ? content.slice(0, headEnd) : '';
    const tailStr = tailStart < content.length ? content.slice(tailStart) : '';

    const truncated = Prompts.getVFSOffloadReminder(uri, totalLines, totalChars, headStr, tailStr);

    return { filename, uri, truncated };
  }

  private _registerEntry(filename: string, uri: string, content: string): void {
    const now = Date.now();
    this._index.set(filename, {
      filename,
      uri,
      createdAt: now,
      accessedAt: now,
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  }

  /**
   * If content exceeds the threshold, writes full content to VFS (synchronously)
   * and returns a truncated string with a pointer URI.
   * Throws an error if the configured adapter is asynchronous.
   */
  public offload(content: string, options?: OffloadOptions): VFSResult {
    const activeThreshold = options?.threshold ?? this.config.threshold;
    const headChars = options?.headChars ?? 0;
    const tailChars = options?.tailChars ?? 2000;

    if (content.length <= activeThreshold) {
      return { isOffloaded: false, content };
    }

    if (headChars + tailChars >= content.length) {
      return { isOffloaded: false, content };
    }

    const { filename, uri, truncated } = this._prepareOffload(content, headChars, tailChars);

    const writeResult = this.adapter.write(filename, content);
    if (writeResult instanceof Promise) {
      throw new Error(
        'Offloader.offload() was called synchronously, but the VFSStorageAdapter is asynchronous. Use offloadAsync() instead.',
      );
    }

    this._registerEntry(filename, uri, content);

    return {
      isOffloaded: true,
      content: truncated,
      uri,
    };
  }

  /**
   * If content exceeds the threshold, writes full content to VFS (asynchronously)
   * and returns a truncated string with a pointer URI.
   * Safely supports both synchronous and asynchronous adapters.
   */
  public async offloadAsync(content: string, options?: OffloadOptions): Promise<VFSResult> {
    const activeThreshold = options?.threshold ?? this.config.threshold;
    const headChars = options?.headChars ?? 0;
    const tailChars = options?.tailChars ?? 2000;

    if (content.length <= activeThreshold) {
      return { isOffloaded: false, content };
    }

    if (headChars + tailChars >= content.length) {
      return { isOffloaded: false, content };
    }

    const { filename, uri, truncated } = this._prepareOffload(content, headChars, tailChars);

    await this.adapter.write(filename, content);

    this._registerEntry(filename, uri, content);

    return {
      isOffloaded: true,
      content: truncated,
      uri,
    };
  }

  /**
   * Reads the full content back from a URI (synchronously).
   * On a hit, updates the entry's accessedAt timestamp; if the URI is not in the index,
   * auto-adopts the file (parses createdAt from filename, seeds bytes from content length).
   * Throws an error if the adapter is asynchronous.
   */
  public resolve(uri: string): string | null {
    const scheme = this.config.uriScheme;
    if (!scheme || !uri.startsWith(scheme)) {
      return null;
    }

    const filename = uri.slice(scheme.length);
    const readResult = this.adapter.read(filename);

    if (readResult instanceof Promise) {
      throw new Error(
        'Offloader.resolve() was called synchronously, but the VFSStorageAdapter is asynchronous. Use resolveAsync() instead.',
      );
    }

    if (readResult != null) {
      this._touchOrAdopt(filename, uri, readResult);
    }

    return readResult;
  }

  /**
   * Reads the full content back from a URI (asynchronously).
   * Safely supports both synchronous and asynchronous adapters.
   */
  public async resolveAsync(uri: string): Promise<string | null> {
    const scheme = this.config.uriScheme;
    if (!scheme || !uri.startsWith(scheme)) {
      return null;
    }

    const filename = uri.slice(scheme.length);
    const readResult = await this.adapter.read(filename);

    if (readResult != null) {
      this._touchOrAdopt(filename, uri, readResult);
    }

    return readResult;
  }

  private _touchOrAdopt(filename: string, uri: string, content: string): void {
    const existing = this._index.get(filename);
    const now = Date.now();
    if (existing) {
      existing.accessedAt = now;
      return;
    }
    const meta = this._buildOrphanMeta(filename, uri);
    meta.accessedAt = now;
    meta.bytes = Buffer.byteLength(content, 'utf8');
    this._index.set(filename, meta);
  }

  private _buildOrphanMeta(filename: string, uri?: string): VFSEntryMeta {
    const resolvedUri = uri ?? `${this.config.uriScheme}${filename}`;
    const match = filename.match(ORPHAN_FILENAME_RE);
    const createdAt = match ? Number(match[1]) : Date.now();
    return {
      filename,
      uri: resolvedUri,
      createdAt,
      accessedAt: createdAt,
      bytes: 0,
    };
  }

  /** Returns a deep-cloned array of all entries currently tracked in the in-memory index. For tests/debugging. */
  public getEntries(): VFSEntryMeta[] {
    return Array.from(this._index.values()).map((e) => ({ ...e }));
  }

  private _missingCleanupCapabilities(): ('list' | 'delete')[] {
    const missing: ('list' | 'delete')[] = [];
    if (!this.adapter.list) missing.push('list');
    if (!this.adapter.delete) missing.push('delete');
    return missing;
  }

  private _planEvictions(
    now: number,
    overrides?: CleanupOptions,
  ): { entry: VFSEntryMeta; reason: VFSEvictionReason }[] {
    const maxAge = overrides?.maxAge ?? this.config.maxAge;
    const maxFiles = overrides?.maxFiles ?? this.config.maxFiles;
    const maxBytes = overrides?.maxBytes ?? this.config.maxBytes;

    const allEntries = Array.from(this._index.values()).map((e) => ({ ...e }));
    const plan: { entry: VFSEntryMeta; reason: VFSEvictionReason }[] = [];
    const remaining = new Map<string, VFSEntryMeta>();

    // Phase A — maxAge sweep (relative to createdAt).
    for (const entry of allEntries) {
      if (maxAge != null && now - entry.createdAt > maxAge) {
        plan.push({ entry, reason: 'maxAge' });
      } else {
        remaining.set(entry.filename, entry);
      }
    }

    if (maxFiles == null && maxBytes == null) return plan;

    // Phase B — single-pass LRU until both count and byte caps are satisfied.
    let totalBytes = 0;
    for (const e of remaining.values()) totalBytes += e.bytes;

    while (true) {
      const overCount = maxFiles != null && remaining.size > maxFiles;
      const overBytes = maxBytes != null && totalBytes > maxBytes;
      if (!overCount && !overBytes) break;
      if (remaining.size === 0) break;

      let victim: VFSEntryMeta | null = null;
      for (const e of remaining.values()) {
        if (!victim || e.accessedAt < victim.accessedAt) victim = e;
      }
      if (!victim) break;

      const reason: VFSEvictionReason = overCount ? 'maxFiles' : 'maxBytes';
      plan.push({ entry: victim, reason });
      remaining.delete(victim.filename);
      totalBytes -= victim.bytes;
    }

    return plan;
  }

  private _accumulateResult(
    result: VFSCleanupResult,
    entry: VFSEntryMeta,
    reason: VFSEvictionReason,
  ): void {
    result.evicted.push(entry);
    result.evictedBytes += entry.bytes;
    if (reason === 'maxAge') result.evictedByAge++;
    else if (reason === 'maxFiles') result.evictedByCount++;
    else result.evictedByBytes++;
  }

  private _emptyResult(): VFSCleanupResult {
    return {
      evicted: [],
      evictedBytes: 0,
      evictedByAge: 0,
      evictedByCount: 0,
      evictedByBytes: 0,
      failed: [],
    };
  }

  /**
   * Sweeps expired and over-cap entries from the adapter and the index.
   * Throws VFSCleanupNotSupportedError if the adapter lacks list() or delete().
   * Throws if the adapter is asynchronous (use cleanupAsync() instead).
   */
  public cleanup(overrides?: CleanupOptions): VFSCleanupResult {
    const adapter = this.adapter;
    if (!adapter.list || !adapter.delete) {
      throw new VFSCleanupNotSupportedError(this._missingCleanupCapabilities());
    }

    // Sync-ness probe: if adapter.list() returns a Promise, we cannot proceed synchronously.
    const probedList = adapter.list();
    if (probedList instanceof Promise) {
      throw new Error(
        'Offloader.cleanup() was called synchronously, but the VFSStorageAdapter is asynchronous. Use cleanupAsync() instead.',
      );
    }

    const plan = this._planEvictions(Date.now(), overrides);
    const result = this._emptyResult();

    for (const { entry, reason } of plan) {
      try {
        const deleteResult = adapter.delete(entry.filename);
        if (deleteResult instanceof Promise) {
          throw new Error(
            'Offloader.cleanup() was called synchronously, but the VFSStorageAdapter is asynchronous. Use cleanupAsync() instead.',
          );
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        result.failed.push({ entry, error: err });
        continue;
      }

      this._index.delete(entry.filename);

      if (this.config.onVFSEvicted) {
        try {
          const hookResult = this.config.onVFSEvicted(entry, reason);
          if (hookResult instanceof Promise) {
            console.warn(
              '[Offloader] onVFSEvicted returned a Promise during sync cleanup(); call cleanupAsync() to await async hooks.',
            );
          }
        } catch (error) {
          console.warn('[Offloader] onVFSEvicted threw:', error);
        }
      }

      this._accumulateResult(result, entry, reason);
    }

    return result;
  }

  /**
   * Async variant of cleanup(). Awaits each adapter.delete() and onVFSEvicted call.
   * Concurrent cleanupAsync() calls are coalesced into a single in-flight promise.
   */
  public cleanupAsync(overrides?: CleanupOptions): Promise<VFSCleanupResult> {
    if (this._cleanupInFlight) return this._cleanupInFlight;
    this._cleanupInFlight = this._cleanupAsyncImpl(overrides).finally(() => {
      this._cleanupInFlight = null;
    });
    return this._cleanupInFlight;
  }

  private async _cleanupAsyncImpl(overrides?: CleanupOptions): Promise<VFSCleanupResult> {
    const adapter = this.adapter;
    if (!adapter.list || !adapter.delete) {
      throw new VFSCleanupNotSupportedError(this._missingCleanupCapabilities());
    }

    const plan = this._planEvictions(Date.now(), overrides);
    const result = this._emptyResult();

    for (const { entry, reason } of plan) {
      try {
        await adapter.delete(entry.filename);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        result.failed.push({ entry, error: err });
        continue;
      }

      this._index.delete(entry.filename);

      if (this.config.onVFSEvicted) {
        try {
          await this.config.onVFSEvicted(entry, reason);
        } catch (error) {
          console.warn('[Offloader] onVFSEvicted threw:', error);
        }
      }

      this._accumulateResult(result, entry, reason);
    }

    return result;
  }

  /**
   * Walks adapter.list() and adopts orphan files (files on the adapter not in the index).
   * Required after process restart for cleanup() to see pre-restart files.
   * Parses createdAt from filename pattern vfs_<ts>_<hash>.txt; falls back to Date.now() on parse failure.
   * Returns count of orphans adopted. With measureBytes, reads each orphan to populate accurate bytes.
   */
  public reconcile(options?: { measureBytes?: boolean }): number {
    if (!this.adapter.list) throw new VFSCleanupNotSupportedError(['list']);

    const filenames = this.adapter.list();
    if (filenames instanceof Promise) {
      throw new Error(
        'Offloader.reconcile() was called synchronously, but the VFSStorageAdapter is asynchronous. Use reconcileAsync() instead.',
      );
    }

    let adopted = 0;
    for (const filename of filenames) {
      if (this._index.has(filename)) continue;

      const meta = this._buildOrphanMeta(filename);
      if (options?.measureBytes) {
        const content = this.adapter.read(filename);
        if (content instanceof Promise) {
          throw new Error(
            'Offloader.reconcile() was called synchronously, but the VFSStorageAdapter is asynchronous. Use reconcileAsync() instead.',
          );
        }
        if (content != null) meta.bytes = Buffer.byteLength(content, 'utf8');
      }

      this._index.set(filename, meta);
      adopted++;
    }
    return adopted;
  }

  /** Async variant of reconcile(). */
  public async reconcileAsync(options?: { measureBytes?: boolean }): Promise<number> {
    if (!this.adapter.list) throw new VFSCleanupNotSupportedError(['list']);

    const filenames = await this.adapter.list();

    let adopted = 0;
    for (const filename of filenames) {
      if (this._index.has(filename)) continue;

      const meta = this._buildOrphanMeta(filename);
      if (options?.measureBytes) {
        const content = await this.adapter.read(filename);
        if (content != null) meta.bytes = Buffer.byteLength(content, 'utf8');
      }

      this._index.set(filename, meta);
      adopted++;
    }
    return adopted;
  }
}
