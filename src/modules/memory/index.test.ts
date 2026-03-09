import { describe, expect, it, vi } from 'vitest';
import { ContextChef } from '../../index';
import { InMemoryStore } from './inMemoryStore';
import type { MemoryStoreEntry } from './memoryStore';
import { Memory, stripMemoryTags } from '.';

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

  it('toXml() wraps entries in <core_memory>', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('lang', 'TypeScript');
    await mem.set('style', 'functional');

    const xml = await mem.toXml();
    expect(xml).toContain('<core_memory>');
    expect(xml).toContain('<lang>TypeScript</lang>');
    expect(xml).toContain('<style>functional</style>');
    expect(xml).toContain('</core_memory>');
  });

  it('extractAndApply() parses update tags', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    const content = `Sure, I'll remember that.
<update_core_memory key="project_lang">TypeScript</update_core_memory>
<update_core_memory key="test_framework">Vitest</update_core_memory>
Done.`;

    const applied = await mem.extractAndApply(content);
    expect(applied).toHaveLength(2);
    expect(await mem.get('project_lang')).toBe('TypeScript');
    expect(await mem.get('test_framework')).toBe('Vitest');
  });

  it('extractAndApply() parses delete tags', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('old_rule', 'deprecated');

    const content = `Removing old rule.
<delete_core_memory key="old_rule" />`;

    await mem.extractAndApply(content);
    expect(await mem.get('old_rule')).toBeNull();
  });

  it('extractAndApply() handles mixed update and delete', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('to_remove', 'old value');

    const content = `
<update_core_memory key="new_rule">always lint</update_core_memory>
<delete_core_memory key="to_remove" />`;

    const applied = await mem.extractAndApply(content);
    expect(applied).toHaveLength(1);
    expect(applied[0].key).toBe('new_rule');
    expect(applied[0].value).toBe('always lint');
    expect(await mem.get('to_remove')).toBeNull();
    expect(await mem.get('new_rule')).toBe('always lint');
  });

  it('extractAndApply() returns empty for content without tags', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    const applied = await mem.extractAndApply('Just a normal response with no memory tags.');
    expect(applied).toHaveLength(0);
  });

  it('snapshot() returns entries and turnCount from InMemoryStore', async () => {
    const store = new InMemoryStore();
    const mem = new Memory({ store });
    await mem.set('k1', 'v1');

    const snap = mem.snapshot();
    expect(snap).not.toBeNull();
    expect(snap!.entries.k1.value).toBe('v1');
    expect(snap!.entries.k1.updateCount).toBe(1);
    expect(snap!.turnCount).toBe(0);
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
    expect(entry!.key).toBe('project');
    expect(entry!.value).toBe('context-chef');
    expect(entry!.updateCount).toBe(1);
    expect(entry!.createdAt).toBeGreaterThan(0);
    expect(entry!.updatedAt).toBeGreaterThanOrEqual(entry!.createdAt);
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
    expect(entry!.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry!.createdAt).toBeLessThanOrEqual(after);
    expect(entry!.updatedAt).toBeGreaterThanOrEqual(before);
    expect(entry!.updateCount).toBe(1);
  });

  it('set() updates preserve createdAt and increment updateCount', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('key', 'v1');
    const first = await mem.getEntry('key');

    await mem.set('key', 'v2');
    const second = await mem.getEntry('key');

    expect(second!.value).toBe('v2');
    expect(second!.createdAt).toBe(first!.createdAt);
    expect(second!.updateCount).toBe(2);
    expect(second!.updatedAt).toBeGreaterThanOrEqual(first!.updatedAt);
  });

  it('set() with importance option', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('important', 'critical', { importance: 10 });

    const entry = await mem.getEntry('important');
    expect(entry!.importance).toBe(10);
  });

  it('toXml() includes all entries', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('rule1', 'always lint');
    await mem.set('rule2', 'use strict');

    const xml = await mem.toXml();
    expect(xml).toContain('<rule1>always lint</rule1>');
    expect(xml).toContain('<rule2>use strict</rule2>');
  });

  it('getAll() returns entries with full metadata', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    await mem.set('a', '1');
    await mem.set('b', '2');

    const all = await mem.getAll();
    expect(all).toHaveLength(2);

    const a = all.find((e) => e.key === 'a')!;
    expect(a.value).toBe('1');
    expect(a.updateCount).toBe(1);
  });
});

// ─── TTL (turn-based) ───────────────────────────────────────────────────────

describe('Memory TTL (turn-based)', () => {
  it('bare number TTL sets expiresAtTurn', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: 3 });
    await mem.set('key', 'val');

    const entry = await mem.getEntry('key');
    expect(entry!.expiresAtTurn).toBe(3); // turnCount=0 + 3
    expect(entry!.expiresAt).toBeUndefined();
  });

  it('{ turns: N } TTL sets expiresAtTurn', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: { turns: 5 } });
    mem.advanceTurn(); // turn 1
    await mem.set('key', 'val');

    const entry = await mem.getEntry('key');
    expect(entry!.expiresAtTurn).toBe(6); // turnCount=1 + 5
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

  it('extractAndApply() entries respect defaultTTL', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: 2 });
    await mem.extractAndApply('<update_core_memory key="lang">TS</update_core_memory>');

    const entry = await mem.getEntry('lang');
    expect(entry!.expiresAtTurn).toBe(2);
  });
});

// ─── TTL (ms-based) ─────────────────────────────────────────────────────────

describe('Memory TTL (ms-based)', () => {
  it('{ ms: N } TTL sets expiresAt timestamp', async () => {
    const mem = new Memory({ store: new InMemoryStore(), defaultTTL: { ms: 5000 } });
    const before = Date.now();
    await mem.set('key', 'val');

    const entry = await mem.getEntry('key');
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(before + 5000);
    expect(entry!.expiresAtTurn).toBeUndefined();
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
  it('allows updates to keys in the allowlist', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['lang', 'style'],
    });

    const content = '<update_core_memory key="lang">TS</update_core_memory>';
    const applied = await mem.extractAndApply(content);

    expect(applied).toHaveLength(1);
    expect(await mem.get('lang')).toBe('TS');
  });

  it('silently skips updates to keys NOT in the allowlist', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['lang'],
    });

    const content = '<update_core_memory key="rogue_key">hack</update_core_memory>';
    const applied = await mem.extractAndApply(content);

    expect(applied).toHaveLength(0);
    expect(await mem.get('rogue_key')).toBeNull();
  });

  it('silently skips deletes to keys NOT in the allowlist', async () => {
    const mem = new Memory({ store: new InMemoryStore(), allowedKeys: ['other'] });
    await mem.set('protected', 'important');

    const content = '<delete_core_memory key="protected" />';
    await mem.extractAndApply(content);

    expect(await mem.get('protected')).toBe('important');
  });

  it('mixed allowed and disallowed keys: only allowed keys are applied', async () => {
    const mem = new Memory({
      store: new InMemoryStore(),
      allowedKeys: ['lang', 'style'],
    });

    const content = `
<update_core_memory key="lang">TypeScript</update_core_memory>
<update_core_memory key="unknown">rejected</update_core_memory>
<update_core_memory key="style">functional</update_core_memory>`;

    const applied = await mem.extractAndApply(content);
    expect(applied).toHaveLength(2);
    expect(applied.map((e) => e.key)).toEqual(['lang', 'style']);
    expect(await mem.get('unknown')).toBeNull();
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
  it('calls hook with (key, value, oldValue) for updates', async () => {
    const hook = vi.fn().mockReturnValue(true);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });
    await mem.set('existing', 'old');

    const content = '<update_core_memory key="existing">new</update_core_memory>';
    await mem.extractAndApply(content);

    expect(hook).toHaveBeenCalledWith('existing', 'new', 'old');
    expect(await mem.get('existing')).toBe('new');
  });

  it('calls hook with (key, null, oldValue) for deletes', async () => {
    const hook = vi.fn().mockReturnValue(true);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });
    await mem.set('doomed', 'bye');

    const content = '<delete_core_memory key="doomed" />';
    await mem.extractAndApply(content);

    expect(hook).toHaveBeenCalledWith('doomed', null, 'bye');
    expect(await mem.get('doomed')).toBeNull();
  });

  it('blocks update when hook returns false', async () => {
    const hook = vi.fn().mockReturnValue(false);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });

    const content = '<update_core_memory key="blocked">val</update_core_memory>';
    const applied = await mem.extractAndApply(content);

    expect(applied).toHaveLength(0);
    expect(await mem.get('blocked')).toBeNull();
  });

  it('blocks delete when hook returns false', async () => {
    const hook = vi.fn().mockReturnValue(false);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });
    await mem.set('protected', 'keep');

    const content = '<delete_core_memory key="protected" />';
    await mem.extractAndApply(content);

    expect(await mem.get('protected')).toBe('keep');
  });

  it('supports async hook', async () => {
    const hook = vi.fn().mockResolvedValue(true);
    const mem = new Memory({ store: new InMemoryStore(), onMemoryUpdate: hook });

    const content = '<update_core_memory key="async_key">val</update_core_memory>';
    await mem.extractAndApply(content);

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

    const content = '<update_core_memory key="disallowed">val</update_core_memory>';
    await mem.extractAndApply(content);

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

  it('fires on extractAndApply() writes', async () => {
    const hook = vi.fn();
    const mem = new Memory({ store: new InMemoryStore(), onMemoryChanged: hook });

    await mem.extractAndApply('<update_core_memory key="lang">TS</update_core_memory>');

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0].type).toBe('set');
    expect(hook.mock.calls[0][0].key).toBe('lang');
    expect(hook.mock.calls[0][0].value).toBe('TS');
  });

  it('fires on extractAndApply() deletes', async () => {
    const hook = vi.fn();
    const mem = new Memory({ store: new InMemoryStore(), onMemoryChanged: hook });
    await mem.set('old', 'val');
    hook.mockClear();

    await mem.extractAndApply('<delete_core_memory key="old" />');

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

  it('compile() injects core memory block with getCoreMemoryBlock prompt', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    await chef.memory().set('rule', 'be concise');

    chef.setTopLayer([{ role: 'system', content: 'You are a helpful assistant.' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hello' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = payload.messages as Array<{ role: string; content: string }>;

    const memMsg = messages.find((m) => m.content.includes('<core_memory>'));
    expect(memMsg).toBeDefined();
    expect(memMsg!.content).toContain('update_core_memory');
    expect(memMsg!.content).toContain('<rule>be concise</rule>');
    expect(memMsg!.content).toContain('persistent core memory');
    expect(memMsg!.content).toContain('Existing memory keys: rule');
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

    const memMsg = messages.find((m) => m.content.includes('<core_memory>'));
    expect(memMsg).toBeDefined();
    expect(memMsg!.content).toContain('Allowed memory keys: lang, style');
    expect(memMsg!.content).toContain('ONLY');
  });

  it('compile() injects CORE_MEMORY_INSTRUCTION even when no memories exist', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = payload.messages as Array<{ role: string; content: string }>;

    expect(messages).toHaveLength(3);
    const memMsg = messages.find((m) => m.content.includes('update_core_memory'));
    expect(memMsg).toBeDefined();
    expect(memMsg!.content).not.toContain('<core_memory>');
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

  it('snapshot without memory has no _memory field', () => {
    const chef = new ContextChef();
    const snap = chef.snapshot();
    expect(snap._memory).toBeUndefined();
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

    const memMsg = messages.find((m) => m.content.includes('<core_memory>'));
    expect(memMsg).toBeDefined();
    expect(memMsg!.content).toContain('<perm>stays</perm>');
    expect(memMsg!.content).not.toContain('temp');
    expect(memMsg!.content).not.toContain('will expire');
  });

  it('compile() returns meta.injectedMemoryKeys', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    await chef.memory().set('lang', 'TS');
    await chef.memory().set('style', 'functional');

    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.meta).toBeDefined();
    expect(payload.meta!.injectedMemoryKeys.sort()).toEqual(['lang', 'style']);
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
    expect(p1.meta!.memoryExpiredKeys).toEqual([]);
    expect(p1.meta!.injectedMemoryKeys.sort()).toEqual(['perm', 'temp']);

    // Second compile: temp expires
    const p2 = await chef.compile({ target: 'openai' });
    expect(p2.meta!.memoryExpiredKeys).toEqual(['temp']);
    expect(p2.meta!.injectedMemoryKeys).toEqual(['perm']);
  });

  it('compile() returns empty meta when no memory configured', async () => {
    const chef = new ContextChef();
    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    expect(payload.meta).toBeDefined();
    expect(payload.meta!.injectedMemoryKeys).toEqual([]);
    expect(payload.meta!.memoryExpiredKeys).toEqual([]);
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
    expect(xml).toContain('<kept>yes</kept>');
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
    const aPos = xml.indexOf('<a_rule>');
    const zPos = xml.indexOf('<z_rule>');
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
    expect(xml).toContain('<high>v3</high>');
    expect(xml).toContain('<mid>v2</mid>');
    expect(xml).not.toContain('<low>');
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
    const memMsg = messages.find((m) => m.content.includes('<core_memory>'));

    expect(memMsg).toBeDefined();
    expect(memMsg!.content).toContain('<important>keep</important>');
    expect(memMsg!.content).not.toContain('trivial');
  });
});

// ─── stripMemoryTags ─────────────────────────────────────────────────────────

describe('stripMemoryTags', () => {
  it('strips update tags', () => {
    const input = `Sure, I'll remember that.
<update_core_memory key="lang">TypeScript</update_core_memory>
Done.`;
    expect(stripMemoryTags(input)).toBe("Sure, I'll remember that.\n\nDone.");
  });

  it('strips delete tags', () => {
    const input = `Removing old rule.
<delete_core_memory key="old_rule" />
OK.`;
    expect(stripMemoryTags(input)).toBe('Removing old rule.\n\nOK.');
  });

  it('strips mixed update and delete tags', () => {
    const input = `Updating memory.
<update_core_memory key="lang">TS</update_core_memory>
<delete_core_memory key="old" />
All done.`;
    expect(stripMemoryTags(input)).toBe('Updating memory.\n\n\nAll done.');
  });

  it('returns content unchanged when no tags present', () => {
    const input = 'Just a normal response with no memory tags.';
    expect(stripMemoryTags(input)).toBe(input);
  });

  it('returns empty string for tag-only content', () => {
    const input = '<update_core_memory key="k">v</update_core_memory>';
    expect(stripMemoryTags(input)).toBe('');
  });

  it('handles multiline values inside update tags', () => {
    const input = `Before.
<update_core_memory key="rules">rule 1
rule 2
rule 3</update_core_memory>
After.`;
    expect(stripMemoryTags(input)).toBe('Before.\n\nAfter.');
  });
});
