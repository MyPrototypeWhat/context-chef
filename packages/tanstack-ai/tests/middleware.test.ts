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
