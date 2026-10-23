/**
 * `appendOnly` through the TanStack middleware: an agent loop calls the model
 * again and again with its whole conversation, and each request must repeat
 * the one before it and only append — dynamic state as events, a landed
 * compression as the head every later call replays, every rewrite a
 * reported checkpoint.
 *
 * The tokenizer counts 10 tokens a conversation message against the default
 * trigger (0.7 of a raw window of 100): a conversation of 9 messages is over
 * the trigger, one of 11 past the raw window. Every expected request is worked
 * out by hand.
 */

import { type Message, type OverflowStrategy, Prompts, summarize } from '@context-chef/core';
import {
  type ChatMiddlewareConfig,
  type ChatMiddlewareContext,
  chat,
  type ModelMessage,
  type StreamChunk,
  type SystemPrompt,
  type Tool,
} from '@tanstack/ai';
import { describe, expect, it, vi } from 'vitest';
import { checkSentPrefix, type SentPayload } from '../../core/src/pipeline/checks';
import { compactTanStackMessages, planCompactionTanStackMessages } from '../src/compaction';
import { contextChefMiddleware } from '../src/middleware';
import type { ContextChefOptions, PrefixBreakEvent } from '../src/types';

const sys = 'You are terse.';
const user = (text: string): ModelMessage => ({ role: 'user', content: text });
/** A reply; with a signature, it carries the thinking signed with it. */
const reply = (text: string, signature?: string): ModelMessage => ({
  role: 'assistant',
  content: text,
  ...(signature ? { thinking: [{ content: `Thinking signed ${signature}.`, signature }] } : {}),
});
const toolCall = (id: string): ModelMessage => ({
  role: 'assistant',
  content: null,
  toolCalls: [{ id, type: 'function', function: { name: 'search', arguments: `{"q":"${id}"}` } }],
});
const toolResult = (id: string): ModelMessage => ({
  role: 'tool',
  content: `found ${id}`,
  toolCallId: id,
});

/** The conversation when question `n` is asked: q1 a1 q2 … qn, reply i signed S_i when `signed`. */
function asked(n: number, signed = false): ModelMessage[] {
  const messages = [user('q1')];
  for (let i = 1; i < n; i++)
    messages.push(reply(`a${i}`, signed ? `S_${i}` : undefined), user(`q${i + 1}`));
  return messages;
}
/** The conversation after `n` tool rounds of the first question. */
function rounds(n: number): ModelMessage[] {
  const messages = [user('q1')];
  for (let i = 1; i <= n; i++) messages.push(toolCall(`t${i}`), toolResult(`t${i}`));
  return messages;
}

/** The user message one call appends for dynamic state `step` at revision `rev`. */
const stateEvent = (step: number, rev: number) =>
  user(
    `<dynamic_state rev="${rev}">\n  <step>${step}</step>\n</dynamic_state>\n\n` +
      Prompts.EVENT_STATE_ANCHOR,
  );
const summary = (n: number) => user(Prompts.getCompactSummaryWrapper(`SUMMARY ${n}`));

const tokenizer = (messages: Message[]): number => messages.length * 10;

/** A compression model answering `SUMMARY 1`, `SUMMARY 2`, … in turn, keeping the last `turns`. */
function keepLastTurn(turns = 1) {
  let summaries = 0;
  const compressionModel = vi.fn(
    async (_messages: Message[]) => `<summary>SUMMARY ${++summaries}</summary>`,
  );
  const strategy = summarize({
    compressionModel,
    split: 'recent-turns',
    preserveRecentMessages: turns,
  });
  return { compressionModel, strategy };
}

const search: Tool = {
  name: 'search',
  description: 'Search the web.',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

function ctxOf(overrides: Partial<ChatMiddlewareContext> = {}): ChatMiddlewareContext {
  return {
    requestId: 'req_1',
    streamId: 'stream_1',
    runId: 'run_1',
    threadId: 'thread_1',
    phase: 'beforeModel',
    iteration: 0,
    chunkIndex: 0,
    abort: vi.fn(),
    defer: vi.fn(),
    context: undefined,
    activity: 'chat',
    provider: 'anthropic',
    model: 'claude',
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

interface Call {
  systemPrompts?: SystemPrompt[];
  tools?: Tool[];
  threadId?: string;
  signal?: AbortSignal;
  phase?: ChatMiddlewareContext['phase'];
  /**
   * The chat() run the firing belongs to (`ctx.requestId`): a run of its own
   * unless given. The engine hands every hook of a run one context object.
   */
  requestId?: string;
}

/** `defaults` apply to every call `send` makes, under what the call itself gives. */
function middlewareWith(options: Partial<ContextChefOptions> = {}, defaults: Call = {}) {
  const warn = vi.fn();
  const breaks: PrefixBreakEvent[] = [];
  const middleware = contextChefMiddleware({
    appendOnly: true,
    logger: { warn },
    onPrefixBreak: (event) => {
      breaks.push(event);
    },
    ...options,
  });

  // Each run's context, by requestId, as the engine keeps one for the run.
  const runs = new Map<string, ChatMiddlewareContext>();
  let last = ctxOf();
  /** One model call's `onConfig` firing, as the engine makes it before the call. */
  const send = async (
    messages: ModelMessage[],
    given: Call = {},
  ): Promise<{ messages: ModelMessage[]; systemPrompts: SystemPrompt[] }> => {
    const onConfig = middleware.onConfig;
    if (!onConfig) throw new Error('onConfig is undefined');
    const call = { ...defaults, ...given };
    const config: ChatMiddlewareConfig = {
      messages,
      systemPrompts: call.systemPrompts ?? [sys],
      tools: call.tools ?? [],
    };
    const requestId = call.requestId ?? `run_${runs.size + 1}`;
    const ctx =
      runs.get(requestId) ??
      ctxOf({ requestId, ...(call.threadId ? { threadId: call.threadId } : {}) });
    runs.set(requestId, ctx);
    // The engine moves its context through the run's phases.
    Object.assign(ctx, { phase: call.phase ?? 'beforeModel', signal: call.signal });
    last = ctx;
    const result = await onConfig(ctx, config);
    return {
      messages: result?.messages ?? config.messages,
      systemPrompts: result?.systemPrompts ?? config.systemPrompts,
    };
  };

  /** The usage of the call last sent (or of `run`'s), reporting `promptTokens`. */
  const respond = (promptTokens: number, run?: string) => {
    middleware.onUsage?.(run ? (runs.get(run) ?? ctxOf()) : last, {
      promptTokens,
      completionTokens: 10,
      totalTokens: promptTokens + 10,
    });
  };

  /** A thinking block streamed for the call last sent (or `run`'s), signed `signature`. */
  const streamed = (signature: string, run?: string) => {
    const chunk = { type: 'STEP_FINISHED', stepName: 'thinking', signature, timestamp: 0 };
    middleware.onChunk?.(run ? (runs.get(run) ?? ctxOf()) : last, chunk as StreamChunk);
  };

  return { middleware, send, respond, streamed, warn, breaks };
}

/** A request sent, as the cross-turn check compares the next one with it. */
function sentRequest(messages: ModelMessage[]): SentPayload {
  let replied = 0;
  messages.forEach((message, i) => {
    if (message.role === 'assistant') replied = i + 1;
  });
  return { payload: { messages }, replied, asked: messages.length, hostLength: 0 };
}

/** Each request repeats the one before it and only appends: every call was answered. */
function expectAppendOnly(requests: ModelMessage[][]) {
  for (let i = 1; i < requests.length; i++) {
    expect(checkSentPrefix(sentRequest(requests[i - 1]), { messages: requests[i] }, true)).toEqual(
      [],
    );
  }
}

const warnings = (warn: ReturnType<typeof vi.fn>, text: string) =>
  warn.mock.calls.filter(([message]) => String(message).includes(text));

describe('appendOnly: dynamic state as events', () => {
  it('appends the state once after the turn it changed in, so every request repeats the last', async () => {
    let step = 0;
    const { send, breaks } = middlewareWith({
      dynamicState: { getState: () => ({ step: ++step }) },
    });
    const first = await send([user('q1')]);
    const second = await send([user('q1'), toolCall('t1'), toolResult('t1')]);
    const third = await send([
      user('q1'),
      toolCall('t1'),
      toolResult('t1'),
      reply('a1'),
      user('q2'),
    ]);

    expect(first.messages).toEqual([user('q1'), stateEvent(1, 1)]);
    expect(second.messages).toEqual([
      ...first.messages,
      toolCall('t1'),
      toolResult('t1'),
      stateEvent(2, 2),
    ]);
    expect(third.messages).toEqual([...second.messages, reply('a1'), user('q2'), stateEvent(3, 3)]);
    expect(third.systemPrompts).toEqual([sys]);
    expectAppendOnly([first.messages, second.messages, third.messages]);
    expect(JSON.stringify(third)).not.toContain('_chef_event');
    expect(breaks).toEqual([]);
  });

  it("says 'system' placement state as a user message too, leaving systemPrompts alone", async () => {
    const { send } = middlewareWith({
      dynamicState: { getState: () => ({ step: 1 }), placement: 'system' },
    });

    expect(await send([user('q1')])).toEqual({
      messages: [user('q1'), stateEvent(1, 1)],
      systemPrompts: [sys],
    });
  });
});

describe('appendOnly: the engine carries each config into the next iteration', () => {
  it('passes the init firing through: the engine settles pending tool calls before its first model call', async () => {
    const getState = vi.fn(() => ({ step: 1 }));
    const { middleware, breaks } = middlewareWith({ dynamicState: { getState } });
    const config: ChatMiddlewareConfig = {
      messages: [user('q1')],
      systemPrompts: [sys],
      tools: [],
    };

    expect(await middleware.onConfig?.(ctxOf({ phase: 'init' }), config)).toBeUndefined();
    expect(getState).not.toHaveBeenCalled();
    expect(breaks).toEqual([]);
  });

  it('reads a carried config as the host conversation and what came since', async () => {
    let step = 0;
    let instructions = 'Plan first.';
    const { send, breaks } = middlewareWith({
      skill: () => ({ name: 's', description: '', instructions }),
      dynamicState: { getState: () => ({ step: ++step }) },
    });
    // As the engine iterates in one run: the last config, then the assistant turn and its results.
    const run = { requestId: 'run' };
    const first = await send([user('q1')], run);
    const second = await send([...first.messages, toolCall('t1'), toolResult('t1')], {
      ...first,
      ...run,
    });
    instructions = 'Answer briefly.';
    const third = await send([...second.messages, toolCall('t2'), toolResult('t2')], {
      ...second,
      ...run,
    });

    expect(third.messages).toEqual([
      user('q1'),
      stateEvent(1, 1),
      toolCall('t1'),
      toolResult('t1'),
      stateEvent(2, 2),
      toolCall('t2'),
      toolResult('t2'),
      stateEvent(3, 3),
    ]);
    // The skill the last call added is not the host's: the new one replaces it.
    expect(third.systemPrompts).toEqual([sys, 'Answer briefly.']);
    expect(breaks.map((b) => b.reason)).toEqual(['system']);
  });

  it('reads a carried config back from a copy of it too', async () => {
    let step = 0;
    const { send, breaks } = middlewareWith({
      dynamicState: { getState: () => ({ step: ++step }) },
    });
    const run = { requestId: 'run' };
    const first = await send([user('q1')], run);
    // Another middleware copied the messages.
    const second = await send(
      [...structuredClone(first.messages), toolCall('t1'), toolResult('t1')],
      run,
    );

    expect(second.messages).toEqual([
      user('q1'),
      stateEvent(1, 1),
      toolCall('t1'),
      toolResult('t1'),
      stateEvent(2, 2),
    ]);
    expect(breaks).toEqual([]);
  });

  it('reads a config from another run as the host sent it, even one that opens with the last request', async () => {
    let step = 0;
    const { send, breaks } = middlewareWith({
      dynamicState: { getState: () => ({ step: ++step }) },
    });
    const first = await send([user('q1')]);
    // A host that stored what the engine sent, events and all, and sends it back next run.
    const next = await send([...first.messages, reply('a1'), user('q2')]);

    expect(next.messages).toEqual([
      user('q1'),
      stateEvent(1, 1),
      stateEvent(1, 1),
      reply('a1'),
      user('q2'),
      stateEvent(2, 2),
    ]);
    expect(breaks).toEqual([]);
  });

  it('keeps each run its own carried record when two runs on one thread interleave', async () => {
    let step = 0;
    const { send, breaks } = middlewareWith({
      dynamicState: { getState: () => ({ step: ++step }) },
    });
    const a1 = await send([user('q1')], { requestId: 'A' });
    await send([user('q1')], { requestId: 'B' });
    const a2 = await send([...a1.messages, toolCall('t1'), toolResult('t1')], {
      ...a1,
      requestId: 'A',
    });

    // Run B's firing appended its event where run A's stands, one message with it (the
    // thread's one ledger); nothing of run A's request comes back as a host message.
    expect(a2.messages).toEqual([
      user('q1'),
      user(`${stateEvent(1, 1).content}\n\n${stateEvent(2, 2).content}`),
      toolCall('t1'),
      toolResult('t1'),
      stateEvent(3, 3),
    ]);
    expect(breaks).toEqual([]);
  });

  it('replays a landed summary from a carried config without summarizing it again', async () => {
    const { compressionModel, strategy } = keepLastTurn();
    const { send, breaks } = middlewareWith({
      contextWindow: 100,
      tokenizer,
      overflow: { strategy },
    });
    const run = { requestId: 'run' };
    let last = await send(asked(1), run);
    const requests = [last.messages];
    for (const n of [1, 2, 3, 4, 5, 6]) {
      last = await send([...last.messages, reply(`a${n}`), user(`q${n + 1}`)], {
        ...last,
        ...run,
      });
      requests.push(last.messages);
    }

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(requests[4]).toEqual([summary(1), user('q5')]);
    expect(requests[6]).toEqual([
      summary(1),
      user('q5'),
      reply('a5'),
      user('q6'),
      reply('a6'),
      user('q7'),
    ]);
    expectAppendOnly(requests.slice(4));
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
  });

  it('sends the model an append-only conversation through a whole chat() run, and the next run', async () => {
    let step = 1;
    let instructions = 'Plan first.';
    const breaks: PrefixBreakEvent[] = [];
    const middleware = contextChefMiddleware({
      appendOnly: true,
      logger: { warn: vi.fn() },
      skill: () => ({ name: 's', description: '', instructions }),
      dynamicState: { getState: () => ({ step }) },
      onPrefixBreak: (event) => {
        breaks.push(event);
      },
    });
    const requests: ModelMessage[][] = [];
    const now = Date.now();
    const thought = (signature: string) => [
      { type: 'STEP_STARTED', stepName: 'thinking', stepId: signature, timestamp: now },
      {
        type: 'STEP_FINISHED',
        stepName: 'thinking',
        stepId: signature,
        delta: `Thinking signed ${signature}.`,
        timestamp: now,
      },
      { type: 'STEP_FINISHED', stepName: 'thinking', stepId: signature, signature, timestamp: now },
    ];
    const calling = (id: string) => [
      ...thought(`SIG_${id}`),
      { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'search', timestamp: now },
      { type: 'TOOL_CALL_END', toolCallId: id, input: { q: id }, timestamp: now },
      {
        type: 'RUN_FINISHED',
        runId: 'r',
        threadId: 'conv',
        finishReason: 'tool_calls',
        timestamp: now,
      },
    ];
    const answering = (text: string) => [
      { type: 'TEXT_MESSAGE_START', messageId: text, role: 'assistant', timestamp: now },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: text, delta: text, timestamp: now },
      { type: 'TEXT_MESSAGE_END', messageId: text, timestamp: now },
      { type: 'RUN_FINISHED', runId: 'r', threadId: 'conv', finishReason: 'stop', timestamp: now },
    ];
    const script = [calling('t1'), calling('t2'), answering('a1'), answering('a2')];
    const adapter = {
      kind: 'text' as const,
      name: 'mock',
      model: 'mock-model',
      '~types': {} as Record<string, unknown>,
      chatStream: (options: { messages: ModelMessage[] }) => {
        requests.push(options.messages);
        const chunks = script[requests.length - 1];
        return (async function* () {
          yield* chunks;
        })();
      },
      structuredOutput: vi.fn(),
    };
    const run = async (messages: ModelMessage[]) => {
      const stream = chat({
        adapter: adapter as never,
        messages,
        systemPrompts: [sys],
        threadId: 'conv',
        tools: [
          {
            ...search,
            execute: async ({ q }: { q: string }) => {
              step++;
              return `found ${q}`;
            },
          },
        ],
        middleware: [middleware],
      } as never) as AsyncIterable<unknown>;
      for await (const _chunk of stream) {
      }
    };
    /** What the model reads of a message: role, text, calls, and the signatures of its thinking. */
    const read = (m: ModelMessage) => [
      m.role,
      typeof m.content === 'string' ? m.content : null,
      m.toolCalls?.map((c) => c.id) ?? [],
      m.thinking?.map((t) => t.signature) ?? [],
    ];
    const called = (id: string): ModelMessage => ({
      role: 'assistant',
      content: null,
      toolCalls: [
        { id, type: 'function', function: { name: 'search', arguments: `{"q":"${id}"}` } },
      ],
      thinking: [{ content: `Thinking signed SIG_${id}.`, signature: `SIG_${id}` }],
    });

    await run([user('q1')]);
    // The client's conversation for the next run, as the engine built it; the skill changed.
    instructions = 'Answer briefly.';
    await run([
      user('q1'),
      called('t1'),
      toolResult('t1'),
      called('t2'),
      toolResult('t2'),
      reply('a1'),
      user('q2'),
    ]);

    expect(requests.map((r) => r.map(read))).toEqual([
      [read(user('q1')), read(stateEvent(1, 1))],
      [
        read(user('q1')),
        read(stateEvent(1, 1)),
        read(called('t1')),
        read(toolResult('t1')),
        read(stateEvent(2, 2)),
      ],
      [
        read(user('q1')),
        read(stateEvent(1, 1)),
        read(called('t1')),
        read(toolResult('t1')),
        read(stateEvent(2, 2)),
        read(called('t2')),
        read(toolResult('t2')),
        read(stateEvent(3, 3)),
      ],
      // The skill switch is a system checkpoint: the signed thinking goes, the rest stays.
      [
        read(user('q1')),
        read(stateEvent(1, 1)),
        read(toolCall('t1')),
        read(toolResult('t1')),
        read(stateEvent(2, 2)),
        read(toolCall('t2')),
        read(toolResult('t2')),
        read(stateEvent(3, 3)),
        read(reply('a1')),
        read(user('q2')),
      ],
    ]);
    expectAppendOnly(requests.slice(0, 3));
    expect(breaks).toEqual([
      { reason: 'system', at: 0, signed: false, strippedThinking: 2, sessionId: 'conv' },
    ]);
  });
});

describe('appendOnly: a compression lands once as the head', () => {
  it('replays the summary on later calls instead of summarizing again', async () => {
    const { compressionModel, strategy } = keepLastTurn();
    const onCompress = vi.fn();
    const { send, breaks } = middlewareWith({
      contextWindow: 100,
      tokenizer,
      onCompress,
      overflow: { strategy },
    });
    const requests: ModelMessage[][] = [];
    for (const n of [1, 2, 3, 4, 5, 6, 7]) requests.push((await send(asked(n))).messages);

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(requests[3]).toEqual(asked(4));
    expect(requests[4]).toEqual([summary(1), user('q5')]);
    expect(requests[5]).toEqual([summary(1), user('q5'), reply('a5'), user('q6')]);
    expect(requests[6]).toEqual([...requests[5], reply('a6'), user('q7')]);
    expectAppendOnly(requests.slice(4));
    expect(breaks).toEqual([
      { reason: 'compaction', at: 0, signed: false, strippedThinking: 0, sessionId: 'thread_1' },
    ]);
    expect(onCompress).toHaveBeenCalledTimes(1);
    expect(onCompress.mock.calls[0].slice(1)).toEqual([
      8,
      { compressedMessages: asked(5).slice(0, 8), replacement: [summary(1)] },
    ]);
  });

  it("hands onCompress only the host's messages: the events it summarized are none of them", async () => {
    let step = 0;
    const { strategy } = keepLastTurn();
    const onCompress = vi.fn();
    const { send } = middlewareWith({
      contextWindow: 100,
      tokenizer,
      overflow: { strategy },
      onCompress,
      dynamicState: { getState: () => ({ step: ++step }) },
    });
    for (const n of [1, 2, 3]) await send(asked(n));
    // q1 E1 a1 q2 E2 a2 q3 E3 a3 q4: 10 messages, over the trigger at a boundary.
    const landed = await send(asked(4));

    // The summary absorbed the earlier revisions: the state is stated afresh after it.
    expect(landed.messages).toEqual([summary(1), user('q4'), stateEvent(4, 1)]);
    expect(onCompress).toHaveBeenCalledTimes(1);
    expect(onCompress.mock.calls[0].slice(1)).toEqual([
      6,
      { compressedMessages: asked(4).slice(0, 6), replacement: [summary(1)] },
    ]);
  });

  /**
   * A host that keeps its own store and, as `onCompress` asks, replaces the
   * compressed slice with what `write` makes of the summary and the details
   * it is handed. Each call sends the store, `before` it may edit it; reply n
   * and question n + 1 are appended after it.
   */
  async function persisting(
    write: (
      summary: string,
      details: { compressedMessages: ModelMessage[]; replacement?: ModelMessage[] },
    ) => ModelMessage[],
    options: {
      keep?: number;
      turns?: number;
      before?: (store: ModelMessage[], n: number) => void;
    } = {},
  ) {
    const { keep = 1, turns = 7, before } = options;
    const { strategy } = keepLastTurn(keep);
    let store: ModelMessage[] = [user('q1')];
    const recorded = middlewareWith({
      contextWindow: 100,
      tokenizer,
      overflow: { strategy },
      onCompress: (summaryText, count, details) => {
        store = [...write(summaryText, details), ...store.slice(count)];
      },
    });
    const requests: ModelMessage[][] = [];
    for (let n = 1; n <= turns; n++) {
      before?.(store, n);
      requests.push((await recorded.send([...store])).messages);
      store = [...store, reply(`a${n}`, `S_${n}`), user(`q${n + 1}`)];
    }
    return { ...recorded, requests };
  }

  it('sends the same request from a store that took the summary in, thinking and all', async () => {
    const { requests, breaks } = await persisting((s) => [user(s)]);

    expect(requests[4]).toEqual([summary(1), user('q5')]);
    expect(requests[5]).toEqual([...requests[4], reply('a5', 'S_5'), user('q6')]);
    expect(requests[6]).toEqual([...requests[5], reply('a6', 'S_6'), user('q7')]);
    expectAppendOnly(requests.slice(4));
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
  });

  it('reports a history checkpoint at a summary the host wrote itself', async () => {
    const { requests, breaks } = await persisting(() => [user('My own summary.')]);

    expect(breaks.map((b) => [b.reason, b.at, b.strippedThinking])).toEqual([
      ['compaction', 0, 0],
      ['history', 0, 1],
    ]);
    expect(requests[5]).toEqual([user('My own summary.'), user('q5'), reply('a5'), user('q6')]);
  });

  it("is taken in when the host writes back the details' replacement", async () => {
    const { requests, breaks } = await persisting((_s, details) => [
      ...(details.replacement ?? []),
    ]);

    expect(requests[4]).toEqual([summary(1), user('q5')]);
    expect(requests[5]).toEqual([...requests[4], reply('a5', 'S_5'), user('q6')]);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
  });

  it('reads a store that took each summary in as it is, run after run, not the history it summarized', async () => {
    const { strategy } = keepLastTurn();
    let store: ModelMessage[] = [user('q1')];
    let written: string[] = [];
    const { send, breaks } = middlewareWith({
      contextWindow: 100,
      tokenizer,
      overflow: { strategy },
      truncate: {
        threshold: 40,
        tailChars: 10,
        storage: {
          write: (_name, content) => {
            written.push(content.split(' ')[2]);
          },
          read: () => null,
        },
      },
      onCompress: (_summary, count, details) => {
        store = [...(details.replacement ?? []), ...store.slice(count)];
      },
    });
    const big = (id: string): ModelMessage => ({
      role: 'tool',
      content: `BIG RESULT ${id} `.repeat(10),
      toolCallId: id,
    });
    const truncated: string[][] = [];
    for (let n = 1; n <= 7; n++) {
      written = [];
      await send([...store]);
      truncated.push(written);
      store = [...store, toolCall(`t${n}`), big(`t${n}`), reply(`a${n}`), user(`q${n + 1}`)];
    }

    // Each call truncates the results its store holds; a summarized one is gone for good.
    expect(truncated).toEqual([
      [],
      ['t1'],
      ['t1', 't2'],
      ['t3'],
      ['t3', 't4'],
      ['t5'],
      ['t5', 't6'],
    ]);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction', 'compaction', 'compaction']);
  });

  it('sends every message once the host edits one it kept behind the summary it wrote back', async () => {
    const { requests, breaks } = await persisting((s) => [user(s)], {
      keep: 3,
      turns: 6,
      before: (store, n) => {
        if (n === 6) store[1] = user('q4 (edited)');
      },
    });

    // The edit is a checkpoint at the message after the summary; nothing is left out.
    expect(requests[5]).toEqual([
      summary(1),
      user('q4 (edited)'),
      reply('a4'),
      user('q5'),
      reply('a5'),
      user('q6'),
    ]);
    expect(breaks.map((b) => [b.reason, b.at, b.strippedThinking])).toEqual([
      ['compaction', 0, 1],
      ['history', 1, 1],
    ]);
  });

  it('counts only the thinking a summary the host wrote itself newly strips', async () => {
    const { breaks } = await persisting(() => [user('My own summary.')], { keep: 3, turns: 6 });

    // a4 went without its thinking when the head landed; a5 is the one this break strips.
    expect(breaks.map((b) => [b.reason, b.at, b.strippedThinking])).toEqual([
      ['compaction', 0, 1],
      ['history', 0, 1],
    ]);
  });

  it('waits in a tool loop below the raw window, and collapses it past the window', async () => {
    const { compressionModel, strategy } = keepLastTurn();
    const { send } = middlewareWith({ contextWindow: 100, tokenizer, overflow: { strategy } });
    const requests: ModelMessage[][] = [];
    for (const n of [0, 1, 2, 3, 4, 5, 6]) requests.push((await send(rounds(n))).messages);

    // Round 4 is 9 messages, over the trigger in a tool turn: it waits.
    expect(requests[4]).toEqual(rounds(4));
    // Round 5 is 11, past the raw window: the whole loop collapses into one summary.
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(requests[5]).toEqual([summary(1)]);
    expect(requests[6]).toEqual([summary(1), toolCall('t6'), toolResult('t6')]);
  });

  it('counts what the loop added since the reported call on top of the report', async () => {
    const { compressionModel, strategy } = keepLastTurn();
    const { send, respond } = middlewareWith({
      contextWindow: 100,
      tokenizer,
      overflow: { strategy },
    });
    await send(rounds(1));
    respond(95);
    const next = await send(rounds(2));

    // 95 reported for the 3 messages sent, plus 20 for the 2 since: past the raw window.
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(next.messages).toEqual([summary(1)]);
  });
});

describe('appendOnly: checkpoints', () => {
  it('strips signed thinking from an edited message on, for good, and reports it', async () => {
    const { send, breaks } = middlewareWith();
    for (const n of [1, 2, 3]) await send(asked(n, true));
    const edited = asked(3, true);
    edited[1] = reply('a1, edited', 'S_1x');
    const changed = await send(edited);
    const later = await send([...edited, reply('a3', 'S_3'), user('q4')]);

    expect(breaks).toEqual([
      { reason: 'history', at: 1, signed: false, strippedThinking: 2, sessionId: 'thread_1' },
    ]);
    expect(changed.messages).toEqual([
      user('q1'),
      reply('a1, edited'),
      user('q2'),
      reply('a2'),
      user('q3'),
    ]);
    expect(later.messages).toEqual([...changed.messages, reply('a3', 'S_3'), user('q4')]);
  });

  it('drops a reply that held nothing but signed thinking once it is stripped', async () => {
    const { send } = middlewareWith();
    const thoughtOnly: ModelMessage = {
      role: 'assistant',
      content: null,
      thinking: [{ content: 'Thought.', signature: 'S_1' }],
    };
    await send([user('q1')]);
    await send([user('q1'), thoughtOnly, user('q2')]);
    const edited = await send([user('q1, edited'), thoughtOnly, user('q2')]);

    expect(edited.messages).toEqual([user('q1, edited'), user('q2')]);
  });

  it('keeps thinking nothing signed, and still reports the checkpoint', async () => {
    const { send, breaks } = middlewareWith();
    // As every TanStack adapter but Anthropic's hands thinking back: no signature.
    const answered: ModelMessage = {
      role: 'assistant',
      content: 'a1',
      thinking: [{ content: 'Thought.' }],
    };
    const thoughtOnly: ModelMessage = {
      role: 'assistant',
      content: null,
      thinking: [{ content: 'Thought.' }],
    };
    await send([user('q1')]);
    await send([user('q1'), answered, user('q2'), thoughtOnly, user('q3')]);
    const changed = await send([user('q1, edited'), answered, user('q2'), thoughtOnly, user('q3')]);

    expect(breaks).toEqual([
      { reason: 'history', at: 0, signed: false, strippedThinking: 0, sessionId: 'thread_1' },
    ]);
    expect(changed.messages).toEqual([
      user('q1, edited'),
      answered,
      user('q2'),
      thoughtOnly,
      user('q3'),
    ]);
  });

  it('strips only the signed blocks of a reply that also holds unsigned thinking', async () => {
    const { send, breaks } = middlewareWith();
    const mixed: ModelMessage = {
      role: 'assistant',
      content: 'a1',
      thinking: [{ content: 'Unsigned.' }, { content: 'Signed.', signature: 'S_1' }],
    };
    await send([user('q1')]);
    await send([user('q1'), mixed, user('q2')]);
    const changed = await send([user('q1, edited'), mixed, user('q2')]);

    expect(breaks.map((b) => b.strippedThinking)).toEqual([1]);
    expect(changed.messages[1]).toEqual({
      role: 'assistant',
      content: 'a1',
      thinking: [{ content: 'Unsigned.' }],
    });
  });

  it('reports the checkpoint a moving clear cut makes on every call', async () => {
    const { send, breaks } = middlewareWith({ clear: [{ target: 'tool-result', keepRecent: 1 }] });
    await send(rounds(0));
    await send(rounds(1));
    const next = await send(rounds(2));

    // t1's result went out in full; now that t2's is the recent one, it is cleared.
    expect(breaks).toEqual([
      { reason: 'history', at: 2, signed: false, strippedThinking: 0, sessionId: 'thread_1' },
    ]);
    expect(next.messages[2]).toEqual({
      role: 'tool',
      content: '[Old tool result content cleared]',
      toolCallId: 't1',
    });
    expect(next.systemPrompts).toEqual([sys, Prompts.TOOL_RESULT_CLEARED_INSTRUCTION]);
  });

  it('does not read a cache breakpoint moving onto the system prompt or a tool as a change', async () => {
    const { send, breaks } = middlewareWith();
    await send(asked(1, true), { tools: [search] });
    const cached: SystemPrompt = {
      content: sys,
      metadata: { cache_control: { type: 'ephemeral' } },
    };
    const cachedTool: Tool = { ...search, metadata: { cacheControl: { type: 'ephemeral' } } };
    const next = await send(asked(2, true), { systemPrompts: [cached], tools: [cachedTool] });

    expect(breaks).toEqual([]);
    expect(next.systemPrompts).toEqual([cached]);
  });

  it('treats a tool list change as a tools checkpoint', async () => {
    const { send, breaks } = middlewareWith();
    const fetchTool: Tool = { name: 'fetch', description: 'Fetch a page.' };
    await send(asked(1, true), { tools: [search] });
    await send(asked(2, true), { tools: [search] });
    await send(asked(3, true), { tools: [search, fetchTool] });

    expect(breaks).toEqual([
      { reason: 'tools', at: 0, signed: false, strippedThinking: 2, sessionId: 'thread_1' },
    ]);
  });

  it('keeps nothing of a call aborted while it compresses: the next one meets the same checkpoint', async () => {
    let aborting = true;
    // A strategy that takes until the call is aborted, and finds nothing to do once it is not.
    const slow: OverflowStrategy = {
      name: 'slow',
      apply: (input) =>
        new Promise((resolve, reject) => {
          const unchanged = { history: input.history, evicted: [], span: [] };
          const meta = { strategy: 'slow', windowId: input.window.current, changed: false };
          if (!aborting) return resolve({ ...unchanged, meta });
          if (input.signal?.aborted) return reject(new Error('aborted'));
          input.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const { send, breaks, warn } = middlewareWith({
      contextWindow: 100,
      tokenizer,
      overflow: { strategy: slow },
    });
    for (const n of [1, 2, 3]) await send(asked(n, true));
    // a1 edited, and 9 messages: over the trigger at a turn boundary, so the strategy runs.
    const edited = asked(5, true);
    edited[1] = reply('a1, edited', 'S_1x');

    const controller = new AbortController();
    const aborted = send(edited, { signal: controller.signal });
    controller.abort();
    // onConfig never fails the run: the request goes out as the host sent it.
    expect((await aborted).messages).toBe(edited);
    expect(warnings(warn, 'onConfig transform failed')).toHaveLength(1);
    expect(breaks).toEqual([]);

    aborting = false;
    await send(edited);
    expect(breaks.map((b) => [b.reason, b.at, b.strippedThinking])).toEqual([['history', 1, 4]]);
  });

  it('treats a skill switch as a system checkpoint', async () => {
    let skill = 'first';
    const { send, breaks } = middlewareWith({
      skill: () => ({ name: skill, description: '', instructions: `Act as ${skill}.` }),
    });
    await send(asked(1, true));
    await send(asked(2, true));
    skill = 'second';
    const switched = await send(asked(3, true));

    expect(breaks).toEqual([
      { reason: 'system', at: 0, signed: false, strippedThinking: 2, sessionId: 'thread_1' },
    ]);
    expect(switched.systemPrompts).toEqual([sys, 'Act as second.']);
  });

  it('goes ahead when onPrefixBreak throws, and says so', async () => {
    const { send, warn } = middlewareWith({
      onPrefixBreak: () => {
        throw new Error('handler down');
      },
    });
    await send(asked(1, true));
    await send(asked(2, true));
    const edited = asked(2, true);
    edited[1] = reply('a1, edited', 'S_1x');
    const changed = await send(edited);

    expect(changed.messages).toEqual([user('q1'), reply('a1, edited'), user('q2')]);
    expect(warnings(warn, 'onPrefixBreak threw')).toHaveLength(1);
  });

  it('keeps each thread to its own ledger', async () => {
    const { send, breaks } = middlewareWith();
    const other = [user('other 1')];
    for (const n of [1, 2, 3]) {
      await send(asked(n, true), { threadId: 'a' });
      await send([...other], { threadId: 'b' });
      other.push(reply(`other a${n}`, `O_${n}`), user(`other ${n + 1}`));
    }

    expect(breaks).toEqual([]);
  });

  it('warns once when a session meets a long history it never sent', async () => {
    const { send, warn, breaks } = middlewareWith();
    await send(asked(4, true), { threadId: 'restarted' });
    await send(asked(5, true), { threadId: 'evicted' });

    expect(breaks[0]).toEqual({
      reason: 'ledger',
      at: 0,
      signed: false,
      strippedThinking: 3,
      sessionId: 'restarted',
    });
    expect(warnings(warn, 'ledger is empty')).toHaveLength(1);
  });
});

describe('appendOnly: requests the conversation does not keep', () => {
  it('sends the structured-output call as a one-off: the conversation keeps its signed thinking', async () => {
    const { send, breaks } = middlewareWith();
    await send(asked(1, true), { tools: [search] });
    await send(asked(2, true), { tools: [search] });
    const structured = await send(asked(2, true), { tools: [search], phase: 'structuredOutput' });
    const next = await send(asked(3, true), { tools: [search] });

    // It goes out without tools, so without the thinking signed over them.
    expect(structured.messages).toEqual([user('q1'), reply('a1'), user('q2')]);
    expect(next.messages).toEqual(asked(3, true));
    expect(breaks).toEqual([]);
  });

  /**
   * A middleware whose skill store fails on demand, and the two requests the
   * conversation does not keep: the structured-output call of a run with
   * tools, and a firing that failed and went out as the engine had it.
   */
  function unkept() {
    let failing = false;
    const recorded = middlewareWith(
      {
        contextWindow: 100,
        tokenizer,
        overflow: { strategy: keepLastTurn().strategy },
        skill: () => {
          if (failing) throw new Error('skill store down');
          return null;
        },
      },
      { tools: [search] },
    );
    const requests = {
      'structured output': (messages: ModelMessage[]) =>
        recorded.send(messages, { phase: 'structuredOutput' }),
      'a failed firing': async (messages: ModelMessage[]) => {
        failing = true;
        const sent = await recorded.send(messages);
        failing = false;
        return sent;
      },
    };
    return { ...recorded, requests };
  }

  it.each([
    'structured output',
    'a failed firing',
  ] as const)('strips the signed thinking of the reply to one (%s), and only that', async (kind) => {
    const { send, requests, streamed, breaks } = unkept();
    await send(asked(1, true));
    await send(asked(2, true));
    streamed('S_2');
    await requests[kind](asked(2, true));
    streamed('S_X');
    const next = await send([
      ...asked(2, true),
      reply('a2', 'S_2'),
      reply('a2, once more', 'S_X'),
      user('q3'),
    ]);

    // Signed over a request the conversation never sent: it cannot be replayed in it.
    expect(next.messages).toEqual([
      ...asked(2, true),
      reply('a2', 'S_2'),
      reply('a2, once more'),
      user('q3'),
    ]);
    expect(breaks).toEqual([]);
  });

  it("captures the reply to a run's one-off though another run on the thread kept a firing meanwhile", async () => {
    const { send, streamed, breaks } = middlewareWith({}, { tools: [search] });
    await send(asked(1, true));
    await send(asked(2, true));
    await send(asked(2, true), { requestId: 'A', phase: 'structuredOutput' });
    await send(asked(2, true), { requestId: 'B' });
    streamed('S_STRUCT', 'A');
    const next = await send([...asked(2, true), reply('{"answer":2}', 'S_STRUCT'), user('q3')]);

    expect(next.messages).toEqual([...asked(2, true), reply('{"answer":2}'), user('q3')]);
    expect(breaks).toEqual([]);
  });

  it('takes a stream it configured no request for as one the ledger did not keep', async () => {
    const { middleware, send } = middlewareWith();
    await send(asked(1, true));
    const chunk = { type: 'STEP_FINISHED', stepName: 'thinking', signature: 'S_U', timestamp: 0 };
    middleware.onChunk?.(ctxOf({ requestId: 'elsewhere' }), chunk as StreamChunk);
    const next = await send([user('q1'), reply('a1', 'S_U'), user('q2')]);

    expect(next.messages).toEqual([user('q1'), reply('a1'), user('q2')]);
  });

  it('keeps stripping such a reply for as long as the host sends it', async () => {
    const { send, streamed } = middlewareWith({}, { tools: [search] });
    await send(asked(1, true));
    await send(asked(1, true), { phase: 'structuredOutput' });
    streamed('S_X');
    const answered = [user('q1'), reply('{"answer":1}', 'S_X'), user('q2')];
    const first = await send(answered);
    const later = await send([...answered, reply('a2', 'S_2'), user('q3')]);

    expect(first.messages).toEqual([user('q1'), reply('{"answer":1}'), user('q2')]);
    expect(later.messages).toEqual([...first.messages, reply('a2', 'S_2'), user('q3')]);
  });

  it('holds at most 16 signatures whose reply never came, and forgets one whose reply left', async () => {
    const { send, streamed } = middlewareWith({}, { tools: [search] });
    await send(asked(1, true));
    // Seventeen structured calls whose replies the host never stored.
    for (let i = 1; i <= 17; i++) {
      await send(asked(1, true), { phase: 'structuredOutput' });
      streamed(`O_${i}`);
    }
    const held = await send([user('q1'), reply('r1', 'O_1'), reply('r17', 'O_17'), user('q2')]);
    // The host drops r17 (a history checkpoint at it), then puts it back past the end.
    await send([user('q1'), reply('r1', 'O_1'), user('q2')]);
    const back = await send([
      user('q1'),
      reply('r1', 'O_1'),
      user('q2'),
      reply('r17', 'O_17'),
      user('q3'),
    ]);

    // O_1 went out first when the 17th came in; O_17 is stripped while its reply is held.
    expect(held.messages).toEqual([user('q1'), reply('r1', 'O_1'), reply('r17'), user('q2')]);
    // Gone from the host's conversation, it was forgotten: back, the reply is a new message.
    expect(back.messages[3]).toEqual(reply('r17', 'O_17'));
  });

  it.each([
    'structured output',
    'a failed firing',
  ] as const)('counts no usage of one (%s): it describes no request the ledger kept', async (kind) => {
    const { send, respond, requests, warn } = unkept();
    await send(rounds(1));
    const sent = await requests[kind](rounds(1));
    respond(95);
    const next = await send(rounds(2));

    if (kind === 'a failed firing') {
      expect(sent.messages).toEqual(rounds(1));
      expect(warnings(warn, 'onConfig transform failed')).toHaveLength(1);
    }
    // Counted by its own 5 messages, not 95 + 20: nothing compresses.
    expect(next.messages).toEqual(rounds(2));
  });
});

describe('appendOnly: a structured chat() run without tools', () => {
  /**
   * chat() with an `outputSchema` and no tools makes one model call, the
   * structured one: the middleware sees `init`, then `structuredOutput`. Each
   * run's request is recorded; `usage` is the prompt token count the adapter
   * reports for it, if any.
   */
  function structuredRuns(
    options: Partial<ContextChefOptions>,
    usage?: (sent: ModelMessage[]) => number,
  ) {
    const warn = vi.fn();
    const breaks: PrefixBreakEvent[] = [];
    const middleware = contextChefMiddleware({
      appendOnly: true,
      logger: { warn },
      onPrefixBreak: (event) => {
        breaks.push(event);
      },
      ...options,
    });
    const requests: ModelMessage[][] = [];
    const adapter = {
      kind: 'text' as const,
      name: 'mock',
      model: 'mock-model',
      '~types': {} as Record<string, unknown>,
      chatStream: () => {
        throw new Error('a run without tools makes no chat call');
      },
      structuredOutput: async ({ chatOptions }: { chatOptions: { messages: ModelMessage[] } }) => {
        requests.push(chatOptions.messages);
        const promptTokens = usage?.(chatOptions.messages);
        return {
          data: { answer: requests.length },
          rawText: `{"answer":${requests.length}}`,
          ...(promptTokens === undefined
            ? {}
            : { usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 } }),
        };
      },
    };
    const run = (messages: ModelMessage[]) =>
      chat({
        adapter: adapter as never,
        messages,
        threadId: 'conv',
        outputSchema: {
          type: 'object',
          properties: { answer: { type: 'number' } },
          required: ['answer'],
        },
        middleware: [middleware],
      } as never);
    return { run, requests, warn, breaks };
  }

  it("sends its one call as the conversation's: kept, compressed, its signed thinking replayed", async () => {
    const { compressionModel, strategy } = keepLastTurn();
    const { run, requests, warn, breaks } = structuredRuns({
      contextWindow: 100,
      tokenizer,
      overflow: { strategy },
    });
    for (const n of [1, 3, 5, 7, 9]) await run(asked(n, true));

    expect(requests).toEqual([
      asked(1, true),
      asked(3, true),
      // 9 messages are over the trigger, at a turn boundary: the summary lands.
      [summary(1), user('q5')],
      // It stands in from then on, and the thinking after it is replayed.
      [summary(1), ...asked(7, true).slice(8)],
      // 10 messages: over the trigger once more.
      [summary(2), user('q9')],
    ]);
    expect(compressionModel).toHaveBeenCalledTimes(2);
    expect(breaks.map((b) => [b.reason, b.strippedThinking])).toEqual([
      ['compaction', 0],
      ['compaction', 0],
    ]);
    expect(warnings(warn, 'ledger is empty')).toEqual([]);
  });

  it('counts the usage its call reports', async () => {
    const { compressionModel, strategy } = keepLastTurn();
    const { run, requests } = structuredRuns(
      { contextWindow: 100, tokenizer, overflow: { strategy } },
      () => 95,
    );
    await run(asked(1, true));
    await run(asked(2, true));

    // 95 reported for the one message sent, plus 20 for the 2 since: past the
    // raw window, though the 3 messages count 30.
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(requests[1]).toEqual([summary(1), user('q2')]);
  });
});

describe('appendOnly: construction warnings', () => {
  it.each([
    [{ compact: { reasoning: 'before-last-message' } }, "compact.reasoning: 'before-last-message'"],
    [
      { compact: { toolCalls: 'before-last-2-messages' } },
      "compact.toolCalls: 'before-last-2-messages'",
    ],
    [
      { compact: { toolCalls: [{ type: 'before-last-message', tools: ['search'] }] } },
      "compact.toolCalls: 'before-last-message'",
    ],
    [
      { clear: [{ target: 'tool-result', keepRecent: 3 }] },
      "clear: { target: 'tool-result', keepRecent: 3 }",
    ],
  ] as const)('warns once that %o rewrites earlier messages every call', (options, named) => {
    const { warn } = middlewareWith(options as Partial<ContextChefOptions>);

    expect(warnings(warn, 'appendOnly')).toHaveLength(1);
    expect(warn.mock.calls[0][0]).toContain(named);
    // Once a compression landed, the rewrite reaches what it summarized: it lands again every call.
    expect(warn.mock.calls[0][0]).toContain(
      'drops its summary, and the conversation is summarized again on every call',
    );
  });

  it("does not warn for settings that rewrite each message once ('all')", () => {
    const { warn } = middlewareWith({
      compact: { reasoning: 'all', toolCalls: 'all' },
      clear: ['tool-result', 'thinking'],
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn about moving settings with appendOnly off', () => {
    const { warn } = middlewareWith({
      appendOnly: false,
      compact: { reasoning: 'before-last-message' },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once that transformContext must give the same bytes every call, and only under appendOnly', () => {
    const transformContext = (messages: ModelMessage[], systemPrompts: SystemPrompt[]) => ({
      messages,
      systemPrompts,
    });
    const on = middlewareWith({ transformContext });
    const off = middlewareWith({ appendOnly: false, transformContext });

    expect(warnings(on.warn, '`transformContext` runs on every call')).toHaveLength(1);
    expect(on.warn.mock.calls[0][0]).toContain('thinking signed over an earlier call');
    expect(on.warn.mock.calls[0][0]).toContain('`dynamicState`');
    expect(off.warn).not.toHaveBeenCalled();
  });

  it('accepts clearAt, warns once that it is ignored, and keeps events on the user channel', async () => {
    const { send, warn } = middlewareWith({
      appendOnly: { clearAt: true },
      dynamicState: { getState: () => ({ step: 1 }), placement: 'system' },
    });
    const first = await send([user('q1')]);
    await send(asked(2));

    expect(warnings(warn, 'clearAt')).toHaveLength(1);
    expect(first.messages).toEqual([user('q1'), stateEvent(1, 1)]);
  });
});

describe('durable compaction: keptReasoning', () => {
  const summarizer = {
    kind: 'text' as const,
    name: 'mock',
    model: 'mock-summarizer',
    '~types': {} as Record<string, unknown>,
    chatStream: () =>
      (async function* () {
        yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'SUMMARY' };
      })(),
    structuredOutput: vi.fn(),
  };
  const thinking = [{ content: 'Thought.', signature: 'S' }];
  const messages: ModelMessage[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1', thinking },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: null, thinking },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a3', thinking },
  ];

  it("keeps the kept messages' thinking by default", async () => {
    const result = await compactTanStackMessages(messages, summarizer as never, {
      keepRecentTurns: 4,
    });

    expect(result.slice(1)).toEqual(messages.slice(2));
  });

  it("'strip' removes it, and a reply left with nothing", async () => {
    const result = await compactTanStackMessages(messages, summarizer as never, {
      keepRecentTurns: 4,
      keptReasoning: 'strip',
    });

    expect(result.slice(1)).toEqual([
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
    ]);
  });

  it("'strip' leaves a history with nothing to compact as it is", async () => {
    const result = await compactTanStackMessages(messages, summarizer as never, {
      keepRecentTurns: 99,
      keptReasoning: 'strip',
    });

    expect(result).toBe(messages);
  });

  it("plans with 'strip' the same way", () => {
    const plan = planCompactionTanStackMessages(messages, {
      keepRecentTurns: 4,
      keptReasoning: 'strip',
    });

    expect(plan.toSummarize).toEqual(messages.slice(0, 2));
    expect(plan.toKeep).toEqual([
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
    ]);
  });
});
