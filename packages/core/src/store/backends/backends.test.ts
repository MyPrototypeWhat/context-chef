import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StorageBackend } from '../types';
import { FileSystemBackend } from './fileSystem';
import { InMemoryBackend } from './inMemory';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'context-chef-store-'));

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const factories: [string, () => StorageBackend][] = [
  ['InMemoryBackend', () => new InMemoryBackend()],
  ['FileSystemBackend', () => new FileSystemBackend(fs.mkdtempSync(path.join(TMP_ROOT, 'fs-')))],
];

const entry = (content: string, meta: Record<string, unknown> = {}) => ({
  content,
  meta: { createdAt: 1000, updatedAt: 2000, ...meta },
});

describe.each(factories)('StorageBackend contract — %s', (_name, make) => {
  it('round-trips content and custom metadata', async () => {
    const backend = make();
    await backend.write('notes', 'a.md', entry('hello', { description: 'greeting', tags: ['x'] }));

    const read = await backend.read('notes', 'a.md');
    expect(read?.content).toBe('hello');
    expect(read?.meta.description).toBe('greeting');
    expect(read?.meta.tags).toEqual(['x']);
    expect(read?.meta.createdAt).toBe(1000);
    expect(read?.meta.updatedAt).toBe(2000);
  });

  it('returns null for a path that was never written', async () => {
    const backend = make();
    expect(await backend.read('notes', 'missing.md')).toBeNull();
  });

  it('delete reports whether anything was removed', async () => {
    const backend = make();
    await backend.write('notes', 'a.md', entry('hello'));

    expect(await backend.delete('notes', 'a.md')).toBe(true);
    expect(await backend.delete('notes', 'a.md')).toBe(false);
    expect(await backend.read('notes', 'a.md')).toBeNull();
  });

  it('list reports every path with UTF-8 byte counts', async () => {
    const backend = make();
    await backend.write('notes', 'a.md', entry('你好')); // 2 chars, 6 bytes
    await backend.write('notes', 'b.md', entry('hi'));

    const listed = await backend.list('notes');
    expect(listed.map((e) => e.path).sort()).toEqual(['a.md', 'b.md']);
    expect(listed.find((e) => e.path === 'a.md')?.meta.bytes).toBe(6);
    expect(listed.find((e) => e.path === 'b.md')?.meta.bytes).toBe(2);
  });

  it('list filters by prefix', async () => {
    const backend = make();
    await backend.write('notes', 'draft_1', entry('a'));
    await backend.write('notes', 'draft_2', entry('b'));
    await backend.write('notes', 'final_1', entry('c'));

    const listed = await backend.list('notes', 'draft_');
    expect(listed.map((e) => e.path).sort()).toEqual(['draft_1', 'draft_2']);
  });

  it('keeps namespaces apart, including identical paths', async () => {
    const backend = make();
    await backend.write('memory', 'shared', entry('from memory'));
    await backend.write('vfs', 'shared', entry('from vfs'));

    expect((await backend.read('memory', 'shared'))?.content).toBe('from memory');
    expect((await backend.read('vfs', 'shared'))?.content).toBe('from vfs');
    expect((await backend.list('memory')).map((e) => e.path)).toEqual(['shared']);

    await backend.delete('memory', 'shared');
    expect(await backend.read('memory', 'shared')).toBeNull();
    expect((await backend.read('vfs', 'shared'))?.content).toBe('from vfs');
  });

  it('snapshot/restore replaces exactly one namespace', async () => {
    const backend = make();
    await backend.write('memory', 'keep', entry('kept'));
    await backend.write('vfs', 'untouched', entry('still here'));

    const snap = backend.snapshot?.('memory');
    expect(Object.keys(snap ?? {})).toEqual(['keep']);

    await backend.write('memory', 'transient', entry('gone after restore'));
    backend.restore?.('memory', snap ?? {});

    expect(await backend.read('memory', 'transient')).toBeNull();
    expect((await backend.read('memory', 'keep'))?.content).toBe('kept');
    expect((await backend.read('vfs', 'untouched'))?.content).toBe('still here');
  });

  it('reports its own capabilities; neither backend can search', () => {
    const backend = make();
    const supports = (cap: Parameters<NonNullable<StorageBackend['supports']>>[0]) =>
      backend.supports ? backend.supports(cap) : typeof backend[cap] === 'function';

    expect(supports('read')).toBe(true);
    expect(supports('list')).toBe(true);
    expect(supports('search')).toBe(false);
  });
});

describe('FileSystemBackend', () => {
  const makeDir = () => fs.mkdtempSync(path.join(TMP_ROOT, 'layout-'));

  it('defaults vfs and archive to raw files and everything else to json', () => {
    const dir = makeDir();
    const backend = new FileSystemBackend(dir);
    backend.write('vfs', 'vfs_abc.txt', entry('offloaded output'));
    backend.write('archive', 'archive_abc.txt', entry('a compressed span'));
    backend.write('memory', 'user_name', entry('Ada', { description: 'who I am talking to' }));

    // The model is handed vfs/archive files by physical path — they must be readable as-is.
    expect(fs.readFileSync(backend.getPhysicalPath('vfs', 'vfs_abc.txt'), 'utf8')).toBe(
      'offloaded output',
    );
    expect(fs.readFileSync(backend.getPhysicalPath('archive', 'archive_abc.txt'), 'utf8')).toBe(
      'a compressed span',
    );
    // Memory entries carry metadata, so theirs is an envelope.
    expect(backend.read('memory', 'user_name')?.meta.description).toBe('who I am talking to');
    expect(backend.read('memory', 'user_name')?.meta.createdAt).toBe(1000);
  });

  it("a 'raw' namespace stores the content verbatim at its physical path", () => {
    const dir = makeDir();
    const backend = new FileSystemBackend(dir, { layouts: { vfs: { format: 'raw', dir } } });
    backend.write('vfs', 'vfs_abc.txt', entry('plain text'));

    expect(fs.readFileSync(path.join(dir, 'vfs_abc.txt'), 'utf8')).toBe('plain text');
    expect(backend.getPhysicalPath('vfs', 'vfs_abc.txt')).toBe(path.join(dir, 'vfs_abc.txt'));
  });

  it("a 'raw' namespace dates entries from the file's own stat", () => {
    const dir = makeDir();
    const backend = new FileSystemBackend(dir, { layouts: { vfs: { format: 'raw', dir } } });
    const before = Date.now();
    backend.write('vfs', 'vfs_abc.txt', entry('plain text', { createdAt: 1, updatedAt: 2 }));

    const read = backend.read('vfs', 'vfs_abc.txt');
    expect(read?.content).toBe('plain text');
    expect(read?.meta.updatedAt as number).toBeGreaterThanOrEqual(before - 1000);
  });

  it('ignores files another namespace owns and its own tmp scratch', () => {
    const dir = makeDir();
    const backend = new FileSystemBackend(dir, {
      layouts: {
        vfs: { format: 'raw', dir, decode: (f) => (f.startsWith('vfs_') ? f : null) },
        archive: { format: 'raw', dir, decode: (f) => (f.startsWith('archive_') ? f : null) },
      },
    });
    backend.write('vfs', 'vfs_1.txt', entry('a'));
    backend.write('archive', 'archive_1.txt', entry('b'));
    fs.writeFileSync(path.join(dir, '.tmp_999_leftover'), 'junk');

    expect(backend.list('vfs').map((e) => e.path)).toEqual(['vfs_1.txt']);
    expect(backend.list('archive').map((e) => e.path)).toEqual(['archive_1.txt']);
  });

  it('recreates a namespace directory removed underneath it', () => {
    const dir = makeDir();
    const backend = new FileSystemBackend(dir);
    backend.write('notes', 'a.md', entry('first'));
    fs.rmSync(path.join(dir, 'notes'), { recursive: true, force: true });

    backend.write('notes', 'a.md', entry('second'));
    expect(backend.read('notes', 'a.md')?.content).toBe('second');
  });

  it('reads back null for a corrupt file instead of surfacing garbage', () => {
    const dir = makeDir();
    const backend = new FileSystemBackend(dir);
    backend.write('notes', 'a.md', entry('valid'));
    fs.writeFileSync(backend.getPhysicalPath('notes', 'a.md'), 'not json', 'utf8');

    expect(backend.read('notes', 'a.md')).toBeNull();
  });

  it('writes atomically — list never sees a partial file', () => {
    const dir = makeDir();
    const backend = new FileSystemBackend(dir);
    backend.write('notes', 'a.md', entry('x'.repeat(5000)));

    expect(fs.readdirSync(path.join(dir, 'notes')).filter((f) => f.startsWith('.tmp_'))).toEqual(
      [],
    );
    expect(backend.list('notes').map((e) => e.path)).toEqual(['a.md']);
  });
});

describe('InMemoryBackend', () => {
  it('appends natively without a read-modify-write', () => {
    const backend = new InMemoryBackend();
    backend.write('notes', 'log', entry('one'));
    backend.append('notes', 'log', '\ntwo');

    expect(backend.read('notes', 'log')?.content).toBe('one\ntwo');
    expect(backend.read('notes', 'log')?.meta.createdAt).toBe(1000);
  });

  it('append creates the entry when it does not exist yet', () => {
    const backend = new InMemoryBackend();
    backend.append('notes', 'log', 'first line');
    expect(backend.read('notes', 'log')?.content).toBe('first line');
  });

  it('snapshot is a deep copy — later writes do not mutate it', () => {
    const backend = new InMemoryBackend();
    backend.write('memory', 'k', entry('v'));
    const snap = backend.snapshot('memory');

    backend.write('memory', 'k', entry('changed'));
    expect(snap.k.content).toBe('v');
  });
});
