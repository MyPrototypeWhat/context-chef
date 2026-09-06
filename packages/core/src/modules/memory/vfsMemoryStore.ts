import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileSystemBackend, type FileSystemNamespaceLayout } from '../../store/backends/fileSystem';
import { memoryEntryToStored, storedToMemoryEntry } from '../../store/legacy';
import { type NamespaceView, Store } from '../../store/store';
import { MEMORY_NAMESPACE, type StoredEntry } from '../../store/types';
import type { MemoryStore, MemoryStoreEntry } from './memoryStore';

const EXT = '.mem';
/** The key list 4.1 kept beside the entries and answered `keys()` from. */
const INDEX_FILE = '_index.json';

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
        const parsed = JSON.parse(raw) as MemoryStoreEntry;
        // A foreign `.mem` file parses as JSON but is not an entry; without
        // this check it becomes a StoredEntry with no content and takes the
        // whole listing down with it.
        if (typeof parsed?.value !== 'string') return null;
        return memoryEntryToStored(parsed);
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
  private readonly dir: string;
  private readonly indexPath: string;
  /** Lazily built from the directory, then kept in step with every mutation. */
  private keyIndex: Set<string> | null = null;

  constructor(storageDir = '.context_memory') {
    const backend = new FileSystemBackend(storageDir, {
      layouts: { [MEMORY_NAMESPACE]: memoryFileLayout(storageDir) },
    });
    this.ns = new Store(backend).namespace(MEMORY_NAMESPACE);
    this.dir = storageDir;
    this.indexPath = path.join(storageDir, INDEX_FILE);
  }

  get(key: string): MemoryStoreEntry | null {
    const entry = this.ns.getSync(key);
    return entry ? storedToMemoryEntry(entry) : null;
  }

  set(key: string, entry: MemoryStoreEntry): void {
    const stored = memoryEntryToStored(entry);
    this.ns.putSync(key, stored.content, stored.meta);
    this._writeIndex((index) => index.add(key));
  }

  delete(key: string): boolean {
    const deleted = this.ns.deleteSync(key);
    if (deleted) this._writeIndex((index) => index.delete(key));
    return deleted;
  }

  /**
   * The directory is the source of truth — a scan sees entries this process
   * never wrote. `_index.json` is only kept for a 4.1 process reading the same
   * directory, and is rebuilt here when it is missing.
   */
  keys(): string[] {
    const keys = this.ns.listSync().map((entry) => entry.path);
    if (fs.existsSync(this.dir) && !fs.existsSync(this.indexPath)) {
      this.keyIndex = new Set(keys);
      // Best-effort: a read must not start throwing because the directory
      // turned out to be read-only. Mutations report their failures.
      try {
        this._saveIndex();
      } catch {
        this.keyIndex = null;
      }
    }
    return keys;
  }

  snapshot(): Record<string, MemoryStoreEntry> {
    return mapRecord(this.ns.snapshot() ?? {}, storedToMemoryEntry);
  }

  restore(data: Record<string, MemoryStoreEntry>): void {
    this.ns.restore(mapRecord<MemoryStoreEntry, StoredEntry>(data, memoryEntryToStored));
    this.keyIndex = new Set(Object.keys(data));
    this._saveIndex();
  }

  private _writeIndex(mutate: (index: Set<string>) => void): void {
    this.keyIndex ??= new Set(this.ns.listSync().map((entry) => entry.path));
    mutate(this.keyIndex);
    this._saveIndex();
  }

  /** 4.1's format exactly: a JSON array of keys beside the `.mem` files. */
  private _saveIndex(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.indexPath, JSON.stringify([...(this.keyIndex ?? [])]), 'utf-8');
  }
}
