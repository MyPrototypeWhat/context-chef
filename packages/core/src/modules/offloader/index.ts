import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileSystemBackend, type FileSystemNamespaceLayout } from '../../store/backends/fileSystem';
import { fromVfsAdapter } from '../../store/legacy';
import { type NamespaceView, Store } from '../../store/store';
import {
  ARCHIVE_NAMESPACE,
  type StorageBackend,
  type StoreCleanupOptions,
  type StoreCleanupResult,
  type StoreEntryMeta,
  VFS_NAMESPACE,
} from '../../store/types';
import type { ChefLogger } from '../../types';
import { LEGACY_VOCABULARY, type Vocabulary } from '../../vocabulary';

/**
 * @deprecated Implement {@link StorageBackend} and pass it as `vfs.store`.
 *   Legacy adapters keep working — they are wrapped with `Store.fromVfsAdapter`.
 */
export interface VFSStorageAdapter {
  write(filename: string, content: string): void | Promise<void>;
  read(filename: string): string | null | Promise<string | null>;
  /**
   * Optional. Lets the Offloader skip redundant writes when a
   * content-addressed file already exists. Adapters that can't answer
   * cheaply may leave this unset — the Offloader then overwrites, which
   * is harmless (same filename ⇒ same content).
   *
   * Contract: only return true for FULLY persisted content. With
   * content-addressed names the Offloader treats existence as proof the
   * bytes are complete and skips the write — a partially written entry
   * reported as existing would be trusted for the rest of the process
   * lifetime (the in-memory index resets on restart, re-checking exists()).
   * Make writes atomic (FileSystemAdapter does: tmp file + rename).
   */
  exists?(filename: string): boolean | Promise<boolean>;
  /** Optional. Required for Offloader.cleanup() / reconcile(). Returns all stored filenames. */
  list?(): string[] | Promise<string[]>;
  /** Optional. Required for Offloader.cleanup(). Must be idempotent (no-op on missing files). */
  delete?(filename: string): void | Promise<void>;
  /**
   * Optional. When implemented, the Offloader exposes the underlying physical
   * path in the truncation marker, letting the model retrieve the original
   * content with its existing file-read tool — no custom URI-aware tool needed.
   * Adapters that don't map to a filesystem (DB, in-memory) should leave this
   * unset; the marker then falls back to the URI alone.
   */
  getPhysicalPath?(filename: string): string | null | Promise<string | null>;
}

/**
 * @deprecated Use {@link FileSystemBackend}, which serves every namespace from
 *   one root directory. This adapter remains for `vfs.adapter` callers.
 */
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
    const tmppath = path.join(this.storageDir, `.tmp_${process.pid}_${filename}`);
    try {
      fs.writeFileSync(tmppath, content, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // The storage dir can vanish mid-process — OS temp cleaners purge
      // /var/folders & friends on long-running hosts, and the constructor's
      // mkdir only ran once. Recreate and retry once.
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(tmppath, content, 'utf8');
    }
    fs.renameSync(tmppath, filepath); // atomic on the same filesystem
  }

  exists(filename: string): boolean {
    return fs.existsSync(path.join(this.storageDir, filename));
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

  getPhysicalPath(filename: string): string {
    return path.join(this.storageDir, filename);
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
  /**
   * The context store backing the `vfs` namespace. Pass a {@link Store} to share
   * one backend with Memory and the archive, or a bare {@link StorageBackend}.
   * Takes precedence over `adapter` and `storageDir`.
   */
  store?: Store | StorageBackend;
  /**
   * Custom storage adapter. If provided, overrides storageDir and filesystem operations.
   *
   * @deprecated Pass `store` instead. A legacy adapter is wrapped with
   *   `Store.fromVfsAdapter`, which serves the `vfs` and `archive` namespaces
   *   from its single flat keyspace.
   */
  adapter?: VFSStorageAdapter;
  /** Max age in ms (since createdAt) before an entry is eligible for cleanup. Undefined = no age cap. */
  maxAge?: number;
  /** Max number of stored entries. Undefined = no count cap. 0 = evict all in cleanup(). */
  maxFiles?: number;
  /** Max total UTF-8 bytes of stored content. Undefined = no byte cap. 0 = evict all in cleanup(). */
  maxBytes?: number;
  /**
   * Per-entry eviction notification.
   *
   * Contract: may throw — errors are caught, logged via the configured logger, and swallowed
   * so a misbehaving hook cannot abort the cleanup sweep. Use cleanupAsync() if the
   * hook is async; calling cleanup() (sync) with an async hook logs a warning and
   * does not await the result.
   */
  onVFSEvicted?: (entry: VFSEntryMeta, reason: VFSEvictionReason) => void | Promise<void>;
  /** Sink for degradation warnings. Defaults to `console`. */
  logger?: ChefLogger;
  /**
   * The wording the truncation marker is written in. `ContextChef` passes the
   * vocabulary it resolved from `ChefConfig.tools`; a standalone Offloader
   * leaves it unset and keeps the 4.x marker.
   *
   * @internal
   */
  vocabulary?: Vocabulary;
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

// Matches only the legacy timestamped name vfs_<ts>_<hash>.txt, so reconciled
// legacy orphans keep their original createdAt. Content-addressed names
// (vfs_<hash16>.txt) carry no timestamp and intentionally miss this pattern —
// they fall back to Date.now() at adoption in _buildOrphanMeta.
const ORPHAN_FILENAME_RE = /^vfs_(\d+)_[a-f0-9]+\.txt$/;

/** Wording kept verbatim from 4.1 — callers match on it. */
const asyncMessage = (sync: string, async: string): string =>
  `Offloader.${sync}() was called synchronously, but the VFSStorageAdapter is asynchronous. Use ${async}() instead.`;
const ASYNC_OFFLOAD_MESSAGE = asyncMessage('offload', 'offloadAsync');
const ASYNC_RESOLVE_MESSAGE = asyncMessage('resolve', 'resolveAsync');
const ASYNC_CLEANUP_MESSAGE = asyncMessage('cleanup', 'cleanupAsync');
const ASYNC_RECONCILE_MESSAGE = asyncMessage('reconcile', 'reconcileAsync');

/**
 * Physical layout that keeps `vfs_…` and `archive_…` files side by side in one
 * directory, each holding its content verbatim — so the physical path handed to
 * the model in the truncation marker opens as plain text.
 */
function flatLayouts(storageDir: string): Record<string, FileSystemNamespaceLayout> {
  const owned = (ns: string) => (file: string) => (file.startsWith(`${ns}_`) ? file : null);
  return {
    [VFS_NAMESPACE]: { dir: storageDir, format: 'raw', decode: owned(VFS_NAMESPACE) },
    [ARCHIVE_NAMESPACE]: { dir: storageDir, format: 'raw', decode: owned(ARCHIVE_NAMESPACE) },
  };
}

export class Offloader {
  private config: VFSConfig;
  /** The context store backing this Offloader. Shared with Memory when one was passed in. */
  readonly store: Store;
  private readonly vfs: NamespaceView;
  private readonly logger: ChefLogger;
  private readonly vocabulary: Vocabulary;
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

    this.logger = config.logger ?? console;
    this.vocabulary = config.vocabulary ?? LEGACY_VOCABULARY;

    const eviction = {
      [VFS_NAMESPACE]: {
        maxAge: config.maxAge,
        maxFiles: config.maxFiles,
        maxBytes: config.maxBytes,
      },
    };
    if (config.store) {
      // A Store the caller already built keeps its own namespace policy; the
      // caps above still apply, because cleanup() passes them per call.
      this.store = Store.from(config.store, { eviction });
    } else if (config.adapter) {
      this.store = new Store(fromVfsAdapter(config.adapter), { eviction });
    } else {
      const backend = new FileSystemBackend(storageDir, { layouts: flatLayouts(storageDir) });
      // Match the legacy FileSystemAdapter, which created its directory eagerly.
      backend.ensureDir(VFS_NAMESPACE);
      this.store = new Store(backend, { eviction });
    }
    this.vfs = this.store.namespace(VFS_NAMESPACE, { uriScheme: this.config.uriScheme });
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

  private _generateFilename(content: string): { filename: string; uri: string } {
    // Content-addressed: identical content always maps to the same file, so
    // re-offloading in an agent loop is idempotent and the truncation marker
    // (URI + physical path) is byte-stable — provider prefix caches survive.
    const filename = this.vfs.autoPath(content);
    return { filename, uri: this.vfs.uri(filename) };
  }

  private _buildTruncatedMarker(
    content: string,
    uri: string,
    headChars: number,
    tailChars: number,
    physicalPath: string | null,
  ): string {
    const totalLines = content.split('\n').length;
    const totalChars = content.length;

    const headEnd = headChars > 0 ? this._snapToLineBoundary(content, headChars, 'head') : 0;
    const tailStart =
      tailChars > 0
        ? this._snapToLineBoundary(content, content.length - tailChars, 'tail')
        : content.length;

    const headStr = headEnd > 0 ? content.slice(0, headEnd) : '';
    const tailStr = tailStart < content.length ? content.slice(tailStart) : '';

    return this.vocabulary.offloadPlaceholder({
      uri,
      totalLines,
      totalChars,
      head: headStr,
      tail: tailStr,
      physicalPath,
    });
  }

  /**
   * Resolves the backend's physical path for `filename` synchronously.
   * Returns null when the backend doesn't expose paths or returns a Promise
   * (degrading to URI-only marker on the sync code path).
   */
  private _resolvePhysicalPathSync(filename: string): string | null {
    const result = this.vfs.getPhysicalPath(filename);
    return typeof result === 'string' ? result : null;
  }

  /** Async variant — awaits Promise-returning backends. */
  private async _resolvePhysicalPathAsync(filename: string): Promise<string | null> {
    return await this.vfs.getPhysicalPath(filename);
  }

  private _registerEntry(filename: string, content: string): void {
    this.vfs.register(filename, Buffer.byteLength(content, 'utf8'));
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

    const { filename, uri } = this._generateFilename(content);
    const physicalPath = this._resolvePhysicalPathSync(filename);
    const truncated = this._buildTruncatedMarker(content, uri, headChars, tailChars, physicalPath);

    if (this.vfs.indexEntry(filename)) {
      // Same content already offloaded by this instance — refresh LRU recency.
      this.vfs.touch(filename);
      return { isOffloaded: true, content: truncated, uri };
    }

    // Strict `=== true` (not truthiness): a Promise means exists() is async,
    // so we fall through rather than treat a pending Promise as "exists".
    // If write() is also async it throws the established async-backend error;
    // a mixed sync-write backend just proceeds with a harmless redundant write.
    if (this.vfs.exists(filename) === true) {
      this._registerEntry(filename, content);
      return { isOffloaded: true, content: truncated, uri };
    }

    this.vfs.putSync(filename, content, undefined, ASYNC_OFFLOAD_MESSAGE);

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

    const { filename, uri } = this._generateFilename(content);
    const physicalPath = await this._resolvePhysicalPathAsync(filename);
    const truncated = this._buildTruncatedMarker(content, uri, headChars, tailChars, physicalPath);

    if (this.vfs.indexEntry(filename)) {
      this.vfs.touch(filename);
      return { isOffloaded: true, content: truncated, uri };
    }

    if (await this.vfs.exists(filename)) {
      this._registerEntry(filename, content);
      return { isOffloaded: true, content: truncated, uri };
    }

    await this.vfs.put(filename, content);

    return {
      isOffloaded: true,
      content: truncated,
      uri,
    };
  }

  /**
   * This Offloader's address for a stored filename, under the configured
   * `uriScheme` (`context://vfs/` by default). The inverse of what
   * {@link resolve} accepts — a caller holding a path rather than a cited URI
   * needs it to ask for the content back.
   */
  public uri(filename: string): string {
    return this.vfs.uri(filename);
  }

  /**
   * Reads the full content back from a URI (synchronously).
   * On a hit, updates the entry's accessedAt timestamp; if the URI is not in the index,
   * auto-adopts the file (parses createdAt from filename, seeds bytes from content length).
   * Throws an error if the adapter is asynchronous.
   */
  public resolve(uri: string): string | null {
    const filename = this.vfs.parseUri(uri);
    if (filename == null) return null;

    const entry = this.vfs.getSync(filename, ASYNC_RESOLVE_MESSAGE);
    if (entry == null) return null;

    this._touchOrAdopt(filename, uri, entry.content);
    return entry.content;
  }

  /**
   * Reads the full content back from a URI (asynchronously).
   * Safely supports both synchronous and asynchronous adapters.
   */
  public async resolveAsync(uri: string): Promise<string | null> {
    const filename = this.vfs.parseUri(uri);
    if (filename == null) return null;

    const entry = await this.vfs.get(filename);
    if (entry == null) return null;

    this._touchOrAdopt(filename, uri, entry.content);
    return entry.content;
  }

  /**
   * `NamespaceView.get` already refreshed recency for entries the store knows
   * about; anything else is a file written outside this instance and is adopted
   * with a filename-derived createdAt.
   */
  private _touchOrAdopt(filename: string, uri: string, content: string): void {
    if (this.vfs.indexEntry(filename)) return;
    const meta = this._buildOrphanMeta(filename, uri);
    this.vfs.adopt(filename, {
      uri: meta.uri,
      createdAt: meta.createdAt,
      accessedAt: Date.now(),
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  }

  /**
   * Builds index metadata for an adopted orphan. Legacy vfs_<ts>_<hash>.txt
   * names parse createdAt from the embedded timestamp. Content-addressed
   * vfs_<hash16>.txt names (and any malformed name) carry no timestamp and
   * fall back to Date.now() at adoption — so maxAge for adopted orphans
   * counts from adoption, the conservative direction (we never under-age and
   * evict early; at worst a just-adopted orphan lingers one maxAge window).
   */
  private _buildOrphanMeta(filename: string, uri?: string): VFSEntryMeta {
    const resolvedUri = uri ?? this.vfs.uri(filename);
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

  /** Returns a deep-cloned array of all entries currently tracked in the store's index. For tests/debugging. */
  public getEntries(): VFSEntryMeta[] {
    return this.vfs.index().map(toVFSEntryMeta);
  }

  /**
   * Translates this Offloader's config and hooks into the store's cleanup
   * contract. The caps are merged here so an explicit `vfs` config always beats
   * the namespace policy the Store was constructed with.
   */
  private _cleanupOptions(overrides?: CleanupOptions, sync = false): StoreCleanupOptions {
    return {
      maxAge: overrides?.maxAge ?? this.config.maxAge,
      maxFiles: overrides?.maxFiles ?? this.config.maxFiles,
      maxBytes: overrides?.maxBytes ?? this.config.maxBytes,
      asyncBackendMessage: ASYNC_CLEANUP_MESSAGE,
      onEvicted: this.config.onVFSEvicted
        ? (entry, reason) => this.config.onVFSEvicted?.(toVFSEntryMeta(entry), reason)
        : undefined,
      onEvictedIgnoredPromise: sync
        ? () =>
            this.logger.warn(
              '[Offloader] onVFSEvicted returned a Promise during sync cleanup(); call cleanupAsync() to await async hooks.',
            )
        : undefined,
      onEvictedError: (error) => this.logger.warn('[Offloader] onVFSEvicted threw:', error),
    };
  }

  /**
   * Sweeps expired and over-cap entries from the store and its index.
   * Throws VFSCleanupNotSupportedError if the backend cannot list or delete.
   * Throws if the backend is asynchronous (use cleanupAsync() instead).
   */
  public cleanup(overrides?: CleanupOptions): VFSCleanupResult {
    this._assertCleanupSupported();
    return toVFSCleanupResult(this.vfs.cleanup(this._cleanupOptions(overrides, true)));
  }

  /**
   * Async variant of cleanup(). Awaits each delete and onVFSEvicted call.
   * Concurrent cleanupAsync() calls are coalesced into a single in-flight promise —
   * callers compare promise identity, so the coalescing wraps the mapped result.
   */
  public cleanupAsync(overrides?: CleanupOptions): Promise<VFSCleanupResult> {
    if (this._cleanupInFlight) return this._cleanupInFlight;
    this._cleanupInFlight = this._cleanupAsyncImpl(overrides).finally(() => {
      this._cleanupInFlight = null;
    });
    return this._cleanupInFlight;
  }

  private async _cleanupAsyncImpl(overrides?: CleanupOptions): Promise<VFSCleanupResult> {
    this._assertCleanupSupported();
    return toVFSCleanupResult(await this.vfs.cleanupAsync(this._cleanupOptions(overrides)));
  }

  /** Raises the Offloader-flavoured capability error, which names the legacy adapter. */
  private _assertCleanupSupported(): void {
    const missing = this.store.missingEvictionCapabilities(VFS_NAMESPACE);
    if (missing.length > 0) throw new VFSCleanupNotSupportedError(missing);
  }

  /**
   * Walks the `vfs` namespace and adopts orphan entries (present on the backend,
   * absent from the index). Required after process restart for cleanup() to see
   * pre-restart files. Legacy vfs_<ts>_<hash>.txt names yield createdAt from the
   * embedded timestamp; content-addressed vfs_<hash16>.txt (and malformed) names
   * fall back to Date.now(). Returns the count of orphans adopted. With
   * measureBytes, reads each orphan to populate accurate bytes.
   */
  public reconcile(options?: { measureBytes?: boolean }): number {
    if (!this.vfs.supports('list')) throw new VFSCleanupNotSupportedError(['list']);

    let adopted = 0;
    for (const listed of this.vfs.listSync(undefined, ASYNC_RECONCILE_MESSAGE)) {
      if (this.vfs.indexEntry(listed.path)) continue;

      const meta = this._buildOrphanMeta(listed.path);
      if (options?.measureBytes) {
        const entry = this.vfs.getSync(listed.path, ASYNC_RECONCILE_MESSAGE);
        if (entry != null) meta.bytes = Buffer.byteLength(entry.content, 'utf8');
      }

      this._adoptOrphan(meta);
      adopted++;
    }
    return adopted;
  }

  /** Async variant of reconcile(). */
  public async reconcileAsync(options?: { measureBytes?: boolean }): Promise<number> {
    if (!this.vfs.supports('list')) throw new VFSCleanupNotSupportedError(['list']);

    const listed = await this.vfs.list();

    let adopted = 0;
    for (const item of listed) {
      if (this.vfs.indexEntry(item.path)) continue;

      const meta = this._buildOrphanMeta(item.path);
      if (options?.measureBytes) {
        const entry = await this.vfs.get(item.path);
        if (entry != null) meta.bytes = Buffer.byteLength(entry.content, 'utf8');
      }

      this._adoptOrphan(meta);
      adopted++;
    }
    return adopted;
  }

  private _adoptOrphan(meta: VFSEntryMeta): void {
    this.vfs.adopt(meta.filename, {
      uri: meta.uri,
      createdAt: meta.createdAt,
      accessedAt: meta.accessedAt,
      bytes: meta.bytes,
    });
  }
}

/** Store index entry → the Offloader's public `VFSEntryMeta` shape. */
function toVFSEntryMeta(entry: StoreEntryMeta): VFSEntryMeta {
  return {
    filename: entry.path,
    uri: entry.uri,
    createdAt: entry.createdAt,
    accessedAt: entry.accessedAt,
    bytes: entry.bytes,
  };
}

function toVFSCleanupResult(result: StoreCleanupResult): VFSCleanupResult {
  return {
    evicted: result.evicted.map(toVFSEntryMeta),
    evictedBytes: result.evictedBytes,
    evictedByAge: result.evictedByAge,
    evictedByCount: result.evictedByCount,
    evictedByBytes: result.evictedByBytes,
    failed: result.failed.map(({ entry, error }) => ({ entry: toVFSEntryMeta(entry), error })),
  };
}
