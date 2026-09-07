import * as crypto from 'node:crypto';
import { fromMemoryStore, fromVfsAdapter } from './legacy';
import { chain } from './maybe';
import {
  type EvictionPolicy,
  type EvictionReason,
  type ListedEntry,
  type MaybePromise,
  type SearchHit,
  type StorageBackend,
  type StoreCapability,
  StoreCapabilityError,
  type StoreCleanupOptions,
  type StoreCleanupResult,
  type StoredEntry,
  type StoredEntryMeta,
  type StoreEntryMeta,
} from './types';

const URI_PREFIX = 'context://';

/** Default URI prefix for a namespace: `context://<ns>/`. */
function defaultScheme(ns: string): string {
  return `${URI_PREFIX}${ns}/`;
}

export interface PutResult {
  path: string;
  uri: string;
}

export interface StoreOptions {
  /** Per-namespace eviction caps, applied by {@link Store.cleanup}. */
  eviction?: Partial<Record<string, EvictionPolicy>>;
  /** Per-namespace URI prefix override. Default: `context://<ns>/`. */
  uriScheme?: Partial<Record<string, string>>;
}

export interface NamespaceOptions {
  /** URI prefix for this view. Overrides the store-level scheme for this namespace. */
  uriScheme?: string;
}

/**
 * One namespace of a {@link Store}. Every method mirrors the backend's
 * sync-or-async nature: with a synchronous backend the result is the value
 * itself, so synchronous callers keep working.
 */
export class NamespaceView {
  readonly ns: string;
  private readonly store: Store;
  private readonly scheme: string;

  constructor(store: Store, ns: string, scheme: string) {
    this.store = store;
    this.ns = ns;
    this.scheme = scheme;
  }

  /** URI for a path in this namespace, honouring a custom scheme. */
  uri(path: string): string {
    return `${this.scheme}${path}`;
  }

  /** Path for a URI in this namespace, or null when the URI belongs elsewhere. */
  parseUri(uri: string): string | null {
    if (!this.scheme || !uri.startsWith(this.scheme)) return null;
    return uri.slice(this.scheme.length);
  }

  /**
   * Content-addressed path used by the auto-id `put(content)` overload.
   * Identical content always maps to the same path, which is what makes
   * re-offloading in an agent loop idempotent and the resulting URI
   * byte-stable across processes.
   */
  autoPath(content: string): string {
    const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
    return `${this.ns}_${hash}.txt`;
  }

  supports(capability: StoreCapability): boolean {
    return this.store.supports(this.ns, capability);
  }

  /** Reads an entry and refreshes its LRU recency when it is already indexed. */
  get(path: string): MaybePromise<StoredEntry | null> {
    return chain(this.store.backend.read(this.ns, path), (entry) => {
      if (entry) this.store.touch(this.ns, path);
      return entry;
    });
  }

  put(path: string, content: string, meta?: Partial<StoredEntryMeta>): MaybePromise<PutResult>;
  put(content: string, meta?: Partial<StoredEntryMeta>): MaybePromise<PutResult>;
  put(
    pathOrContent: string,
    contentOrMeta?: string | Partial<StoredEntryMeta>,
    maybeMeta?: Partial<StoredEntryMeta>,
  ): MaybePromise<PutResult> {
    const addressed = typeof contentOrMeta === 'string';
    const content = addressed ? contentOrMeta : pathOrContent;
    const path = addressed ? pathOrContent : this.autoPath(content);
    const meta = addressed ? maybeMeta : contentOrMeta;
    return this._write(path, content, meta);
  }

  /**
   * Synchronous {@link get}. Throws `asyncMessage` — before touching the index —
   * when the backend answers asynchronously.
   */
  getSync(path: string, asyncMessage?: string): StoredEntry | null {
    const entry = requireSync(
      this.store.backend.read(this.ns, path),
      this.ns,
      'read',
      asyncMessage,
    );
    if (entry) this.store.touch(this.ns, path);
    return entry;
  }

  /** Synchronous {@link put}. Throws — without indexing — when the backend is async. */
  putSync(
    path: string,
    content: string,
    meta?: Partial<StoredEntryMeta>,
    asyncMessage?: string,
  ): PutResult {
    const { entry, uri } = this._prepare(path, content, meta);
    requireSync(this.store.backend.write(this.ns, path, entry), this.ns, 'write', asyncMessage);
    this.store.register(this.ns, path, uri, byteLength(content));
    return { path, uri };
  }

  /** Synchronous {@link delete}. Throws when the backend is async. */
  deleteSync(path: string, asyncMessage?: string): boolean {
    const deleted = requireSync(
      this.store.backend.delete(this.ns, path),
      this.ns,
      'delete',
      asyncMessage,
    );
    this.store.dropIndex(this.ns, path);
    return deleted;
  }

  /** Synchronous {@link list}. Throws when the backend is async. */
  listSync(prefix?: string, asyncMessage?: string): ListedEntry[] {
    return requireSync(this.store.backend.list(this.ns, prefix), this.ns, 'list', asyncMessage);
  }

  /**
   * Appends to an entry, creating it when absent. Uses the backend's native
   * append when it has one — except when the caller supplies `meta`, which
   * `StorageBackend.append` has no parameter for: applying it needs the
   * read-modify-write path, and one public method may not mean two different
   * things depending on which backend is configured.
   */
  append(path: string, content: string, meta?: Partial<StoredEntryMeta>): MaybePromise<PutResult> {
    const backend = this.store.backend;
    const uri = this.uri(path);
    if (backend.append && this.supports('append') && meta === undefined) {
      return chain(backend.append(this.ns, path, content), () =>
        chain(backend.read(this.ns, path), (entry) => {
          this.store.register(this.ns, path, uri, byteLength(entry?.content ?? content));
          return { path, uri };
        }),
      );
    }
    return chain(backend.read(this.ns, path), (existing) => {
      const appended = (existing?.content ?? '') + content;
      return this._write(path, appended, {
        // The entry keeps the metadata it had — an append is not a rewrite —
        // with the caller's fields on top and the two an append invalidates
        // brought up to date. Same result the native branch produces.
        ...existing?.meta,
        ...meta,
        updatedAt: meta?.updatedAt ?? Date.now(),
        bytes: byteLength(appended),
      });
    });
  }

  delete(path: string): MaybePromise<boolean> {
    return chain(this.store.backend.delete(this.ns, path), (deleted) => {
      this.store.dropIndex(this.ns, path);
      return deleted;
    });
  }

  list(prefix?: string): MaybePromise<ListedEntry[]> {
    return this.store.backend.list(this.ns, prefix);
  }

  /**
   * Full-namespace read in one pass, in the backend's own key order. Falls back
   * to `list()` + `get()` when the backend has no bulk read.
   *
   * A Map, because the caller that renders these entries (`Memory.getAll()` →
   * the injected `<memory>` block) must see them in store order, and a plain
   * object would hoist integer-like keys ahead of the rest.
   */
  entries(prefix?: string): MaybePromise<Map<string, StoredEntry>> {
    const backend = this.store.backend;
    if (backend.readAll && this.supports('readAll')) {
      return backend.readAll(this.ns, prefix);
    }
    return chain(backend.list(this.ns, prefix), (listed) => {
      const reads = listed.map((item) => backend.read(this.ns, item.path));
      const collect = (values: (StoredEntry | null)[]): Map<string, StoredEntry> => {
        const out = new Map<string, StoredEntry>();
        for (let i = 0; i < listed.length; i++) {
          const entry = values[i];
          if (entry) out.set(listed[i].path, entry);
        }
        return out;
      };
      return reads.some((r) => r instanceof Promise)
        ? Promise.all(reads).then(collect)
        : collect(reads as (StoredEntry | null)[]);
    });
  }

  search(query: string): MaybePromise<SearchHit[]> {
    const backend = this.store.backend;
    if (!backend.search || !this.supports('search')) {
      throw new StoreCapabilityError(this.ns, ['search']);
    }
    return backend.search(this.ns, query);
  }

  exists(path: string): MaybePromise<boolean> {
    const backend = this.store.backend;
    if (!backend.exists || !this.supports('exists')) return false;
    return backend.exists(this.ns, path);
  }

  getPhysicalPath(path: string): MaybePromise<string | null> {
    const backend = this.store.backend;
    if (!backend.getPhysicalPath || !this.supports('getPhysicalPath')) return null;
    return backend.getPhysicalPath(this.ns, path);
  }

  snapshot(): Record<string, StoredEntry> | null {
    const backend = this.store.backend;
    if (!backend.snapshot || !this.supports('snapshot')) return null;
    return backend.snapshot(this.ns);
  }

  restore(data: Record<string, StoredEntry>): boolean {
    const backend = this.store.backend;
    if (!backend.restore || !this.supports('restore')) return false;
    backend.restore(this.ns, data);
    this.store.clearIndex(this.ns);
    return true;
  }

  // ─── Access index ───────────────────────────────────────────────────────

  /** Index metadata for one path, or null when this store has never seen it. */
  indexEntry(path: string): StoreEntryMeta | null {
    return this.store.indexEntry(this.ns, path);
  }

  /** Deep-cloned index metadata for every tracked path in this namespace. */
  index(): StoreEntryMeta[] {
    return this.store.index(this.ns);
  }

  /** Refreshes LRU recency for an already-tracked path. */
  touch(path: string): void {
    this.store.touch(this.ns, path);
  }

  /**
   * Indexes content this store did not write in this call — a content-addressed
   * entry the backend already had, so the write could be skipped.
   */
  register(path: string, bytes: number): void {
    this.store.register(this.ns, path, this.uri(path), bytes);
  }

  /**
   * Adds an entry the store did not write to the index — a file found on the
   * backend after a restart. The caller supplies the timestamps because only
   * it knows how to date foreign content.
   */
  adopt(path: string, meta: Omit<StoreEntryMeta, 'ns' | 'path' | 'uri'> & { uri?: string }): void {
    this.store.adopt(this.ns, path, { ...meta, uri: meta.uri ?? this.uri(path) });
  }

  cleanup(options?: StoreCleanupOptions): StoreCleanupResult {
    return this.store.cleanup(this.ns, options);
  }

  cleanupAsync(options?: StoreCleanupOptions): Promise<StoreCleanupResult> {
    return this.store.cleanupAsync(this.ns, options);
  }

  private _prepare(
    path: string,
    content: string,
    meta?: Partial<StoredEntryMeta>,
  ): { entry: StoredEntry; uri: string } {
    const now = Date.now();
    // Defaults are filled in AFTER the caller's fields so a caller that manages
    // its own timestamps (Memory) round-trips key-for-key through the backend.
    const entryMeta = { ...meta } as StoredEntryMeta;
    if (entryMeta.createdAt === undefined) entryMeta.createdAt = now;
    if (entryMeta.updatedAt === undefined) entryMeta.updatedAt = now;
    return { entry: { content, meta: entryMeta }, uri: this.uri(path) };
  }

  private _write(
    path: string,
    content: string,
    meta?: Partial<StoredEntryMeta>,
  ): MaybePromise<PutResult> {
    const { entry, uri } = this._prepare(path, content, meta);
    return chain(this.store.backend.write(this.ns, path, entry), () => {
      this.store.register(this.ns, path, uri, byteLength(content));
      return { path, uri };
    });
  }
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/** Unwraps a backend answer that a synchronous call site cannot await. */
function requireSync<T>(
  value: MaybePromise<T>,
  ns: string,
  operation: string,
  asyncMessage?: string,
): T {
  if (value instanceof Promise) {
    throw new Error(
      asyncMessage ??
        `Store.${operation}('${ns}') was called synchronously, but the StorageBackend is asynchronous. Use the async entry point instead.`,
    );
  }
  return value;
}

/**
 * Namespaced access to one {@link StorageBackend}, plus the access index and
 * LRU eviction that used to live inside the Offloader.
 *
 * Addressing is `context://<ns>/<path>`. The built-in namespaces are `memory`
 * (Memory), `vfs` (Offloader) and `archive` (compressed spans).
 */
export class Store {
  readonly backend: StorageBackend;
  private readonly eviction: Partial<Record<string, EvictionPolicy>>;
  private readonly schemes: Partial<Record<string, string>>;
  private readonly _index = new Map<string, Map<string, StoreEntryMeta>>();
  private readonly _cleanupInFlight = new Map<string, Promise<StoreCleanupResult>>();

  constructor(backend: StorageBackend, options: StoreOptions = {}) {
    this.backend = backend;
    this.eviction = options.eviction ?? {};
    this.schemes = options.uriScheme ?? {};
  }

  /** `context://<ns>/<path>` — the canonical address of a stored entry. */
  static uri(ns: string, path: string): string {
    return `${defaultScheme(ns)}${path}`;
  }

  /** Splits a canonical `context://<ns>/<path>` URI. Returns null for anything else. */
  static parseUri(uri: string): { ns: string; path: string } | null {
    if (!uri.startsWith(URI_PREFIX)) return null;
    const rest = uri.slice(URI_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return null;
    return { ns: rest.slice(0, slash), path: rest.slice(slash + 1) };
  }

  /** Wraps a legacy `MemoryStore` as a backend serving the `memory` namespace. */
  static fromMemoryStore = fromMemoryStore;

  /** Wraps a legacy `VFSStorageAdapter` as a backend serving `vfs` and `archive`. */
  static fromVfsAdapter = fromVfsAdapter;

  /** Returns `input` when it is already a Store, otherwise wraps the backend in one. */
  static from(input: Store | StorageBackend, options?: StoreOptions): Store {
    return input instanceof Store ? input : new Store(input, options);
  }

  namespace(ns: string, options?: NamespaceOptions): NamespaceView {
    return new NamespaceView(this, ns, options?.uriScheme ?? this.schemes[ns] ?? defaultScheme(ns));
  }

  supports(ns: string, capability: StoreCapability): boolean {
    const backend = this.backend;
    if (backend.supports) return backend.supports(capability, ns);
    return typeof backend[capability] === 'function';
  }

  // ─── Access index ───────────────────────────────────────────────────────

  /** Records a write. Keeps the original `createdAt` when the path is already tracked. */
  register(ns: string, path: string, uri: string, bytes: number): void {
    const now = Date.now();
    const bucket = this._bucket(ns);
    const existing = bucket.get(path);
    bucket.set(path, {
      ns,
      path,
      uri,
      createdAt: existing?.createdAt ?? now,
      accessedAt: now,
      bytes,
    });
  }

  adopt(ns: string, path: string, meta: Omit<StoreEntryMeta, 'ns' | 'path'>): void {
    this._bucket(ns).set(path, { ...meta, ns, path });
  }

  /** Refreshes LRU recency. No-op for paths the store has never written or adopted. */
  touch(ns: string, path: string): void {
    const entry = this._index.get(ns)?.get(path);
    if (entry) entry.accessedAt = Date.now();
  }

  indexEntry(ns: string, path: string): StoreEntryMeta | null {
    const entry = this._index.get(ns)?.get(path);
    return entry ? { ...entry } : null;
  }

  index(ns: string): StoreEntryMeta[] {
    const bucket = this._index.get(ns);
    return bucket ? Array.from(bucket.values(), (e) => ({ ...e })) : [];
  }

  dropIndex(ns: string, path: string): void {
    this._index.get(ns)?.delete(path);
  }

  clearIndex(ns?: string): void {
    if (ns === undefined) this._index.clear();
    else this._index.get(ns)?.clear();
  }

  // ─── Eviction ───────────────────────────────────────────────────────────

  /**
   * Sweeps expired and over-cap entries from the backend and the index.
   * Throws {@link StoreCapabilityError} when the backend cannot list or delete,
   * and a plain Error when the backend turns out to be asynchronous.
   */
  cleanup(ns: string, options?: StoreCleanupOptions): StoreCleanupResult {
    this._assertEvictable(ns);
    const asyncMessage =
      options?.asyncBackendMessage ??
      `Store.cleanup('${ns}') was called synchronously, but the StorageBackend is asynchronous. Use cleanupAsync() instead.`;

    // Sync-ness probe: an async list() means we cannot finish synchronously.
    if (this.backend.list(ns) instanceof Promise) throw new Error(asyncMessage);

    const plan = this._planEvictions(ns, Date.now(), options);
    const result = emptyCleanupResult();

    for (const { entry, reason } of plan) {
      try {
        const deleted = this.backend.delete(ns, entry.path);
        if (deleted instanceof Promise) throw new Error(asyncMessage);
      } catch (error) {
        result.failed.push({ entry, error: toError(error) });
        continue;
      }

      this.dropIndex(ns, entry.path);

      if (options?.onEvicted) {
        try {
          const hookResult = options.onEvicted(entry, reason);
          if (hookResult instanceof Promise) options.onEvictedIgnoredPromise?.();
        } catch (error) {
          options.onEvictedError?.(error);
        }
      }

      accumulate(result, entry, reason);
    }

    return result;
  }

  /** Async variant of {@link cleanup}. Concurrent calls per namespace are coalesced. */
  cleanupAsync(ns: string, options?: StoreCleanupOptions): Promise<StoreCleanupResult> {
    const inFlight = this._cleanupInFlight.get(ns);
    if (inFlight) return inFlight;
    const run = this._cleanupAsyncImpl(ns, options).finally(() => {
      this._cleanupInFlight.delete(ns);
    });
    this._cleanupInFlight.set(ns, run);
    return run;
  }

  private async _cleanupAsyncImpl(
    ns: string,
    options?: StoreCleanupOptions,
  ): Promise<StoreCleanupResult> {
    this._assertEvictable(ns);

    const plan = this._planEvictions(ns, Date.now(), options);
    const result = emptyCleanupResult();

    for (const { entry, reason } of plan) {
      try {
        await this.backend.delete(ns, entry.path);
      } catch (error) {
        result.failed.push({ entry, error: toError(error) });
        continue;
      }

      this.dropIndex(ns, entry.path);

      if (options?.onEvicted) {
        try {
          await options.onEvicted(entry, reason);
        } catch (error) {
          options.onEvictedError?.(error);
        }
      }

      accumulate(result, entry, reason);
    }

    return result;
  }

  /** The capabilities eviction needs, in the order callers report them. */
  missingEvictionCapabilities(ns: string): ('list' | 'delete')[] {
    const missing: ('list' | 'delete')[] = [];
    if (!this.supports(ns, 'list')) missing.push('list');
    if (!this.supports(ns, 'delete')) missing.push('delete');
    return missing;
  }

  private _assertEvictable(ns: string): void {
    const missing = this.missingEvictionCapabilities(ns);
    if (missing.length > 0) throw new StoreCapabilityError(ns, missing);
  }

  /**
   * Phase A sweeps everything past `maxAge` (relative to createdAt); Phase B
   * evicts least-recently-accessed entries until both the count and byte caps
   * hold. Overrides beat the namespace policy field by field.
   */
  private _planEvictions(
    ns: string,
    now: number,
    overrides?: EvictionPolicy,
  ): { entry: StoreEntryMeta; reason: EvictionReason }[] {
    const policy = this.eviction[ns] ?? {};
    const maxAge = overrides?.maxAge ?? policy.maxAge;
    const maxFiles = overrides?.maxFiles ?? policy.maxFiles;
    const maxBytes = overrides?.maxBytes ?? policy.maxBytes;

    const plan: { entry: StoreEntryMeta; reason: EvictionReason }[] = [];
    const remaining = new Map<string, StoreEntryMeta>();

    for (const entry of this.index(ns)) {
      if (maxAge != null && now - entry.createdAt > maxAge) {
        plan.push({ entry, reason: 'maxAge' });
      } else {
        remaining.set(entry.path, entry);
      }
    }

    if (maxFiles == null && maxBytes == null) return plan;

    let totalBytes = 0;
    for (const e of remaining.values()) totalBytes += e.bytes;

    while (true) {
      const overCount = maxFiles != null && remaining.size > maxFiles;
      const overBytes = maxBytes != null && totalBytes > maxBytes;
      if (!overCount && !overBytes) break;
      if (remaining.size === 0) break;

      let victim: StoreEntryMeta | null = null;
      for (const e of remaining.values()) {
        if (!victim || e.accessedAt < victim.accessedAt) victim = e;
      }
      if (!victim) break;

      plan.push({ entry: victim, reason: overCount ? 'maxFiles' : 'maxBytes' });
      remaining.delete(victim.path);
      totalBytes -= victim.bytes;
    }

    return plan;
  }

  private _bucket(ns: string): Map<string, StoreEntryMeta> {
    let bucket = this._index.get(ns);
    if (!bucket) {
      bucket = new Map();
      this._index.set(ns, bucket);
    }
    return bucket;
  }
}

function emptyCleanupResult(): StoreCleanupResult {
  return {
    evicted: [],
    evictedBytes: 0,
    evictedByAge: 0,
    evictedByCount: 0,
    evictedByBytes: 0,
    failed: [],
  };
}

function accumulate(
  result: StoreCleanupResult,
  entry: StoreEntryMeta,
  reason: EvictionReason,
): void {
  result.evicted.push(entry);
  result.evictedBytes += entry.bytes;
  if (reason === 'maxAge') result.evictedByAge++;
  else if (reason === 'maxFiles') result.evictedByCount++;
  else result.evictedByBytes++;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
