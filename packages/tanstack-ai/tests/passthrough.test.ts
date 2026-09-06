/**
 * Phase 4c passthrough: the axes core grew in 4.2 reach the middleware's own
 * Janitor and Offloader unchanged — an explicit `overflow.strategy` in place
 * of the `compress` tuning, an `overflow.archive` behind the summary's
 * citation, and a `truncate.store` behind the `context://vfs/` URI.
 *
 * There is deliberately no `tools` / `contextTool` option here: this package
 * rewrites messages and never emits tool definitions, so a tools mode would
 * have nothing to reach. Register `getContextToolDefinition()` on a
 * `ContextChef` for that.
 */

import { InMemoryBackend, reset, Store, summarize } from '@context-chef/core';
import type { ChatMiddlewareConfig, ChatMiddlewareContext, ModelMessage } from '@tanstack/ai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contextChefMiddleware } from '../src/middleware';
import { truncateToolResults } from '../src/truncator';

const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
beforeAll(() => warnSpy.mockClear());
afterAll(() => warnSpy.mockRestore());

function createMockCtx(): ChatMiddlewareContext {
  return {
    requestId: 'req_1',
    streamId: 'stream_1',
    runId: 'run_1',
    threadId: 'thread_1',
    phase: 'init',
    iteration: 0,
    chunkIndex: 0,
    abort: vi.fn(),
    defer: vi.fn(),
    context: undefined,
    activity: 'chat',
    provider: 'openai',
    model: 'gpt-4o',
    source: 'server',
    streaming: true,
    systemPrompts: [],
    messageCount: 0,
    hasTools: false,
    currentMessageId: null,
    accumulatedContent: '',
    messages: [],
    createId: (prefix: string) => `${prefix}_1`,
  } as unknown as ChatMiddlewareContext;
}

const config = (messages: ModelMessage[]): ChatMiddlewareConfig =>
  ({ messages, systemPrompts: [], tools: [] }) as ChatMiddlewareConfig;

/** Each message costs 100 tokens against the tiny windows below. */
const tokenizer = (messages: unknown[]): number => messages.length * 100;

const conversation = (turns: number): ModelMessage[] =>
  Array.from({ length: turns }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `turn-${i + 1}: ${'context '.repeat(20)}`,
  }));

describe('overflow passthrough', () => {
  it('runs the configured strategy instead of the compress defaults', async () => {
    const compressionModel = vi.fn(async () => '<summary>STRATEGY SUMMARY</summary>');
    const mw = contextChefMiddleware({
      contextWindow: 10,
      tokenizer,
      overflow: { strategy: summarize({ compressionModel, preserveRecentMessages: 1 }) },
    });

    const messages = conversation(6);
    const result = await mw.onConfig?.(createMockCtx(), config(messages));

    expect(compressionModel).toHaveBeenCalled();
    expect(result?.messages?.length ?? messages.length).toBeLessThan(messages.length);
    expect(JSON.stringify(result?.messages)).toContain('STRATEGY SUMMARY');
  });

  it('opens a budget check on a strategy alone, with no compress block', async () => {
    const mw = contextChefMiddleware({
      contextWindow: 10,
      tokenizer,
      overflow: { strategy: reset() },
    });

    const messages = conversation(6);
    const result = await mw.onConfig?.(createMockCtx(), config(messages));

    expect(result?.messages?.length ?? messages.length).toBeLessThan(messages.length);
    expect(JSON.stringify(result?.messages)).toContain('Context window reset');
  });

  it('requires a contextWindow once a strategy is configured', () => {
    expect(() => contextChefMiddleware({ overflow: { strategy: reset() } })).toThrow(
      /`contextWindow` is required/,
    );
  });

  it('archives the evicted span and cites it in the summary', async () => {
    const archive = new Store(new InMemoryBackend()).namespace('archive');
    const mw = contextChefMiddleware({
      contextWindow: 10,
      tokenizer,
      overflow: {
        strategy: summarize({
          compressionModel: async () => '<summary>ARCHIVED SUMMARY</summary>',
          preserveRecentMessages: 1,
        }),
        archive: { store: async (serialized) => (await archive.put(serialized)).uri },
      },
    });

    const result = await mw.onConfig?.(createMockCtx(), config(conversation(6)));

    expect(JSON.stringify(result?.messages)).toContain(
      'are archived in full at context://archive/',
    );
    expect(archive.list()).not.toHaveLength(0);
  });
});

describe('truncate.store passthrough', () => {
  const toolMessages = (output: string): ModelMessage[] => [
    { role: 'tool', content: output, toolCallId: 'tc_1', name: 'run_cmd' } as ModelMessage,
  ];

  const firstContent = (messages: ModelMessage[]): string => {
    const content = (messages[0] as { content?: unknown }).content;
    return typeof content === 'string' ? content : JSON.stringify(content);
  };

  it('persists the original into the store and cites its URI', async () => {
    const store = new Store(new InMemoryBackend());
    const result = await truncateToolResults(toolMessages('line\n'.repeat(500)), {
      threshold: 100,
      headChars: 20,
      tailChars: 20,
      store,
    });

    expect(firstContent(result)).toContain('context://vfs/');
    expect(store.namespace('vfs').list()).toHaveLength(1);
  });

  it('lets the store win over a legacy adapter', async () => {
    const store = new Store(new InMemoryBackend());
    const adapter = { write: vi.fn(), read: vi.fn(() => null) };

    await truncateToolResults(toolMessages('line\n'.repeat(500)), {
      threshold: 100,
      tailChars: 20,
      storage: adapter,
      store,
    });

    expect(adapter.write).not.toHaveBeenCalled();
    expect(store.namespace('vfs').list()).toHaveLength(1);
  });
});
