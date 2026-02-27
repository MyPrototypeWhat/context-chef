import { describe, expect, it, vi } from 'vitest';
import { ContextChef } from '../../index';
import { InMemoryStore } from './inMemoryStore';
import { Memory } from '.';

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
    expect(applied[0]).toEqual({ key: 'new_rule', value: 'always lint' });
    expect(await mem.get('to_remove')).toBeNull();
    expect(await mem.get('new_rule')).toBe('always lint');
  });

  it('extractAndApply() returns empty for content without tags', async () => {
    const mem = new Memory({ store: new InMemoryStore() });
    const applied = await mem.extractAndApply('Just a normal response with no memory tags.');
    expect(applied).toHaveLength(0);
  });

  it('snapshot() returns entries from InMemoryStore', () => {
    const store = new InMemoryStore();
    store.set('k1', 'v1');
    const mem = new Memory({ store });

    const snap = mem.snapshot();
    expect(snap).toEqual({ k1: 'v1' });
  });

  it('restore() replaces store contents', () => {
    const store = new InMemoryStore();
    store.set('k1', 'v1');
    const mem = new Memory({ store });

    mem.restore({ k2: 'v2', k3: 'v3' });
    expect(store.get('k1')).toBeNull();
    expect(store.get('k2')).toBe('v2');
    expect(store.get('k3')).toBe('v3');
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
    const store = new InMemoryStore();
    store.set('protected', 'important');
    const mem = new Memory({ store, allowedKeys: ['other'] });

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
    const store = new InMemoryStore();
    store.set('protected', 'keep');
    const mem = new Memory({ store, onMemoryUpdate: hook });

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

  it('compile() skips memory injection when no memories exist', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    chef.setTopLayer([{ role: 'system', content: 'system' }]);
    chef.useRollingHistory([{ role: 'user', content: 'hi' }]);

    const payload = await chef.compile({ target: 'openai' });
    const messages = payload.messages as Array<{ role: string; content: string }>;

    // No core_memory message injected
    expect(messages).toHaveLength(2);
  });

  it('snapshot/restore includes memory store state (InMemoryStore)', async () => {
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });
    await chef.memory().set('key1', 'val1');

    const snap = chef.snapshot('before change');

    await chef.memory().set('key1', 'changed');
    await chef.memory().set('key2', 'new');

    chef.restore(snap);

    expect(await chef.memory().get('key1')).toBe('val1');
    expect(await chef.memory().get('key2')).toBeNull();
  });

  it('snapshot without memory has no _memoryStore field', () => {
    const chef = new ContextChef();
    const snap = chef.snapshot();
    expect(snap._memoryStore).toBeUndefined();
  });
});
