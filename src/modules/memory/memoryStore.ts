/**
 * Standard key-value store interface for ContextChef memory subsystem.
 *
 * Supports both synchronous and asynchronous implementations, mirroring the
 * VFSStorageAdapter pattern. Use InMemoryStore for ephemeral/test scenarios,
 * VFSMemoryStore for persistent cross-session memory, or supply your own
 * implementation backed by Redis, SQLite, a vector DB, etc.
 *
 * This interface is the storage foundation for E4 (Core Memory persistence),
 * where the model can actively write to the static Top Layer via
 * <update_core_memory> output tags.
 */
export interface MemoryStore {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  delete(key: string): boolean | Promise<boolean>;
  keys(): string[] | Promise<string[]>;
  /** Optional: capture all entries for snapshot (e.g. InMemoryStore). */
  snapshot?(): Record<string, string>;
  /** Optional: restore all entries from a snapshot. */
  restore?(data: Record<string, string>): void;
}
