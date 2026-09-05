/**
 * The single persistence substrate: addressed content with metadata.
 *
 * Everything ContextChef keeps outside the window — memory entries, offloaded
 * tool output, archived compression spans — is the same thing at different
 * addresses. A {@link StorageBackend} moves bytes; {@link Store} adds
 * namespacing, URIs, an access index and eviction on top of it.
 */

export type MaybePromise<T> = T | Promise<T>;

/** Memory's namespace: durable facts, injected into every compile. */
export const MEMORY_NAMESPACE = 'memory';
/** The Offloader's namespace: content pulled out of the window, recoverable by URI. */
export const VFS_NAMESPACE = 'vfs';
/** Reversible compression's namespace: full spans behind a summary's citation. */
export const ARCHIVE_NAMESPACE = 'archive';

export interface StoredEntryMeta {
  createdAt: number;
  updatedAt: number;
  /** UTF-8 byte length of `content`. Backends that can answer cheaply should. */
  bytes?: number;
  [key: string]: unknown;
}

export interface StoredEntry {
  content: string;
  meta: StoredEntryMeta;
}

export interface ListedEntry {
  path: string;
  meta: StoredEntryMeta;
}

export interface SearchHit {
  path: string;
  meta: StoredEntryMeta;
  /** Matching excerpt, when the backend can produce one. */
  snippet?: string;
  /** Backend-defined relevance; higher is better. */
  score?: number;
}

/**
 * Optional backend methods a namespace may or may not have. `read`, `write`,
 * `delete` and `list` are mandatory and always present.
 */
export type StoreCapability =
  | 'read'
  | 'write'
  | 'delete'
  | 'list'
  | 'readAll'
  | 'exists'
  | 'append'
  | 'search'
  | 'snapshot'
  | 'restore'
  | 'getPhysicalPath';

/**
 * Moves bytes for one or more namespaces. Every method may be sync or async —
 * the Store passes the choice straight through, so a synchronous backend keeps
 * synchronous call sites working (`Offloader.offload`, `Memory.snapshot`).
 */
export interface StorageBackend {
  read(ns: string, path: string): MaybePromise<StoredEntry | null>;
  write(ns: string, path: string, entry: StoredEntry): MaybePromise<void>;
  delete(ns: string, path: string): MaybePromise<boolean>;
  list(ns: string, prefix?: string): MaybePromise<ListedEntry[]>;
  /**
   * Optional bulk read. Present so a full-namespace scan costs one pass
   * instead of `list()` plus one `read()` per path — the difference between
   * 1+N and 2N round-trips on a network-backed store.
   */
  readAll?(ns: string, prefix?: string): MaybePromise<Record<string, StoredEntry>>;
  /**
   * Optional existence probe. Contract: only report `true` for FULLY persisted
   * content — content-addressed callers treat existence as proof the bytes are
   * complete and skip the write.
   */
  exists?(ns: string, path: string): MaybePromise<boolean>;
  /** Optional native append. Without it the Store does read-modify-write. */
  append?(ns: string, path: string, content: string): MaybePromise<void>;
  search?(ns: string, query: string): MaybePromise<SearchHit[]>;
  snapshot?(ns: string): Record<string, StoredEntry>;
  restore?(ns: string, data: Record<string, StoredEntry>): void;
  /**
   * Optional. When implemented, callers can hand the model a real filesystem
   * path instead of (or alongside) the `context://` URI.
   */
  getPhysicalPath?(ns: string, path: string): MaybePromise<string | null>;
  /**
   * Optional capability override. Backends that wrap a legacy store implement
   * every method to satisfy this interface but may not be able to honour all
   * of them; they report the truth here instead of by method presence.
   */
  supports?(capability: StoreCapability, ns?: string): boolean;
}

/** Per-namespace eviction caps. Same semantics as the legacy `VFSConfig` fields. */
export interface EvictionPolicy {
  /** Max age in ms (since createdAt) before an entry is eligible. Undefined = no age cap. */
  maxAge?: number;
  /** Max number of tracked entries. Undefined = no count cap. 0 = evict all. */
  maxFiles?: number;
  /** Max total UTF-8 bytes tracked. Undefined = no byte cap. 0 = evict all. */
  maxBytes?: number;
}

export type EvictionReason = 'maxAge' | 'maxFiles' | 'maxBytes';

/** One entry in the Store's in-memory access index. Drives LRU eviction. */
export interface StoreEntryMeta {
  ns: string;
  path: string;
  uri: string;
  /** Date.now() at write, or the value supplied when an orphan was adopted. */
  createdAt: number;
  /** Date.now() at last read. Drives LRU eviction order. */
  accessedAt: number;
  /** UTF-8 byte length of the stored content. */
  bytes: number;
}

export interface StoreCleanupResult {
  evicted: StoreEntryMeta[];
  evictedBytes: number;
  evictedByAge: number;
  evictedByCount: number;
  evictedByBytes: number;
  failed: { entry: StoreEntryMeta; error: Error }[];
}

export interface StoreCleanupOptions extends EvictionPolicy {
  /**
   * Per-entry eviction notification, invoked in eviction order after the
   * backend delete succeeds. May throw — see {@link onEvictedError}.
   */
  onEvicted?: (entry: StoreEntryMeta, reason: EvictionReason) => void | Promise<void>;
  /** Sync cleanup only: `onEvicted` returned a Promise, which is not awaited. */
  onEvictedIgnoredPromise?: () => void;
  /** `onEvicted` threw or rejected. The sweep continues. */
  onEvictedError?: (error: unknown) => void;
  /** Message for the error thrown when a sync cleanup meets an async backend. */
  asyncBackendMessage?: string;
}

/**
 * Thrown when a namespace is asked for something its backend cannot do —
 * `search` on a backend without search, `cleanup` on one that cannot list.
 */
export class StoreCapabilityError extends Error {
  readonly ns: string;
  readonly missing: StoreCapability[];

  constructor(ns: string, missing: StoreCapability[]) {
    super(
      `Store namespace '${ns}' requires the backend to implement: ${missing.join(', ')}. The configured StorageBackend does not.`,
    );
    this.name = 'StoreCapabilityError';
    this.ns = ns;
    this.missing = missing;
  }
}
