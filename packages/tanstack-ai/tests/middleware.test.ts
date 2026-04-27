import type { Skill } from '@context-chef/core';
import type { ChatMiddlewareConfig, ChatMiddlewareContext, ModelMessage } from '@tanstack/ai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contextChefMiddleware } from '../src/middleware';

// Suppress Janitor warnings across the entire suite
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
beforeAll(() => warnSpy.mockClear());
afterAll(() => warnSpy.mockRestore());

function createMockCtx(overrides?: Partial<ChatMiddlewareContext>): ChatMiddlewareContext {
  return {
    requestId: 'req_1',
    streamId: 'stream_1',
    phase: 'init',
    iteration: 0,
    chunkIndex: 0,
    abort: vi.fn(),
    defer: vi.fn(),
    context: undefined,
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
    ...overrides,
  };
}

function createMockConfig(
  messages: ModelMessage[],
  overrides?: Partial<ChatMiddlewareConfig>,
): ChatMiddlewareConfig {
  return {
    messages,
    systemPrompts: [],
    tools: [],
    ...overrides,
  };
}

/** Helper to extract result fields with proper typing */
function getResult(result: Partial<ChatMiddlewareConfig>) {
  return {
    messages: result.messages ?? [],
    systemPrompts: result.systemPrompts ?? [],
  };
}

describe('contextChefMiddleware', () => {
  it('returns a ChatMiddleware with name', () => {
    const mw = contextChefMiddleware({ contextWindow: 100_000 });
    expect(mw.name).toBe('context-chef');
    expect(mw.onConfig).toBeTypeOf('function');
    expect(mw.onUsage).toBeTypeOf('function');
  });

  it('passes through messages unchanged when no options enabled', async () => {
    const mw = contextChefMiddleware({ contextWindow: 100_000 });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    const result = await mw.onConfig?.(ctx, config);
    expect(result).toEqual({ messages, systemPrompts: [] });
  });

  it('truncates large tool results', async () => {
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      truncate: { threshold: 50, headChars: 5, tailChars: 5 },
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Run the tool' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_1', type: 'function', function: { name: 'big_tool', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'X'.repeat(200), toolCallId: 'tc_1' },
    ];
    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    const result = await mw.onConfig?.(ctx, config);
    const { messages: resultMessages } = getResult(result as Partial<ChatMiddlewareConfig>);
    const toolMsg = resultMessages.find((m) => m.role === 'tool');
    expect((toolMsg?.content as string).length).toBeLessThan(200);
    expect(toolMsg?.content).toContain('--- truncated');
  });

  it('compacts tool calls with before-last-message mode', async () => {
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      compact: { toolCalls: 'before-last-message' },
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'First query' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{"q":"old"}' } },
        ],
      },
      { role: 'tool', content: 'Old result', toolCallId: 'tc_1' },
      { role: 'assistant', content: 'Old answer' },
      { role: 'user', content: 'Second query' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_2', type: 'function', function: { name: 'search', arguments: '{"q":"new"}' } },
        ],
      },
      { role: 'tool', content: 'New result', toolCallId: 'tc_2' },
      { role: 'assistant', content: 'New answer' },
    ];
    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    const result = await mw.onConfig?.(ctx, config);
    const { messages: resultMessages } = getResult(result as Partial<ChatMiddlewareConfig>);
    // First tool pair should be removed
    const toolMessages = resultMessages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].toolCallId).toBe('tc_2');
  });

  it('injects dynamic state into last user message (string content)', async () => {
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      dynamicState: {
        getState: () => ({ step: 1, status: 'running' }),
        placement: 'last_user',
      },
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'What should I do?' }];
    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    const result = await mw.onConfig?.(ctx, config);
    const { messages: resultMessages } = getResult(result as Partial<ChatMiddlewareConfig>);
    const userMsg = resultMessages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('<dynamic_state>');
    expect(userMsg?.content).toContain('<step>1</step>');
    expect(userMsg?.content).toContain('<status>running</status>');
  });

  it('injects dynamic state into ContentPart[] user message', async () => {
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      dynamicState: {
        getState: () => ({ mode: 'active' }),
        placement: 'last_user',
      },
    });
    const parts = [
      { type: 'text' as const, content: 'Look at this image' },
      {
        type: 'image' as const,
        source: { type: 'url' as const, value: 'https://example.com/img.png' },
      },
    ];
    const messages: ModelMessage[] = [{ role: 'user', content: parts }];
    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    const result = await mw.onConfig?.(ctx, config);
    const { messages: resultMessages } = getResult(result as Partial<ChatMiddlewareConfig>);
    const userMsg = resultMessages.find((m) => m.role === 'user');
    // Should be an array with the original parts + appended text part
    expect(Array.isArray(userMsg?.content)).toBe(true);
    const contentArr = userMsg?.content as Array<{ type: string; content?: string }>;
    expect(contentArr).toHaveLength(3);
    expect(contentArr[0]).toEqual(parts[0]);
    expect(contentArr[1]).toEqual(parts[1]);
    expect(contentArr[2].type).toBe('text');
    expect(contentArr[2].content).toContain('<dynamic_state>');
    expect(contentArr[2].content).toContain('<mode>active</mode>');
  });

  it('injects dynamic state into system prompts', async () => {
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      dynamicState: {
        getState: () => ({ step: 2 }),
        placement: 'system',
      },
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];
    const ctx = createMockCtx();
    const config = createMockConfig(messages, { systemPrompts: ['You are helpful'] });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result as Partial<ChatMiddlewareConfig>);
    expect(systemPrompts).toHaveLength(2);
    expect(systemPrompts[1]).toContain('CURRENT TASK STATE');
    expect(systemPrompts[1]).toContain('<step>2</step>');
  });

  it('applies transformContext hook', async () => {
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      transformContext: (messages, systemPrompts) => ({
        messages: [...messages, { role: 'user' as const, content: '[RAG context injected]' }],
        systemPrompts: [...systemPrompts, 'Extra instruction'],
      }),
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];
    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    const result = await mw.onConfig?.(ctx, config);
    const { messages: resultMessages, systemPrompts } = getResult(
      result as Partial<ChatMiddlewareConfig>,
    );
    expect(resultMessages).toHaveLength(2);
    expect(resultMessages[1].content).toBe('[RAG context injected]');
    expect(systemPrompts).toContain('Extra instruction');
  });

  it('onUsage feeds token usage to janitor', () => {
    const mw = contextChefMiddleware({ contextWindow: 100_000 });
    const ctx = createMockCtx();
    // Should not throw
    mw.onUsage?.(ctx, {
      promptTokens: 5000,
      completionTokens: 100,
      totalTokens: 5100,
    });
  });

  it('warns once when promptTokens is missing', () => {
    const localWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mw = contextChefMiddleware({ contextWindow: 100_000 });
    const ctx = createMockCtx();

    // Filter out Janitor init warnings that fire during contextChefMiddleware()
    localWarnSpy.mockClear();

    mw.onUsage?.(ctx, {
      promptTokens: undefined as unknown as number,
      completionTokens: 100,
      totalTokens: 100,
    });
    expect(localWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('did not include usage.promptTokens'),
    );

    // Second call should not warn again
    localWarnSpy.mockClear();
    mw.onUsage?.(ctx, {
      promptTokens: undefined as unknown as number,
      completionTokens: 100,
      totalTokens: 100,
    });
    expect(localWarnSpy).not.toHaveBeenCalled();

    localWarnSpy.mockRestore();
  });
});

describe('skill', () => {
  const planning: Skill = {
    name: 'planning',
    description: 'Plan changes before editing',
    instructions: 'Read code, list affected files, write a plan to the scratchpad.',
    allowedTools: ['read_file', 'grep'],
  };

  it('injects a static Skill object into systemPrompts', async () => {
    const mw = contextChefMiddleware({ contextWindow: 100_000, skill: planning });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['You are helpful'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result as Partial<ChatMiddlewareConfig>);
    expect(systemPrompts).toEqual(['You are helpful', planning.instructions]);
  });

  it('does not enforce skill.allowedTools (annotation only)', async () => {
    // Sanity-check: presence of allowedTools must NOT affect tools/messages.
    // chef does not consult allowedTools — Claude Code semantics.
    const mw = contextChefMiddleware({ contextWindow: 100_000, skill: planning });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }]);

    const result = await mw.onConfig?.(ctx, config);
    // Result must contain only messages + systemPrompts (no `tools` mutation).
    expect(Object.keys(result ?? {}).sort()).toEqual(['messages', 'systemPrompts']);
  });

  it('calls the function form on every request', async () => {
    const fn = vi.fn(() => planning);
    const mw = contextChefMiddleware({ contextWindow: 100_000, skill: fn });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }]);

    await mw.onConfig?.(ctx, config);
    await mw.onConfig?.(ctx, config);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('skips injection when the function returns null', async () => {
    const mw = contextChefMiddleware({ contextWindow: 100_000, skill: () => null });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['original'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result as Partial<ChatMiddlewareConfig>);
    expect(systemPrompts).toEqual(['original']);
  });

  it('skips injection when the function returns undefined', async () => {
    const mw = contextChefMiddleware({ contextWindow: 100_000, skill: () => undefined });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['original'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result as Partial<ChatMiddlewareConfig>);
    expect(systemPrompts).toEqual(['original']);
  });

  it('supports an async function returning a Skill', async () => {
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      skill: async () => planning,
    });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }]);

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result as Partial<ChatMiddlewareConfig>);
    expect(systemPrompts).toContain(planning.instructions);
  });

  it('leaves systemPrompts untouched when no skill option is provided', async () => {
    // Regression: existing usage must keep its system prompts byte-identical.
    const mw = contextChefMiddleware({ contextWindow: 100_000 });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['You are helpful', 'Be concise'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result as Partial<ChatMiddlewareConfig>);
    expect(systemPrompts).toEqual(['You are helpful', 'Be concise']);
  });

  it('skips injection when skill.instructions is an empty string', async () => {
    const empty: Skill = { name: 'noop', description: 'nothing', instructions: '' };
    const mw = contextChefMiddleware({ contextWindow: 100_000, skill: empty });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['original'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result as Partial<ChatMiddlewareConfig>);
    expect(systemPrompts).toEqual(['original']);
  });

  it('skips injection when skill.instructions is whitespace-only', async () => {
    const blank: Skill = { name: 'blank', description: 'blank', instructions: '   \n\t  ' };
    const mw = contextChefMiddleware({ contextWindow: 100_000, skill: blank });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['original'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result as Partial<ChatMiddlewareConfig>);
    expect(systemPrompts).toEqual(['original']);
  });

  it('coexists with dynamicState — skill in systemPrompts, dynamicState in last user', async () => {
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      skill: planning,
      dynamicState: {
        getState: () => ({ step: 1 }),
        placement: 'last_user',
      },
    });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'do something' }]);

    const result = await mw.onConfig?.(ctx, config);
    const { messages, systemPrompts } = getResult(result as Partial<ChatMiddlewareConfig>);

    // Skill went to systemPrompts.
    expect(systemPrompts).toEqual([planning.instructions]);
    // dynamicState went into the user message, not systemPrompts.
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('<dynamic_state>');
    expect(userMsg?.content).toContain('<step>1</step>');
  });

  it('coexists with dynamicState placement=system — skill comes before dynamicState', async () => {
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      skill: planning,
      dynamicState: {
        getState: () => ({ step: 1 }),
        placement: 'system',
      },
    });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['You are helpful'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result as Partial<ChatMiddlewareConfig>);
    expect(systemPrompts).toHaveLength(3);
    expect(systemPrompts[0]).toBe('You are helpful');
    expect(systemPrompts[1]).toBe(planning.instructions);
    expect(systemPrompts[2]).toContain('CURRENT TASK STATE');
  });

  it('coexists with compress — skill still injected after compression runs', async () => {
    const chunks = [
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: 'summary' },
      { type: 'RUN_FINISHED', messageId: 'msg_1' },
    ];
    const mockAdapter = {
      kind: 'text' as const,
      name: 'mock',
      model: 'mock-model',
      '~types': {} as Record<string, unknown>,
      chatStream: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of chunks) yield chunk;
        },
      }),
      structuredOutput: vi.fn(),
    };
    const mw = contextChefMiddleware({
      contextWindow: 10,
      compress: { adapter: mockAdapter as never },
      tokenizer: (msgs) => msgs.length * 100,
      skill: planning,
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply2' },
      { role: 'user', content: 'third' },
    ];
    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result as Partial<ChatMiddlewareConfig>);
    expect(mockAdapter.chatStream).toHaveBeenCalled();
    expect(systemPrompts).toContain(planning.instructions);
  });
});

describe('createCompressionAdapter', () => {
  it('formats messages and collects streamed deltas', async () => {
    const chunks = [
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: 'Summary: ' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: 'User asked about cats.' },
      { type: 'RUN_FINISHED', messageId: 'msg_1' },
    ];

    const mockAdapter = {
      kind: 'text' as const,
      name: 'mock',
      model: 'mock-model',
      '~types': {} as Record<string, unknown>,
      chatStream: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
      }),
      structuredOutput: vi.fn(),
    };

    const mw = contextChefMiddleware({
      contextWindow: 10, // Very small to trigger compression
      compress: { adapter: mockAdapter as never },
      tokenizer: (msgs: unknown[]) => msgs.length * 100, // Each message = 100 tokens
    });

    // Build a conversation that exceeds the 10-token window
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Search for cats' },
      {
        role: 'assistant',
        content: 'Let me search',
        toolCalls: [
          { id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{"q":"cats"}' } },
        ],
      },
      { role: 'tool', content: 'Found 5 cats', toolCallId: 'tc_1' },
      { role: 'assistant', content: 'Here are the results' },
      { role: 'user', content: 'Tell me more' },
    ];

    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    const result = await mw.onConfig?.(ctx, config);
    const { messages: resultMessages } = getResult(result as Partial<ChatMiddlewareConfig>);

    // Compression should have been triggered
    expect(mockAdapter.chatStream).toHaveBeenCalled();

    // Verify chatStream was called with properly formatted messages
    const callArgs = mockAdapter.chatStream.mock.calls[0][0];
    expect(callArgs.model).toBe('mock-model');
    expect(callArgs.maxTokens).toBe(2048);
    // Messages should only have user/assistant roles (tool converted to user)
    for (const m of callArgs.messages) {
      expect(['user', 'assistant']).toContain(m.role);
    }

    // Result should contain the summary
    expect(resultMessages.length).toBeLessThan(messages.length);
  });
});
