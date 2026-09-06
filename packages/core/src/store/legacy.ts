import type { MemoryStore, MemoryStoreEntry } from '../modules/memory/memoryStore';
import type { VFSStorageAdapter } from '../modules/offloader';
import { chain } from './maybe';
import {
  type ListedEntry,
  type StorageBackend,
  type StoreCapability,
  StoreCapabilityError,
  type StoredEntry,
} from './types';

/** `MemoryStoreEntry` → `StoredEntry`: the value is the content, everything else is meta. */
export function memoryEntryToStored(entry: MemoryStoreEntry): StoredEntry {
  const { value, ...meta } = entry;
  return { content: value, meta };
}

/** `StoredEntry` → `MemoryStoreEntry`. Inverse of {@link memoryEntryToStored}. */
export function storedToMemoryEntry(entry: StoredEntry): MemoryStoreEntry {
  return { value: entry.content, ...entry.meta } as unknown as MemoryStoreEntry;
}

function mapRecord<A, B>(data: Record<string, A>, fn: (value: A) => B): Record<string, B> {
  const out: Record<string, B> = {};
  for (const [key, value] of Object.entries(data)) out[key] = fn(value);
  return out;
}

/**
 * Serves the `memory` namespace from a legacy {@link MemoryStore}.
 *
 * A legacy store is a single flat keyspace, so the namespace argument is
 * ignored — every namespace on this backend addresses the same keys. Use a
 * real {@link StorageBackend} when you want more than one namespace.
 *
 * @param legacy the store to wrap
 */
export function fromMemoryStore(legacy: MemoryStore): StorageBackend {
  const capabilities = new Set<StoreCapability>(['read', 'write', 'delete', 'list', 'readAll']);
  if (legacy.snapshot) capabilities.add('snapshot');
  if (legacy.restore) capabilities.add('restore');

  // A Map, not a plain object: `legacy.keys()` order is the store's own, and
  // an object would reorder integer-like keys ('10' ahead of 'zeta').
  const readAll = (
    _ns: string,
    prefix?: string,
  ): Map<string, StoredEntry> | Promise<Map<string, StoredEntry>> =>
    chain(legacy.keys(), (keys) => {
      const selected = prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
      const reads = selected.map((key) => legacy.get(key));
      const collect = (entries: (MemoryStoreEntry | null)[]): Map<string, StoredEntry> => {
        const out = new Map<string, StoredEntry>();
        for (let i = 0; i < selected.length; i++) {
          const entry = entries[i];
          if (entry) out.set(selected[i], memoryEntryToStored(entry));
        }
        return out;
      };
      return reads.some((r) => r instanceof Promise)
        ? Promise.all(reads).then(collect)
        : collect(reads as (MemoryStoreEntry | null)[]);
    });

  return {
    read: (_ns, path) => chain(legacy.get(path), (e) => (e ? memoryEntryToStored(e) : null)),
    write: (_ns, path, entry) => legacy.set(path, storedToMemoryEntry(entry)),
    delete: (_ns, path) => legacy.delete(path),
    list: (ns, prefix) =>
      chain(readAll(ns, prefix), (entries) =>
        Array.from(entries, ([path, entry]): ListedEntry => ({ path, meta: entry.meta })),
      ),
    readAll,
    snapshot: (ns) => {
      if (!legacy.snapshot) throw new StoreCapabilityError(ns, ['snapshot']);
      return mapRecord(legacy.snapshot(), memoryEntryToStored);
    },
    restore: (ns, data) => {
      if (!legacy.restore) throw new StoreCapabilityError(ns, ['restore']);
      legacy.restore(mapRecord(data, storedToMemoryEntry));
    },
    supports: (capability) => capabilities.has(capability),
  };
}

/**
 * Serves the `vfs` and `archive` namespaces from a legacy
 * {@link VFSStorageAdapter}.
 *
 * A legacy adapter is one flat set of filenames, so both namespaces address
 * the same files — which is exactly what happens today, where archived
 * compression spans are written through the Offloader as `vfs_…` files. The
 * logical path IS the filename.
 *
 * Optional adapter methods that are missing stay missing: `supports()` reports
 * false and the corresponding backend method throws a
 * {@link StoreCapabilityError} rather than silently doing nothing.
 */
export function fromVfsAdapter(legacy: VFSStorageAdapter): StorageBackend {
  const capabilities = new Set<StoreCapability>(['read', 'write']);
  if (legacy.delete) capabilities.add('delete');
  if (legacy.list) capabilities.add('list');
  if (legacy.exists) capabilities.add('exists');
  if (legacy.getPhysicalPath) capabilities.add('getPhysicalPath');

  // A legacy adapter stores bytes only — it carries no timestamps, so reads
  // report the observation time. The Store's own index is what tracks age and
  // recency for eviction.
  const wrap = (content: string): StoredEntry => {
    const now = Date.now();
    return {
      content,
      meta: { createdAt: now, updatedAt: now, bytes: Buffer.byteLength(content, 'utf8') },
    };
  };

  return {
    read: (_ns, path) => chain(legacy.read(path), (c) => (c == null ? null : wrap(c))),
    write: (_ns, path, entry) => legacy.write(path, entry.content),
    delete: (ns, path) => {
      if (!legacy.delete) throw new StoreCapabilityError(ns, ['delete']);
      return chain(legacy.delete(path), () => true);
    },
    list: (ns, prefix) => {
      if (!legacy.list) throw new StoreCapabilityError(ns, ['list']);
      return chain(legacy.list(), (names) => {
        const now = Date.now();
        return names
          .filter((name) => !prefix || name.startsWith(prefix))
          .map((name): ListedEntry => ({ path: name, meta: { createdAt: now, updatedAt: now } }));
      });
    },
    exists: (ns, path) => {
      if (!legacy.exists) throw new StoreCapabilityError(ns, ['exists']);
      return legacy.exists(path);
    },
    getPhysicalPath: (ns, path) => {
      if (!legacy.getPhysicalPath) throw new StoreCapabilityError(ns, ['getPhysicalPath']);
      return legacy.getPhysicalPath(path);
    },
    supports: (capability) => capabilities.has(capability),
  };
}
