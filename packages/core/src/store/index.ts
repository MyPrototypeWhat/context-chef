/**
 * The context store: one {@link StorageBackend} behind one {@link Store},
 * addressed as `context://<ns>/<path>`.
 *
 * Namespaces in use today: `memory` (Memory), `vfs` (Offloader) and `archive`
 * (compressed spans). Legacy `MemoryStore` / `VFSStorageAdapter` implementations
 * keep working through {@link Store.fromMemoryStore} / {@link Store.fromVfsAdapter}.
 */

export {
  type FileStat,
  FileSystemBackend,
  type FileSystemBackendOptions,
  type FileSystemFormat,
  type FileSystemNamespaceLayout,
} from './backends/fileSystem';
export { InMemoryBackend } from './backends/inMemory';
export { fromMemoryStore, fromVfsAdapter } from './legacy';
export {
  type NamespaceOptions,
  NamespaceView,
  type PutResult,
  Store,
  type StoreOptions,
} from './store';
export {
  ARCHIVE_NAMESPACE,
  type EvictionPolicy,
  type EvictionReason,
  type ListedEntry,
  type MaybePromise,
  MEMORY_NAMESPACE,
  type SearchHit,
  type StorageBackend,
  type StoreCapability,
  StoreCapabilityError,
  type StoreCleanupOptions,
  type StoreCleanupResult,
  type StoredEntries,
  type StoredEntry,
  type StoredEntryMeta,
  type StoreEntryMeta,
  VFS_NAMESPACE,
} from './types';
