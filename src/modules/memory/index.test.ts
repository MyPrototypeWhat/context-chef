import { describe, expect, it, vi } from 'vitest';
import { ContextChef } from '../../index';
import { Memory } from '.';
import { InMemoryStore } from './inMemoryStore';

// ─── Memory module unit tests ───────────────────────────────────────────────

describe('Memory', () => {
  it('set / get / delete / getAll', async () => {
    const store = new InMemoryStore();
    const mem = new Memory({ store });

    await mem.set('rule1', 'use strict mode');
    await mem.set('rule2', 'prefer const');

    expect(await mem.get('rule1')).toBe('use strict mode');
    expect(await mem.getAll()).toHaveLength(2);

    await mem.delete('rule1');
    expect(await mem.get('rule1')).toBeNull();
    expect(await mem.getAll()).toHaveLength(1);
  });

  it('toXml() returns empty string when no memories', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    expect(await mem.toXml()).toBe('');
  });

  it('toXml() wraps entries in <memory> with metadata', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'TypeScript');
    await mem.set('style', 'functional');

    const xml = await mem.toXml();
    expect(xml).toContain('<memory>');
    expect(xml).toContain('<entry key="lang">');
    expect(xml).toContain('<metadata>');
    expect(xml).toContain('- updated_at=');
    expect(xml).toContain('- update_count=1');
    expect(xml).toContain('<value>\nTypeScript\n</value>');
    expect(xml).toContain('<entry key="style">');
    expect(xml).toContain('<value>\nfunctional\n</value>');
    expect(xml).toContain('</memory>');
  });

  it('toXml() includes description when set', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'TypeScript', { description: 'Primary project language' });

    const xml = await mem.toXml();
    expect(xml).toContain('<description>\nPrimary project language\n</description>');
    expect(xml).toContain('<value>\nTypeScript\n</value>');
  });

  it('toXml() omits description tag when not set', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'TypeScript');

    const xml = await mem.toXml();
    expect(xml).not.toContain('<description>');
  });

  it('snapshot() returns entries and turnCount from InMemoryStore', async () => {
    const store = new InMemoryStore();
    const mem = new Memory({ store });
    await mem.set('k1', 'v1');

    const snap = mem.snapshot();
    expect(snap).not.toBeNull();
    expect(snap?.entries.k1.value).toBe('v1');
    expect(snap?.entries.k1.updateCount).toBe(1);
    expect(snap?.turnCount).toBe(0);
  });

  it('restore() replaces store contents and turnCount', async () => {
    const store = new InMemoryStore();
    const mem = new Memory({ store });
    await mem.set('k1', 'v1');

    const now = Date.now();
    mem.restore({
      entries: {
        k2: { value: 'v2', createdAt: now, updatedAt: now, updateCount: 1 },
        k3: { value: 'v3', createdAt: now, updatedAt: now, updateCount: 1 },
      },
      turnCount: 5,
    });
    expect(await mem.get('k1')).toBeNull();
    expect(await mem.get('k2')).toBe('v2');
    expect(await mem.get('k3')).toBe('v3');
    expect(mem.turnCount).toBe(5);
  });

  it('snapshot() returns null for stores without snapshot support', () => {
    const bareStore = {
      get: () => null,
      set: () => {},
      delete: () => false,
      keys: () => [],
    };
    const mem = new Memory({ store: bareStore });
    expect(mem.snapshot()).toBeNull();
  });

  it('getEntry() returns full metadata', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('project', 'context-chef');

    const entry = await mem.getEntry('project');
    expect(entry).not.toBeNull();
    expect(entry?.key).toBe('project');
    expect(entry?.value).toBe('context-chef');
    expect(entry?.updateCount).toBe(1);
    expect(entry?.createdAt).toBeGreaterThan(0);
    expect(entry?.updatedAt).toBeGreaterThanOrEqual(entry?.createdAt as number);
  });

  it('getEntry() returns null for unknown key', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    expect(await mem.getEntry('nope')).toBeNull();
  });

  it('set() auto-generates metadata on new entries', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    const before = Date.now();
    await mem.set('key', 'val');
    const after = Date.now();

    const entry = await mem.getEntry('key');
    expect(entry?.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry?.createdAt).toBeLessThanOrEqual(after);
    expect(entry?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(entry?.updateCount).toBe(1);
  });

  it('set() updates preserve createdAt and increment updateCount', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('key', 'v1');
    const first = await mem.getEntry('key');

    await mem.set('key', 'v2');
    const second = await mem.getEntry('key');

    expect(second?.value).toBe('v2');
    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.updateCount).toBe(2);
    expect(second?.updatedAt).toBeGreaterThanOrEqual(first?.updatedAt as number);
  });

  it('set() with importance option', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('important', 'critical', { importance: 10 });

    const entry = await mem.getEntry('important');
    expect(entry?.importance).toBe(10);
  });

  it('toXml() includes all entries', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('rule1', 'always lint');
    await mem.set('rule2', 'use strict');

    const xml = await mem.toXml();
    expect(xml).toContain('<entry key="rule1"');
    expect(xml).toContain('always lint');
    expect(xml).toContain('<entry key="rule2"');
    expect(xml).toContain('use strict');
  });

  it('getAll() returns entries with full metadata', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('a', '1');
    await mem.set('b', '2');

    const all = await mem.getAll();
    expect(all).toHaveLength(2);

    const a = all.find((e) => e.key === 'a');
    expect(a).toBeDefined();
    expect(a?.value).toBe('1');
    expect(a?.updateCount).toBe(1);
  });
});

// ─── createMemory / updateMemory / deleteMemory ──────────────────────────────

describe('Memory validated methods', () => {
  it('createMemory() creates a new entry and returns it', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    const entry = await mem.createMemory('lang', 'TypeScript');

    expect(entry).not.toBeNull();
    expect(entry?.key).toBe('lang');
    expect(entry?.value).toBe('TypeScript');
    expect(entry?.updateCount).toBe(1);
    expect(await mem.get('lang')).toBe('TypeScript');
  });

  it('createMemory() returns null for disallowed key', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['lang'],
    });
    const entry = await mem.createMemory('rogue', 'hack');

    expect(entry).toBeNull();
    expect(await mem.get('rogue')).toBeNull();
  });

  it('createMemory() returns null when veto hook blocks', async () => {
    const hook = vi.fn().mockReturnValue(false);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });
    const entry = await mem.createMemory('blocked', 'val');

    expect(entry).toBeNull();
    expect(await mem.get('blocked')).toBeNull();
    expect(hook).toHaveBeenCalledWith('blocked', 'val', null);
  });

  it('createMemory() can overwrite existing key', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'JS');
    const entry = await mem.createMemory('lang', 'TypeScript');

    expect(entry?.value).toBe('TypeScript');
    expect(entry?.updateCount).toBe(2);
  });

  it('createMemory() stores description', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    const entry = await mem.createMemory('lang', 'TypeScript', 'Primary project language');

    expect(entry?.description).toBe('Primary project language');

    const xml = await mem.toXml();
    expect(xml).toContain('<description>\nPrimary project language\n</description>');
  });

  it('updateMemory() can update description', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'JS', { description: 'Old desc' });
    const entry = await mem.updateMemory('lang', 'TypeScript', 'New desc');

    expect(entry?.description).toBe('New desc');
  });

  it('updateMemory() preserves existing description when not provided', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'JS', { description: 'Keep this' });
    const entry = await mem.updateMemory('lang', 'TypeScript');

    expect(entry?.description).toBe('Keep this');
  });

  it('updateMemory() updates an existing entry', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'JS');
    const entry = await mem.updateMemory('lang', 'TypeScript');

    expect(entry).not.toBeNull();
    expect(entry?.value).toBe('TypeScript');
    expect(entry?.updateCount).toBe(2);
  });

  it('updateMemory() returns null for non-existent key', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    const entry = await mem.updateMemory('missing', 'val');

    expect(entry).toBeNull();
  });

  it('updateMemory() returns null for disallowed key', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['other'],
    });
    await mem.set('lang', 'JS');
    const entry = await mem.updateMemory('lang', 'TS');

    expect(entry).toBeNull();
    expect(await mem.get('lang')).toBe('JS');
  });

  it('updateMemory() returns null when veto hook blocks', async () => {
    const hook = vi.fn().mockReturnValue(false);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });
    await mem.set('lang', 'JS');
    const entry = await mem.updateMemory('lang', 'TS');

    expect(entry).toBeNull();
    expect(await mem.get('lang')).toBe('JS');
    expect(hook).toHaveBeenCalledWith('lang', 'TS', 'JS');
  });

  it('deleteMemory() deletes an existing entry', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'TS');
    const result = await mem.deleteMemory('lang');

    expect(result).toBe(true);
    expect(await mem.get('lang')).toBeNull();
  });

  it('deleteMemory() returns false for non-existent key', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    const result = await mem.deleteMemory('missing');

    expect(result).toBe(false);
  });

  it('deleteMemory() returns false for disallowed key', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['other'],
    });
    await mem.set('protected', 'important');
    const result = await mem.deleteMemory('protected');

    expect(result).toBe(false);
    expect(await mem.get('protected')).toBe('important');
  });

  it('deleteMemory() returns false when veto hook blocks', async () => {
    const hook = vi.fn().mockReturnValue(false);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });
    await mem.set('protected', 'keep');
    const result = await mem.deleteMemory('protected');

    expect(result).toBe(false);
    expect(await mem.get('protected')).toBe('keep');
    expect(hook).toHaveBeenCalledWith('protected', null, 'keep');
  });

  it('createMemory() respects defaultTTL', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: 2 });
    await mem.createMemory('lang', 'TS');

    const entry = await mem.getEntry('lang');
    expect(entry?.expiresAtTurn).toBe(2);
  });

  it('validated methods support async veto hook', async () => {
    const hook = vi.fn().mockResolvedValue(true);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });
    await mem.createMemory('key', 'val');

    expect(hook).toHaveBeenCalled();
    expect(await mem.get('key')).toBe('val');
  });

  it('allowedKeys is checked before onMemoryUpdate', async () => {
    const hook = vi.fn().mockReturnValue(true);
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['allowed'],
      onMemoryUpdate: hook,
    });
    await mem.createMemory('disallowed', 'val');

    expect(hook).not.toHaveBeenCalled();
  });
});

// ─── getToolDefinitions ──────────────────────────────────────────────────────

describe('Memory getToolDefinitions', () => {
  it('returns only create_memory when no entries exist', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    const tools = await mem.getToolDefinitions();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('create_memory');
  });

  it('returns create_memory and modify_memory when entries exist', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'TS');
    await mem.set('style', 'functional');

    const tools = await mem.getToolDefinitions();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('create_memory');
    expect(tools[1].name).toBe('modify_memory');
  });

  it('modify_memory key has enum of existing keys', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'TS');
    await mem.set('style', 'functional');

    const tools = await mem.getToolDefinitions();
    const modifyTool = tools.find((t) => t.name === 'modify_memory');
    const keyParam = (modifyTool?.parameters as Record<string, unknown>)?.properties as Record<
      string,
      unknown
    >;
    const keyDef = keyParam?.key as Record<string, unknown>;

    expect(keyDef.enum).toEqual(['lang', 'style']);
  });

  it('modify_memory action has update/delete enum', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'TS');

    const tools = await mem.getToolDefinitions();
    const modifyTool = tools.find((t) => t.name === 'modify_memory');
    const props = (modifyTool?.parameters as Record<string, unknown>)?.properties as Record<
      string,
      unknown
    >;
    const actionDef = props?.action as Record<string, unknown>;

    expect(actionDef.enum).toEqual(['update', 'delete']);
  });

  it('create_memory key has allowedKeys enum when configured', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['lang', 'style', 'framework'],
    });

    const tools = await mem.getToolDefinitions();
    const createTool = tools.find((t) => t.name === 'create_memory');
    const props = (createTool?.parameters as Record<string, unknown>)?.properties as Record<
      string,
      unknown
    >;
    const keyDef = props?.key as Record<string, unknown>;

    expect(keyDef.enum).toEqual(['lang', 'style', 'framework']);
  });

  it('create_memory key is free-form when no allowedKeys', async () => {
    const mem = new Memory({ store: new InMemoryStore() });

    const tools = await mem.getToolDefinitions();
    const createTool = tools.find((t) => t.name === 'create_memory');
    const props = (createTool?.parameters as Record<string, unknown>)?.properties as Record<
      string,
      unknown
    >;
    const keyDef = props?.key as Record<string, unknown>;

    expect(keyDef.enum).toBeUndefined();
    expect(keyDef.type).toBe('string');
  });

  it('create_memory and modify_memory include description parameter', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'TS');

    const tools = await mem.getToolDefinitions();
    const createTool = tools.find((t) => t.name === 'create_memory');
    const modifyTool = tools.find((t) => t.name === 'modify_memory');

    const createProps = (createTool?.parameters as Record<string, unknown>)?.properties as Record<
      string,
      unknown
    >;
    expect(createProps?.description).toBeDefined();

    const modifyProps = (modifyTool?.parameters as Record<string, unknown>)?.properties as Record<
      string,
      unknown
    >;
    expect(modifyProps?.description).toBeDefined();
  });
});

// ─── TTL (turn-based) ───────────────────────────────────────────────────────

describe('Memory TTL (turn-based)', () => {
  it('bare number TTL sets expiresAtTurn', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: 3 });
    await mem.set('key', 'val');

    const entry = await mem.getEntry('key');
    expect(entry?.expiresAtTurn).toBe(3); // turnCount=0 + 3
    expect(entry?.expiresAt).toBeUndefined();
  });

  it('{ turns: N } TTL sets expiresAtTurn', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: { turns: 5 } });
    mem.advanceTurn(); // turn 1
    await mem.set('key', 'val');

    const entry = await mem.getEntry('key');
    expect(entry?.expiresAtTurn).toBe(6); // turnCount=1 + 5
  });

  it('sweepExpired() removes entries past their turn', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: 2 });
    await mem.set('short', 'val');

    // Advance 2 turns → should expire
    mem.advanceTurn();
    mem.advanceTurn();

    const expired = await mem.sweepExpired();
    expect(expired).toEqual(['short']);
    expect(await mem.get('short')).toBeNull();
  });

  it('sweepExpired() keeps entries within TTL', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: 5 });
    await mem.set('fresh', 'val');

    mem.advanceTurn(); // only 1 turn, TTL=5

    const expired = await mem.sweepExpired();
    expect(expired).toEqual([]);
    expect(await mem.get('fresh')).toBe('val');
  });

  it('set() with ttl: null overrides defaultTTL (never expires)', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: 1 });
    await mem.set('permanent', 'val', { ttl: null });

    mem.advanceTurn();
    mem.advanceTurn();
    mem.advanceTurn();

    const expired = await mem.sweepExpired();
    expect(expired).toEqual([]);
    expect(await mem.get('permanent')).toBe('val');
  });

  it('set() with per-entry ttl overrides defaultTTL', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: 10 });
    await mem.set('short_lived', 'val', { ttl: 1 });

    mem.advanceTurn();
    const expired = await mem.sweepExpired();
    expect(expired).toEqual(['short_lived']);
  });

  it('updating an entry refreshes its TTL', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: 2 });
    await mem.set('key', 'v1'); // expiresAtTurn = 2

    mem.advanceTurn(); // turn 1
    await mem.set('key', 'v2'); // refreshes → expiresAtTurn = 3

    mem.advanceTurn(); // turn 2 — would have expired with original TTL

    const expired = await mem.sweepExpired();
    expect(expired).toEqual([]);
    expect(await mem.get('key')).toBe('v2');
  });
});

// ─── TTL (ms-based) ─────────────────────────────────────────────────────────

describe('Memory TTL (ms-based)', () => {
  it('{ ms: N } TTL sets expiresAt timestamp', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: { ms: 5000 } });
    const before = Date.now();
    await mem.set('key', 'val');

    const entry = await mem.getEntry('key');
    expect(entry?.expiresAt).toBeGreaterThanOrEqual(before + 5000);
    expect(entry?.expiresAtTurn).toBeUndefined();
  });

  it('sweepExpired() removes entries past their wall-clock expiry', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    // Manually set an entry that's already expired
    await mem.set('old', 'val', { ttl: { ms: -1 } }); // negative = already expired

    const expired = await mem.sweepExpired();
    expect(expired).toEqual(['old']);
    expect(await mem.get('old')).toBeNull();
  });
});

// ─── onMemoryExpired ────────────────────────────────────────────────────────

describe('Memory onMemoryExpired', () => {
  it('calls onMemoryExpired hook when entry expires', async () => {
    const hook = vi.fn();
    const mem = new Memory({
      store: new InMemoryStore(),
      defaultTTL: 1,
      onMemoryExpired: hook,
    });
    await mem.set('temp', 'val');
    mem.advanceTurn();

    await mem.sweepExpired();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0].key).toBe('temp');
    expect(hook.mock.calls[0][0].value).toBe('val');
  });

  it('supports async onMemoryExpired hook', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    const mem = new Memory({
      store: new InMemoryStore(),
      defaultTTL: 1,
      onMemoryExpired: hook,
    });
    await mem.set('temp', 'val');
    mem.advanceTurn();

    await mem.sweepExpired();
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

// ─── No defaultTTL (never expires by default) ───────────────────────────────

describe('Memory without defaultTTL', () => {
  it('entries never expire when no defaultTTL is set', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('persistent', 'val');

    // Advance many turns
    for (let i = 0; i < 100; i++) mem.advanceTurn();

    const expired = await mem.sweepExpired();
    expect(expired).toEqual([]);
    expect(await mem.get('persistent')).toBe('val');
  });
});

// ─── allowedKeys ────────────────────────────────────────────────────────────

describe('Memory allowedKeys', () => {
  it('createMemory allows keys in the allowlist', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['lang', 'style'],
    });

    const entry = await mem.createMemory('lang', 'TS');

    expect(entry).not.toBeNull();
    expect(await mem.get('lang')).toBe('TS');
  });

  it('createMemory returns null for keys NOT in the allowlist', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['lang'],
    });

    const entry = await mem.createMemory('rogue_key', 'hack');

    expect(entry).toBeNull();
    expect(await mem.get('rogue_key')).toBeNull();
  });

  it('deleteMemory returns false for keys NOT in the allowlist', async () => {
    const mem = new Memory({ store: new InMemoryStore(), allowedKeys: ['other'] });
    await mem.set('protected', 'important');

    const result = await mem.deleteMemory('protected');

    expect(result).toBe(false);
    expect(await mem.get('protected')).toBe('important');
  });

  it('allowedKeys is exposed as readonly property', () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['a', 'b'],
    });
    expect(mem.allowedKeys).toEqual(['a', 'b']);
  });
});

// ─── onMemoryUpdate ─────────────────────────────────────────────────────────

describe('Memory onMemoryUpdate', () => {
  it('calls hook with (key, value, oldValue) for createMemory', async () => {
    const hook = vi.fn().mockReturnValue(true);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });

    await mem.createMemory('lang', 'TS');

    expect(hook).toHaveBeenCalledWith('lang', 'TS', null);
    expect(await mem.get('lang')).toBe('TS');
  });

  it('calls hook with (key, value, oldValue) for updateMemory', async () => {
    const hook = vi.fn().mockReturnValue(true);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });
    await mem.set('existing', 'old');

    await mem.updateMemory('existing', 'new');

    expect(hook).toHaveBeenCalledWith('existing', 'new', 'old');
    expect(await mem.get('existing')).toBe('new');
  });

  it('calls hook with (key, null, oldValue) for deleteMemory', async () => {
    const hook = vi.fn().mockReturnValue(true);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });
    await mem.set('doomed', 'bye');

    await mem.deleteMemory('doomed');

    expect(hook).toHaveBeenCalledWith('doomed', null, 'bye');
    expect(await mem.get('doomed')).toBeNull();
  });

  it('blocks createMemory when hook returns false', async () => {
    const hook = vi.fn().mockReturnValue(false);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });

    const entry = await mem.createMemory('blocked', 'val');

    expect(entry).toBeNull();
    expect(await mem.get('blocked')).toBeNull();
  });

  it('blocks deleteMemory when hook returns false', async () => {
    const hook = vi.fn().mockReturnValue(false);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });
    await mem.set('protected', 'keep');

    const result = await mem.deleteMemory('protected');

    expect(result).toBe(false);
    expect(await mem.get('protected')).toBe('keep');
  });

  it('supports async hook', async () => {
    const hook = vi.fn().mockResolvedValue(true);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });

    await mem.createMemory('async_key', 'val');

    expect(hook).toHaveBeenCalled();
    expect(await mem.get('async_key')).toBe('val');
  });

  it('allowedKeys is checked before onMemoryUpdate (hook not called for disallowed keys)', async () => {
    const hook = vi.fn().mockReturnValue(true);
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['allowed'],
      onMemoryUpdate: hook,
    });

    await mem.createMemory('disallowed', 'val');

    expect(hook).not.toHaveBeenCalled();
  });
});

// ─── onMemoryChanged ────────────────────────────────────────────────────────

describe('Memory onMemoryChanged', () => {
  it('fires on set() with type=set', async () => {
    const hook = vi.fn();
    const mem = new Memory({ store: new InMemoryStore(), onMemoryChanged: hook });

    await mem.set('key', 'val');

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({
      type: 'set',
      key: 'key',
      value: 'val',
      oldValue: null,
    });
  });

  it('fires on set() update with previous oldValue', async () => {
    const hook = vi.fn();
    const mem = new Memory({ store: new InMemoryStore(), onMemoryChanged: hook });

    await mem.set('key', 'v1');
    await mem.set('key', 'v2');

    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[1][0]).toEqual({
      type: 'set',
      key: 'key',
      value: 'v2',
      oldValue: 'v1',
    });
  });

  it('fires on delete() with type=delete', async () => {
    const hook = vi.fn();
    const mem = new Memory({ store: new InMemoryStore(), onMemoryChanged: hook });

    await mem.set('key', 'val');
    hook.mockClear();

    await mem.delete('key');

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({
      type: 'delete',
      key: 'key',
      value: null,
      oldValue: 'val',
    });
  });

  it('does not fire on delete() when key does not exist', async () => {
    const hook = vi.fn();
    const mem = new Memory({ store: new InMemoryStore(), onMemoryChanged: hook });

    await mem.delete('nonexistent');

    expect(hook).not.toHaveBeenCalled();
  });

  it('fires on expire with type=expire', async () => {
    const hook = vi.fn();
    const mem = new Memory({
      store: new InMemoryStore(),
      defaultTTL: 1,
      onMemoryChanged: hook,
    });

    await mem.set('temp', 'val');
    hook.mockClear();

    mem.advanceTurn();
    await mem.sweepExpired();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({
      type: 'expire',
      key: 'temp',
      value: null,
      oldValue: 'val',
    });
  });

  it('fires on createMemory()', async () => {
    const hook = vi.fn();
    const mem = new Memory({ store: new InMemoryStore(), onMemoryChanged: hook });

    await mem.createMemory('lang', 'TS');

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0].type).toBe('set');
    expect(hook.mock.calls[0][0].key).toBe('lang');
    expect(hook.mock.calls[0][0].value).toBe('TS');
  });

  it('fires on deleteMemory()', async () => {
    const hook = vi.fn();
    const mem = new Memory({ store: new InMemoryStore(), onMemoryChanged: hook });
    await mem.set('old', 'val');
    hook.mockClear();

    await mem.deleteMemory('old');

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toEqual({
      type: 'delete',
      key: 'old',
      value: null,
      oldValue: 'val',
    });
  });

  it('supports async hook', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryChanged: hook });

    await mem.set('key', 'val');
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

// ─── ContextChef integration ────────────────────────────────────────────────

describe('ContextChef + Memory', () => {
  it('memory() throws when memory not configured', () => {
    const chef = new ContextChef();
    expect(() => chef.memory()).toThrow('memory');
  });

  it('memory() returns Memory instance when configured', () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    expect(chef.memory()).toBeInstanceOf(Memory);
  });

  it('compile() injects memory block with getMemoryBlock prompt', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    await chef.memory().set('rule', 'be concise');

    chef.setTopLayer([{ role: 'system', content: 'You are a helpful assistant.' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hello' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = payload.messages as Array<{ role: string; content: string }>;

    const memMsg = messages.find((m) => m.content.includes('<memory>'));
    expect(memMsg).toBeDefined();
    expect(memMsg?.content).toContain('memory tools');
    expect(memMsg?.content).toContain('<entry key="rule"');
    expect(memMsg?.content).toContain('be concise');
    expect(memMsg?.content).toContain('You recall the following from previous conversations');
    expect(memMsg?.content).toContain('Existing memory keys: rule');
  });

  it('compile() includes allowedKeys guidance when configured', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), allowedKeys: ['lang', 'style'] },
    });
    await chef.memory().set('lang', 'TypeScript');

    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = payload.messages as Array<{ role: string; content: string }>;

    const memMsg = messages.find((m) => m.content.includes('<memory>'));
    expect(memMsg).toBeDefined();
    expect(memMsg?.content).toContain('Allowed memory keys: lang, style');
    expect(memMsg?.content).toContain('ONLY');
  });

  it('compile() injects MEMORY_INSTRUCTION even when no memories exist', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = payload.messages as Array<{ role: string; content: string }>;

    expect(messages).toHaveLength(3);
    const memMsg = messages.find((m) => m.content.includes('memory tools'));
    expect(memMsg).toBeDefined();
    expect(memMsg?.content).not.toContain('<memory>');
  });

  it('compile() auto-injects memory tools into payload', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    await chef.memory().set('lang', 'TS');

    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });

    expect(payload.tools).toBeDefined();
    const toolNames = payload.tools?.map((t) => t.name);
    expect(toolNames).toContain('create_memory');
    expect(toolNames).toContain('modify_memory');
  });

  it('compile() includes only create_memory when no entries exist', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });

    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });

    expect(payload.tools).toBeDefined();
    const toolNames = payload.tools?.map((t) => t.name);
    expect(toolNames).toContain('create_memory');
    expect(toolNames).not.toContain('modify_memory');
  });

  it('snapshot/restore includes memory state', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    await chef.memory().set('key1', 'val1');

    const snap = chef.snapshot('before change');

    await chef.memory().set('key1', 'changed');
    await chef.memory().set('key2', 'new');

    chef.restore(snap);

    expect(await chef.memory().get('key1')).toBe('val1');
    expect(await chef.memory().get('key2')).toBeNull();
  });

  it('snapshot without memory has null modules.memory', () => {
    const chef = new ContextChef();
    const snap = chef.snapshot();
    expect(snap.modules.memory).toBeNull();
  });

  it('compile() advances memory turnCount', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    expect(chef.memory().turnCount).toBe(0);
    await chef.compile({ target: 'openai' });
    expect(chef.memory().turnCount).toBe(1);
    await chef.compile({ target: 'openai' });
    expect(chef.memory().turnCount).toBe(2);
  });

  it('compile() sweeps expired entries before injection', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), defaultTTL: 1 },
    });
    await chef.memory().set('temp', 'will expire');
    await chef.memory().set('perm', 'stays', { ttl: null });

    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    // First compile: turn 0→1, temp was created at turn 0 with TTL 1 → expiresAtTurn=1
    // At sweep time turnCount=0, so 0 >= 1 is false → not expired yet
    await chef.compile({ target: 'openai' });

    // Second compile: turn 1→2, sweep checks turnCount=1, 1 >= 1 → expired
    const payload = await chef.compile({ target: 'openai' });
    const messages = payload.messages as Array<{ role: string; content: string }>;

    const memMsg = messages.find((m) => m.content.includes('<memory>'));
    expect(memMsg).toBeDefined();
    expect(memMsg?.content).toContain('<entry key="perm"');
    expect(memMsg?.content).toContain('stays');
    expect(memMsg?.content).not.toContain('temp');
    expect(memMsg?.content).not.toContain('will expire');
  });

  it('compile() returns meta.injectedMemoryKeys', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    await chef.memory().set('lang', 'TS');
    await chef.memory().set('style', 'functional');

    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.meta).toBeDefined();
    expect(payload.meta?.injectedMemoryKeys.sort()).toEqual(['lang', 'style']);
  });

  it('compile() returns meta.memoryExpiredKeys', async () => {
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), defaultTTL: 1 },
    });
    await chef.memory().set('temp', 'will expire');
    await chef.memory().set('perm', 'stays', { ttl: null });

    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    // First compile: nothing expires yet
    const p1 = await chef.compile({ target: 'openai' });
    expect(p1.meta?.memoryExpiredKeys).toEqual([]);
    expect(p1.meta?.injectedMemoryKeys.sort()).toEqual(['perm', 'temp']);

    // Second compile: temp expires
    const p2 = await chef.compile({ target: 'openai' });
    expect(p2.meta?.memoryExpiredKeys).toEqual(['temp']);
    expect(p2.meta?.injectedMemoryKeys).toEqual(['perm']);
  });

  it('compile() returns empty meta when no memory configured', async () => {
    const chef = new ContextChef();
    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.meta).toBeDefined();
    expect(payload.meta?.injectedMemoryKeys).toEqual([]);
    expect(payload.meta?.memoryExpiredKeys).toEqual([]);
  });
});

// ─── selector ────────────────────────────────────────────────────────────────

describe('Memory selector', () => {
  it('filters entries in toXml()', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      selector: (entries) => entries.filter((e) => e.key !== 'excluded'),
    });
    await mem.set('kept', 'yes');
    await mem.set('excluded', 'no');

    const xml = await mem.toXml();
    expect(xml).toContain('<entry key="kept"');
    expect(xml).toContain('yes');
    expect(xml).not.toContain('excluded');
  });

  it('sorts entries in toXml()', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      selector: (entries) => entries.sort((a, b) => a.key.localeCompare(b.key)),
    });
    await mem.set('z_rule', 'last');
    await mem.set('a_rule', 'first');

    const xml = await mem.toXml();
    const aPos = xml.indexOf('key="a_rule"');
    const zPos = xml.indexOf('key="z_rule"');
    expect(aPos).toBeLessThan(zPos);
  });

  it('truncates entries via slice', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      selector: (entries) =>
        entries.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, 2),
    });
    await mem.set('low', 'v1', { importance: 1 });
    await mem.set('mid', 'v2', { importance: 5 });
    await mem.set('high', 'v3', { importance: 10 });

    const xml = await mem.toXml();
    // Only the 2 highest importance should be present
    expect(xml).toContain('key="high"');
    expect(xml).toContain('v3');
    expect(xml).toContain('key="mid"');
    expect(xml).toContain('v2');
    expect(xml).not.toContain('key="low"');
  });

  it('returns empty XML when selector filters out all entries', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      selector: () => [],
    });
    await mem.set('key', 'val');

    const xml = await mem.toXml();
    expect(xml).toBe('');
  });

  it('does not affect getAll() — only toXml()', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      selector: (entries) => entries.filter((e) => e.key === 'kept'),
    });
    await mem.set('kept', 'yes');
    await mem.set('hidden', 'no');

    // getAll() returns everything
    expect(await mem.getAll()).toHaveLength(2);
    // toXml() respects selector
    const xml = await mem.toXml();
    expect(xml).not.toContain('hidden');
  });

  it('selector receives entries with full metadata', async () => {
    const selectorSpy = vi.fn((entries) => entries);
    const mem = new Memory({
      store: new InMemoryStore(),
      selector: selectorSpy,
    });
    await mem.set('key', 'val', { importance: 8 });

    await mem.toXml();

    expect(selectorSpy).toHaveBeenCalledTimes(1);
    const received = selectorSpy.mock.calls[0][0];
    expect(received).toHaveLength(1);
    expect(received[0].key).toBe('key');
    expect(received[0].importance).toBe(8);
    expect(received[0].updatedAt).toBeGreaterThan(0);
  });

  it('works with ContextChef compile()', async () => {
    const chef = new ContextChef({
      memory: {
        store: new InMemoryStore(),
        selector: (entries) => entries.filter((e) => e.importance != null && e.importance >= 5),
      },
    });
    await chef.memory().set('important', 'keep', { importance: 10 });
    await chef.memory().set('trivial', 'drop', { importance: 1 });

    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = payload.messages as Array<{ role: string; content: string }>;
    const memMsg = messages.find((m) => m.content.includes('<memory>'));

    expect(memMsg).toBeDefined();
    expect(memMsg?.content).toContain('key="important"');
    expect(memMsg?.content).toContain('keep');
    expect(memMsg?.content).not.toContain('trivial');
  });
});
