/**
 * `appendOnly` through the middleware: an agent loop calls the model again and
 * again with its whole history, and each prompt must repeat the one before it
 * and only append — dynamic state as events, a landed compression as the head
 * every later call replays, every rewrite a reported checkpoint.
 *
 * The tokenizer counts 10 tokens a conversation message against the default
 * trigger (0.7 of a raw window of 100): a conversation of 9 messages is over
 * the trigger, one of 11 past the raw window. Every expected prompt is worked
 * out by hand.
 */

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import { type Message, type OverflowStrategy, Prompts, summarize } from '@context-chef/core';
import { generateText, type ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { checkSentPrefix, type SentPayload } from '../../core/src/pipeline/checks';
import { compactModelMessages, planCompactionModelMessages } from '../src/compaction';
import { withContextChef } from '../src/index';
import { createMiddleware } from '../src/middleware';
import type { ContextChefOptions, PrefixBreakEvent } from '../src/types';

const sys: LanguageModelV4Message = { role: 'system', content: 'You are terse.' };
const user = (text: string): LanguageModelV4Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
});
const reasoning = (signature: string) => ({
  type: 'reasoning' as const,
  text: `Reasoning signed ${signature}.`,
  providerOptions: { anthropic: { signature } },
});
/** A reply; with a signature, it carries the reasoning signed with it. */
const reply = (text: string, signature?: string): LanguageModelV4Message => ({
  role: 'assistant',
  content: [...(signature ? [reasoning(signature)] : []), { type: 'text', text }],
});
const toolCall = (id: string): LanguageModelV4Message => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: 'search', input: { q: id } }],
});
const toolResult = (id: string): LanguageModelV4Message => ({
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId: id,
      toolName: 'search',
      output: { type: 'text', value: `found ${id}` },
    },
  ],
});

/** The prompt when question `n` is asked: q1 a1 q2 … qn, reply i signed S_i when `signed`. */
function asked(n: number, signed = false): LanguageModelV4Prompt {
  const prompt = [sys, user('q1')];
  for (let i = 1; i < n; i++)
    prompt.push(reply(`a${i}`, signed ? `S_${i}` : undefined), user(`q${i + 1}`));
  return prompt;
}
/** The prompt after `n` tool rounds of the first question. */
function rounds(n: number): LanguageModelV4Prompt {
  const prompt = [sys, user('q1')];
  for (let i = 1; i <= n; i++) prompt.push(toolCall(`t${i}`), toolResult(`t${i}`));
  return prompt;
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

function mockModel(inputTokens = 100): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},
    async doGenerate(_opts: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: undefined },
        warnings: [],
        usage: {
          inputTokens: {
            total: inputTokens,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: undefined, reasoning: undefined },
        },
        response: { id: 'id', timestamp: new Date(), modelId: 'test-model' },
      };
    },
    async doStream() {
      throw new Error('not used');
    },
  };
}

function middlewareWith(options: Partial<ContextChefOptions> = {}) {
  const warn = vi.fn();
  const breaks: PrefixBreakEvent[] = [];
  const middleware = createMiddleware({
    appendOnly: true,
    logger: { warn },
    onPrefixBreak: (event) => {
      breaks.push(event);
    },
    ...options,
  });

  const send = async (
    prompt: LanguageModelV4Prompt,
    providerOptions?: LanguageModelV4CallOptions['providerOptions'],
    abortSignal?: AbortSignal,
  ): Promise<LanguageModelV4Prompt> => {
    const transform = middleware.transformParams;
    if (!transform) throw new Error('transformParams is undefined');
    const params: LanguageModelV4CallOptions = {
      prompt,
      ...(providerOptions ? { providerOptions } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    };
    return (await transform({ params, type: 'generate', model: mockModel() })).prompt;
  };

  /** The response to the call last sent, reporting `inputTokens`. */
  const respond = async (inputTokens: number) => {
    const wrap = middleware.wrapGenerate;
    if (!wrap) throw new Error('wrapGenerate is undefined');
    const model = mockModel(inputTokens);
    await wrap({
      doGenerate: () => model.doGenerate({ prompt: [] }),
      doStream: () => model.doStream({ prompt: [] }),
      params: { prompt: [] },
      model,
    });
  };

  /** The same response, streamed: the count comes with the finish part. */
  const respondStreaming = async (inputTokens: number) => {
    const wrap = middleware.wrapStream;
    if (!wrap) throw new Error('wrapStream is undefined');
    const model = mockModel(inputTokens);
    const finish: LanguageModelV4StreamPart = {
      type: 'finish',
      usage: (await model.doGenerate({ prompt: [] })).usage,
      finishReason: { unified: 'stop', raw: undefined },
    };
    const { stream } = await wrap({
      doGenerate: () => model.doGenerate({ prompt: [] }),
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue(finish);
            controller.close();
          },
        }),
      }),
      params: { prompt: [] },
      model,
    });
    const reader = stream.getReader();
    while (!(await reader.read()).done) {}
  };

  return { middleware, send, respond, respondStreaming, warn, breaks };
}

/** A prompt sent, as the cross-turn check compares the next one with it. */
function sentPrompt(prompt: LanguageModelV4Prompt): SentPayload {
  let replied = 0;
  prompt.forEach((message, i) => {
    if (message.role === 'assistant') replied = i + 1;
  });
  return { payload: { messages: prompt }, replied, asked: prompt.length, hostLength: 0 };
}

/** Each prompt repeats the one before it and only appends: every call was answered. */
function expectAppendOnly(prompts: LanguageModelV4Prompt[]) {
  for (let i = 1; i < prompts.length; i++) {
    expect(checkSentPrefix(sentPrompt(prompts[i - 1]), { messages: prompts[i] }, true)).toEqual([]);
  }
}

const warnings = (warn: ReturnType<typeof vi.fn>, text: string) =>
  warn.mock.calls.filter(([message]) => String(message).includes(text));

describe('appendOnly: dynamic state as events', () => {
  it('appends the state once after the turn it changed in, so every prompt repeats the last', async () => {
    let step = 0;
    const { send, breaks } = middlewareWith({
      dynamicState: { getState: () => ({ step: ++step }) },
    });
    const first = await send([sys, user('q1')]);
    const second = await send([sys, user('q1'), toolCall('t1'), toolResult('t1')]);
    const third = await send([
      sys,
      user('q1'),
      toolCall('t1'),
      toolResult('t1'),
      reply('a1'),
      user('q2'),
    ]);

    expect(first).toEqual([sys, user('q1'), stateEvent(1, 1)]);
    expect(second).toEqual([...first, toolCall('t1'), toolResult('t1'), stateEvent(2, 2)]);
    expect(third).toEqual([...second, reply('a1'), user('q2'), stateEvent(3, 3)]);
    expectAppendOnly([first, second, third]);
    expect(JSON.stringify(third)).not.toContain('_chef_event');
    expect(breaks).toEqual([]);
  });

  it("says 'system' placement state as a user message too", async () => {
    const { send } = middlewareWith({
      dynamicState: { getState: () => ({ step: 1 }), placement: 'system' },
    });

    expect(await send([sys, user('q1')])).toEqual([sys, user('q1'), stateEvent(1, 1)]);
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
    const prompts: LanguageModelV4Prompt[] = [];
    for (const n of [1, 2, 3, 4, 5, 6, 7]) prompts.push(await send(asked(n)));

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(prompts[3]).toEqual(asked(4));
    expect(prompts[4]).toEqual([sys, summary(1), user('q5')]);
    expect(prompts[5]).toEqual([sys, summary(1), user('q5'), reply('a5'), user('q6')]);
    expect(prompts[6]).toEqual([...prompts[5], reply('a6'), user('q7')]);
    expectAppendOnly(prompts.slice(4));
    expect(breaks).toEqual([
      { reason: 'compaction', at: 0, signed: false, strippedThinking: 0, sessionId: '__default__' },
    ]);
    expect(onCompress).toHaveBeenCalledTimes(1);
    expect(onCompress.mock.calls[0].slice(1)).toEqual([
      8,
      { compressedMessages: asked(5).slice(1, 9), replacement: [summary(1)] },
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
      details: { compressedMessages: LanguageModelV4Prompt; replacement?: LanguageModelV4Prompt },
    ) => LanguageModelV4Message[],
    options: {
      keep?: number;
      turns?: number;
      before?: (store: LanguageModelV4Message[], n: number) => void;
    } = {},
  ) {
    const { keep = 1, turns = 7, before } = options;
    const { strategy } = keepLastTurn(keep);
    let store: LanguageModelV4Message[] = [user('q1')];
    const recorded = middlewareWith({
      contextWindow: 100,
      tokenizer,
      overflow: { strategy },
      onCompress: (summaryText, count, details) => {
        store = [...write(summaryText, details), ...store.slice(count)];
      },
    });
    const prompts: LanguageModelV4Prompt[] = [];
    for (let n = 1; n <= turns; n++) {
      before?.(store, n);
      prompts.push(await recorded.send([sys, ...store]));
      store = [...store, reply(`a${n}`, `S_${n}`), user(`q${n + 1}`)];
    }
    return { ...recorded, prompts };
  }

  it('sends the same prompt from a store that took the summary in, reasoning and all', async () => {
    const { prompts, breaks } = await persisting((s) => [user(s)]);

    expect(prompts[4]).toEqual([sys, summary(1), user('q5')]);
    expect(prompts[5]).toEqual([...prompts[4], reply('a5', 'S_5'), user('q6')]);
    expect(prompts[6]).toEqual([...prompts[5], reply('a6', 'S_6'), user('q7')]);
    expectAppendOnly(prompts.slice(4));
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
  });

  it('reports a history checkpoint at a summary the host wrote itself', async () => {
    const { prompts, breaks } = await persisting(() => [user('My own summary.')]);

    expect(breaks.map((b) => [b.reason, b.at, b.strippedThinking])).toEqual([
      ['compaction', 0, 0],
      ['history', 0, 1],
    ]);
    expect(prompts[5]).toEqual([sys, user('My own summary.'), user('q5'), reply('a5'), user('q6')]);
  });

  it("is taken in when the host writes back the details' replacement", async () => {
    const { prompts, breaks } = await persisting((_s, details) => [...(details.replacement ?? [])]);

    expect(prompts[4]).toEqual([sys, summary(1), user('q5')]);
    expect(prompts[5]).toEqual([...prompts[4], reply('a5', 'S_5'), user('q6')]);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
  });

  it('takes the replacement in from a generateText store of ModelMessages, end to end', async () => {
    // Claude through @ai-sdk/anthropic: reply n comes with reasoning signed SIG_n.
    const prompts: LanguageModelV4Prompt[] = [];
    const claude: LanguageModelV4 = {
      ...mockModel(10),
      provider: 'anthropic.messages',
      async doGenerate(options) {
        prompts.push(options.prompt);
        const n = prompts.length;
        const result = await mockModel(10).doGenerate(options);
        return {
          ...result,
          content: [
            {
              type: 'reasoning',
              text: `Reasoning ${n}.`,
              providerMetadata: { anthropic: { signature: `SIG_${n}` } },
            },
            { type: 'text', text: `a${n}` },
          ],
        };
      },
    };
    const { compressionModel, strategy } = keepLastTurn();
    const breaks: PrefixBreakEvent[] = [];
    let store: ModelMessage[] = [{ role: 'user', content: 'q1' }];
    const model = withContextChef(claude, {
      appendOnly: true,
      logger: { warn: vi.fn() },
      contextWindow: 100,
      tokenizer,
      overflow: { strategy },
      onPrefixBreak: (event) => {
        breaks.push(event);
      },
      onCompress: (_summary, count, details) => {
        // The summary is a user text message, which reads the same as a ModelMessage.
        store = [...((details.replacement ?? []) as ModelMessage[]), ...store.slice(count)];
      },
    });
    for (let n = 1; n <= 7; n++) {
      const { response } = await generateText({ model, system: 'You are terse.', messages: store });
      store = [...store, ...response.messages, { role: 'user', content: `q${n + 1}` }];
    }
    /** What the model read: each message's role, then its text and the signature of its reasoning. */
    const read = (prompt: LanguageModelV4Prompt) =>
      prompt.map((message) =>
        typeof message.content === 'string'
          ? [message.role, message.content]
          : [
              message.role,
              ...message.content.map((part) =>
                part.type === 'reasoning'
                  ? `reasoning ${part.providerOptions?.anthropic?.signature}`
                  : part.type === 'text'
                    ? part.text
                    : part.type,
              ),
            ],
      );
    const system = ['system', 'You are terse.'];
    const head = ['user', Prompts.getCompactSummaryWrapper('SUMMARY 1')];
    const q = (n: number) => ['user', `q${n}`];
    const a = (n: number) => ['assistant', `reasoning SIG_${n}`, `a${n}`];

    // 9 messages at the fifth call: over the trigger, so the summary lands there.
    expect(read(prompts[3])).toEqual([system, q(1), a(1), q(2), a(2), q(3), a(3), q(4)]);
    expect(read(prompts[4])).toEqual([system, head, q(5)]);
    // Sent from the store that took it in: nothing to report, and the reasoning after it replayed.
    expect(read(prompts[5])).toEqual([system, head, q(5), a(5), q(6)]);
    expect(read(prompts[6])).toEqual([system, head, q(5), a(5), q(6), a(6), q(7)]);
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(breaks.map((b) => [b.reason, b.at, b.strippedThinking])).toEqual([['compaction', 0, 0]]);
  });

  it('sends every message once the host edits one it kept behind the summary it wrote back', async () => {
    const { prompts, breaks } = await persisting((s) => [user(s)], {
      keep: 3,
      turns: 6,
      before: (store, n) => {
        if (n === 6) store[1] = user('q4 (edited)');
      },
    });

    // The edit is a checkpoint at the message after the summary; nothing is left out.
    expect(prompts[5]).toEqual([
      sys,
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

  it('counts only the reasoning a summary the host wrote itself newly strips', async () => {
    const { breaks } = await persisting(() => [user('My own summary.')], { keep: 3, turns: 6 });

    // a4 went without its reasoning when the head landed; a5 is the one this break strips.
    expect(breaks.map((b) => [b.reason, b.at, b.strippedThinking])).toEqual([
      ['compaction', 0, 1],
      ['history', 0, 1],
    ]);
  });

  it('waits in a tool loop below the raw window, and collapses it past the window', async () => {
    const { compressionModel, strategy } = keepLastTurn();
    const { send } = middlewareWith({ contextWindow: 100, tokenizer, overflow: { strategy } });
    const prompts: LanguageModelV4Prompt[] = [];
    for (const n of [0, 1, 2, 3, 4, 5, 6]) prompts.push(await send(rounds(n)));

    // Round 4 is 9 messages, over the trigger in a tool turn: it waits.
    expect(prompts[4]).toEqual(rounds(4));
    // Round 5 is 11, past the raw window: the whole loop collapses into one summary.
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(prompts[5]).toEqual([sys, summary(1)]);
    expect(prompts[6]).toEqual([sys, summary(1), toolCall('t6'), toolResult('t6')]);
  });

  it.each([
    'respond',
    'respondStreaming',
  ] as const)('counts what the loop added since the reported call on top of the report (%s)', async (how) => {
    const { compressionModel, strategy } = keepLastTurn();
    const responder = middlewareWith({
      contextWindow: 100,
      tokenizer,
      overflow: { strategy },
    });
    const { send } = responder;
    await send(rounds(1));
    await responder[how](95);
    const next = await send(rounds(2));

    // 95 reported for the 3 messages sent, plus 20 for the 2 since: past the raw window.
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(next).toEqual([sys, summary(1)]);
  });

  it('yields to provider-side context management, and still appends events', async () => {
    const { compressionModel, strategy } = keepLastTurn();
    const { send, warn } = middlewareWith({
      contextWindow: 100,
      tokenizer,
      overflow: { strategy },
      dynamicState: { getState: () => ({ step: 1 }) },
    });
    const managed = { anthropic: { contextManagement: { edits: [] } } };
    const prompt = await send(asked(6), managed);

    expect(compressionModel).not.toHaveBeenCalled();
    expect(prompt).toEqual([...asked(6), stateEvent(1, 1)]);
    expect(warnings(warn, 'server-side context management')).toHaveLength(1);
  });
});

describe('appendOnly: checkpoints', () => {
  it('strips reasoning from an edited message on, for good, and reports it', async () => {
    const { send, breaks } = middlewareWith();
    for (const n of [1, 2, 3]) await send(asked(n, true));
    const edited = asked(3, true);
    edited[2] = reply('a1, edited', 'S_1x');
    const changed = await send(edited);
    const later = await send([...edited, reply('a3', 'S_3'), user('q4')]);

    expect(breaks).toEqual([
      { reason: 'history', at: 1, signed: false, strippedThinking: 2, sessionId: '__default__' },
    ]);
    expect(changed).toEqual([
      sys,
      user('q1'),
      reply('a1, edited'),
      user('q2'),
      reply('a2'),
      user('q3'),
    ]);
    expect(later).toEqual([...changed, reply('a3', 'S_3'), user('q4')]);
  });

  it('drops a reply that held nothing but reasoning once it is stripped', async () => {
    const { send } = middlewareWith();
    const thoughtOnly: LanguageModelV4Message = { role: 'assistant', content: [reasoning('S_1')] };
    await send([sys, user('q1')]);
    await send([sys, user('q1'), thoughtOnly, user('q2')]);
    const edited = await send([sys, user('q1, edited'), thoughtOnly, user('q2')]);

    expect(edited).toEqual([sys, user('q1, edited'), user('q2')]);
  });

  it('keeps reasoning no Anthropic-family provider signed, and still reports the checkpoint', async () => {
    const { send, breaks } = middlewareWith();
    // As @ai-sdk/openai hands reasoning back: an item id and encrypted content, no signature.
    const thought = {
      type: 'reasoning' as const,
      text: 'Thought.',
      providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' } },
    };
    const answered: LanguageModelV4Message = {
      role: 'assistant',
      content: [thought, { type: 'text', text: 'a1' }],
    };
    const thoughtOnly: LanguageModelV4Message = { role: 'assistant', content: [thought] };
    await send([sys, user('q1')]);
    await send([sys, user('q1'), answered, user('q2'), thoughtOnly, user('q3')]);
    const changed = await send([
      sys,
      user('q1, edited'),
      answered,
      user('q2'),
      thoughtOnly,
      user('q3'),
    ]);

    expect(breaks).toEqual([
      { reason: 'history', at: 0, signed: false, strippedThinking: 0, sessionId: '__default__' },
    ]);
    expect(changed).toEqual([
      sys,
      user('q1, edited'),
      answered,
      user('q2'),
      thoughtOnly,
      user('q3'),
    ]);
  });

  it('strips the reasoning Bedrock signed, and a redacted block, as it does a signed one', async () => {
    const { send, breaks } = middlewareWith();
    const bedrock: LanguageModelV4Message = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Thought.', providerOptions: { bedrock: { signature: 'B_1' } } },
        { type: 'text', text: 'a1' },
      ],
    };
    const redacted: LanguageModelV4Message = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '', providerOptions: { anthropic: { redactedData: 'R_2' } } },
        { type: 'text', text: 'a2' },
      ],
    };
    await send([sys, user('q1')]);
    await send([sys, user('q1'), bedrock, user('q2'), redacted, user('q3')]);
    const changed = await send([
      sys,
      user('q1, edited'),
      bedrock,
      user('q2'),
      redacted,
      user('q3'),
    ]);

    expect(breaks.map((b) => b.strippedThinking)).toEqual([2]);
    expect(changed).toEqual([
      sys,
      user('q1, edited'),
      reply('a1'),
      user('q2'),
      reply('a2'),
      user('q3'),
    ]);
  });

  it('reports the checkpoint a moving clear cut makes on every call', async () => {
    const { send, breaks } = middlewareWith({ clear: [{ target: 'tool-result', keepRecent: 1 }] });
    await send(rounds(0));
    await send(rounds(1));
    const next = await send(rounds(2));

    // t1's result went out in full; now that t2's is the recent one, it is cleared.
    expect(breaks).toEqual([
      { reason: 'history', at: 2, signed: false, strippedThinking: 0, sessionId: '__default__' },
    ]);
    expect(next[4]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 't1',
          toolName: 'search',
          output: { type: 'text', value: '[Old tool result content cleared]' },
        },
      ],
    });
  });

  it('does not read a cache breakpoint moving onto the system prompt as a change', async () => {
    const { send, breaks } = middlewareWith();
    await send(asked(1, true));
    const cached: LanguageModelV4Message = {
      ...sys,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    };
    const prompt = await send([cached, ...asked(2, true).slice(1)]);

    expect(breaks).toEqual([]);
    expect(prompt[0]).toEqual(cached);
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
    const { send, breaks } = middlewareWith({
      contextWindow: 100,
      tokenizer,
      overflow: { strategy: slow },
    });
    for (const n of [1, 2, 3]) await send(asked(n, true));
    // a1 edited, and 9 messages: over the trigger at a turn boundary, so the strategy runs.
    const edited = asked(5, true);
    edited[2] = reply('a1, edited', 'S_1x');

    const controller = new AbortController();
    const aborted = send(edited, undefined, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toThrow('aborted');
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
    await send(asked(3, true));

    expect(breaks).toEqual([
      { reason: 'system', at: 0, signed: false, strippedThinking: 2, sessionId: '__default__' },
    ]);
  });

  it('keeps each session to its own ledger', async () => {
    const { send, breaks } = middlewareWith();
    const a = { contextChef: { sessionId: 'a' } };
    const b = { contextChef: { sessionId: 'b' } };
    const other = [sys, user('other 1')];
    for (const n of [1, 2, 3]) {
      await send(asked(n, true), a);
      await send(other, b);
      other.push(reply(`other a${n}`, `O_${n}`), user(`other ${n + 1}`));
    }

    expect(breaks).toEqual([]);
  });

  it('warns once when a session meets a long history it never sent', async () => {
    const { send, warn, breaks } = middlewareWith();
    await send(asked(4, true), { contextChef: { sessionId: 'restarted' } });
    await send(asked(5, true), { contextChef: { sessionId: 'evicted' } });

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

describe('appendOnly: construction warnings', () => {
  it.each([
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
      clear: ['tool-result'],
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for reasoning kept on the last message only, which is never one sent before', () => {
    // The last message of a request is the new question or tool result: every
    // reply loses its reasoning before a later call sends it again, as with 'all'.
    const { warn } = middlewareWith({ compact: { reasoning: 'before-last-message' } });

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
    const transformContext = (prompt: LanguageModelV4Prompt) => prompt;
    const on = middlewareWith({ transformContext });
    const off = middlewareWith({ appendOnly: false, transformContext });

    expect(warnings(on.warn, '`transformContext` runs on every call')).toHaveLength(1);
    expect(on.warn.mock.calls[0][0]).toContain('reasoning signed over an earlier call');
    expect(on.warn.mock.calls[0][0]).toContain('`dynamicState`');
    expect(off.warn).not.toHaveBeenCalled();
  });

  it('accepts clearAt, warns once that it is ignored, and keeps events on the user channel', async () => {
    const { send, warn } = middlewareWith({
      appendOnly: { clearAt: true },
      dynamicState: { getState: () => ({ step: 1 }), placement: 'system' },
    });
    const prompt = await send([sys, user('q1')]);
    await send(asked(2));

    expect(warnings(warn, 'clearAt')).toHaveLength(1);
    expect(prompt).toEqual([sys, user('q1'), stateEvent(1, 1)]);
  });
});

describe('durable compaction: keptReasoning', () => {
  const summarizer = mockModel();
  /** Signed through `@ai-sdk/anthropic`: a new summary in front of it breaks the signature. */
  const thought = {
    type: 'reasoning' as const,
    text: 'Thought.',
    providerOptions: { anthropic: { signature: 'S' } },
  };
  const messages: ModelMessage[] = [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: [thought, { type: 'text', text: 'a1' }] },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: [thought] },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: [thought, { type: 'text', text: 'a3' }] },
  ];

  it("keeps the kept messages' reasoning by default", async () => {
    const result = await compactModelMessages(messages, summarizer, { keepRecentTurns: 4 });

    expect(result.slice(2)).toEqual(messages.slice(3));
  });

  it("'strip' removes it, and a reply left with nothing", async () => {
    const result = await compactModelMessages(messages, summarizer, {
      keepRecentTurns: 4,
      keptReasoning: 'strip',
    });

    expect(result.slice(2)).toEqual([
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: [{ type: 'text', text: 'a3' }] },
    ]);
  });

  it("'strip' leaves a history with nothing to compact as it is", async () => {
    const result = await compactModelMessages(messages, summarizer, {
      keepRecentTurns: 99,
      keptReasoning: 'strip',
    });

    expect(result).toBe(messages);
  });

  it("plans with 'strip' the same way", () => {
    const plan = planCompactionModelMessages(messages, {
      keepRecentTurns: 4,
      keptReasoning: 'strip',
    });

    expect(plan.toSummarize).toEqual(messages.slice(1, 3));
    expect(plan.toKeep).toEqual([
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: [{ type: 'text', text: 'a3' }] },
    ]);
  });

  it("'strip' keeps reasoning no Anthropic-family provider signed, such as OpenAI's", async () => {
    const openai = {
      type: 'reasoning' as const,
      text: 'Thought.',
      providerOptions: { openai: { itemId: 'rs_1' } },
    };
    const mixed: ModelMessage[] = [
      ...messages.slice(0, 4),
      { role: 'assistant', content: [openai] },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: [thought, openai, { type: 'text', text: 'a3' }] },
    ];
    const result = await compactModelMessages(mixed, summarizer, {
      keepRecentTurns: 4,
      keptReasoning: 'strip',
    });

    expect(result.slice(2)).toEqual([
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: [openai] },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: [openai, { type: 'text', text: 'a3' }] },
    ]);
  });
});
