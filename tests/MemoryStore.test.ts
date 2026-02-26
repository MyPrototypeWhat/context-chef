/**
 * E12: MemoryStore tests
 *
 * Covers:
 * - InMemoryStore: get/set/delete/keys CRUD
 * - VFSMemoryStore: get/set/delete/keys with real filesystem I/O
 * - VFSMemoryStore: persistence across instances (simulates process restart)
 * - VFSMemoryStore: safe filenames via base64url encoding
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { InMemoryStore } from '../src/stores/InMemoryStore';
import { VFSMemoryStore } from '../src/stores/VFSMemoryStore';

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
    store.set('persona', 'You are a helpful assistant.');
    expect(store.get('persona')).toBe('You are a helpful assistant.');
  });

  it('overwrites an existing key', () => {
    store.set('k', 'v1');
    store.set('k', 'v2');
    expect(store.get('k')).toBe('v2');
  });

  it('delete returns true when key existed', () => {
    store.set('x', 'data');
    expect(store.delete('x')).toBe(true);
    expect(store.get('x')).toBeNull();
  });

  it('delete returns false when key did not exist', () => {
    expect(store.delete('nonexistent')).toBe(false);
  });

  it('keys returns all current keys', () => {
    store.set('a', '1');
    store.set('b', '2');
    store.set('c', '3');
    expect(store.keys().sort()).toEqual(['a', 'b', 'c']);
  });

  it('keys excludes deleted entries', () => {
    store.set('a', '1');
    store.set('b', '2');
    store.delete('a');
    expect(store.keys()).toEqual(['b']);
  });

  it('starts empty — independent instances do not share state', () => {
    const s1 = new InMemoryStore();
    const s2 = new InMemoryStore();
    s1.set('key', 'val');
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
    store.set('system_persona', 'Expert coder.');
    expect(fs.existsSync(TMP_DIR)).toBe(true);
    expect(store.get('system_persona')).toBe('Expert coder.');
  });

  it('overwrites an existing key', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    store.set('rule', 'v1');
    store.set('rule', 'v2');
    expect(store.get('rule')).toBe('v2');
  });

  it('delete removes the file and returns true', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    store.set('tmp', 'bye');
    expect(store.delete('tmp')).toBe(true);
    expect(store.get('tmp')).toBeNull();
  });

  it('delete returns false for nonexistent key', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    expect(store.delete('ghost')).toBe(false);
  });

  it('keys lists all stored keys', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    store.set('a', '1');
    store.set('b', '2');
    expect(store.keys().sort()).toEqual(['a', 'b']);
  });

  it('keys excludes deleted entries', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    store.set('x', '1');
    store.set('y', '2');
    store.delete('x');
    expect(store.keys()).toEqual(['y']);
  });

  it('persists across instance re-creation (simulates process restart)', () => {
    const store1 = new VFSMemoryStore(TMP_DIR);
    store1.set('persistent_rule', 'Always use TypeScript.');

    // New instance reads from disk
    const store2 = new VFSMemoryStore(TMP_DIR);
    expect(store2.get('persistent_rule')).toBe('Always use TypeScript.');
    expect(store2.keys()).toContain('persistent_rule');
  });

  it('handles keys with special characters via base64url encoding', () => {
    const store = new VFSMemoryStore(TMP_DIR);
    const weirdKey = 'project/rules:v1 (draft)';
    store.set(weirdKey, 'content');
    expect(store.get(weirdKey)).toBe('content');
    expect(store.keys()).toContain(weirdKey);
  });
});
