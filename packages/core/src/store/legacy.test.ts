import { describe, expect, it, vi } from 'vitest';
import { Memory, type MemoryEntry } from '../modules/memory';
import type { MemoryStore, MemoryStoreEntry } from '../modules/memory/memoryStore';
import {
  Offloader,
  VFSCleanupNotSupportedError,
  type VFSStorageAdapter,
} from '../modules/offloader';
import { fromMemoryStore, fromVfsAdapter } from './legacy';
import { Store } from './store';
import { StoreCapabilityError, type StoredEntry } from './types';

/** A hand-written MemoryStore of the kind users have in the wild. */
class HandWrittenMemoryStore implements MemoryStore {
  readonly db = new Map<string, MemoryStoreEntry>();
  keysCalls = 0;

  get(key: string): MemoryStoreEntry | null {
    return this.db.get(key) ?? null;
  }
  set(key: string, entry: MemoryStoreEntry): void {
    this.db.set(key, entry);
  }
  delete(key: string): boolean {
    return this.db.delete(key);
  }
  keys(): string[] {
    this.keysCalls++;
    return Array.from(this.db.keys());
  }
}

/** The same, but async and without snapshot/restore. */
class AsyncMemoryStore implements MemoryStore {
  private readonly db = new Map<string, MemoryStoreEntry>();

  async get(key: string): Promise<MemoryStoreEntry | null> {
    return this.db.get(key) ?? null;
  }
  async set(key: string, entry: MemoryStoreEntry): Promise<void> {
    this.db.set(key, entry);
  }
  async delete(key: string): Promise<boolean> {
    return this.db.delete(key);
  }
  async keys(): Promise<string[]> {
    return Array.from(this.db.keys());
  }
}

class HandWrittenVfsAdapter implements VFSStorageAdapter {
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

describe('Store.fromMemoryStore', () => {
  it('maps MemoryStoreEntry onto StoredEntry field for field', () => {
    const legacy = new HandWrittenMemoryStore();
    const backend = fromMemoryStore(legacy);
    const entry: MemoryStoreEntry = {
      value: 'Ada',
      description: 'who I am talking to',
      createdAt: 1,
      updatedAt: 2,
      updateCount: 3,
      importance: 4,
      expiresAt: 5,
      expiresAtTurn: 6,
    };
    legacy.set('user', entry);

    const stored = backend.read('memory', 'user') as StoredEntry;
    expect(stored.content).toBe('Ada');
    expect(stored.meta).toEqual({
      description: 'who I am talking to',
      createdAt: 1,
      updatedAt: 2,
      updateCount: 3,
      importance: 4,
      expiresAt: 5,
      expiresAtTurn: 6,
    });

    backend.write('memory', 'copy', stored);
    expect(legacy.db.get('copy')).toEqual(entry);
  });

  it('reports snapshot/restore only when the legacy store has them', () => {
    const without = fromMemoryStore(new HandWrittenMemoryStore());
    expect(without.supports?.('snapshot')).toBe(false);
    expect(() => without.snapshot?.('memory')).toThrow(StoreCapabilityError);

    const base = new HandWrittenMemoryStore();
    const withSnapshot = fromMemoryStore({
      get: (key) => base.get(key),
      set: (key, entry) => base.set(key, entry),
      delete: (key) => base.delete(key),
      keys: () => base.keys(),
      snapshot: () => ({}),
      restore: () => {},
    });
    expect(withSnapshot.supports?.('snapshot')).toBe(true);
    expect(withSnapshot.supports?.('restore')).toBe(true);
  });

  it('Memory still runs on a hand-written store, with one keys() scan per compile', async () => {
    const legacy = new HandWrittenMemoryStore();
    const selector = vi.fn((entries: MemoryEntry[]) => entries);
    const memory = new Memory({ store: legacy, selector });

    await memory.set('a', '1', { description: 'first' });
    await memory.set('b', '2');
    const before = legacy.keysCalls;

    const artifacts = await memory.compileArtifacts();

    expect(legacy.keysCalls - before).toBe(1);
    expect(selector).toHaveBeenCalledTimes(1);
    expect(artifacts.selected.map((e) => e.key).sort()).toEqual(['a', 'b']);
    expect(artifacts.dataXml).toContain('key="a"');
    expect(await memory.get('a')).toBe('1');

    expect(await memory.delete('a')).toBe(true);
    expect(await memory.get('a')).toBeNull();
    expect(legacy.db.has('a')).toBe(false);
  });

  it('Memory runs on an async hand-written store', async () => {
    const memory = new Memory({ store: new AsyncMemoryStore() });

    await memory.set('k', 'v');
    expect(await memory.get('k')).toBe('v');
    expect((await memory.getAll()).map((e) => e.key)).toEqual(['k']);
    // No snapshot capability on this store — Memory reports that honestly.
    expect(memory.snapshot()).toBeNull();
  });

  it('Memory TTL expiry still deletes through the legacy store', async () => {
    const legacy = new HandWrittenMemoryStore();
    const expired = vi.fn();
    const memory = new Memory({ store: legacy, onMemoryExpired: expired });

    await memory.set('stale', 'old', { ttl: 1 });
    memory.advanceTurn();
    const artifacts = await memory.compileArtifacts();

    expect(artifacts.expiredKeys).toEqual(['stale']);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(legacy.db.has('stale')).toBe(false);
  });
});

describe('Store.fromVfsAdapter', () => {
  it('serves vfs and archive from the adapter’s single flat keyspace', () => {
    const legacy = new HandWrittenVfsAdapter();
    const store = new Store(fromVfsAdapter(legacy));

    store.namespace('vfs').put('vfs_1.txt', 'offloaded');
    store.namespace('archive').put('archive_1.txt', 'a compressed span');

    expect(Array.from(legacy.db.keys()).sort()).toEqual(['archive_1.txt', 'vfs_1.txt']);
    expect((store.namespace('vfs').get('vfs_1.txt') as { content: string }).content).toBe(
      'offloaded',
    );
    expect(store.namespace('vfs').uri('vfs_1.txt')).toBe('context://vfs/vfs_1.txt');
    expect(store.namespace('archive').uri('archive_1.txt')).toBe('context://archive/archive_1.txt');
  });

  it('turns missing optional adapter methods into capability errors', () => {
    const minimal: VFSStorageAdapter = { write: () => {}, read: () => null };
    const backend = fromVfsAdapter(minimal);

    expect(backend.supports?.('delete')).toBe(false);
    expect(backend.supports?.('list')).toBe(false);
    expect(backend.supports?.('exists')).toBe(false);
    expect(backend.supports?.('getPhysicalPath')).toBe(false);
    expect(() => backend.delete('vfs', 'x')).toThrow(StoreCapabilityError);
    expect(() => backend.list('vfs')).toThrow(StoreCapabilityError);
  });

  it('Offloader still runs on a hand-written adapter, end to end', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const legacy = new HandWrittenVfsAdapter();
    const offloader = new Offloader({ adapter: legacy, threshold: 10, maxFiles: 1 });

    const first = offloader.offload('A'.repeat(50), { tailChars: 0 });
    vi.advanceTimersByTime(10);
    const second = offloader.offload('B'.repeat(50), { tailChars: 0 });
    vi.advanceTimersByTime(10);

    expect(first.isOffloaded).toBe(true);
    expect(first.uri).toMatch(/^context:\/\/vfs\/vfs_[0-9a-f]{16}\.txt$/);
    expect(offloader.resolve(first.uri ?? '')).toBe('A'.repeat(50));
    expect(offloader.getEntries()).toHaveLength(2);

    const cleaned = offloader.cleanup();
    expect(cleaned.evicted).toHaveLength(1);
    // `first` was just resolved, so `second` is the least recently used.
    expect(cleaned.evicted[0].filename).toBe(second.uri?.split('/').pop());
    expect(legacy.db.size).toBe(1);
    vi.useRealTimers();
  });

  it('Offloader reconciles orphans an adapter already held', () => {
    const legacy = new HandWrittenVfsAdapter();
    legacy.write('vfs_5000_aabbccdd.txt', 'written before this process started');
    const offloader = new Offloader({ adapter: legacy, threshold: 10 });

    expect(offloader.reconcile({ measureBytes: true })).toBe(1);
    const [entry] = offloader.getEntries();
    expect(entry.createdAt).toBe(5000); // parsed out of the legacy filename
    expect(entry.bytes).toBe(Buffer.byteLength('written before this process started'));
  });

  it('an adapter without list/delete still reports the legacy cleanup error', () => {
    const offloader = new Offloader({
      adapter: { write: () => {}, read: () => null },
      threshold: 10,
    });

    let caught: unknown;
    try {
      offloader.cleanup();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VFSCleanupNotSupportedError);
    if (!(caught instanceof VFSCleanupNotSupportedError)) throw new Error('wrong error');
    expect(caught.missing).toEqual(['list', 'delete']);
  });
});
