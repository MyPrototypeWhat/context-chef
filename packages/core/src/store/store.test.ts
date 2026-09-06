import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Memory } from '../modules/memory';
import { Offloader, type VFSStorageAdapter } from '../modules/offloader';
import { FileSystemBackend } from './backends/fileSystem';
import { InMemoryBackend } from './backends/inMemory';
import { Store } from './store';
import { type StorageBackend, StoreCapabilityError } from './types';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'context-chef-store-unit-'));

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

const tmpDir = () => fs.mkdtempSync(path.join(TMP_ROOT, 'd-'));

/** Unwraps a namespace-view answer that a synchronous backend must have given. */
function sync<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) throw new Error('expected a synchronous backend');
  return value;
}

describe('Store URIs', () => {
  it('addresses entries as context://<ns>/<path>', () => {
    expect(Store.uri('memory', 'user_name')).toBe('context://memory/user_name');
    expect(Store.uri('vfs', 'vfs_abc.txt')).toBe('context://vfs/vfs_abc.txt');
  });

  it('round-trips through parseUri', () => {
    for (const [ns, p] of [
      ['memory', 'user_name'],
      ['vfs', 'vfs_abc.txt'],
      ['notes', 'plans/2026-q1.md'],
    ]) {
      expect(Store.parseUri(Store.uri(ns, p))).toEqual({ ns, path: p });
    }
  });

  it('rejects anything that is not a namespaced context URI', () => {
    expect(Store.parseUri('https://example.com/a')).toBeNull();
    expect(Store.parseUri('context://')).toBeNull();
    expect(Store.parseUri('context://vfs/')).toBeNull();
    expect(Store.parseUri('context:///path')).toBeNull();
  });

  it('a namespace view honours a custom scheme in both directions', () => {
    const store = new Store(new InMemoryBackend(), { uriScheme: { vfs: 'file://cache/' } });
    const view = store.namespace('vfs');

    expect(view.uri('vfs_1.txt')).toBe('file://cache/vfs_1.txt');
    expect(view.parseUri('file://cache/vfs_1.txt')).toBe('vfs_1.txt');
    expect(view.parseUri('context://vfs/vfs_1.txt')).toBeNull();
  });
});

describe('Store namespaces', () => {
  it('keeps identical paths in different namespaces apart', () => {
    const store = new Store(new InMemoryBackend());
    const memory = store.namespace('memory');
    const vfs = store.namespace('vfs');

    memory.put('shared', 'memory value');
    vfs.put('shared', 'vfs value');

    expect(sync(memory.get('shared'))?.content).toBe('memory value');
    expect(sync(vfs.get('shared'))?.content).toBe('vfs value');
    expect(memory.index().map((e) => e.uri)).toEqual(['context://memory/shared']);
    expect(vfs.index().map((e) => e.uri)).toEqual(['context://vfs/shared']);
  });

  it('put(content) derives a content-addressed path inside the namespace', () => {
    const store = new Store(new InMemoryBackend());
    const vfs = store.namespace('vfs');
    const content = 'a big blob of tool output';
    const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);

    const first = sync(vfs.put(content));
    const second = sync(vfs.put(content));

    expect(first.path).toBe(`vfs_${hash}.txt`);
    expect(first.uri).toBe(`context://vfs/vfs_${hash}.txt`);
    expect(second.path).toBe(first.path);
    expect(store.namespace('archive').autoPath(content)).toBe(`archive_${hash}.txt`);
  });

  it('put(path, content) writes where it is told', () => {
    const store = new Store(new InMemoryBackend());
    const notes = store.namespace('notes');

    const result = sync(notes.put('plan.md', 'the plan', { description: 'a note' }));

    expect(result.path).toBe('plan.md');
    expect(sync(notes.get('plan.md'))?.meta.description).toBe('a note');
  });

  it('append falls back to read-modify-write on a backend without native append', () => {
    const backend: StorageBackend = new FileSystemBackend(tmpDir());
    expect(backend.append).toBeUndefined();
    const notes = new Store(backend).namespace('notes');

    notes.put('log', 'line 1');
    notes.append('log', '\nline 2');
    notes.append('log', '\nline 3');

    expect(sync(notes.get('log'))?.content).toBe('line 1\nline 2\nline 3');
  });

  it('append preserves createdAt across the rewrite', () => {
    const notes = new Store(new FileSystemBackend(tmpDir())).namespace('notes');
    notes.put('log', 'first', { createdAt: 5000 });
    notes.append('log', ' second');

    expect(sync(notes.get('log'))?.meta.createdAt).toBe(5000);
  });

  it('append creates the entry when it is missing', () => {
    const notes = new Store(new FileSystemBackend(tmpDir())).namespace('notes');
    notes.append('log', 'from nothing');
    expect(sync(notes.get('log'))?.content).toBe('from nothing');
  });

  // Regression: "NamespaceView.append silently drops `meta` when the backend
  // implements native append" — one public method, one meaning, whichever
  // backend is configured.
  describe('append applies meta on every backend', () => {
    const backends: [string, () => StorageBackend][] = [
      ['InMemoryBackend (native append)', () => new InMemoryBackend()],
      ['FileSystemBackend (read-modify-write)', () => new FileSystemBackend(tmpDir())],
    ];

    it.each(backends)('%s', (_name, make) => {
      const notes = new Store(make()).namespace('notes');
      notes.put('a.md', 'one', { description: 'x', createdAt: 5000 });
      notes.append('a.md', 'two', { description: 'y' });

      const entry = sync(notes.get('a.md'));
      expect(entry?.content).toBe('onetwo');
      expect(entry?.meta.description).toBe('y');
      expect(entry?.meta.createdAt).toBe(5000);
      expect(entry?.meta.bytes).toBe(6);
    });

    it.each(backends)('%s keeps metadata the caller did not mention', (_name, make) => {
      const notes = new Store(make()).namespace('notes');
      notes.put('a.md', 'one', { description: 'x' });
      notes.append('a.md', 'two');

      expect(sync(notes.get('a.md'))?.meta.description).toBe('x');
    });
  });

  it('search throws a capability error naming the namespace and the gap', () => {
    const notes = new Store(new InMemoryBackend()).namespace('notes');
    let caught: unknown;
    try {
      notes.search('anything');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StoreCapabilityError);
    if (!(caught instanceof StoreCapabilityError)) throw new Error('expected a capability error');
    expect(caught.ns).toBe('notes');
    expect(caught.missing).toEqual(['search']);
    expect(caught.message).toContain('search');
  });

  it('search works when the backend has it', () => {
    const inner = new InMemoryBackend();
    const backend: StorageBackend = {
      read: (ns, entryPath) => inner.read(ns, entryPath),
      write: (ns, entryPath, entry) => inner.write(ns, entryPath, entry),
      delete: (ns, entryPath) => inner.delete(ns, entryPath),
      list: (ns, prefix) => inner.list(ns, prefix),
      search: (ns, query) => [{ path: `${ns}/${query}`, meta: { createdAt: 0, updatedAt: 0 } }],
    };
    const notes = new Store(backend).namespace('notes');
    expect(notes.search('todo')).toEqual([
      { path: 'notes/todo', meta: { createdAt: 0, updatedAt: 0 } },
    ]);
  });
});

describe('Store eviction', () => {
  /** Minimal legacy adapter so the Offloader and the Store see identical content. */
  class MapAdapter implements VFSStorageAdapter {
    readonly db = new Map<string, string>();
    write(filename: string, content: string): void {
      this.db.set(filename, content);
    }
    read(filename: string): string | null {
      return this.db.get(filename) ?? null;
    }
    list(): string[] {
      return Array.from(this.db.keys());
    }
    delete(filename: string): void {
      this.db.delete(filename);
    }
  }

  it('evicts exactly what Offloader.cleanup() evicts for the same caps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const contents = ['A'.repeat(40), 'B'.repeat(40), 'C'.repeat(40)];

    const offloader = new Offloader({ adapter: new MapAdapter(), threshold: 10, maxFiles: 1 });
    const view = new Store(new InMemoryBackend(), {
      eviction: { vfs: { maxFiles: 1 } },
    }).namespace('vfs');

    const uris: string[] = [];
    for (const content of contents) {
      uris.push(offloader.offload(content, { tailChars: 0 }).uri ?? '');
      view.put(content);
      vi.advanceTimersByTime(10);
    }

    // Re-reading the oldest entry makes it the most recently used on both sides.
    offloader.resolve(uris[0]);
    view.get(view.autoPath(contents[0]));

    const fromOffloader = offloader.cleanup();
    const fromStore = view.cleanup();

    expect(fromStore.evicted.map((e) => e.path)).toEqual(
      fromOffloader.evicted.map((e) => e.filename),
    );
    expect(fromStore.evictedByCount).toBe(fromOffloader.evictedByCount);
    expect(fromStore.evictedBytes).toBe(fromOffloader.evictedBytes);
    expect(fromStore.evicted).toHaveLength(2);
  });

  it('maxAge sweeps by createdAt before the LRU pass runs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const view = new Store(new InMemoryBackend()).namespace('vfs');
    view.put('old.txt', 'old');
    vi.setSystemTime(10_000);
    view.put('new.txt', 'new');

    const result = view.cleanup({ maxAge: 5_000 });

    expect(result.evicted.map((e) => e.path)).toEqual(['old.txt']);
    expect(result.evictedByAge).toBe(1);
    expect(view.get('old.txt')).toBeNull();
  });

  it('per-namespace policy applies when the call passes no override', () => {
    const store = new Store(new InMemoryBackend(), {
      eviction: { vfs: { maxFiles: 0 }, memory: { maxFiles: 10 } },
    });
    store.namespace('vfs').put('a.txt', 'a');
    store.namespace('memory').put('k', 'v');

    expect(store.cleanup('vfs').evicted).toHaveLength(1);
    expect(store.cleanup('memory').evicted).toHaveLength(0);
  });

  it('reports eviction hook failures without aborting the sweep', () => {
    const view = new Store(new InMemoryBackend()).namespace('vfs');
    view.put('a.txt', 'a');
    view.put('b.txt', 'b');
    const errors: unknown[] = [];

    const result = view.cleanup({
      maxFiles: 0,
      onEvicted: () => {
        throw new Error('hook exploded');
      },
      onEvictedError: (error) => errors.push(error),
    });

    expect(result.evicted).toHaveLength(2);
    expect(errors).toHaveLength(2);
    expect(view.index()).toHaveLength(0);
  });

  it('cleanup throws a capability error when the backend cannot list or delete', () => {
    const backend: StorageBackend = {
      read: () => null,
      write: () => {},
      delete: () => false,
      list: () => [],
      supports: (capability) => capability === 'read' || capability === 'write',
    };
    const store = new Store(backend);

    expect(store.missingEvictionCapabilities('vfs')).toEqual(['list', 'delete']);
    expect(() => store.cleanup('vfs')).toThrow(StoreCapabilityError);
  });

  it('coalesces overlapping cleanupAsync() calls per namespace', async () => {
    const deletes: string[] = [];
    const backend: StorageBackend = {
      read: async () => null,
      write: async () => {},
      list: async () => [],
      delete: async (_ns, entryPath) => {
        deletes.push(entryPath);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return true;
      },
    };
    const store = new Store(backend);
    await store.namespace('vfs').put('a.txt', 'a');

    const first = store.cleanupAsync('vfs', { maxFiles: 0 });
    const second = store.cleanupAsync('vfs', { maxFiles: 0 });
    expect(first).toBe(second);

    await Promise.all([first, second]);
    expect(deletes).toEqual(['a.txt']);
  });
});

describe('one backend, every namespace', () => {
  it('serves Memory and the Offloader at once with no cross-namespace leakage', async () => {
    const backend = new InMemoryBackend();
    const store = new Store(backend);

    const memory = new Memory({ store });
    const offloader = new Offloader({ store, threshold: 10 });

    await memory.set('user_name', 'Ada', { description: 'who I am talking to' });
    const offloaded = offloader.offload('x'.repeat(500), { tailChars: 0 });

    // Both namespaces are live on the same backend…
    expect(backend.list('memory').map((e) => e.path)).toEqual(['user_name']);
    expect(backend.list('vfs').map((e) => e.path)).toEqual([offloaded.uri?.split('/').pop()]);

    // …and neither sees the other's entries.
    expect(await memory.getAll()).toHaveLength(1);
    expect(offloader.getEntries()).toHaveLength(1);
    expect(await memory.get(offloaded.uri?.split('/').pop() ?? '')).toBeNull();
    expect(offloader.resolve('context://vfs/user_name')).toBeNull();

    // Round-trips still work through their own module.
    expect(await memory.get('user_name')).toBe('Ada');
    expect(offloader.resolve(offloaded.uri ?? '')).toBe('x'.repeat(500));

    // Evicting the vfs namespace leaves memory alone.
    offloader.cleanup({ maxFiles: 0 });
    expect(backend.list('vfs')).toHaveLength(0);
    expect(await memory.get('user_name')).toBe('Ada');
  });

  it('memory entries survive a full round-trip through a shared file backend', async () => {
    const dir = tmpDir();
    const memory = new Memory({ store: new Store(new FileSystemBackend(dir)) });

    await memory.set('project', 'context-chef', { description: 'the repo', importance: 3 });
    const entry = await memory.getEntry('project');

    expect(entry).toMatchObject({
      key: 'project',
      value: 'context-chef',
      description: 'the repo',
      importance: 3,
      updateCount: 1,
    });

    // A second Memory over the same directory sees the same entry.
    const reopened = new Memory({ store: new Store(new FileSystemBackend(dir)) });
    expect(await reopened.get('project')).toBe('context-chef');
    expect((await reopened.getEntry('project'))?.description).toBe('the repo');
  });

  it('one file backend serves memory and vfs with the right file shape for each', async () => {
    const dir = tmpDir();
    const backend = new FileSystemBackend(dir);
    const store = new Store(backend);
    const memory = new Memory({ store });
    const offloader = new Offloader({ store, threshold: 10 });

    await memory.set('project', 'context-chef', { description: 'the repo' });
    const result = offloader.offload('y'.repeat(400), { tailChars: 0 });
    const filename = result.uri?.split('/').pop() ?? '';

    // The truncation marker points the model at a file it can read as plain text.
    const physical = backend.getPhysicalPath('vfs', filename);
    expect(result.content).toContain(physical);
    expect(fs.readFileSync(physical, 'utf8')).toBe('y'.repeat(400));

    // Memory keeps its metadata through the same backend.
    expect((await memory.getEntry('project'))?.description).toBe('the repo');
    expect(offloader.resolve(result.uri ?? '')).toBe('y'.repeat(400));
  });
});
