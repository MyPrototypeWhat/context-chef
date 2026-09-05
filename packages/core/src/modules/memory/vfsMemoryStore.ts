import { FileSystemBackend, type FileSystemNamespaceLayout } from '../../store/backends/fileSystem';
import { memoryEntryToStored, storedToMemoryEntry } from '../../store/legacy';
import { type NamespaceView, Store } from '../../store/store';
import { MEMORY_NAMESPACE, type StoredEntry } from '../../store/types';
import type { MemoryStore, MemoryStoreEntry } from './memoryStore';

const EXT = '.mem';

/**
 * The on-disk shape this store has always used: one base64url-named `.mem`
 * file per key, holding the JSON-serialized entry. Kept byte-for-byte so
 * existing storage directories keep loading.
 */
function memoryFileLayout(dir: string): FileSystemNamespaceLayout {
  return {
    dir,
    encode: (key) => `${Buffer.from(key).toString('base64url')}${EXT}`,
    decode: (file) =>
      file.endsWith(EXT)
        ? Buffer.from(file.slice(0, -EXT.length), 'base64url').toString('utf8')
        : null,
    serialize: (entry) => JSON.stringify(storedToMemoryEntry(entry)),
    deserialize: (raw) => {
      try {
        return memoryEntryToStored(JSON.parse(raw) as MemoryStoreEntry);
      } catch {
        return null;
      }
    },
  };
}

function mapRecord<A, B>(data: Record<string, A>, fn: (value: A) => B): Record<string, B> {
  const out: Record<string, B> = {};
  for (const [key, value] of Object.entries(data)) out[key] = fn(value);
  return out;
}

/**
 * File-backed memory store.
 *
 * @deprecated This is the `memory` namespace of a {@link FileSystemBackend}.
 *   Prefer `new Store(new FileSystemBackend(dir))` and pass it as
 *   `memory.store` (and, if you like, `vfs.store`) so one backend serves every
 *   namespace. The class stays for existing callers and reads the same files.
 */
export class VFSMemoryStore implements MemoryStore {
  private readonly ns: NamespaceView;

  constructor(storageDir = '.context_memory') {
    const backend = new FileSystemBackend(storageDir, {
      layouts: { [MEMORY_NAMESPACE]: memoryFileLayout(storageDir) },
    });
    this.ns = new Store(backend).namespace(MEMORY_NAMESPACE);
  }

  get(key: string): MemoryStoreEntry | null {
    const entry = this.ns.getSync(key);
    return entry ? storedToMemoryEntry(entry) : null;
  }

  set(key: string, entry: MemoryStoreEntry): void {
    const stored = memoryEntryToStored(entry);
    this.ns.putSync(key, stored.content, stored.meta);
  }

  delete(key: string): boolean {
    return this.ns.deleteSync(key);
  }

  keys(): string[] {
    return this.ns.listSync().map((entry) => entry.path);
  }

  snapshot(): Record<string, MemoryStoreEntry> {
    return mapRecord(this.ns.snapshot() ?? {}, storedToMemoryEntry);
  }

  restore(data: Record<string, MemoryStoreEntry>): void {
    this.ns.restore(mapRecord<MemoryStoreEntry, StoredEntry>(data, memoryEntryToStored));
  }
}
