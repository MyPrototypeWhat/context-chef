import type { ListedEntry, StorageBackend, StoredEntry } from '../types';

/**
 * Process-lifetime backend. The default for every namespace when no other
 * storage is configured; also the backend the tests use to prove one instance
 * can serve `memory`, `vfs` and `archive` at once without leakage.
 */
export class InMemoryBackend implements StorageBackend {
  private readonly namespaces = new Map<string, Map<string, StoredEntry>>();

  read(ns: string, path: string): StoredEntry | null {
    return this.namespaces.get(ns)?.get(path) ?? null;
  }

  write(ns: string, path: string, entry: StoredEntry): void {
    this._bucket(ns).set(path, entry);
  }

  delete(ns: string, path: string): boolean {
    return this.namespaces.get(ns)?.delete(path) ?? false;
  }

  exists(ns: string, path: string): boolean {
    return this.namespaces.get(ns)?.has(path) ?? false;
  }

  append(ns: string, path: string, content: string): void {
    const bucket = this._bucket(ns);
    const existing = bucket.get(path);
    const now = Date.now();
    const appended = (existing?.content ?? '') + content;
    bucket.set(path, {
      content: appended,
      meta: {
        ...existing?.meta,
        createdAt: existing?.meta.createdAt ?? now,
        updatedAt: now,
        bytes: Buffer.byteLength(appended, 'utf8'),
      },
    });
  }

  list(ns: string, prefix?: string): ListedEntry[] {
    const bucket = this.namespaces.get(ns);
    if (!bucket) return [];
    const out: ListedEntry[] = [];
    for (const [path, entry] of bucket) {
      if (prefix && !path.startsWith(prefix)) continue;
      out.push({
        path,
        meta: {
          ...entry.meta,
          bytes: entry.meta.bytes ?? Buffer.byteLength(entry.content, 'utf8'),
        },
      });
    }
    return out;
  }

  readAll(ns: string, prefix?: string): Map<string, StoredEntry> {
    const out = new Map<string, StoredEntry>();
    const bucket = this.namespaces.get(ns);
    if (!bucket) return out;
    for (const [path, entry] of bucket) {
      if (prefix && !path.startsWith(prefix)) continue;
      out.set(path, entry);
    }
    return out;
  }

  snapshot(ns: string): Record<string, StoredEntry> {
    const bucket = this.namespaces.get(ns);
    return bucket ? structuredClone(Object.fromEntries(bucket)) : {};
  }

  restore(ns: string, data: Record<string, StoredEntry>): void {
    const bucket = this._bucket(ns);
    bucket.clear();
    for (const [path, entry] of Object.entries(structuredClone(data))) {
      bucket.set(path, entry);
    }
  }

  private _bucket(ns: string): Map<string, StoredEntry> {
    let bucket = this.namespaces.get(ns);
    if (!bucket) {
      bucket = new Map();
      this.namespaces.set(ns, bucket);
    }
    return bucket;
  }
}
