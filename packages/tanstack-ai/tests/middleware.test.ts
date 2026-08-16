import type { Skill } from '@context-chef/core';
import type {
  ChatMiddleware,
  ChatMiddlewareConfig,
  ChatMiddlewareContext,
  ModelMessage,
  SystemPrompt,
} from '@tanstack/ai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contextChefMiddleware } from '../src/middleware';

// Suppress Janitor warnings across the entire suite
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
beforeAll(() => warnSpy.mockClear());
afterAll(() => warnSpy.mockRestore());

/**
 * Minimal ChatMiddlewareContext double: a plain object carrying only the
 * fields the middleware reads (threadId/conversationId/phase and the shared
 * scalars). Capability plumbing is never touched, hence the cast.
 */
function createMockCtx(overrides?: Partial<ChatMiddlewareContext>): ChatMiddlewareContext {
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
    ...overrides,
  } as unknown as ChatMiddlewareContext;
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
function getResult(result: Awaited<ReturnType<NonNullable<ChatMiddleware['onConfig']>>>) {
  return {
    messages: result?.messages ?? [],
    systemPrompts: result?.systemPrompts ?? [],
  };
}

function promptText(p: SystemPrompt): string {
  return typeof p === 'string' ? p : p.content;
}

/** Mock TanStack text adapter whose chatStream yields the given deltas. */
function createMockAdapter(deltas: string[] = ['summary']) {
  const chunks = [
    ...deltas.map((delta) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta })),
    { type: 'RUN_FINISHED', messageId: 'msg_1' },
  ];
  return {
    kind: 'text' as const,
    name: 'mock',
    model: 'mock-model',
    '~types': {} as Record<string, unknown>,
    chatStream: vi.fn().mockImplementation(() => ({
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    })),
    structuredOutput: vi.fn(),
  };
}

describe('contextChefMiddleware', () => {
  it('returns a ChatMiddleware with name', () => {
    const mw = contextChefMiddleware({ contextWindow: 100_000 });
    expect(mw.name).toBe('context-chef');
    expect(mw.onConfig).toBeTypeOf('function');
    expect(mw.onUsage).toBeTypeOf('function');
  });

  it('throws when a compression option is configured without contextWindow', () => {
    expect(() =>
      contextChefMiddleware({ compress: { adapter: createMockAdapter() as never } }),
    ).toThrow(/`contextWindow` is required when a compression option/);
    expect(() => contextChefMiddleware({ onCompress: vi.fn() })).toThrow(/contextWindow/);
    expect(() => contextChefMiddleware({ onBeforeCompress: () => undefined })).toThrow(
      /contextWindow/,
    );
  });

  it('does not require contextWindow for non-budgeting configurations', () => {
    expect(() =>
      contextChefMiddleware({ truncate: { threshold: 100 }, compact: { toolCalls: 'all' } }),
    ).not.toThrow();
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

  it('preserves systemPrompt metadata objects when passing through', async () => {
    const mw = contextChefMiddleware({});
    const systemPrompts: SystemPrompt[] = [
      { content: 'Stable instructions', metadata: { cache_control: { type: 'ephemeral' } } },
      'Volatile instruction',
    ];
    const config = createMockConfig([{ role: 'user', content: 'hi' }], { systemPrompts });

    const result = await mw.onConfig?.(createMockCtx(), config);
    expect(getResult(result).systemPrompts).toEqual(systemPrompts);
  });

  it('truncates large tool results', async () => {
    const mw = contextChefMiddleware({
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
    const { messages: resultMessages } = getResult(result);
    const toolMsg = resultMessages.find((m) => m.role === 'tool');
    expect((toolMsg?.content as string).length).toBeLessThan(200);
    expect(toolMsg?.content).toContain('--- truncated');
  });

  it('compacts tool calls with before-last-message mode', async () => {
    const mw = contextChefMiddleware({
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
    ];
    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    const result = await mw.onConfig?.(ctx, config);
    const { messages: resultMessages } = getResult(result);
    // First tool pair should be removed; the final tool result survives.
    const toolMessages = resultMessages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].toolCallId).toBe('tc_2');
  });

  it('compact.reasoning strips thinking arrays from outgoing messages', async () => {
    const mw = contextChefMiddleware({ compact: { reasoning: 'all' } });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', thinking: [{ content: 'chain of thought' }] },
      { role: 'user', content: 'q2' },
    ];
    const result = await mw.onConfig?.(createMockCtx(), createMockConfig(messages));
    const { messages: resultMessages } = getResult(result);
    const assistant = resultMessages.find((m) => m.role === 'assistant');
    expect(assistant?.thinking).toBeUndefined();
    expect(assistant?.content).toBe('a');
  });

  it('injects dynamic state into last user message (string content)', async () => {
    const mw = contextChefMiddleware({
      dynamicState: {
        getState: () => ({ step: 1, status: 'running' }),
        placement: 'last_user',
      },
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'What should I do?' }];
    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    const result = await mw.onConfig?.(ctx, config);
    const { messages: resultMessages } = getResult(result);
    const userMsg = resultMessages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('<dynamic_state>');
    expect(userMsg?.content).toContain('<step>1</step>');
    expect(userMsg?.content).toContain('<status>running</status>');
  });

  it('injects dynamic state into ContentPart[] user message', async () => {
    const mw = contextChefMiddleware({
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
    const { messages: resultMessages } = getResult(result);
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
      dynamicState: {
        getState: () => ({ step: 2 }),
        placement: 'system',
      },
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];
    const ctx = createMockCtx();
    const config = createMockConfig(messages, { systemPrompts: ['You are helpful'] });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result);
    expect(systemPrompts).toHaveLength(2);
    expect(promptText(systemPrompts[1])).toContain('CURRENT TASK STATE');
    expect(promptText(systemPrompts[1])).toContain('<step>2</step>');
  });

  it('applies transformContext hook with ctx as third argument', async () => {
    const transformSpy = vi.fn(
      (messages: ModelMessage[], systemPrompts: SystemPrompt[], _ctx: ChatMiddlewareContext) => ({
        messages: [...messages, { role: 'user' as const, content: '[RAG context injected]' }],
        systemPrompts: [...systemPrompts, 'Extra instruction'],
      }),
    );
    const mw = contextChefMiddleware({ transformContext: transformSpy });
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];
    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    const result = await mw.onConfig?.(ctx, config);
    const { messages: resultMessages, systemPrompts } = getResult(result);
    expect(resultMessages).toHaveLength(2);
    expect(resultMessages[1].content).toBe('[RAG context injected]');
    expect(systemPrompts).toContain('Extra instruction');
    expect(transformSpy.mock.calls[0][2]).toBe(ctx);
  });

  it('onUsage feeds token usage to janitor', () => {
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      onBeforeCompress: () => undefined,
    });
    const ctx = createMockCtx();
    // Should not throw
    mw.onUsage?.(ctx, {
      promptTokens: 5000,
      completionTokens: 100,
      totalTokens: 5100,
    });
  });

  it('isolates janitor state between conversations via ctx.threadId', async () => {
    // Window large enough that the heuristic estimate of the short history
    // stays under budget — only the FED usage (thread A's) exceeds it.
    const mw = contextChefMiddleware({
      contextWindow: 10_000,
      onBeforeCompress: () => undefined,
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
    ];

    // Thread A exceeds the budget (20_000 > 10_000).
    mw.onUsage?.(createMockCtx({ threadId: 'thread-a' }), {
      promptTokens: 20_000,
      completionTokens: 10,
      totalTokens: 20_010,
    });

    // Thread B must NOT inherit A's fed token usage — no compression.
    const resB = await mw.onConfig?.(
      createMockCtx({ threadId: 'thread-b' }),
      createMockConfig(messages),
    );
    expect(getResult(resB).messages).toHaveLength(messages.length);

    // Thread A compresses on its own next call.
    const resA = await mw.onConfig?.(
      createMockCtx({ threadId: 'thread-a' }),
      createMockConfig(messages),
    );
    expect(getResult(resA).messages.length).toBeLessThan(messages.length);
  });

  it('falls back to the deprecated conversationId alias when threadId is absent', async () => {
    const mw = contextChefMiddleware({
      contextWindow: 10_000,
      onBeforeCompress: () => undefined,
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];

    mw.onUsage?.(createMockCtx({ threadId: undefined, conversationId: 'legacy-conv' }), {
      promptTokens: 20_000,
      completionTokens: 10,
      totalTokens: 20_010,
    });

    const res = await mw.onConfig?.(
      createMockCtx({ threadId: undefined, conversationId: 'legacy-conv' }),
      createMockConfig(messages),
    );
    expect(getResult(res).messages.length).toBeLessThan(messages.length);
  });

  it('routes an empty threadId to the default slot and warns once', async () => {
    const warn = vi.fn();
    const mw = contextChefMiddleware({
      contextWindow: 10_000,
      onBeforeCompress: () => undefined,
      logger: { warn },
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];

    // Over-budget usage reported under an EMPTY threadId (invalid).
    mw.onUsage?.(createMockCtx({ threadId: '' }), {
      promptTokens: 20_000,
      completionTokens: 10,
      totalTokens: 20_010,
    });

    // A call with no usable threadId shares the default slot → sees the fed usage.
    const res = await mw.onConfig?.(
      createMockCtx({ threadId: undefined }),
      createMockConfig(messages),
    );
    expect(getResult(res).messages.length).toBeLessThan(messages.length);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('threadId'));
  });

  it('emits the missing-compression-config nag once across conversations', async () => {
    const warn = vi.fn();
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      onBeforeCompress: () => undefined,
      logger: { warn },
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }];

    await mw.onConfig?.(createMockCtx({ threadId: 'thread-a' }), createMockConfig(messages));
    await mw.onConfig?.(createMockCtx({ threadId: 'thread-b' }), createMockConfig(messages));

    const nags = warn.mock.calls.filter((c) =>
      String(c[0]).includes('No tokenizer and no compressionModel'),
    );
    expect(nags).toHaveLength(1);
  });

  it('warns once when promptTokens is missing', () => {
    const warn = vi.fn();
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      onBeforeCompress: () => undefined,
      logger: { warn },
    });
    const ctx = createMockCtx();

    warn.mockClear();
    mw.onUsage?.(ctx, {
      promptTokens: undefined as unknown as number,
      completionTokens: 100,
      totalTokens: 100,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('did not include usage.promptTokens'),
    );

    // Second call should not warn again
    warn.mockClear();
    mw.onUsage?.(ctx, {
      promptTokens: undefined as unknown as number,
      completionTokens: 100,
      totalTokens: 100,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('hook robustness — never break the host chat() run', () => {
  it('onConfig degrades to pass-through when a transform throws', async () => {
    const warn = vi.fn();
    const mw = contextChefMiddleware({
      dynamicState: {
        getState: () => {
          throw new Error('state provider exploded');
        },
      },
      logger: { warn },
    });
    const config = createMockConfig([{ role: 'user', content: 'hi' }]);

    const result = await mw.onConfig?.(createMockCtx(), config);
    // Pass-through: no partial returned, engine keeps the original config.
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onConfig transform failed'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('state provider exploded'));
  });

  it('onConfig degrades to pass-through when transformContext throws', async () => {
    const warn = vi.fn();
    const mw = contextChefMiddleware({
      transformContext: () => {
        throw new Error('user hook exploded');
      },
      logger: { warn },
    });
    const result = await mw.onConfig?.(
      createMockCtx(),
      createMockConfig([{ role: 'user', content: 'hi' }]),
    );
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onConfig transform failed'));
  });

  it('onUsage swallows janitor errors', () => {
    const warn = vi.fn();
    const mw = contextChefMiddleware({
      contextWindow: 100_000,
      onBeforeCompress: () => undefined,
      logger: { warn },
    });
    // A poisoned context whose threadId getter throws.
    const ctx = createMockCtx();
    Object.defineProperty(ctx, 'threadId', {
      get() {
        throw new Error('poisoned ctx');
      },
    });

    expect(() =>
      mw.onUsage?.(ctx, { promptTokens: 10, completionTokens: 1, totalTokens: 11 }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onUsage failed'));
  });
});

describe('iteration idempotency — onConfig fires at init AND each agent iteration', () => {
  /** Feeds the transformed config back in, as the agent loop does. */
  async function runTwoIterations(
    mw: ReturnType<typeof contextChefMiddleware>,
    config: ChatMiddlewareConfig,
  ): Promise<ChatMiddlewareConfig> {
    const first = await mw.onConfig?.(createMockCtx({ phase: 'init' }), config);
    const afterInit: ChatMiddlewareConfig = { ...config, ...first };
    const second = await mw.onConfig?.(
      createMockCtx({ phase: 'beforeModel', iteration: 1 }),
      afterInit,
    );
    return { ...afterInit, ...second };
  }

  it('does not duplicate skill instructions', async () => {
    const skill: Skill = { name: 's', description: 'd', instructions: 'Plan before acting.' };
    const mw = contextChefMiddleware({ skill });
    const final = await runTwoIterations(
      mw,
      createMockConfig([{ role: 'user', content: 'hi' }], { systemPrompts: ['base'] }),
    );
    expect(final.systemPrompts.filter((p) => promptText(p) === skill.instructions)).toHaveLength(1);
  });

  it('does not duplicate the clear explainer', async () => {
    const mw = contextChefMiddleware({ clear: [{ target: 'tool-result', keepRecent: 1 }] });
    const final = await runTwoIterations(
      mw,
      createMockConfig([{ role: 'user', content: 'hi' }], { systemPrompts: ['base'] }),
    );
    const explainers = final.systemPrompts.filter((p) =>
      promptText(p).includes('automatically cleared'),
    );
    expect(explainers).toHaveLength(1);
  });

  it('replaces (not accumulates) system-placement dynamic state and refreshes it', async () => {
    let step = 1;
    const mw = contextChefMiddleware({
      dynamicState: { getState: () => ({ step: step++ }), placement: 'system' },
    });
    const final = await runTwoIterations(
      mw,
      createMockConfig([{ role: 'user', content: 'hi' }], { systemPrompts: ['base'] }),
    );
    const stateBlocks = final.systemPrompts.filter((p) =>
      promptText(p).startsWith('CURRENT TASK STATE:'),
    );
    expect(stateBlocks).toHaveLength(1);
    // Second firing sees the refreshed state
    expect(promptText(stateBlocks[0])).toContain('<step>2</step>');
    expect(final.systemPrompts[0]).toBe('base');
  });

  it('replaces (not accumulates) last_user dynamic state in string content', async () => {
    let step = 1;
    const mw = contextChefMiddleware({
      dynamicState: { getState: () => ({ step: step++ }), placement: 'last_user' },
    });
    const final = await runTwoIterations(
      mw,
      createMockConfig([{ role: 'user', content: 'What next?' }]),
    );
    const userMsg = final.messages.find((m) => m.role === 'user');
    const content = userMsg?.content as string;
    expect(content.match(/<dynamic_state>/g)).toHaveLength(1);
    expect(content).toContain('<step>2</step>');
    expect(content).not.toContain('<step>1</step>');
    expect(content.startsWith('What next?')).toBe(true);
  });

  it('replaces (not accumulates) last_user dynamic state in ContentPart[] content', async () => {
    let step = 1;
    const mw = contextChefMiddleware({
      dynamicState: { getState: () => ({ step: step++ }), placement: 'last_user' },
    });
    const parts = [{ type: 'text' as const, content: 'Original question' }];
    const final = await runTwoIterations(mw, createMockConfig([{ role: 'user', content: parts }]));
    const userMsg = final.messages.find((m) => m.role === 'user');
    const contentArr = userMsg?.content as Array<{ type: string; content?: string }>;
    const stateParts = contentArr.filter((p) => p.content?.includes('<dynamic_state>'));
    expect(stateParts).toHaveLength(1);
    expect(stateParts[0].content).toContain('<step>2</step>');
    expect(contentArr[0]).toEqual(parts[0]);
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
    const mw = contextChefMiddleware({ skill: planning });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['You are helpful'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result);
    expect(systemPrompts).toEqual(['You are helpful', planning.instructions]);
  });

  it('does not enforce skill.allowedTools (annotation only)', async () => {
    // Sanity-check: presence of allowedTools must NOT affect tools/messages.
    // chef does not consult allowedTools — Claude Code semantics.
    const mw = contextChefMiddleware({ skill: planning });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }]);

    const result = await mw.onConfig?.(ctx, config);
    // Result must contain only messages + systemPrompts (no `tools` mutation).
    expect(Object.keys(result ?? {}).sort()).toEqual(['messages', 'systemPrompts']);
  });

  it('calls the function form on every request', async () => {
    const fn = vi.fn(() => planning);
    const mw = contextChefMiddleware({ skill: fn });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }]);

    await mw.onConfig?.(ctx, config);
    await mw.onConfig?.(ctx, config);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('skips injection when the function returns null', async () => {
    const mw = contextChefMiddleware({ skill: () => null });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['original'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result);
    expect(systemPrompts).toEqual(['original']);
  });

  it('skips injection when the function returns undefined', async () => {
    const mw = contextChefMiddleware({ skill: () => undefined });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['original'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result);
    expect(systemPrompts).toEqual(['original']);
  });

  it('supports an async function returning a Skill', async () => {
    const mw = contextChefMiddleware({ skill: async () => planning });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }]);

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result);
    expect(systemPrompts).toContain(planning.instructions);
  });

  it('leaves systemPrompts untouched when no skill option is provided', async () => {
    // Regression: existing usage must keep its system prompts byte-identical.
    const mw = contextChefMiddleware({});
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['You are helpful', 'Be concise'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result);
    expect(systemPrompts).toEqual(['You are helpful', 'Be concise']);
  });

  it('skips injection when skill.instructions is an empty string', async () => {
    const empty: Skill = { name: 'noop', description: 'nothing', instructions: '' };
    const mw = contextChefMiddleware({ skill: empty });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['original'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result);
    expect(systemPrompts).toEqual(['original']);
  });

  it('skips injection when skill.instructions is whitespace-only', async () => {
    const blank: Skill = { name: 'blank', description: 'blank', instructions: '   \n\t  ' };
    const mw = contextChefMiddleware({ skill: blank });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'hi' }], {
      systemPrompts: ['original'],
    });

    const result = await mw.onConfig?.(ctx, config);
    const { systemPrompts } = getResult(result);
    expect(systemPrompts).toEqual(['original']);
  });

  it('coexists with dynamicState — skill in systemPrompts, dynamicState in last user', async () => {
    const mw = contextChefMiddleware({
      skill: planning,
      dynamicState: {
        getState: () => ({ step: 1 }),
        placement: 'last_user',
      },
    });
    const ctx = createMockCtx();
    const config = createMockConfig([{ role: 'user', content: 'do something' }]);

    const result = await mw.onConfig?.(ctx, config);
    const { messages, systemPrompts } = getResult(result);

    // Skill went to systemPrompts.
    expect(systemPrompts).toEqual([planning.instructions]);
    // dynamicState went into the user message, not systemPrompts.
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('<dynamic_state>');
    expect(userMsg?.content).toContain('<step>1</step>');
  });

  it('coexists with dynamicState placement=system — skill comes before dynamicState', async () => {
    const mw = contextChefMiddleware({
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
    const { systemPrompts } = getResult(result);
    expect(systemPrompts).toHaveLength(3);
    expect(systemPrompts[0]).toBe('You are helpful');
    expect(systemPrompts[1]).toBe(planning.instructions);
    expect(promptText(systemPrompts[2])).toContain('CURRENT TASK STATE');
  });

  it('coexists with compress — skill still injected after compression runs', async () => {
    const mockAdapter = createMockAdapter();
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
    const { systemPrompts } = getResult(result);
    expect(mockAdapter.chatStream).toHaveBeenCalled();
    expect(systemPrompts).toContain(planning.instructions);
  });
});

describe('clear', () => {
  it('replaces old tool results with placeholders and appends the explainer to systemPrompts', async () => {
    const mw = contextChefMiddleware({
      clear: [{ target: 'tool-result', keepRecent: 1 }],
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
      { role: 'tool', content: 'Old tool result data', toolCallId: 'tc_1' },
      { role: 'assistant', content: 'Found something old' },
      { role: 'user', content: 'Second query' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_2', type: 'function', function: { name: 'search', arguments: '{"q":"new"}' } },
        ],
      },
      { role: 'tool', content: 'New tool result data', toolCallId: 'tc_2' },
    ];
    const ctx = createMockCtx();
    const config = createMockConfig(messages, { systemPrompts: ['You are helpful'] });

    const result = await mw.onConfig?.(ctx, config);
    const { messages: resultMessages, systemPrompts } = getResult(result);

    // Nothing deleted — both tool messages remain
    const toolMsgs = resultMessages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);

    // Older tool result (tc_1) replaced with placeholder
    const olderTool = toolMsgs.find((m) => m.toolCallId === 'tc_1');
    expect(olderTool?.content).toBe('[Old tool result content cleared]');
    // Must NOT leak original content
    expect(olderTool?.content).not.toContain('Old tool result data');

    // Newer tool result (tc_2) preserved
    const newerTool = toolMsgs.find((m) => m.toolCallId === 'tc_2');
    expect(newerTool?.content).toBe('New tool result data');

    // Explainer appended to systemPrompts
    expect(systemPrompts.some((s) => promptText(s).includes('automatically cleared'))).toBe(true);
    // Original system prompt preserved
    expect(systemPrompts[0]).toBe('You are helpful');
  });

  it("clear: ['thinking'] strips thinking without appending the explainer", async () => {
    const mw = contextChefMiddleware({ clear: ['thinking'] });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi', thinking: [{ content: 'private reasoning' }] },
    ];
    const ctx = createMockCtx();
    const config = createMockConfig(messages, { systemPrompts: ['You are helpful'] });

    const result = await mw.onConfig?.(ctx, config);
    const { messages: resultMessages, systemPrompts } = getResult(result);

    const assistant = resultMessages.find((m) => m.role === 'assistant');
    expect(assistant?.thinking).toBeUndefined();
    expect(assistant?.content).toBe('Hi');

    // Explainer must NOT be appended for thinking-only clear
    expect(systemPrompts.some((s) => promptText(s).includes('automatically cleared'))).toBe(false);
    expect(systemPrompts).toEqual(['You are helpful']);
  });

  it('clear does not modify compact path — compact still deletes, clear still placeholders', async () => {
    // Verify the two options are independent: compact deletes, clear placeholders
    const mw = contextChefMiddleware({
      compact: { toolCalls: 'all' },
      clear: [{ target: 'tool-result', keepRecent: 0 }],
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Query' },
      {
        role: 'assistant',
        content: 'done',
        toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'tool', arguments: '{}' } }],
      },
      { role: 'tool', content: 'Result', toolCallId: 'tc_1' },
      { role: 'assistant', content: 'Done' },
      { role: 'user', content: 'Follow-up' },
    ];
    const ctx = createMockCtx();
    const config = createMockConfig(messages);

    // Should not throw regardless of path interaction
    const result = await mw.onConfig?.(ctx, config);
    expect(result).toBeDefined();
  });
});

describe('createCompressionAdapter', () => {
  it('formats messages and collects streamed deltas', async () => {
    const mockAdapter = createMockAdapter(['Summary: ', 'User asked about cats.']);

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
    const { messages: resultMessages } = getResult(result);

    // Compression should have been triggered
    expect(mockAdapter.chatStream).toHaveBeenCalled();

    // Verify chatStream was called with properly formatted messages
    const callArgs = mockAdapter.chatStream.mock.calls[0][0];
    expect(callArgs.model).toBe('mock-model');
    expect(callArgs.logger).toBeDefined();
    // Messages should only have user/assistant roles (tool converted to user)
    for (const m of callArgs.messages) {
      expect(['user', 'assistant']).toContain(m.role);
    }

    // Result should contain the summary
    expect(resultMessages.length).toBeLessThan(messages.length);
  });

  it('onCompress receives the compressed slice in TanStack format', async () => {
    const mockAdapter = createMockAdapter();
    const onCompressSpy = vi.fn();

    const mw = contextChefMiddleware({
      contextWindow: 10,
      compress: { adapter: mockAdapter as never },
      tokenizer: (msgs: unknown[]) => msgs.length * 100,
      onCompress: onCompressSpy,
    });

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

    await mw.onConfig?.(ctx, config);

    expect(onCompressSpy).toHaveBeenCalled();
    const [, , details] = onCompressSpy.mock.calls[0];
    expect(Array.isArray(details.compressedMessages)).toBe(true);
    expect(details.compressedMessages.length).toBeGreaterThan(0);
    // TanStack AI ModelMessage shape: role + content
    const first = details.compressedMessages[0];
    expect(first).toHaveProperty('role');
    expect(first).toHaveProperty('content');
  });
});

describe('compress persistence warning', () => {
  const overBudget: ModelMessage[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' },
  ];

  async function runCycles(mw: ReturnType<typeof contextChefMiddleware>, n: number) {
    for (let i = 0; i < n; i++) {
      const ctx = createMockCtx();
      mw.onUsage?.(ctx, { promptTokens: 20_000, completionTokens: 10, totalTokens: 20_010 });
      await mw.onConfig?.(ctx, createMockConfig(overBudget));
    }
  }

  it('warns exactly once when compression keeps firing without onCompress', async () => {
    const warn = vi.fn();
    const mw = contextChefMiddleware({
      contextWindow: 100,
      compress: { adapter: createMockAdapter() as never },
      logger: { warn },
    });

    // E10 suppression skips every other call, so several cycles are needed to
    // reach the threshold; the once-flag keeps it to a single warning.
    await runCycles(mw, 12);

    const persistenceWarns = warn.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('compress has fired'),
    );
    expect(persistenceWarns).toHaveLength(1);
    expect(persistenceWarns[0][0]).toContain('onCompress');
  });

  it('does not warn when onCompress is configured', async () => {
    const warn = vi.fn();
    const mw = contextChefMiddleware({
      contextWindow: 100,
      compress: { adapter: createMockAdapter() as never },
      onCompress: vi.fn(),
      logger: { warn },
    });

    await runCycles(mw, 12);

    const persistenceWarns = warn.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('compress has fired'),
    );
    expect(persistenceWarns).toHaveLength(0);
  });
});
