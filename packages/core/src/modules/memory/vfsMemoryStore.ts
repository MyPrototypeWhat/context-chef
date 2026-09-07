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

/** The layout below always names both codecs; `_saveIndex` reuses them. */
type MemoryFileLayout = FileSystemNamespaceLayout & {
  encode: (key: string) => string;
  decode: (file: string) => string | null;
};

/**
 * The on-disk shape this store has always used: one base64url-named `.mem`
 * file per key, holding the JSON-serialized entry. Kept byte-for-byte so
 * existing storage directories keep loading.
 */
function memoryFileLayout(dir: string): MemoryFileLayout {
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
  /** The same layout the backend reads with, so there is one naming rule. */
  private readonly layout: MemoryFileLayout;

  constructor(storageDir = '.context_memory') {
    this.layout = memoryFileLayout(storageDir);
    const backend = new FileSystemBackend(storageDir, {
      layouts: { [MEMORY_NAMESPACE]: this.layout },
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
    this._saveIndex();
  }

  delete(key: string): boolean {
    const deleted = this.ns.deleteSync(key);
    if (deleted) this._saveIndex();
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
      try {
        this._saveIndex();
      } catch {
        // Best-effort: a read must not start throwing because the directory
        // turned out to be read-only. Mutations report their failures.
      }
    }
    return keys;
  }

  snapshot(): Record<string, MemoryStoreEntry> {
    return mapRecord(this.ns.snapshot() ?? {}, storedToMemoryEntry);
  }

  restore(data: Record<string, MemoryStoreEntry>): void {
    this.ns.restore(mapRecord<MemoryStoreEntry, StoredEntry>(data, memoryEntryToStored));
    this._saveIndex();
  }

  /**
   * 4.1's format exactly: a JSON array of keys beside the `.mem` files.
   *
   * Recomputed from the directory on every write rather than tracked in
   * memory, because a second process sharing the directory is the whole reason
   * the file exists — a key list this process maintained would not know about
   * that process's entries and would drop them from the index. `readdirSync`
   * and not `ns.listSync()`: the memory layout deserializes, so a listing
   * reads and parses every `.mem` file, turning each write into O(n) reads.
   *
   * `decode` only strips the extension, so a name this store never wrote
   * (`not-ours.mem`, a `.tmp_…` scratch file a crashed write left behind)
   * base64url-decodes to mojibake rather than being rejected. Requiring the
   * key to encode back to the same filename drops those without reading them,
   * which keeps the index agreeing with `keys()`.
   */
  private _saveIndex(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const keys: string[] = [];
    for (const file of fs.readdirSync(this.dir)) {
      const key = this.layout.decode(file);
      if (key !== null && this.layout.encode(key) === file) keys.push(key);
    }
    fs.writeFileSync(this.indexPath, JSON.stringify(keys), 'utf-8');
  }
}
