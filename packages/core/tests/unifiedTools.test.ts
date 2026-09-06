/**
 * Phase 4b at the chef level: the `tools` mode decides what `compile()` emits,
 * `ownsTool` / `handleTool` decide what comes back, and `ChefConfig.store`
 * decides where any of it lives.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type ChefConfig,
  ContextChef,
  getContextToolDefinition,
  InMemoryBackend,
  Store,
} from '../src/index';
import { InMemoryStore } from '../src/modules/memory/inMemoryStore';
import type { ChefLogger, Message, TargetPayload, ToolDefinition } from '../src/types';

const silent: ChefLogger = { warn: () => {} };

const TARGETS = ['openai', 'anthropic', 'gemini'] as const;

const conversation: Message[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
  { role: 'user', content: 'and now?' },
];

function chef(config: ChefConfig = {}): ContextChef {
  return new ContextChef({ logger: silent, store: new InMemoryBackend(), ...config })
    .setSystemPrompt([{ role: 'system', content: 'You are helpful.' }])
    .setHistory(conversation);
}

const toolNames = (payload: TargetPayload): string[] =>
  (payload.tools ?? []).map((tool: ToolDefinition) => tool.name);

describe("tools: 'unified'", () => {
  it('emits `context` and drops the legacy memory tools', async () => {
    const payload = await chef({ tools: 'unified', memory: {} }).compile();
    expect(toolNames(payload)).toEqual(['context']);
  });

  it('emits `context` even without memory — notes/ is always available', async () => {
    const payload = await chef({ tools: 'unified' }).compile();
    expect(toolNames(payload)).toEqual(['context']);
  });

  it('adds `new_context` only when a handoff budget is configured', async () => {
    const without = await chef({ tools: 'unified' }).compile();
    expect(toolNames(without)).toEqual(['context']);

    const withHandoff = await chef({
      tools: 'unified',
      overflow: { handoff: { budgetTokens: 500 } },
    }).compile();
    expect(toolNames(withHandoff)).toEqual(['context', 'new_context']);
  });

  it('keeps the pruner tools ahead of the library tools', async () => {
    const instance = chef({ tools: 'unified', memory: {} });
    instance.registerTools([{ name: 'read_file', description: 'Reads a file.' }]);

    expect(toolNames(await instance.compile())).toEqual(['read_file', 'context']);
  });

  it('emits the identical tool list on every target', async () => {
    for (const target of TARGETS) {
      const payload = await chef({ tools: 'unified', memory: {} }).compile({ target });
      expect(toolNames(payload)).toEqual(['context']);
    }
  });

  it('reuses the same definition object across compiles and chefs', async () => {
    const instance = chef({ tools: 'unified' });
    const first = await instance.compile();
    const second = await instance.compile();

    expect(first.tools?.[0]).toBe(second.tools?.[0]);
    expect(first.tools?.[0]).toBe(getContextToolDefinition());
  });

  it('hands out a fresh tools array the caller may reorder', async () => {
    const instance = chef({ tools: 'unified' });
    const payload = await instance.compile();
    payload.tools?.push({ name: 'extra', description: 'x' });

    expect(toolNames(await instance.compile())).toEqual(['context']);
  });
});

describe("tools: 'legacy' (default)", () => {
  it('emits the legacy memory tools and no context tool', async () => {
    const payload = await chef({ memory: {} }).compile();
    expect(toolNames(payload)).toEqual(['create_memory', 'modify_memory']);
  });

  it('emits no library tools at all without memory', async () => {
    const payload = await chef().compile();
    expect(payload.tools).toBeUndefined();
  });

  it('is what an unset `tools` resolves to', async () => {
    const explicit = await chef({ tools: 'legacy', memory: {} }).compile();
    const implicit = await chef({ memory: {} }).compile();
    expect(toolNames(explicit)).toEqual(toolNames(implicit));
  });
});

describe('ownsTool / handleTool', () => {
  const owned = ['context', 'new_context', 'create_memory', 'modify_memory', 'recall_context'];
  const foreign = ['read_file', 'load_toolkit', 'contexts', ''];

  it('owns the five library tools in either mode', () => {
    for (const mode of ['legacy', 'unified'] as const) {
      const instance = chef({ tools: mode });
      for (const name of owned) expect(instance.ownsTool(name)).toBe(true);
      for (const name of foreign) expect(instance.ownsTool(name)).toBe(false);
    }
  });

  it('throws on a foreign tool name', () => {
    expect(() => chef().handleTool({ name: 'read_file', arguments: {} })).toThrow(
      /does not own that tool/,
    );
  });

  it('round-trips a note through the context tool', async () => {
    const instance = chef({ tools: 'unified' });

    expect(
      await instance.handleTool({
        name: 'context',
        arguments: { command: 'create', path: 'notes/plan.md', file_text: 'step one' },
      }),
    ).toBe('Created context://notes/plan.md.');
    expect(
      await instance.handleTool({
        name: 'context',
        arguments: JSON.stringify({ command: 'view', path: 'context://notes/plan.md' }),
      }),
    ).toBe('     1\tstep one');
  });

  it('routes memory writes through the module hooks', async () => {
    const onMemoryUpdate = vi.fn().mockReturnValue(false);
    const instance = chef({ tools: 'unified', memory: { onMemoryUpdate } });

    const result = await instance.handleTool({
      name: 'create_memory',
      arguments: { key: 'k', value: 'v' },
    });

    expect(result).toBe('Error: the write to context://memory/k was rejected by the host.');
    expect(onMemoryUpdate).toHaveBeenCalledWith('k', 'v', null);
  });

  it('emits memory:changed for a tool-driven write', async () => {
    const instance = chef({ tools: 'unified', memory: {} });
    const changed = vi.fn();
    instance.on('memory:changed', changed);

    await instance.handleTool({ name: 'create_memory', arguments: { key: 'k', value: 'v' } });

    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set', key: 'k' }),
      undefined,
    );
  });

  it('new_context forces the next compile to overflow', async () => {
    const applied = vi.fn();
    const instance = new ContextChef({
      logger: silent,
      janitor: { contextWindow: 1_000_000, tokenizer: (messages) => messages.length },
      overflow: {
        strategy: {
          name: 'spy',
          async apply(input) {
            applied();
            return {
              history: input.history.slice(1),
              evicted: input.history.slice(0, 1),
              meta: { strategy: 'spy', windowId: input.window.current, changed: true },
            };
          },
        },
      },
    }).setHistory(conversation);

    await instance.compile();
    expect(applied).not.toHaveBeenCalled();

    expect(await instance.handleTool({ name: 'new_context' })).toBe(
      'Starting a new context window.',
    );
    await instance.compile();
    expect(applied).toHaveBeenCalledTimes(1);

    // One request, one compile.
    await instance.compile();
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('denies a write the policy does not cover', async () => {
    const instance = chef({
      tools: 'unified',
      memory: {},
      contextTool: { writable: ['notes'] },
    });
    const result = await instance.handleTool({
      name: 'create_memory',
      arguments: { key: 'k', value: 'v' },
    });

    expect(result).toBe('Error: context://memory/k is read-only.');
  });

  it('reads back content the chef offloaded', async () => {
    const instance = chef({ vfs: { threshold: 10 } });
    const marker = await instance.offloadAsync('x'.repeat(5000));
    const uri = marker.match(/context:\/\/vfs\/\S+?\.txt/)?.[0];

    expect(uri).toBeDefined();
    expect(await instance.handleTool({ name: 'recall_context', arguments: { uri } })).toBe(
      'x'.repeat(5000),
    );
  });
});

describe('ChefConfig.store', () => {
  it('serves memory and the vfs from one backend', async () => {
    const backend = new InMemoryBackend();
    const instance = new ContextChef({ logger: silent, store: backend, memory: {} });

    await instance.getMemory().set('k', 'remembered');
    await instance.offloadAsync('y'.repeat(6000));

    expect(backend.list('memory').map((e) => e.path)).toEqual(['k']);
    expect(backend.list('vfs')).toHaveLength(1);
    expect(instance.getStore().backend).toBe(backend);
    expect(instance.getOffloader().store).toBe(instance.getStore());
  });

  it('accepts a pre-built Store', () => {
    const store = new Store(new InMemoryBackend());
    const instance = new ContextChef({ logger: silent, store, memory: {} });

    expect(instance.getStore()).toBe(store);
  });

  it('lets an explicit memory.store win for memory only', async () => {
    const shared = new InMemoryBackend();
    const legacy = new InMemoryStore();
    const instance = new ContextChef({
      logger: silent,
      store: shared,
      memory: { store: legacy },
    });

    await instance.getMemory().set('k', 'v');
    await instance.offloadAsync('z'.repeat(6000));

    expect(await legacy.keys()).toEqual(['k']);
    expect(shared.list('memory')).toEqual([]);
    expect(shared.list('vfs')).toHaveLength(1);
    expect(instance.getStore().backend).toBe(shared);
  });

  it('lets an explicit vfs.store win for the vfs only', async () => {
    const shared = new InMemoryBackend();
    const vfsBackend = new InMemoryBackend();
    const instance = new ContextChef({
      logger: silent,
      store: shared,
      vfs: { store: vfsBackend },
      memory: {},
    });

    await instance.getMemory().set('k', 'v');
    await instance.offloadAsync('q'.repeat(6000));

    expect(shared.list('memory').map((e) => e.path)).toEqual(['k']);
    expect(shared.list('vfs')).toEqual([]);
    expect(vfsBackend.list('vfs')).toHaveLength(1);
    // getStore() reports the shared store; the Offloader keeps its own.
    expect(instance.getStore().backend).toBe(shared);
    expect(instance.getOffloader().store.backend).toBe(vfsBackend);
  });

  it('falls back to the Offloader store when nothing is shared', () => {
    const vfsBackend = new InMemoryBackend();
    const instance = new ContextChef({ logger: silent, vfs: { store: vfsBackend } });

    expect(instance.getStore()).toBe(instance.getOffloader().store);
  });

  it('rejects memory without any store', () => {
    expect(() => new ContextChef({ logger: silent, memory: {} })).toThrow(
      /memory is configured without a store/,
    );
  });

  it('backs the notes namespace the context tool writes to', async () => {
    const backend = new InMemoryBackend();
    const instance = new ContextChef({ logger: silent, store: backend, tools: 'unified' });

    await instance.handleTool({
      name: 'context',
      arguments: { command: 'create', path: 'notes/a.md', file_text: 'body' },
    });

    expect(backend.read('notes', 'a.md')?.content).toBe('body');
  });
});
