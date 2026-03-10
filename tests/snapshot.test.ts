import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ContextChef } from '../src/index';
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
    chef.useRollingHistory([userMsg('hello'), assistantMsg('hi')]);

    const snap = chef.snapshot('test label');

    expect(snap.rollingHistory).toHaveLength(2);
    expect(snap.rollingHistory[0].content).toBe('hello');
    expect(snap.label).toBe('test label');
    expect(snap.createdAt).toBeGreaterThan(0);
  });

  it('restore rolls back rollingHistory', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.useRollingHistory([userMsg('turn 1')]);

    const snap = chef.snapshot();

    chef.useRollingHistory([userMsg('turn 1'), assistantMsg('reply'), userMsg('turn 2')]);
    expect(chef.snapshot().rollingHistory).toHaveLength(3);

    chef.restore(snap);
    expect(chef.snapshot().rollingHistory).toHaveLength(1);
    expect(chef.snapshot().rollingHistory[0].content).toBe('turn 1');
  });

  it('restore rolls back topLayer', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.setTopLayer([{ role: 'system', content: 'original system' }]);
    const snap = chef.snapshot();

    chef.setTopLayer([{ role: 'system', content: 'modified system' }]);
    chef.restore(snap);

    expect(chef.snapshot().topLayer[0].content).toBe('original system');
  });

  it('restore rolls back dynamicStatePlacement and rawDynamicXml', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    const schema = z.object({ key: z.string() });
    chef.setDynamicState(schema, { key: 'value' }, { placement: 'system' });

    const snap = chef.snapshot();
    expect(snap.dynamicStatePlacement).toBe('system');
    expect(snap.rawDynamicXml).toContain('<key>value</key>');

    chef.setDynamicState(schema, { key: 'other' }, { placement: 'last_user' });
    chef.restore(snap);

    const restored = chef.snapshot();
    expect(restored.dynamicStatePlacement).toBe('system');
    expect(restored.rawDynamicXml).toContain('<key>value</key>');
  });

  it('snapshot is a deep copy — mutating original does not affect snapshot', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    const history = [userMsg('original')];
    chef.useRollingHistory(history);

    const snap = chef.snapshot();

    chef.useRollingHistory([userMsg('original'), assistantMsg('new message')]);

    expect(snap.rollingHistory).toHaveLength(1);
    expect(snap.rollingHistory[0].content).toBe('original');
  });

  it('restore is a deep copy — mutating snapshot after restore does not affect chef', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.useRollingHistory([userMsg('original')]);
    const snap = chef.snapshot();

    chef.restore(snap);

    (snap.rollingHistory[0] as Message).content = 'mutated';

    expect(chef.snapshot().rollingHistory[0].content).toBe('original');
  });

  it('supports multiple snapshots and restores to any of them', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });

    chef.useRollingHistory([userMsg('step 1')]);
    const snap1 = chef.snapshot('step 1');

    chef.useRollingHistory([userMsg('step 1'), assistantMsg('reply 1'), userMsg('step 2')]);
    const snap2 = chef.snapshot('step 2');

    const current = chef.snapshot().rollingHistory;
    chef.useRollingHistory([...current, assistantMsg('reply 2'), userMsg('step 3')]);

    chef.restore(snap1);
    expect(chef.snapshot().rollingHistory).toHaveLength(1);

    chef.restore(snap2);
    expect(chef.snapshot().rollingHistory).toHaveLength(3);
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

    chef.feedTokenUsage(999);

    const snap = chef.snapshot();
    expect(snap.modules.janitor.externalTokenUsage).toBe(999);

    chef.feedTokenUsage(0);

    chef.restore(snap);

    const restored = chef.snapshot();
    expect(restored.modules.janitor.externalTokenUsage).toBe(999);
  });

  it('agent branching pattern: snapshot before fork, restore on failure', () => {
    const chef = new ContextChef({
      janitor: { contextWindow: 1000, tokenizer: makeTokenizer(10) },
    });
    chef.useRollingHistory([userMsg('task: do something risky')]);

    const beforeFork = chef.snapshot('before risky tool call');

    chef.useRollingHistory([
      ...chef.snapshot().rollingHistory,
      assistantMsg('attempting risky action...'),
      { role: 'tool', content: 'ERROR: action failed', tool_call_id: 't1' },
    ]);
    expect(chef.snapshot().rollingHistory).toHaveLength(3);

    chef.restore(beforeFork);
    expect(chef.snapshot().rollingHistory).toHaveLength(1);
    expect(chef.snapshot().rollingHistory[0].content).toBe('task: do something risky');
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
    expect(chef.tools().getAllTools()).toHaveLength(2);

    // Restore rolls back to original tools
    chef.restore(snap);
    expect(chef.tools().getAllTools()).toHaveLength(1);
    expect(chef.tools().getAllTools()[0].name).toBe('read_file');
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
    const extracted = chef.tools().extractToolkit('Weather');
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
});
