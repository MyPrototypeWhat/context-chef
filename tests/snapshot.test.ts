import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContextChef, InMemoryStore } from '../src/index';
import { VFSMemoryStore } from '../src/modules/memory/vfsMemoryStore';
import type { Message, ToolDefinition } from '../src/types';

const userMsg = (content: string): Message => ({ role: 'user', content });
const assistantMsg = (content: string): Message => ({ role: 'assistant', content });

const makeTokenizer =
  (tokensPerMsg: number) =>
  (messages: Message[]): number =>
    messages.length * tokensPerMsg;

describe('E3: Snapshot & Restore', () => {
  it('snapshot captures current state', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setHistory([userMsg('hello'), assistantMsg('hi')]);

    const snap = chef.snapshot('test label');

    expect(snap.history).toHaveLength(2);
    expect(snap.history[0].content).toBe('hello');
    expect(snap.label).toBe('test label');
    expect(snap.createdAt).toBeGreaterThan(0);
  });

  it('restore rolls back history', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setHistory([userMsg('turn 1')]);

    const snap = chef.snapshot();

    chef.setHistory([userMsg('turn 1'), assistantMsg('reply'), userMsg('turn 2')]);
    expect(chef.snapshot().history).toHaveLength(3);

    chef.restore(snap);
    expect(chef.snapshot().history).toHaveLength(1);
    expect(chef.snapshot().history[0].content).toBe('turn 1');
  });

  it('restore rolls back systemPrompt', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setSystemPrompt([{ role: 'system', content: 'original system' }]);
    const snap = chef.snapshot();

    chef.setSystemPrompt([{ role: 'system', content: 'modified system' }]);
    chef.restore(snap);

    expect(chef.snapshot().systemPrompt[0].content).toBe('original system');
  });

  it('restore rolls back dynamicStatePlacement and dynamicStateXml', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    const schema = z.object({ key: z.string() });
    chef.setDynamicState(schema, { key: 'value' }, { placement: 'system' });

    const snap = chef.snapshot();
    expect(snap.dynamicStatePlacement).toBe('system');
    expect(snap.dynamicStateXml).toContain('<key>value</key>');

    chef.setDynamicState(schema, { key: 'other' }, { placement: 'last_user' });
    chef.restore(snap);

    const restored = chef.snapshot();
    expect(restored.dynamicStatePlacement).toBe('system');
    expect(restored.dynamicStateXml).toContain('<key>value</key>');
  });

  it('snapshot is a deep copy — mutating original does not affect snapshot', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    const history = [userMsg('original')];
    chef.setHistory(history);

    const snap = chef.snapshot();

    chef.setHistory([userMsg('original'), assistantMsg('new message')]);

    expect(snap.history).toHaveLength(1);
    expect(snap.history[0].content).toBe('original');
  });

  it('restore is a deep copy — mutating snapshot after restore does not affect chef', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setHistory([userMsg('original')]);
    const snap = chef.snapshot();

    chef.restore(snap);

    (snap.history[0] as Message).content = 'mutated';

    expect(chef.snapshot().history[0].content).toBe('original');
  });

  it('supports multiple snapshots and restores to any of them', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });

    chef.setHistory([userMsg('step 1')]);
    const snap1 = chef.snapshot('step 1');

    chef.setHistory([userMsg('step 1'), assistantMsg('reply 1'), userMsg('step 2')]);
    const snap2 = chef.snapshot('step 2');

    const current = chef.snapshot().history;
    chef.setHistory([...current, assistantMsg('reply 2'), userMsg('step 3')]);

    chef.restore(snap1);
    expect(chef.snapshot().history).toHaveLength(1);

    chef.restore(snap2);
    expect(chef.snapshot().history).toHaveLength(3);
  });

  it('restore() returns this for chaining', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    const snap = chef.snapshot();
    const result = chef.restore(snap);
    expect(result).toBe(chef);
  });

  it('Janitor state is captured and restored', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });

    chef.reportTokenUsage(999);

    const snap = chef.snapshot();
    expect(snap.modules.janitor.externalTokenUsage).toBe(999);

    chef.reportTokenUsage(0);

    chef.restore(snap);

    const restored = chef.snapshot();
    expect(restored.modules.janitor.externalTokenUsage).toBe(999);
  });

  it('agent branching pattern: snapshot before fork, restore on failure', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setHistory([userMsg('task: do something risky')]);

    const beforeFork = chef.snapshot('before risky tool call');

    chef.setHistory([
      ...chef.snapshot().history,
      assistantMsg('attempting risky action...'),
      { role: 'tool', content: 'ERROR: action failed', tool_call_id: 't1' },
    ]);
    expect(chef.snapshot().history).toHaveLength(3);

    chef.restore(beforeFork);
    expect(chef.snapshot().history).toHaveLength(1);
    expect(chef.snapshot().history[0].content).toBe('task: do something risky');
  });

  it('snapshot has modules namespace with janitor, memory, and pruner', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });

    const snap = chef.snapshot();

    expect(snap.modules).toBeDefined();
    expect(snap.modules.janitor).toBeDefined();
    expect(snap.modules.memory).toBeNull();
    expect(snap.modules.pruner).toBeDefined();
  });

  it('Pruner flat tools are captured and restored', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    const basicTools: ToolDefinition[] = [
      { name: 'read_file', description: 'Read a file', tags: ['file'] },
    ];
    chef.registerTools(basicTools);

    const snap = chef.snapshot();

    expect(snap.modules.pruner.flatTools).toHaveLength(1);
    expect(snap.modules.pruner.flatTools[0].name).toBe('read_file');

    // Change tools after snapshot
    chef.registerTools([
      { name: 'write_file', description: 'Write a file', tags: ['file'] },
      { name: 'delete_file', description: 'Delete a file', tags: ['file'] },
    ]);
    expect(chef.getPruner().getAllTools()).toHaveLength(2);

    // Restore rolls back to original tools
    chef.restore(snap);
    expect(chef.getPruner().getAllTools()).toHaveLength(1);
    expect(chef.getPruner().getAllTools()[0].name).toBe('read_file');
  });

  it('Pruner namespaces are captured and restored', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.registerNamespaces([
      {
        name: 'file_ops',
        description: 'File operations',
        tools: [{ name: 'read_file', description: 'Read' }],
      },
    ]);

    const snap = chef.snapshot();

    chef.registerNamespaces([]);

    chef.restore(snap);
    expect(snap.modules.pruner.namespaces).toHaveLength(1);
    expect(snap.modules.pruner.namespaces[0].name).toBe('file_ops');
  });

  it('Pruner lazy toolkits are captured and restored', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.registerToolkits([
      {
        name: 'Weather',
        description: 'Weather tools',
        tools: [{ name: 'get_forecast', description: 'Get forecast' }],
      },
    ]);

    const snap = chef.snapshot();

    chef.registerToolkits([]);

    chef.restore(snap);
    const extracted = chef.getPruner().extractToolkit('Weather');
    expect(extracted).toHaveLength(1);
    expect(extracted[0].name).toBe('get_forecast');
  });

  it('Pruner snapshot is a deep copy — mutating tools does not affect snapshot', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.registerTools([{ name: 'tool_a', description: 'A' }]);

    const snap = chef.snapshot();

    chef.registerTools([{ name: 'tool_b', description: 'B' }]);

    expect(snap.modules.pruner.flatTools).toHaveLength(1);
    expect(snap.modules.pruner.flatTools[0].name).toBe('tool_a');
  });

  it('deep clone: nested tool_calls are isolated between snapshot and chef', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    const msgWithToolCalls: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'foo', arguments: '{}' } }],
    };
    chef.setHistory([msgWithToolCalls]);

    const snap = chef.snapshot();

    // Mutate the original message's nested tool_calls
    msgWithToolCalls.tool_calls[0].function.name = 'mutated';

    expect(snap.history[0].tool_calls?.[0].function.name).toBe('foo');
  });

  it('deep clone: nested thinking is isolated between snapshot and chef', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setHistory([
      {
        role: 'assistant',
        content: 'reply',
        thinking: { thinking: 'original thought', signature: 'sig1' },
      },
    ]);

    const snap = chef.snapshot();

    // Mutate thinking via a new snapshot
    const snap2 = chef.snapshot();
    (snap2.history[0] as Message).thinking = { thinking: 'mutated' };

    expect(snap.history[0].thinking?.thinking).toBe('original thought');
  });

  it('deep clone: tool parameters are isolated in pruner snapshot', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    const params = { type: 'object', properties: { path: { type: 'string' } } };
    chef.registerTools([{ name: 'read', description: 'Read', parameters: params }]);

    const snap = chef.snapshot();

    // Mutate the original parameters object
    (params.properties as Record<string, unknown>).extra = { type: 'number' };

    expect(snap.modules.pruner.flatTools[0].parameters).not.toHaveProperty('properties.extra');
  });

  it('deep clone: same checkpoint can be restored multiple times', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setHistory([userMsg('original')]);
    const snap = chef.snapshot();

    // First restore + mutate
    chef.restore(snap);
    chef.setHistory([userMsg('after first restore'), assistantMsg('reply')]);

    // Second restore from same snapshot
    chef.restore(snap);
    expect(chef.snapshot().history).toHaveLength(1);
    expect(chef.snapshot().history[0].content).toBe('original');
  });

  it('deep clone: InMemoryStore snapshot isolates entry references', () => {
    const store = new InMemoryStore();
    store.set('key1', {
      value: 'hello',
      createdAt: 1000,
      updatedAt: 1000,
      updateCount: 1,
    });

    const snap = store.snapshot();

    // Mutate via store
    store.set('key1', {
      value: 'mutated',
      createdAt: 1000,
      updatedAt: 2000,
      updateCount: 2,
    });

    expect(snap.key1.value).toBe('hello');
    expect(snap.key1.updateCount).toBe(1);
  });
});

describe('VFSMemoryStore snapshot & restore', () => {
  const testDir = path.join(process.cwd(), '.test_vfs_snapshot');

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('snapshot captures all entries from disk', () => {
    const store = new VFSMemoryStore(testDir);
    store.set('k1', { value: 'v1', createdAt: 1, updatedAt: 1, updateCount: 1 });
    store.set('k2', { value: 'v2', createdAt: 2, updatedAt: 2, updateCount: 1 });

    const snap = store.snapshot();

    expect(Object.keys(snap)).toHaveLength(2);
    expect(snap.k1.value).toBe('v1');
    expect(snap.k2.value).toBe('v2');
  });

  it('restore replaces all entries on disk', () => {
    const store = new VFSMemoryStore(testDir);
    store.set('old', { value: 'will be removed', createdAt: 1, updatedAt: 1, updateCount: 1 });

    const snapData = {
      new1: { value: 'restored1', createdAt: 10, updatedAt: 10, updateCount: 1 },
      new2: { value: 'restored2', createdAt: 20, updatedAt: 20, updateCount: 1 },
    };
    store.restore(snapData);

    expect(store.get('old')).toBeNull();
    expect(store.get('new1')?.value).toBe('restored1');
    expect(store.get('new2')?.value).toBe('restored2');
    expect(store.keys()).toHaveLength(2);
  });

  it('snapshot + restore round-trips correctly', () => {
    const store = new VFSMemoryStore(testDir);
    store.set('a', { value: 'alpha', createdAt: 1, updatedAt: 1, updateCount: 1 });

    const snap = store.snapshot();

    store.set('b', { value: 'beta', createdAt: 2, updatedAt: 2, updateCount: 1 });
    store.delete('a');

    store.restore(snap);

    expect(store.get('a')?.value).toBe('alpha');
    expect(store.get('b')).toBeNull();
    expect(store.keys()).toEqual(['a']);
  });

  it('works with ContextChef snapshot/restore', async () => {
    const store = new VFSMemoryStore(testDir);
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
      memory: { store },
    });

    await chef.getMemory().createMemory('rule', 'always use strict mode');
    const snap = chef.snapshot();

    await chef.getMemory().createMemory('rule2', 'never use var');
    await chef.getMemory().deleteMemory('rule');

    chef.restore(snap);

    expect(store.get('rule')?.value).toBe('always use strict mode');
    expect(store.get('rule2')).toBeNull();
  });
});
