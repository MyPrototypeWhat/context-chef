import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from './inMemoryStore';
import type { MemoryStoreEntry } from './memoryStore';
import { VFSMemoryStore } from './vfsMemoryStore';

function entry(value: string, overrides?: Partial<MemoryStoreEntry>): MemoryStoreEntry {
  return {
    value,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    updateCount: 1,
    ...overrides,
  };
}

// ─── InMemoryStore ─────────────────────────────────────────────────────────

describe('InMemoryStore', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('returns null for unknown keys', () => {
    expect(store.get('missing')).toBeNull();
  });

  it('set and get a value', () => {
    store.set('persona', entry('You are a helpful assistant.'));
    expect(store.get('persona')?.value).toBe('You are a helpful assistant.');
  });

  it('overwrites an existing key', () => {
    store.set('k', entry('v1'));
    store.set('k', entry('v2'));
    expect(store.get('k')?.value).toBe('v2');
  });

  it('delete returns true when key existed', () => {
    store.set('x', entry('data'));
    expect(store.delete('x')).toBe(true);
    expect(store.get('x')).toBeNull();
  });

  it('delete returns false when key did not exist', () => {
    expect(store.delete('nonexistent')).toBe(false);
  });

  it('keys returns all current keys', () => {
    store.set('a', entry('1'));
    store.set('b', entry('2'));
    store.set('c', entry('3'));
    expect(store.keys().sort()).toEqual(['a', 'b', 'c']);
  });

  it('keys excludes deleted entries', () => {
    store.set('a', entry('1'));
    store.set('b', entry('2'));
    store.delete('a');
    expect(store.keys()).toEqual(['b']);
  });

  it('starts empty — independent instances do not share state', () => {
    const s1 = new InMemoryStore();
    const s2 = new InMemoryStore();
    s1.set('key', entry('val'));
    expect(s2.get('key')).toBeNull();
  });
});

// ─── VFSMemoryStore ────────────────────────────────────────────────────────

const TMP_DIR = path.join(__dirname, '__vfs_memory_test__');

function cleanup() {
  if (fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

describe('VFSMemoryStore', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('returns null for unknown keys', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    expect(store.get('missing')).toBeNull();
  });

  it('set creates the storage directory and persists the value', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    store.set('system_persona', entry('Expert coder.'));
    expect(fs.existsSync(TMP_DIR)).toBe(true);
    expect(store.get('system_persona')?.value).toBe('Expert coder.');
  });

  it('overwrites an existing key', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    store.set('rule', entry('v1'));
    store.set('rule', entry('v2'));
    expect(store.get('rule')?.value).toBe('v2');
  });

  it('delete removes the file and returns true', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    store.set('tmp', entry('bye'));
    expect(store.delete('tmp')).toBe(true);
    expect(store.get('tmp')).toBeNull();
  });

  it('delete returns false for nonexistent key', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    expect(store.delete('ghost')).toBe(false);
  });

  it('keys lists all stored keys', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    store.set('a', entry('1'));
    store.set('b', entry('2'));
    expect(store.keys().sort()).toEqual(['a', 'b']);
  });

  it('keys excludes deleted entries', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    store.set('x', entry('1'));
    store.set('y', entry('2'));
    store.delete('x');
    expect(store.keys()).toEqual(['y']);
  });

  it('persists across instance re-creation (simulates process restart)', () => {
    const e = entry('Always use TypeScript.', { importance: 5 });
    const store1 = new VFSMemoryStore(TMP_DIR);
    store1.set('persistent_rule', e);

    const store2 = new VFSMemoryStore(TMP_DIR);
    const restored = store2.get('persistent_rule');
    expect(restored?.value).toBe('Always use TypeScript.');
    expect(restored?.importance).toBe(5);
    expect(restored?.createdAt).toBe(e.createdAt);
    expect(store2.keys()).toContain('persistent_rule');
  });

  it('handles keys with special characters via base64url encoding', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    const weirdKey = 'project/rules:v1 (draft)';
    store.set(weirdKey, entry('content'));
    expect(store.get(weirdKey)?.value).toBe('content');
    expect(store.keys()).toContain(weirdKey);
  });
});
