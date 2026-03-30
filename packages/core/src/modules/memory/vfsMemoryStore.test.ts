import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryStoreEntry } from './memoryStore';
import { VFSMemoryStore } from './vfsMemoryStore';

const testDir = path.join(process.cwd(), '.test_vfs_memory');

const makeEntry = (value: string, overrides?: Partial<MemoryStoreEntry>): MemoryStoreEntry => ({
  value,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  updateCount: 1,
  ...overrides,
});

describe('VFSMemoryStore', () => {
  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('set and get a value', () => {
    const store = new VFSMemoryStore(testDir);
    const entry = makeEntry('hello');
    store.set('key1', entry);

    const result = store.get('key1');
    expect(result?.value).toBe('hello');
  });

  it('get returns null for missing key', () => {
    const store = new VFSMemoryStore(testDir);
    expect(store.get('nonexistent')).toBeNull();
  });

  it('delete removes an entry', () => {
    const store = new VFSMemoryStore(testDir);
    store.set('key1', makeEntry('value'));

    const deleted = store.delete('key1');
    expect(deleted).toBe(true);
    expect(store.get('key1')).toBeNull();
  });

  it('delete returns false for missing key', () => {
    const store = new VFSMemoryStore(testDir);
    expect(store.delete('nonexistent')).toBe(false);
  });

  it('keys returns all stored keys', () => {
    const store = new VFSMemoryStore(testDir);
    store.set('a', makeEntry('1'));
    store.set('b', makeEntry('2'));
    store.set('c', makeEntry('3'));

    const keys = store.keys();
    expect(keys).toHaveLength(3);
    expect(keys).toContain('a');
    expect(keys).toContain('b');
    expect(keys).toContain('c');
  });

  it('overwrites existing entry on set', () => {
    const store = new VFSMemoryStore(testDir);
    store.set('key1', makeEntry('old'));
    store.set('key1', makeEntry('new'));

    expect(store.get('key1')?.value).toBe('new');
    expect(store.keys()).toHaveLength(1);
  });

  it('persists data across instances', () => {
    const store1 = new VFSMemoryStore(testDir);
    store1.set('persistent', makeEntry('survives'));

    const store2 = new VFSMemoryStore(testDir);
    expect(store2.get('persistent')?.value).toBe('survives');
    expect(store2.keys()).toContain('persistent');
  });

  it('handles keys with special characters', () => {
    const store = new VFSMemoryStore(testDir);
    const specialKey = 'user/preferences::theme';
    store.set(specialKey, makeEntry('dark'));

    expect(store.get(specialKey)?.value).toBe('dark');
    expect(store.keys()).toContain(specialKey);
  });

  it('preserves all entry fields', () => {
    const store = new VFSMemoryStore(testDir);
    const entry = makeEntry('test', {
      description: 'A test entry',
      importance: 5,
      expiresAt: 99999,
      expiresAtTurn: 10,
      createdAt: 1000,
      updatedAt: 2000,
      updateCount: 3,
    });
    store.set('full', entry);

    const result = store.get('full');
    expect(result?.description).toBe('A test entry');
    expect(result?.importance).toBe(5);
    expect(result?.expiresAt).toBe(99999);
    expect(result?.expiresAtTurn).toBe(10);
    expect(result?.createdAt).toBe(1000);
    expect(result?.updatedAt).toBe(2000);
    expect(result?.updateCount).toBe(3);
  });

  it('get returns null for corrupted file', () => {
    const store = new VFSMemoryStore(testDir);
    store.set('key1', makeEntry('valid'));

    // Corrupt the file
    const safe = Buffer.from('key1').toString('base64url');
    const filePath = path.join(testDir, `${safe}.mem`);
    fs.writeFileSync(filePath, 'not valid json', 'utf-8');

    expect(store.get('key1')).toBeNull();
  });

  it('snapshot captures all entries', () => {
    const store = new VFSMemoryStore(testDir);
    store.set('a', makeEntry('1'));
    store.set('b', makeEntry('2'));

    const snap = store.snapshot();
    expect(Object.keys(snap)).toHaveLength(2);
    expect(snap.a.value).toBe('1');
    expect(snap.b.value).toBe('2');
  });

  it('restore replaces all entries', () => {
    const store = new VFSMemoryStore(testDir);
    store.set('old', makeEntry('will be removed'));

    store.restore({
      new1: makeEntry('restored1'),
      new2: makeEntry('restored2'),
    });

    expect(store.get('old')).toBeNull();
    expect(store.get('new1')?.value).toBe('restored1');
    expect(store.get('new2')?.value).toBe('restored2');
    expect(store.keys()).toHaveLength(2);
  });

  it('snapshot + restore round-trips correctly', () => {
    const store = new VFSMemoryStore(testDir);
    store.set('x', makeEntry('original'));

    const snap = store.snapshot();

    store.set('y', makeEntry('added'));
    store.delete('x');

    store.restore(snap);

    expect(store.get('x')?.value).toBe('original');
    expect(store.get('y')).toBeNull();
    expect(store.keys()).toEqual(['x']);
  });
});
