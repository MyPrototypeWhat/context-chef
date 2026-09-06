import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ARCHIVE_NAMESPACE,
  type ListedEntry,
  type StorageBackend,
  type StoredEntry,
  type StoredEntryMeta,
  VFS_NAMESPACE,
} from '../types';

export interface FileStat {
  bytes: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * How one namespace maps onto the filesystem.
 *
 * - `'json'` writes `{ content, meta }`, so custom metadata survives a
 *   round-trip. The default for every namespace that carries meta — memory
 *   entries, notes.
 * - `'raw'` writes the content and nothing else, and reconstructs timestamps
 *   from the file's own stat. The default for `vfs` and `archive`, whose files
 *   are opaque blobs the model is pointed at by physical path and must be able
 *   to read as plain text.
 */
export type FileSystemFormat = 'raw' | 'json';

export interface FileSystemNamespaceLayout {
  /** Directory for this namespace. Default: `<root>/<ns>`. */
  dir?: string;
  /**
   * File body format. Defaults to `'raw'` for `vfs` and `archive`, `'json'`
   * everywhere else. Ignored when `serialize`/`deserialize` are given.
   */
  format?: FileSystemFormat;
  /** Logical path → filename. Default: identity. */
  encode?: (path: string) => string;
  /** Filename → logical path. Return null for files this namespace does not own. */
  decode?: (file: string) => string | null;
  /** Entry → file body. Overrides `format`. */
  serialize?: (entry: StoredEntry) => string;
  /** File body → entry. Return null for unreadable content. Overrides `format`. */
  deserialize?: (raw: string, stat: FileStat) => StoredEntry | null;
}

export interface FileSystemBackendOptions {
  layouts?: Record<string, FileSystemNamespaceLayout>;
}

/** Files starting with a dot are the backend's own scratch (`.tmp_…`), never entries. */
function defaultDecode(file: string): string | null {
  return file.startsWith('.') ? null : file;
}

/**
 * Namespaces and entry paths reach this backend from model output (the
 * `context` tool addresses storage keys directly), so a key must never be able
 * to name a file outside its namespace directory. These throw rather than
 * returning null: a caller that got here with a traversing path has a bug or an
 * injection, and both deserve a stack trace, not a soft failure.
 */
function assertSafeNamespace(ns: string): void {
  if (ns === '' || ns === '.' || ns === '..' || ns.includes('/') || ns.includes('\\')) {
    throw new Error(
      `FileSystemBackend: '${ns}' is not a usable namespace — a namespace is one path segment, ` +
        'and cannot be empty, "." or ".." or contain a path separator.',
    );
  }
}

/**
 * Resolves `file` under `dir` and proves the result stayed there. `path.join`
 * alone does not: it collapses `..` segments, and on Windows it collapses
 * backslash-separated ones too, so `notes/..\..\evil.txt` lands outside the
 * root while looking like a single filename to any `/`-based guard.
 */
function confine(dir: string, file: string): string {
  if (file.includes('\\')) {
    throw new Error(
      `FileSystemBackend: '${file}' is not a usable path — a backslash is a path separator ` +
        'on some platforms, so it is never allowed in a storage key.',
    );
  }
  const root = path.resolve(dir);
  const resolved = path.resolve(root, file);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `FileSystemBackend: '${file}' resolves to ${resolved}, outside the namespace directory ${root}.`,
    );
  }
  // Joined, not resolved: a backend rooted at a relative path keeps handing out
  // relative physical paths, exactly as it did before the check existed.
  return path.join(dir, file);
}

function rawSerialize(entry: StoredEntry): string {
  return entry.content;
}

function rawDeserialize(raw: string, stat: FileStat): StoredEntry {
  return {
    content: raw,
    meta: { createdAt: stat.createdAt, updatedAt: stat.updatedAt, bytes: stat.bytes },
  };
}

function jsonSerialize(entry: StoredEntry): string {
  return JSON.stringify(entry);
}

function jsonDeserialize(raw: string, stat: FileStat): StoredEntry | null {
  try {
    const parsed = JSON.parse(raw) as StoredEntry;
    if (typeof parsed?.content !== 'string') return null;
    // Timestamps written into the envelope win; the file's own stat only fills
    // in for an envelope that never carried them.
    const meta: StoredEntryMeta = {
      ...parsed.meta,
      createdAt: parsed.meta?.createdAt ?? stat.createdAt,
      updatedAt: parsed.meta?.updatedAt ?? stat.updatedAt,
    };
    return { content: parsed.content, meta };
  } catch {
    return null;
  }
}

/**
 * Filesystem-backed storage. Writes are atomic (tmp file + rename), so an
 * `exists()` hit always means fully persisted bytes.
 */
export class FileSystemBackend implements StorageBackend {
  private readonly root: string;
  private readonly layouts: Record<string, FileSystemNamespaceLayout>;

  constructor(root: string, options: FileSystemBackendOptions = {}) {
    this.root = root;
    this.layouts = options.layouts ?? {};
  }

  read(ns: string, entryPath: string): StoredEntry | null {
    const filepath = this.getPhysicalPath(ns, entryPath);
    if (!fs.existsSync(filepath)) return null;
    let raw: string;
    let stat: fs.Stats;
    try {
      raw = fs.readFileSync(filepath, 'utf8');
      stat = fs.statSync(filepath);
    } catch {
      return null;
    }
    // `?? rawDeserialize` on the RESULT would resurrect corrupt content as raw
    // text; the fallback belongs to the missing hook, not to a null return.
    return this._deserializer(ns)(raw, toFileStat(stat));
  }

  write(ns: string, entryPath: string, entry: StoredEntry): void {
    const layout = this._layout(ns);
    const filepath = this.getPhysicalPath(ns, entryPath);
    const dir = path.dirname(filepath);
    const tmppath = path.join(dir, `.tmp_${process.pid}_${path.basename(filepath)}`);
    const serialize =
      layout.serialize ?? (this._format(ns) === 'raw' ? rawSerialize : jsonSerialize);
    const body = serialize(entry);
    try {
      fs.writeFileSync(tmppath, body, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // The storage dir can vanish mid-process — OS temp cleaners purge
      // /var/folders & friends on long-running hosts. Recreate and retry once.
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmppath, body, 'utf8');
    }
    fs.renameSync(tmppath, filepath); // atomic on the same filesystem
  }

  delete(ns: string, entryPath: string): boolean {
    const filepath = this.getPhysicalPath(ns, entryPath);
    if (!fs.existsSync(filepath)) return false;
    fs.unlinkSync(filepath);
    return true;
  }

  exists(ns: string, entryPath: string): boolean {
    return fs.existsSync(this.getPhysicalPath(ns, entryPath));
  }

  /**
   * Walks the namespace directory depth-first. The walk is recursive because
   * `write()` creates the directories a `/`-bearing key implies — a flat
   * `readdir` would write `notes/todo` and then never list it again.
   *
   * `decode` sees the file's `/`-joined path relative to the namespace
   * directory, which is exactly what `encode` produces, so a layout that owns
   * files by name prefix (`vfs_…`) still rejects everything it does not own.
   */
  list(ns: string, prefix?: string): ListedEntry[] {
    const dir = this._dir(ns);
    if (!fs.existsSync(dir)) return [];
    const layout = this._layout(ns);
    const out: ListedEntry[] = [];
    this._walk(ns, dir, '', {
      decode: layout.decode ?? defaultDecode,
      // A raw namespace keeps everything the metadata needs in the file's own
      // stat; any other format has to be parsed to answer honestly.
      statOnly: !layout.deserialize && this._format(ns) === 'raw',
      prefix,
      out,
    });
    return out;
  }

  private _walk(ns: string, dir: string, relative: string, ctx: WalkContext): void {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // raced with a delete
    }
    for (const name of names) {
      // The backend's own scratch (`.tmp_…`) and anything else hidden.
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue; // raced with a delete
      }
      if (stat.isDirectory()) {
        // A symlinked directory can point at an ancestor; walking it would not
        // terminate. Symlinked FILES still list, as they always have.
        if (fs.lstatSync(full).isSymbolicLink()) continue;
        this._walk(ns, full, `${relative}${name}/`, ctx);
        continue;
      }
      if (!stat.isFile()) continue;
      const entryPath = ctx.decode(`${relative}${name}`);
      if (entryPath == null) continue;
      if (ctx.prefix && !entryPath.startsWith(ctx.prefix)) continue;
      if (ctx.statOnly) {
        const { bytes, createdAt, updatedAt } = toFileStat(stat);
        ctx.out.push({ path: entryPath, meta: { createdAt, updatedAt, bytes } });
        continue;
      }
      const entry = this.read(ns, entryPath);
      if (!entry) continue;
      ctx.out.push({
        path: entryPath,
        meta: {
          ...entry.meta,
          bytes: entry.meta.bytes ?? Buffer.byteLength(entry.content, 'utf8'),
        },
      });
    }
  }

  readAll(ns: string, prefix?: string): Map<string, StoredEntry> {
    const out = new Map<string, StoredEntry>();
    for (const listed of this.list(ns, prefix)) {
      const entry = this.read(ns, listed.path);
      if (entry) out.set(listed.path, entry);
    }
    return out;
  }

  snapshot(ns: string): Record<string, StoredEntry> {
    return Object.fromEntries(this.readAll(ns));
  }

  restore(ns: string, data: Record<string, StoredEntry>): void {
    for (const listed of this.list(ns)) this.delete(ns, listed.path);
    for (const [entryPath, entry] of Object.entries(data)) this.write(ns, entryPath, entry);
  }

  getPhysicalPath(ns: string, entryPath: string): string {
    const layout = this._layout(ns);
    const file = layout.encode ? layout.encode(entryPath) : entryPath;
    return confine(this._dir(ns), file);
  }

  /** Creates the namespace directory if it does not exist yet. */
  ensureDir(ns: string): string {
    const dir = this._dir(ns);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private _layout(ns: string): FileSystemNamespaceLayout {
    return this.layouts[ns] ?? {};
  }

  private _deserializer(ns: string): (raw: string, stat: FileStat) => StoredEntry | null {
    const layout = this._layout(ns);
    if (layout.deserialize) return layout.deserialize;
    return this._format(ns) === 'raw' ? rawDeserialize : jsonDeserialize;
  }

  /**
   * `vfs` and `archive` hold opaque blobs the model is handed by physical path,
   * so their files must stay plain text; everything else needs its metadata back.
   */
  private _format(ns: string): FileSystemFormat {
    const configured = this._layout(ns).format;
    if (configured) return configured;
    return ns === VFS_NAMESPACE || ns === ARCHIVE_NAMESPACE ? 'raw' : 'json';
  }

  private _dir(ns: string): string {
    const configured = this._layout(ns).dir;
    if (configured !== undefined) return configured;
    assertSafeNamespace(ns);
    return path.join(this.root, ns);
  }
}

interface WalkContext {
  decode: (file: string) => string | null;
  statOnly: boolean;
  prefix?: string;
  out: ListedEntry[];
}

function toFileStat(stat: fs.Stats): FileStat {
  return {
    bytes: stat.size,
    createdAt: Math.round(stat.birthtimeMs || stat.ctimeMs),
    updatedAt: Math.round(stat.mtimeMs),
  };
}
