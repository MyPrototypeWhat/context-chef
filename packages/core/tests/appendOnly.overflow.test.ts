/**
 * `ChefConfig.appendOnly` and overflow: a landed compaction is a reported
 * checkpoint, and its result — the head — replaces the summarized host
 * messages in every later window, until the next overflow summarizes that
 * window (head and all) into a new one.
 *
 * Unsigned, it waits for the turn boundary while a tool turn is in progress,
 * unless it cannot wait: the model asked for a new window, or the window
 * outgrew the raw context window. Then the whole window, the turn in progress
 * included, collapses into one summary.
 *
 * Conversations are compiled turn by turn from the first request, as an agent
 * loop does; every expected message is worked out by hand. The tokenizer
 * counts 10 tokens a message against a trigger of 60 and a raw window of 100,
 * so a window of 7 messages is over the trigger and one of 11 past the window.
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  anchored,
  background,
  type ChefConfig,
  type ChefEvents,
  type CompressionDetails,
  ContextChef,
  chain,
  checkPrefixContinuity,
  fromAnthropic,
  InMemoryBackend,
  type ITargetAdapter,
  OpenAIAdapter,
  type OverflowInput,
  type OverflowStrategy,
  Prompts,
  reset,
  server,
  summarize,
} from '../src/index';
import { unchanged } from '../src/overflow/types';
import type {
  AnthropicPayload,
  ChefLogger,
  Message,
  OpenAIPayload,
  TargetPayload,
  ToolDefinition,
} from '../src/types';
import { estimateMessages } from '../src/utils/tokenUtils';

const silent: ChefLogger = { warn: () => {} };
const THREE = ['anthropic', 'openai', 'gemini'] as const;

const user = (content: string): Message => ({ role: 'user', content });
const reply = (content: string, signature: string): Message => ({
  role: 'assistant',
  content,
  thinking: { thinking: `Reasoning signed ${signature}.`, signature },
});
const call = (id: string, signature: string, name = 'search'): Message => ({
  role: 'assistant',
  content: '',
  thinking: { thinking: 'Search first.', signature },
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
});
const result = (id: string, content: string): Message => ({
  role: 'tool',
  content,
  tool_call_id: id,
});

// q1 a1 q2 a2 …: reply i is signed SIG_i. One array, so every turn shares the host's objects.
const qa: Message[] = [user('q1')];
for (let i = 1; i < 12; i++) qa.push(reply(`a${i}`, `SIG_${i}`), user(`q${i + 1}`));
/** The host history when question `n` is asked: q1 a1 q2 … qn. */
const asked = (n: number): Message[] => qa.slice(0, 2 * n - 1);

/** What the Anthropic target sends. */
const text = (role: 'user' | 'assistant', content: string) => ({
  role,
  content: [{ type: 'text', text: content }],
});
const answer = (i: number) => ({
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: `Reasoning signed SIG_${i}.`, signature: `SIG_${i}` },
    { type: 'text', text: `a${i}` },
  ],
});
/** The message the `n`th summary is sent as. */
const SUMMARY = (n: number) => Prompts.getCompactSummaryWrapper(`SUMMARY ${n}`);
/** The message that stands in for window `id` when it was reset rather than summarized. */
const RESET = (id: string | undefined) =>
  Prompts.getCompactSummaryWrapper(
    `Context window reset (window ${id}). Earlier conversation was cleared from the window.`,
  );

const ANCHOR = Prompts.EVENT_STATE_ANCHOR;
const State = z.object({ step: z.number() });
const state = (step: number, rev: number) =>
  `<dynamic_state rev="${rev}">\n  <step>${step}</step>\n</dynamic_state>`;
const announcement = (id: string, content: string, rev: number) =>
  `<announcement rev="${rev}" id="${id}">\n${content}\n</announcement>`;

const search: ToolDefinition = {
  name: 'search',
  description: 'Search the web',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
};

const tokenizer = (messages: Message[]): number => messages.length * 10;
const JANITOR = { contextWindow: 100, triggerRatio: 0.6, tokenizer };

type CompressionModel = (messages: Message[]) => Promise<string>;
const keepLast = (turns: number) => (compressionModel: CompressionModel) =>
  summarize({ compressionModel, split: 'recent-turns', preserveRecentMessages: turns });

/**
 * A chef that checks the pipeline invariants and records what it reports. Its
 * compression model answers `SUMMARY 1`, `SUMMARY 2`, … in turn.
 */
function chefWith(
  config: ChefConfig = {},
  strategy: (compressionModel: CompressionModel) => OverflowStrategy = keepLast(1),
) {
  let summaries = 0;
  const compressionModel = vi.fn(
    async (_messages: Message[]) => `<summary>SUMMARY ${++summaries}</summary>`,
  );
  const chef = new ContextChef({
    logger: silent,
    appendOnly: true,
    pipelineChecks: true,
    janitor: JANITOR,
    overflow: { strategy: strategy(compressionModel) },
    ...config,
  }).setSystemPrompt([{ role: 'system', content: 'You are terse.' }]);
  const breaks: ChefEvents['prefix:break'][] = [];
  const invariants: string[] = [];
  chef.on('prefix:break', (event) => {
    breaks.push(event);
  });
  chef.on('pipeline:invariant', ({ message }) => {
    invariants.push(message);
  });
  return { chef, compressionModel, breaks, invariants };
}

/** Compiles each turn in order, `setup` first, as the agent loop does. */
async function converse<P extends TargetPayload = AnthropicPayload>(
  chef: ContextChef,
  turns: Message[][],
  target: string | ITargetAdapter = 'anthropic',
  setup: (chef: ContextChef, turn: number) => void = () => {},
): Promise<P[]> {
  const payloads: P[] = [];
  for (const [i, history] of turns.entries()) {
    setup(chef, i + 1);
    payloads.push((await chef.setHistory(history).compile({ target })) as P);
  }
  return payloads;
}

function expectAppendOnly(payloads: TargetPayload[]) {
  for (let i = 1; i < payloads.length; i++) {
    expect(checkPrefixContinuity(payloads[i - 1], payloads[i])).toEqual({ ok: true });
  }
}

/** The signatures of the thinking blocks sent, in order. */
const signatures = (payload: AnthropicPayload): string[] =>
  payload.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .flatMap((b) => (b.type === 'thinking' ? [b.signature] : []));

/** What reaches the provider: the payload without `meta`. */
const wire = (payload: TargetPayload): Omit<TargetPayload, 'meta'> => {
  const { meta: _meta, ...rest } = payload;
  return rest;
};

const occurrences = (payload: TargetPayload, text: string): number =>
  JSON.stringify(wire(payload)).split(JSON.stringify(text).slice(1, -1)).length - 1;

/** Chat Completions message contents: the plainest view of the window. */
const contents = (payload: TargetPayload): string[] =>
  (payload as OpenAIPayload).messages.map((m) => String(m.content));

/** What the compression model was handed for its `n`th summary, without the instruction after it. */
const summarized = (model: ReturnType<typeof chefWith>['compressionModel'], n: number) =>
  model.mock.calls[n - 1][0].slice(0, -1);

const COMPACTED = { reason: 'compaction', at: 0, signed: false } as const;

describe('appendOnly overflow: a compaction is a checkpoint whose head stays', () => {
  it('lands over budget at a turn boundary, then replays its head while the window fits', async () => {
    const { chef, compressionModel, breaks, invariants } = chefWith();

    const payloads = await converse(chef, [1, 2, 3, 4, 5, 6].map(asked));
    const [, , , compacted, next, last] = payloads;

    // asked(4) is 7 messages: q1…a3 are summarized, the last turn is kept.
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(summarized(compressionModel, 1)).toEqual(asked(4).slice(0, 6));
    expect(compacted.messages).toEqual([text('user', SUMMARY(1)), text('user', 'q4')]);
    expect(compacted.meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 0 });
    expect(next.messages).toEqual([...compacted.messages, answer(4), text('user', 'q5')]);
    expect(last.messages).toEqual([...next.messages, answer(5), text('user', 'q6')]);
    expectAppendOnly(payloads.slice(0, 3));
    expectAppendOnly(payloads.slice(3));
    expect(payloads.map((p) => p.meta?.prefix?.stable)).toEqual([0, 1, 3, 0, 2, 4]);
    expect(breaks).toEqual([
      { ...COMPACTED, strippedThinking: 0, windowId: compacted.meta?.windowId },
    ]);
    expect(invariants).toEqual([]);
  });

  it('summarizes the window, head and all, the next time it is over budget', async () => {
    const { chef, compressionModel } = chefWith();

    const payloads = await converse(chef, [1, 2, 3, 4, 5, 6, 7].map(asked));

    // [SUMMARY 1, q4, a4, q5, a5, q6, a6, q7]: 8 messages.
    expect(compressionModel).toHaveBeenCalledTimes(2);
    expect(summarized(compressionModel, 2).map((m) => m.content)).toEqual([
      SUMMARY(1),
      'q4',
      'a4',
      'q5',
      'a5',
      'q6',
      'a6',
    ]);
    expect(payloads[6].messages).toEqual([text('user', SUMMARY(2)), text('user', 'q7')]);
    expect(payloads[6].meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 0 });
  });

  it.each(THREE)('replays the head instead of summarizing again (%s)', async (target) => {
    const { chef, compressionModel, breaks, invariants } = chefWith();

    const payloads = await converse(chef, [1, 2, 3, 4, 5, 6].map(asked), target);

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
    expectAppendOnly(payloads.slice(3));
    expect(invariants).toEqual([]);
  });

  it('keeps replaying the head in a chef restored from a snapshot', async () => {
    const first = chefWith();
    const [, , , compacted] = await converse(first.chef, [1, 2, 3, 4].map(asked));

    // A chef per request: the next one starts from what the last one kept.
    const restored = chefWith();
    restored.chef.restore(first.chef.snapshot());
    const [next] = await converse(restored.chef, [asked(5)]);

    expect(restored.compressionModel).not.toHaveBeenCalled();
    expect(next.messages).toEqual([...compacted.messages, answer(4), text('user', 'q5')]);
    expect(restored.breaks).toEqual([]);
  });

  it('still summarizes every compile over budget without appendOnly (4.x)', async () => {
    const { chef, compressionModel } = chefWith({ appendOnly: false });

    const [first, again] = await converse(chef, [asked(4), asked(4)]);

    expect(compressionModel).toHaveBeenCalledTimes(2);
    expect(first.messages).toEqual([text('user', SUMMARY(1)), text('user', 'q4')]);
    expect(again.messages).toEqual([text('user', SUMMARY(2)), text('user', 'q4')]);
    expect(first.meta).not.toHaveProperty('prefix');
  });
});

describe('appendOnly overflow: a host that persists the summary through onCompress', () => {
  /**
   * A host that keeps its own store and, as `onCompress` asks, replaces what
   * was compressed with what `write` makes of the summary and the details it
   * is handed. Each compile sends the store; the model's reply and the next
   * question are appended after it. `onCompress` counts are recorded.
   */
  async function persisting(
    write: (summary: Message, details: CompressionDetails) => Message[],
    options: {
      keep?: number;
      first?: Message;
      turns?: number;
      setup?: (chef: ContextChef) => void;
    } = {},
  ) {
    const { keep = 1, first = qa[0], turns = 6, setup } = options;
    let store: Message[] = [first];
    const counts: number[] = [];
    const onCompress = (summary: Message, count: number, details: CompressionDetails) => {
      counts.push(count);
      const kept = store.filter((m) => !details.compressedMessages.includes(m));
      store = [...write(summary, details), ...kept];
    };
    const recorded = chefWith({ janitor: { ...JANITOR, onCompress } }, keepLast(keep));
    setup?.(recorded.chef);
    const payloads: AnthropicPayload[] = [];
    for (let n = 1; n <= turns; n++) {
      payloads.push(
        (await recorded.chef
          .setHistory(store)
          .compile({ target: 'anthropic' })) as AnthropicPayload,
      );
      store = [...store, qa[2 * n - 1], qa[2 * n]];
    }
    return { ...recorded, payloads, counts, store: () => store };
  }

  it('sends the same window from the store that took the summary in, and keeps the thinking', async () => {
    const { payloads, breaks, invariants, compressionModel } = await persisting((s) => [s]);
    const [, , , compacted, next, last] = payloads;

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
    expect(next.messages).toEqual([...compacted.messages, answer(4), text('user', 'q5')]);
    expect(last.messages).toEqual([...next.messages, answer(5), text('user', 'q6')]);
    expect(signatures(last)).toEqual(['SIG_4', 'SIG_5']);
    expectAppendOnly(payloads.slice(3));
    expect(invariants).toEqual([]);
  });

  it('reports a `history` checkpoint at a summary the host wrote itself', async () => {
    const { payloads, breaks, invariants } = await persisting(() => [user('My own summary.')]);
    const [, , , , next] = payloads;

    expect(breaks.map(({ windowId: _id, ...b }) => b)).toEqual([
      { ...COMPACTED, strippedThinking: 0 },
      { reason: 'history', at: 0, signed: false, strippedThinking: 1 },
    ]);
    expect(next.messages).toEqual([
      text('user', 'My own summary.'),
      text('user', 'q4'),
      text('assistant', 'a4'),
      text('user', 'q5'),
    ]);
    expect(invariants).toEqual([]);
  });

  it('counts only the thinking a summary the host wrote itself newly strips', async () => {
    const { breaks } = await persisting(() => [user('My own summary.')], { keep: 3, turns: 5 });

    // a3 went without its thinking when the head landed; a4 is the one this break strips.
    expect(breaks.map((b) => [b.reason, b.strippedThinking])).toEqual([
      ['compaction', 1],
      ['history', 1],
    ]);
  });

  it('sends every message of a store that left out the pinned message the head put back', async () => {
    const pinned: Message = { ...qa[0], pinned: true };
    const { payloads, breaks, invariants, store } = await persisting((s) => [s], {
      keep: 3,
      first: pinned,
    });

    // The head no longer applies: the window is the store again, nothing of it dropped.
    expect(payloads[4].messages).toEqual([
      text('user', SUMMARY(1)),
      text('user', 'q3'),
      text('assistant', 'a3'),
      text('user', 'q4'),
      text('assistant', 'a4'),
      text('user', 'q5'),
    ]);
    expect(breaks.map(({ windowId: _id, ...b }) => b)).toEqual([
      { ...COMPACTED, strippedThinking: 1 },
      { reason: 'history', at: 0, signed: false, strippedThinking: 1 },
      { ...COMPACTED, strippedThinking: 1 },
    ]);
    // The second landing left the store whole.
    expect(store().map((m) => m.content)).toEqual([SUMMARY(2), 'q5', 'a5', 'q6', 'a6', 'q7']);
    expect(invariants).toEqual([]);
  });
});

describe('appendOnly overflow: an unsigned compaction strips the thinking it invalidated', () => {
  it('strips the thinking of the turns it kept, on Anthropic', async () => {
    const { chef, invariants } = chefWith({}, keepLast(3));

    const [, , , compacted, next] = await converse(chef, [1, 2, 3, 4, 5].map(asked));

    // q3, a3, q4 kept: a3 was signed over the q1…a2 the summary replaced.
    expect(compacted.messages).toEqual([
      text('user', SUMMARY(1)),
      text('user', 'q3'),
      text('assistant', 'a3'),
      text('user', 'q4'),
    ]);
    expect(compacted.meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 1 });
    expect(next.messages).toEqual([...compacted.messages, answer(4), text('user', 'q5')]);
    expect(signatures(next)).toEqual(['SIG_4']);
    expectAppendOnly([compacted, next]);
    expect(invariants).toEqual([]);
  });

  it('strips a pinned message the head put back after the summary, on Anthropic', async () => {
    const pinned = [...asked(4)];
    pinned[1] = { ...pinned[1], pinned: true };
    const { chef } = chefWith();

    const [, , , compacted, next] = await converse(chef, [
      pinned.slice(0, 1),
      pinned.slice(0, 3),
      pinned.slice(0, 5),
      pinned,
      [...pinned, ...asked(5).slice(7)],
    ]);

    expect(compacted.messages).toEqual([
      text('user', SUMMARY(1)),
      text('assistant', 'a1'),
      text('user', 'q4'),
    ]);
    expect(compacted.meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 1 });
    expect(signatures(next)).toEqual(['SIG_4']);
    expectAppendOnly([compacted, next]);
  });

  it('strips the thinking of a head built from copies of the window', async () => {
    // The hook hands the strategy copies: no kept message is the window's own, so the head is all of it.
    const { chef } = chefWith(
      { janitor: { ...JANITOR, onBeforeCompress: (history) => history.map((m) => ({ ...m })) } },
      keepLast(3),
    );

    const [, , , compacted, next] = await converse(chef, [1, 2, 3, 4, 5].map(asked));

    expect(compacted.messages).toEqual([
      text('user', SUMMARY(1)),
      text('user', 'q3'),
      text('assistant', 'a3'),
      text('user', 'q4'),
    ]);
    expect(compacted.meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 1 });
    expect(signatures(next)).toEqual(['SIG_4']);
    expectAppendOnly([compacted, next]);
  });

  it('strips nothing on other targets, which have no signature check', async () => {
    const pinned = [...asked(4)];
    pinned[1] = { ...pinned[1], pinned: true };
    const target = new OpenAIAdapter({ preserveThinkingAsText: true });
    const { chef } = chefWith({}, keepLast(3));

    const [, , , compacted] = await converse(
      chef,
      [pinned.slice(0, 1), pinned.slice(0, 3), pinned.slice(0, 5), pinned],
      target,
    );

    expect(compacted.meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 0 });
    expect(occurrences(compacted, 'Reasoning signed SIG_1.')).toBe(1);
    expect(occurrences(compacted, 'Reasoning signed SIG_3.')).toBe(1);
  });
});

describe('appendOnly overflow: in the middle of a tool turn it waits for the boundary', () => {
  // asked(3) is 5 messages; each tool step adds two.
  const loop1 = [...asked(3), call('t1', 'SIG_C1'), result('t1', 'r1')]; // 7: over the trigger
  const loop2 = [...loop1, call('t2', 'SIG_C2'), result('t2', 'r2')]; // 9
  const answered = [...loop2, reply('a3', 'SIG_3'), user('q4')]; // 11: a turn boundary
  const turns = [asked(1), asked(2), asked(3), loop1, loop2, answered];

  it('lands on the first compile after the tool turn, not during it', async () => {
    const { chef, compressionModel, breaks, invariants } = chefWith();

    const payloads = await converse(chef, turns);

    expect(signatures(payloads[4])).toEqual(['SIG_1', 'SIG_2', 'SIG_C1', 'SIG_C2']);
    expectAppendOnly(payloads.slice(0, 5));
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(summarized(compressionModel, 1)).toEqual(answered.slice(0, 10));
    expect(payloads[5].messages).toEqual([text('user', SUMMARY(1)), text('user', 'q4')]);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
    expect(invariants).toEqual([]);
  });

  it('still waits when the host put a system message after the tool results', async () => {
    const { chef, compressionModel, breaks } = chefWith();
    const noted: Message = { role: 'system', content: 'Results may be stale.', _positional: true };

    await converse(chef, [asked(1), asked(2), asked(3), [...loop1, noted]]);

    expect(compressionModel).not.toHaveBeenCalled();
    expect(breaks).toEqual([]);
  });

  it('opens one window per compaction, and none while it waits', async () => {
    const { chef } = chefWith();
    const opened = chef.snapshot().modules.janitor.window;

    const ids = (await converse(chef, turns)).map((p) => p.meta?.windowId);

    expect(ids.slice(0, 5)).toEqual(Array(5).fill(opened?.current));
    expect(ids[5]).not.toBe(opened?.current);
    expect(chef.snapshot().modules.janitor.window).toEqual({
      first: opened?.first,
      previous: opened?.current,
      current: ids[5],
    });
  });

  it('keeps the usage it waited on for the boundary compile', async () => {
    // No tokenizer: only the reported usage puts this window over the trigger.
    const { chef, compressionModel } = chefWith({
      janitor: { contextWindow: 1000, triggerRatio: 0.5 },
    });
    const loop = [...asked(2), call('t1', 'SIG_C1'), result('t1', 'r1')];
    const done = [...loop, reply('a2', 'SIG_2'), user('q3')];
    await converse(chef, [asked(1), asked(2)]);

    chef.reportTokenUsage(600);
    await converse(chef, [loop]);
    expect(compressionModel).not.toHaveBeenCalled();

    // Nothing reported since: the 600 still stands.
    const [compacted] = await converse(chef, [done]);
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(compacted.messages).toEqual([text('user', SUMMARY(1)), text('user', 'q3')]);
  });

  it('drops a usage reported from before a landing once, also while it waits', async () => {
    // No tokenizer: the reported usage alone puts these windows over the trigger of 500.
    const { chef, compressionModel, breaks } = chefWith({
      janitor: { contextWindow: 1000, triggerRatio: 0.5 },
    });
    const loop = [...asked(3), call('t1', 'SIG_C1'), result('t1', 'r1')];
    const done = [...loop, reply('a3', 'SIG_3'), user('q4')];
    await converse(chef, [asked(1), asked(2)]);
    chef.reportTokenUsage(600);
    await converse(chef, [asked(3)]);
    expect(compressionModel).toHaveBeenCalledTimes(1);

    // 100 for the compacted request: the first reading after the landing drops it, here while
    // the compaction waits. 600 for the tool step's request, which the boundary compile acts on.
    chef.reportTokenUsage(100);
    await converse(chef, [loop]);
    chef.reportTokenUsage(600);
    const [compacted] = await converse(chef, [done]);

    expect(compressionModel).toHaveBeenCalledTimes(2);
    expect(compacted.messages).toEqual([text('user', SUMMARY(2)), text('user', 'q4')]);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction', 'compaction']);
  });

  it('waits while the tool call the history ends with has no result yet', async () => {
    const { chef, compressionModel, breaks } = chefWith();

    // 8 messages, the last a tool call the host has not run.
    await converse(chef, [asked(1), asked(2), asked(3), [...loop1, call('t2', 'SIG_C2')]]);

    expect(compressionModel).not.toHaveBeenCalled();
    expect(breaks).toEqual([]);
  });

  it('collapses once the window being sent is past the raw window, however little was reported', async () => {
    const { chef, compressionModel } = chefWith({
      janitor: { contextWindow: 1000, triggerRatio: 0.5 },
    });
    const fetched = [...asked(2), call('t1', 'SIG_C1'), result('t1', 'x'.repeat(8000))];
    await converse(chef, [asked(1), asked(2)]);

    // The last request was small; this one carries some 2,400 tokens of tool output.
    chef.reportTokenUsage(100);
    const [collapsed] = await converse(chef, [fetched]);

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(collapsed.messages).toEqual([text('user', SUMMARY(1))]);
  });

  it.each([
    ['with', true],
    ['without', false],
  ])('counts an attachment at a flat cost, so a screenshot loop keeps waiting (%s usage reports)', async (_, reports) => {
    // A 300 KB PNG per step: its base64 counted as text would be some 120,000 tokens.
    const shot = (id: string): Message => ({
      role: 'tool',
      content: 'screenshot',
      tool_call_id: id,
      attachments: [{ mediaType: 'image/png', data: 'A'.repeat(400_000) }],
    });
    const { chef, compressionModel, breaks } = chefWith({ janitor: { contextWindow: 200_000 } });
    const history: Message[] = [user('Click through the app.')];
    await converse(chef, [history]);

    for (let i = 1; i <= 3; i++) {
      history.push(call(`t${i}`, `SIG_C${i}`), shot(`t${i}`));
      // What the provider reported for the request before this one.
      if (reports) chef.reportTokenUsage(3000 * i);
      await converse(chef, [[...history]]);
    }
    // The turn ends: the trigger is read the same way.
    if (reports) chef.reportTokenUsage(12_000);
    await converse(chef, [[...history, reply('Done.', 'SIG_D'), user('Thanks.')]]);

    expect(compressionModel).not.toHaveBeenCalled();
    expect(breaks).toEqual([]);
  });

  it('still counts the base64 of an attachment without appendOnly (4.x)', async () => {
    const shot: Message = {
      role: 'tool',
      content: 'screenshot',
      tool_call_id: 't1',
      attachments: [{ mediaType: 'image/png', data: 'A'.repeat(400_000) }],
    };
    // Some 120,000 tokens of base64 against a trigger of 70,000.
    const { chef, compressionModel } = chefWith({
      appendOnly: false,
      janitor: { contextWindow: 100_000 },
    });

    await converse(chef, [
      [user('q1'), call('t1', 'SIG_C1'), shot, reply('a1', 'SIG_1'), user('q2')],
    ]);

    expect(compressionModel).toHaveBeenCalledTimes(1);
  });

  describe('a usage report covers the request it came back for, however long ago', () => {
    // 8,000 characters of text a step, some 2,400 tokens, against a raw window of 10,000.
    const read = (id: string): Message => ({
      role: 'tool',
      content: 'x'.repeat(8000),
      tool_call_id: id,
    });
    const task = user('Read every file.');
    const steps: Message[][] = [[task]];
    for (let i = 1; i <= 6; i++) {
      steps.push([...steps[i - 1], call(`t${i}`, `SIG_C${i}`), read(`t${i}`)]);
    }

    /**
     * Model calls after each compile of `histories` from the second on, each
     * compiled `times` times. `reported(i)` says whether usage came back for
     * the request before history `i`.
     */
    async function modelCalls(
      histories: Message[][],
      reported: (i: number) => boolean,
      times = 1,
    ): Promise<number[]> {
      const { chef, compressionModel } = chefWith({ janitor: { contextWindow: 10_000 } });
      await converse(chef, [histories[0]]);
      const calls: number[] = [];
      for (let i = 1; i < histories.length; i++) {
        // What the provider reported for the request before this one, counted the same way.
        if (reported(i)) chef.reportTokenUsage(estimateMessages(histories[i - 1]));
        for (let n = 0; n < times; n++) {
          await converse(chef, [histories[i]]);
          calls.push(compressionModel.mock.calls.length);
        }
      }
      return calls;
    }

    /** Model calls after each compile of steps 1–6, each compiled `times` times. */
    const collapses = (reports: 'every' | 'once' | 'none', times = 1) =>
      modelCalls(steps, (i) => reports === 'every' || (reports === 'once' && i === 1), times);

    it.each([
      'every',
      'once',
      'none',
    ] as const)('collapses at step 5 with reports %s', async (reports) => {
      expect(await collapses(reports)).toEqual([0, 0, 0, 0, 1, 1]);
    });

    it('reads a retry the same way as the compile before it', async () => {
      expect(await collapses('once', 2)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    });

    describe('and never a message the host changed since', () => {
      // 2,558 reported for `running`; the result that replaced its placeholder is 12,015.
      const running = [...steps[1], call('t2', 'SIG_C2'), result('t2', 'running…')];
      const filled = [...steps[1], call('t2', 'SIG_C2'), result('t2', 'x'.repeat(40_000))];

      it('counts a tool result filled in since the report', async () => {
        expect(await modelCalls([steps[0], steps[1], running, filled], () => true)).toEqual([
          0, 0, 1,
        ]);
      });

      it('collapses the first compile of it, so a rejected request is not sent again', async () => {
        // The provider rejects a request past the raw window: nothing comes back for it.
        const histories = [steps[0], steps[1], running, filled, filled, filled];
        expect(await modelCalls(histories, (i) => i <= 3)).toEqual([0, 0, 1, 1, 1]);
      });

      it('counts a tool step the host ran again since the report', async () => {
        // 2,559 reported for `failed`; the step that replaced its last two messages is 12,071.
        const failed = [...steps[1], call('t2', 'SIG_C2'), result('t2', 'Error: timeout')];
        const rerun = [...steps[1], call('t3', 'SIG_C3'), result('t3', 'x'.repeat(40_000))];

        expect(await modelCalls([steps[0], steps[1], failed, rerun], () => true)).toEqual([
          0, 0, 1,
        ]);
      });

      it('counts what took the place of a step dropped since the report', async () => {
        const two = [task, call('t1', 'SIG_C1'), result('t1', 'x'.repeat(2000))];
        two.push(call('t2', 'SIG_C2'), result('t2', 'x'.repeat(2000)));
        const one = two.slice(0, 3);
        const grown = [...one, call('t3', 'SIG_C3'), result('t3', 'x'.repeat(20_000))];
        grown.push(call('t4', 'SIG_C4'), result('t4', 'x'.repeat(20_000)));

        // 1,355 reported for `two`, of which `grown` still starts with 3 messages: 1,355 +
        // 12,142 is past the raw window. Its last 2 messages alone (6,071) would fit.
        expect(await modelCalls([steps[0], two, one, grown], (i) => i === 2)).toEqual([0, 0, 1]);
      });

      it('counts a message edited in a compile that fit, once a later one does not', async () => {
        const placeholder = [task, call('t1', 'SIG_C1'), result('t1', 'running…')];
        const edited = [...placeholder.slice(0, 2), result('t1', 'x'.repeat(25_000))];
        const next = [...edited, call('t2', 'SIG_C2'), result('t2', 'x'.repeat(12_000))];

        // 87 reported for `placeholder`, and nothing since. `edited`, the same length, waits
        // at 87 + 7,515; `next` is 87 + 11,186. Its last 2 messages alone (3,671) would fit.
        expect(await modelCalls([steps[0], placeholder, edited, next], (i) => i === 2)).toEqual([
          0, 0, 1,
        ]);
      });
    });
  });

  it.each([
    ['feedFirst', 'waits', 0],
    ['max', 'collapses', 1],
    ['tokenizerFirst', 'collapses', 1],
  ] as const)('respects usagePreference %s: the window being sent %s', async (usagePreference, _, summaries) => {
    const steps: Message[][] = [[user('q1')]];
    for (let i = 1; i <= 5; i++) {
      steps.push([...steps[i - 1], call(`t${i}`, `SIG_C${i}`), result(`t${i}`, `r${i}`)]);
    }
    const { chef, compressionModel } = chefWith({ janitor: { ...JANITOR, usagePreference } });
    await converse(chef, steps.slice(0, 5));

    // 11 messages are 110 by the tokenizer; 30 reported plus the 2 sent since are 50.
    chef.reportTokenUsage(30);
    await converse(chef, [steps[5]]);

    expect(compressionModel).toHaveBeenCalledTimes(summaries);
  });

  it('collapses the whole window into one user message once it outgrows the raw window', async () => {
    const steps: Message[][] = [[user('q1')]];
    for (let i = 1; i <= 5; i++) {
      steps.push([...steps[i - 1], call(`t${i}`, `SIG_C${i}`), result(`t${i}`, `r${i}`)]);
    }
    const after = [...steps[5], reply('Found them.', 'SIG_6'), user('q2')];
    const { chef, compressionModel, breaks, invariants } = chefWith();

    // 1, 3, 5, 7 and 9 messages, then 11: past the raw window with the tool turn still going.
    const payloads = await converse(chef, [...steps, after]);

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(summarized(compressionModel, 1)).toEqual(steps[5]);
    expect(payloads[5].messages).toEqual([text('user', SUMMARY(1))]);
    expect(payloads[5].meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 0 });
    expect(payloads[6].messages).toEqual([
      text('user', SUMMARY(1)),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Reasoning signed SIG_6.', signature: 'SIG_6' },
          { type: 'text', text: 'Found them.' },
        ],
      },
      text('user', 'q2'),
    ]);
    expectAppendOnly(payloads.slice(0, 5));
    expectAppendOnly(payloads.slice(5));
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
    expect(invariants).toEqual([]);
  });

  it('collapses at once when the model asks for a new window in the middle of its turn', async () => {
    const asking = [
      ...asked(2),
      call('n1', 'SIG_N', 'new_context'),
      result('n1', 'Starting a new context window.'),
    ];
    const { chef, compressionModel } = chefWith();
    await converse(chef, [asked(1), asked(2)]);

    // The agent loop dispatches the new_context call, then compiles its result.
    chef.requestNewContext();
    const [collapsed, next] = await converse(chef, [
      asking,
      [...asking, reply('a2', 'SIG_2'), user('q3')],
    ]);

    expect(summarized(compressionModel, 1)).toEqual(asking);
    expect(collapsed.messages).toEqual([text('user', SUMMARY(1))]);
    expect(next.messages).toEqual([...collapsed.messages, answer(2), text('user', 'q3')]);
  });

  it('keeps a tool call still waiting for its result when it collapses, so the result follows it', async () => {
    const pending = [...asked(2), call('t1', 'SIG_C1')];
    const { chef, compressionModel } = chefWith();
    await converse(chef, [asked(1), asked(2)]);

    chef.requestNewContext();
    const [collapsed, next] = await converse(chef, [pending, [...pending, result('t1', 'r1')]]);

    // The call was signed over what the summary replaced: it goes without its thinking.
    const unsigned = {
      role: 'assistant',
      content: [
        { type: 'text', text: '' },
        { type: 'tool_use', id: 't1', name: 'search', input: {} },
      ],
    };
    expect(summarized(compressionModel, 1)).toEqual(asked(2));
    expect(collapsed.messages).toEqual([text('user', SUMMARY(1)), unsigned]);
    expect(collapsed.meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 1 });
    expect(next.messages).toEqual([
      ...collapsed.messages,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }] },
    ]);
  });

  it.each([
    ['reset()', () => reset(), true],
    [
      'chain(summarize(), reset())',
      () =>
        chain(
          summarize({
            compressionModel: async () => {
              throw new Error('model down');
            },
          }),
          reset(),
        ),
      true,
    ],
    ['anchored()', (compressionModel: CompressionModel) => anchored({ compressionModel }), false],
  ])('keeps a tool call still waiting for its result when %s collapses', async (_, strategy, resets) => {
    const pending = [...asked(2), call('t1', 'SIG_C1')];
    const { chef } = chefWith({}, strategy);
    const [, before] = await converse(chef, [asked(1), asked(2)]);

    chef.requestNewContext();
    const [collapsed, next] = await converse(chef, [pending, [...pending, result('t1', 'r1')]]);

    expect(collapsed.messages).toEqual([
      text('user', resets ? RESET(before.meta?.windowId) : SUMMARY(1)),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'tool_use', id: 't1', name: 'search', input: {} },
        ],
      },
    ]);
    expect(next.messages).toEqual([
      ...collapsed.messages,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }] },
    ]);
  });

  it('keeps the request a new window asked for between turns answers', async () => {
    const { chef } = chefWith();
    await converse(chef, [asked(1), asked(2)]);

    chef.requestNewContext();
    const [compacted] = await converse(chef, [asked(3)]);

    expect(compacted.messages).toEqual([text('user', SUMMARY(1)), text('user', 'q3')]);
    expect(compacted.meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 0 });
  });

  describe('without a compression model (the 4.x default)', () => {
    const steps: Message[][] = [[user('q1')]];
    for (let i = 1; i <= 5; i++) {
      steps.push([...steps[i - 1], call(`t${i}`, `SIG_C${i}`), result(`t${i}`, `r${i}`)]);
    }

    it('leaves a reset notice in place of a window the model asked to close', async () => {
      const asking = [
        ...asked(2),
        call('n1', 'SIG_N', 'new_context'),
        result('n1', 'Starting a new context window.'),
      ];
      const { chef } = chefWith({ overflow: undefined });
      const [, before] = await converse(chef, [asked(1), asked(2)]);

      chef.requestNewContext();
      const [collapsed, next] = await converse(chef, [
        asking,
        [...asking, reply('a2', 'SIG_2'), user('q3')],
      ]);

      expect(collapsed.messages).toEqual([text('user', RESET(before.meta?.windowId))]);
      expect(collapsed.meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 0 });
      expect(next.messages).toEqual([...collapsed.messages, answer(2), text('user', 'q3')]);
    });

    it('leaves a reset notice in place of a window past the raw window', async () => {
      const { chef } = chefWith({ overflow: undefined });

      const payloads = await converse(chef, steps);

      expect(payloads[5].messages).toEqual([text('user', RESET(payloads[4].meta?.windowId))]);
    });

    it('keeps a tool call still waiting for its result after the notice', async () => {
      const pending = [...asked(2), call('t1', 'SIG_C1')];
      const { chef } = chefWith({ overflow: undefined });
      const [, before] = await converse(chef, [asked(1), asked(2)]);

      chef.requestNewContext();
      const [collapsed] = await converse(chef, [pending]);

      expect(collapsed.messages).toEqual([
        text('user', RESET(before.meta?.windowId)),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'tool_use', id: 't1', name: 'search', input: {} },
          ],
        },
      ]);
    });
  });
});

describe('appendOnly overflow: after a compaction the window is stated again', () => {
  it('pushes the memory snapshot again once the summary absorbed it', async () => {
    const { chef } = chefWith({ store: new InMemoryBackend(), memory: {} });
    await chef.getMemory().set('lang', 'TypeScript');

    // [q1, snapshot, a1, q2, a2, q3, a3, q4]: over at asked(4).
    const payloads = await converse<OpenAIPayload>(chef, [1, 2, 3, 4].map(asked), 'openai');
    const snapshot = contents(payloads[0]).at(-1);

    expect(contents(payloads[3])).toEqual([
      'You are terse.',
      Prompts.MEMORY_INSTRUCTION,
      SUMMARY(1),
      'q4',
      snapshot,
    ]);
    expect(payloads.map((p) => p.meta?.injectedMemoryKeys)).toEqual([['lang'], [], [], ['lang']]);
  });

  it('restates a source the summary absorbed, and not one whose event it kept', async () => {
    const { chef, breaks } = chefWith({ janitor: { ...JANITOR, triggerRatio: 0.8 } }, keepLast(3));
    const setup = (c: ContextChef, turn: number) => {
      if (turn === 1) c.setDynamicState(State, { step: 1 });
      if (turn === 3) c.announce('docs', 'Docs are indexed.', { channel: 'user_tail' });
    };

    // [q1, state, a1, q2, a2, q3, docs, a3, q4]: 9 messages, the last 3 turns ([q3, docs], a3
    // and q4) kept.
    const payloads = await converse<OpenAIPayload>(
      chef,
      [1, 2, 3, 4, 5].map(asked),
      'openai',
      setup,
    );

    expect(contents(payloads[3])).toEqual([
      'You are terse.',
      SUMMARY(1),
      'q3',
      `${announcement('docs', 'Docs are indexed.', 1)}\n\n${ANCHOR}`,
      'a3',
      'q4',
      `${state(1, 1)}\n\n${ANCHOR}`,
    ]);
    expectAppendOnly(payloads.slice(3));
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
  });

  it('summarizes an event a strategy that cuts inside a turn keeps first, and states its source again', async () => {
    // Keeps the last 3 messages, wherever the turns start.
    const lastThree: OverflowStrategy = {
      name: 'last-three',
      async apply(input) {
        const span = input.history.slice(0, -3);
        return {
          history: [user('NOTE'), ...input.history.slice(-3)],
          evicted: span,
          span,
          meta: { strategy: 'last-three', windowId: input.window.current, changed: true },
        };
      },
    };
    const { chef } = chefWith({ janitor: { ...JANITOR, triggerRatio: 0.8 } }, () => lastThree);
    const setup = (c: ContextChef, turn: number) => {
      if (turn === 1) c.setDynamicState(State, { step: 1 });
      if (turn === 3) c.announce('docs', 'Docs are indexed.', { channel: 'user_tail' });
    };

    // It keeps [docs, a3, q4]: the window resumes at a3, the event goes with q1…q3.
    const payloads = await converse<OpenAIPayload>(chef, [1, 2, 3, 4].map(asked), 'openai', setup);

    expect(contents(payloads[3])).toEqual([
      'You are terse.',
      'NOTE',
      'a3',
      'q4',
      `${state(1, 1)}\n\n${announcement('docs', 'Docs are indexed.', 1)}\n\n${ANCHOR}`,
    ]);
  });

  it('keeps in the new head what the strategy kept of the previous one', async () => {
    // Puts two notes in place of the oldest message, and keeps the rest as it is.
    let notes = 0;
    const notesFirst: OverflowStrategy = {
      name: 'notes-first',
      async apply(input) {
        notes++;
        const [oldest, ...rest] = input.history;
        return {
          history: [user(`note ${notes}a`), user(`note ${notes}b`), ...rest],
          evicted: [oldest],
          span: [oldest],
          meta: { strategy: 'notes-first', windowId: input.window.current, changed: true },
        };
      },
    };
    const { chef, breaks } = chefWith({}, () => notesFirst);

    // [note 1a, note 1b, a1, …, q4, a4, q5] is over budget again.
    const payloads = await converse(chef, [1, 2, 3, 4, 5].map(asked));

    expect(payloads[4].messages).toEqual([
      text('user', 'note 2a'),
      text('user', 'note 2b'),
      text('user', 'note 1b'),
      ...['a1', 'q2', 'a2', 'q3', 'a3', 'q4', 'a4', 'q5'].map((content) =>
        text(content.startsWith('a') ? 'assistant' : 'user', content),
      ),
    ]);
    expect(breaks.map((b) => [b.reason, b.strippedThinking])).toEqual([
      ['compaction', 3],
      ['compaction', 1],
    ]);
  });
});

describe('appendOnly overflow: an event stays with the turn it follows', () => {
  /** Chat Completions messages as [role, content]: shows which channel an event went out on. */
  const said = (payload: OpenAIPayload): Array<[string, string]> =>
    payload.messages.map((m) => [m.role, String(m.content)]);

  it('keeps a positional system event with the user turn before it', async () => {
    const { chef, breaks } = chefWith({ janitor: { ...JANITOR, triggerRatio: 0.8 } }, keepLast(3));
    const setup = (c: ContextChef, turn: number) => {
      if (turn === 1) c.setDynamicState(State, { step: 1 });
      if (turn === 3) c.announce('docs', 'Docs are indexed.', { channel: 'system' });
    };

    // [q1, state, a1, q2, a2, q3, docs, a3, q4]: the last 3 turns are [q3, docs], a3 and q4.
    const payloads = await converse<OpenAIPayload>(
      chef,
      [1, 2, 3, 4, 5].map(asked),
      'openai',
      setup,
    );

    expect(said(payloads[3])).toEqual([
      ['system', 'You are terse.'],
      ['user', SUMMARY(1)],
      ['user', 'q3'],
      ['system', `${announcement('docs', 'Docs are indexed.', 1)}\n\n${ANCHOR}`],
      ['assistant', 'a3'],
      ['user', 'q4'],
      ['user', `${state(1, 1)}\n\n${ANCHOR}`],
    ]);
    expectAppendOnly(payloads.slice(3));
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
  });

  it.each([
    ['the request is tried again', asked(3), 'q3'],
    [
      'the host adds a message to the unanswered request',
      [...asked(3), user('q3, again')],
      'q3, again',
    ],
  ])('keeps the pending question with the event after it when %s', async (_, retry, question) => {
    const { chef } = chefWith();
    const setup = (c: ContextChef, turn: number) => {
      if (turn === 1) c.setDynamicState(State, { step: 1 });
      if (turn === 3) c.setDynamicState(State, { step: 2 });
    };

    // The first try at q3 appends step 2 after it, and nothing answers it: the next compile's
    // window ends [question, step 2], over the trigger, and keeps that last turn whole.
    const payloads = await converse<OpenAIPayload>(
      chef,
      [asked(1), asked(2), asked(3), retry],
      'openai',
      setup,
    );

    expect(said(payloads[3])).toEqual([
      ['system', 'You are terse.'],
      ['user', SUMMARY(1)],
      ['user', question],
      ['user', `${state(2, 2)}\n\n${ANCHOR}`],
    ]);
  });

  it.each([
    'anthropic',
    'openai',
    'gemini',
    'openai-responses',
  ])('sends no trace of the mark the events carry in the window (%s)', async (target) => {
    const { chef } = chefWith();
    chef.setDynamicState(State, { step: 1 });
    chef.announce('docs', 'Docs are indexed.', { channel: 'system' });

    const [payload] = await converse(chef, [asked(2)], target);

    expect(occurrences(payload, 'Docs are indexed.')).toBe(1);
    expect(JSON.stringify(wire(payload))).not.toContain('_chef_event');
  });
});

const inBackground = (compressionModel: CompressionModel) =>
  background(keepLast(1)(compressionModel));

/** `inBackground`, its first job never finishing. */
const stuckFirst = (compressionModel: CompressionModel) => {
  let calls = 0;
  return inBackground((messages) =>
    ++calls === 1 ? new Promise<string>(() => {}) : compressionModel(messages),
  );
};

/** `inBackground`, its model throwing on the calls listed (1 is the first). */
const failingOn =
  (...failing: number[]) =>
  (compressionModel: CompressionModel) => {
    let calls = 0;
    return inBackground(async (messages) => {
      if (failing.includes(++calls)) throw new Error('model down');
      return compressionModel(messages);
    });
  };

/** `converse`, letting a background job finish between compiles. */
async function converseSettling<P extends TargetPayload = AnthropicPayload>(
  chef: ContextChef,
  turns: Message[][],
  target = 'anthropic',
): Promise<P[]> {
  const payloads: P[] = [];
  for (const history of turns) {
    payloads.push(...(await converse<P>(chef, [history], target)));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return payloads;
}

describe('appendOnly overflow: background() lands a job while the window only grew', () => {
  it('lands the job at the next compile, its events rendered anew, the turns since kept', async () => {
    const { chef, compressionModel, breaks } = chefWith({}, inBackground);
    chef.setDynamicState(State, { step: 1 });

    // asked(4) is [q1, state, a1, …, q4], over the trigger: the job starts there and keeps q4.
    const payloads = await converseSettling<OpenAIPayload>(
      chef,
      [1, 2, 3, 4, 5].map(asked),
      'openai',
    );

    const stated = `${state(1, 1)}\n\n${ANCHOR}`;
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(summarized(compressionModel, 1).map((m) => m.content)).toEqual([
      'q1',
      stated,
      'a1',
      'q2',
      'a2',
      'q3',
      'a3',
    ]);
    expect(contents(payloads[3])).toEqual([
      'You are terse.',
      'q1',
      stated,
      'a1',
      'q2',
      'a2',
      'q3',
      'a3',
      'q4',
    ]);
    expect(contents(payloads[4])).toEqual(['You are terse.', SUMMARY(1), 'q4', 'a4', 'q5', stated]);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
    expectAppendOnly(payloads.slice(0, 4));
  });

  it('waits for the tool turn in progress to end before it lands', async () => {
    const { chef, compressionModel, breaks } = chefWith({}, inBackground);
    const loop = [...asked(4), call('t1', 'SIG_C1'), result('t1', 'r1')]; // 9
    const done = [...loop, reply('a4', 'SIG_4'), user('q5')]; // 11, a turn boundary

    const payloads = await converseSettling<OpenAIPayload>(
      chef,
      [asked(1), asked(2), asked(3), asked(4), loop, done],
      'openai',
    );

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expectAppendOnly(payloads.slice(0, 5));
    expect(contents(payloads[5])).toEqual([
      'You are terse.',
      SUMMARY(1),
      'q4',
      '',
      'r1',
      'a4',
      'q5',
    ]);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
  });

  it('drops a job when a checkpoint rewrote the window it started on, and lands the next one', async () => {
    const { chef, compressionModel, breaks } = chefWith({}, inBackground);
    const edited = (n: number) =>
      asked(n).map((m) => (m.content === 'q2' ? user('q2, edited') : m));

    const payloads = await converseSettling<OpenAIPayload>(
      chef,
      [asked(1), asked(2), asked(3), asked(4), edited(5), edited(6)],
      'openai',
    );

    // The first job summarized q2 as it was: the edit drops it, and a job starts on the window
    // that holds the edit. That one lands.
    expect(compressionModel).toHaveBeenCalledTimes(2);
    expect(summarized(compressionModel, 2).map((m) => m.content)).toContain('q2, edited');
    expect(contents(payloads[4])).toEqual(['You are terse.', ...edited(5).map((m) => m.content)]);
    expect(contents(payloads[5])).toEqual(['You are terse.', SUMMARY(2), 'q5', 'a5', 'q6']);
    expect(breaks.map((b) => b.reason)).toEqual(['history', 'compaction']);
  });

  it('lands on Anthropic without the thinking of the turns it kept and the turns since', async () => {
    const { chef, breaks, invariants } = chefWith({}, (model) => background(keepLast(3)(model)));

    // The job starts at asked(4) and keeps [q3, a3, q4]; a4 and q5 arrive before it lands.
    const payloads = await converseSettling(chef, [1, 2, 3, 4, 5, 6].map(asked));

    expect(payloads[4].messages).toEqual([
      text('user', SUMMARY(1)),
      text('user', 'q3'),
      text('assistant', 'a3'),
      text('user', 'q4'),
      text('assistant', 'a4'),
      text('user', 'q5'),
    ]);
    expect(payloads[4].meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 2 });
    expect(signatures(payloads[5])).toEqual(['SIG_5']);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
    expectAppendOnly(payloads.slice(0, 4));
    expectAppendOnly(payloads.slice(4));
    expect(invariants).toEqual([]);
  });

  it('lands a job however the host moved what no provider is sent, a cache breakpoint here', async () => {
    const { chef, compressionModel, breaks } = chefWith({}, inBackground);
    // The host marks its newest message for caching, on a copy, every compile.
    const marked = (n: number) =>
      asked(n).map((m, i, all) => (i === all.length - 1 ? { ...m, _cache_breakpoint: true } : m));

    const payloads = await converseSettling<OpenAIPayload>(
      chef,
      [1, 2, 3, 4, 5, 6, 7, 8].map(marked),
      'openai',
    );

    // Jobs start at 7 and 8 messages (q4, q7) and land on the next compile.
    expect(payloads.map((p) => p.messages.length)).toEqual([2, 4, 6, 8, 5, 7, 9, 5]);
    expect(compressionModel).toHaveBeenCalledTimes(2);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction', 'compaction']);
  });

  it('collapses a tool turn that cannot wait at once, whatever job is running', async () => {
    // The job started at q4 never finishes.
    const { chef, compressionModel } = chefWith({}, stuckFirst);
    const loop = [...asked(4), call('t1', 'SIG_C1'), result('t1', 'r1')];
    await converseSettling(chef, [asked(1), asked(2), asked(3), asked(4)]);

    chef.requestNewContext();
    const [collapsed] = await converse(chef, [loop]);

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(summarized(compressionModel, 1)).toEqual(loop);
    expect(collapsed.messages).toEqual([text('user', SUMMARY(1))]);
    expect(collapsed.meta?.prefix?.break?.reason).toBe('compaction');
  });
});

describe('appendOnly overflow: a request past the raw window at a turn boundary lands now', () => {
  it('summarizes at once when a background job would only start', async () => {
    const { chef, compressionModel, breaks } = chefWith({}, inBackground);

    // The host compiles again only at q7: 13 messages, past the raw window of 10.
    const payloads = await converseSettling(chef, [asked(1), asked(2), asked(7)]);

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(payloads[2].messages).toEqual([text('user', SUMMARY(1)), text('user', 'q7')]);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
  });

  it('summarizes at once rather than wait for the job in flight', async () => {
    const { chef, compressionModel } = chefWith({}, stuckFirst);

    // The job started at q4 never finishes; q5 (9 messages) still fits, q6 (11) does not.
    const payloads = await converseSettling(chef, [1, 2, 3, 4, 5, 6].map(asked));

    expect(payloads[4].messages).toHaveLength(9);
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(summarized(compressionModel, 1)).toEqual(asked(6).slice(0, 10));
    expect(payloads[5].messages).toEqual([text('user', SUMMARY(1)), text('user', 'q6')]);
  });

  it('summarizes at once in place of a job a checkpoint made stale', async () => {
    const { chef, compressionModel, breaks } = chefWith({}, inBackground);
    const edited = asked(6).map((m) => (m.content === 'q2' ? user('q2, edited') : m));

    const payloads = await converseSettling(chef, [asked(1), asked(2), asked(3), asked(4), edited]);

    expect(compressionModel).toHaveBeenCalledTimes(2);
    expect(summarized(compressionModel, 2).map((m) => m.content)).toContain('q2, edited');
    expect(payloads[4].messages).toEqual([text('user', SUMMARY(2)), text('user', 'q6')]);
    expect(breaks.map((b) => b.reason)).toEqual(['history', 'compaction']);
  });

  it('summarizes the window a finished job leaves when that is still past the raw window', async () => {
    const { chef, compressionModel, breaks } = chefWith({}, inBackground);

    // The job starts at q4 and keeps it. The host comes back at q12: the job would leave
    // [SUMMARY 1, q4 … q12], 18 messages.
    const payloads = await converseSettling(chef, [
      asked(1),
      asked(2),
      asked(3),
      asked(4),
      asked(12),
    ]);

    expect(compressionModel).toHaveBeenCalledTimes(2);
    expect(summarized(compressionModel, 2)[0].content).toBe(SUMMARY(1));
    expect(payloads[4].messages).toEqual([text('user', SUMMARY(2)), text('user', 'q12')]);
    expect(breaks.map((b) => b.reason)).toEqual(['compaction']);
  });

  it('keeps a pinned message through the refit, though the host builds every message anew', async () => {
    const { chef, compressionModel } = chefWith({}, inBackground);
    // q2 is pinned, and every request hands in copies, as a host parsing its own store does.
    const pinnedAt = (n: number) =>
      structuredClone(asked(n).map((m) => (m.content === 'q2' ? { ...m, pinned: true } : m)));

    // The job puts q2 back after SUMMARY 1; at q12 what it leaves is past the raw window.
    const payloads = await converseSettling(chef, [1, 2, 3, 4, 12].map(pinnedAt));

    expect(compressionModel).toHaveBeenCalledTimes(2);
    expect(payloads[4].messages).toEqual([
      text('user', SUMMARY(2)),
      text('user', 'q2'),
      text('user', 'q12'),
    ]);
  });

  it('counts a refit that failed: the job lands, and the breaker is not cleared', async () => {
    const { chef } = chefWith({}, (model) => {
      let calls = 0;
      return inBackground(async (messages) => {
        if (++calls > 1) throw new Error('model down');
        return model(messages);
      });
    });

    // The job lands at q12; summarizing what it leaves fails, so that goes out as it is.
    const payloads = await converseSettling(chef, [1, 2, 3, 4, 12].map(asked));

    expect(payloads[4].messages[0]).toEqual(text('user', SUMMARY(1)));
    expect(payloads[4].messages).toHaveLength(18);
    expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(1);
  });

  it('credits the job before its refit: a failure counted before the job does not stay', async () => {
    // The job started at q4 fails. The one started at q5 lands at q12, and summarizing what it
    // leaves fails.
    const { chef } = chefWith({}, failingOn(1, 3));

    const payloads = await converseSettling(chef, [1, 2, 3, 4, 5, 12].map(asked));

    expect(payloads[5].messages[0]).toEqual(text('user', SUMMARY(1)));
    expect(payloads[5].messages).toHaveLength(16);
    expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(1);
  });

  it('leaves the breaker shut after a refit fails one failure short of it', async () => {
    const { chef } = chefWith({}, failingOn(2));
    const fresh = chef.snapshot();
    chef.restore({
      ...fresh,
      modules: { ...fresh.modules, janitor: { ...fresh.modules.janitor, consecutiveFailures: 2 } },
    });

    // The job started at q4 lands at q11, and summarizing what it leaves fails.
    const payloads = await converseSettling(chef, [1, 2, 3, 4, 11].map(asked));
    expect(payloads[4].messages).toHaveLength(16);
    expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(1);

    // At q12 that window, 18 messages, is past the raw window again: it is summarized, not sent.
    const [next] = await converse(chef, [asked(12)]);
    expect(next.messages).toEqual([text('user', SUMMARY(2)), text('user', 'q12')]);
    expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(0);
  });

  describe('with background() inside chain()', () => {
    /** A step that never changes the window. */
    const declines: OverflowStrategy = {
      name: 'declines',
      apply: async (input) => unchanged(input, 'declines', 'nothing to do'),
    };
    /** `inBackground`, its model throwing from the second call on: the refit always fails. */
    const refitFails = (model: CompressionModel) => {
      let calls = 0;
      return inBackground(async (messages) => {
        if (++calls > 1) throw new Error('model down');
        return model(messages);
      });
    };

    it('credits the job before its refit through the chain: a failure before it does not stay', async () => {
      const { chef } = chefWith({}, (model) => chain(failingOn(1, 3)(model), declines));

      // As without the chain: the job at q4 fails, the one at q5 lands at q12, its refit fails.
      const payloads = await converseSettling(chef, [1, 2, 3, 4, 5, 12].map(asked));

      expect(payloads[5].messages[0]).toEqual(text('user', SUMMARY(1)));
      expect(payloads[5].messages).toHaveLength(16);
      expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(1);
    });

    it('keeps a failed refit counted though a later step changes nothing', async () => {
      const { chef } = chefWith({}, (model) => chain(refitFails(model), declines));

      const payloads = await converseSettling(chef, [1, 2, 3, 4, 12].map(asked));

      expect(payloads[4].messages[0]).toEqual(text('user', SUMMARY(1)));
      expect(payloads[4].messages).toHaveLength(18);
      expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(1);
    });

    it('keeps a failed refit counted though a later step rescues the window', async () => {
      // Past the raw window only, it keeps the request alone; a reset() would also run when
      // the job starts, the background step having changed nothing yet.
      const lastResort: OverflowStrategy = {
        name: 'last-resort',
        async apply(input) {
          if (!input.pastLimit) return unchanged(input, 'last-resort', 'within the raw window');
          const evicted = input.history.slice(0, -1);
          return {
            history: input.history.slice(-1),
            evicted,
            span: evicted,
            meta: { strategy: 'last-resort', windowId: input.window.current, changed: true },
          };
        },
      };
      const { chef } = chefWith({}, (model) => chain(refitFails(model), lastResort));

      const payloads = await converseSettling(chef, [1, 2, 3, 4, 12].map(asked));

      expect(payloads[4].messages).toEqual([text('user', 'q12')]);
      expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(1);
    });

    it('clears the count once the job and its refit both succeed', async () => {
      const { chef, compressionModel } = chefWith({}, (model) =>
        chain(inBackground(model), declines),
      );
      const fresh = chef.snapshot();
      chef.restore({
        ...fresh,
        modules: {
          ...fresh.modules,
          janitor: { ...fresh.modules.janitor, consecutiveFailures: 2 },
        },
      });

      const payloads = await converseSettling(chef, [1, 2, 3, 4, 12].map(asked));

      expect(compressionModel).toHaveBeenCalledTimes(2);
      expect(payloads[4].messages).toEqual([text('user', SUMMARY(2)), text('user', 'q12')]);
      expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(0);
    });
  });

  it('reads no report once a checkpoint changed the request it came back for', async () => {
    // A trigger of 95: only a reading past the raw window of 100 compacts.
    const { chef, compressionModel, breaks } = chefWith({
      janitor: { ...JANITOR, triggerRatio: 0.95 },
    });
    const edited = (n: number) =>
      asked(n).map((m) => (m.content === 'q2' ? user('q2, edited') : m));
    await converse(chef, [asked(1), asked(2), asked(3)], 'openai');

    // 60 came back for [q1 … q3], the system prompt included. Then q2 is edited: the windows are
    // 70 and 90, and the report, which counted the old q2 and everything after it, describes
    // neither of them.
    chef.reportTokenUsage(60);
    const payloads = await converse<OpenAIPayload>(chef, [edited(4), edited(5)], 'openai');

    expect(compressionModel).not.toHaveBeenCalled();
    expect(payloads.map((p) => p.messages.length)).toEqual([8, 10]);
    expect(breaks.map((b) => b.reason)).toEqual(['history']);
  });

  it('keeps reading no report through the rest of a tool turn after the edit', async () => {
    const { chef, compressionModel, breaks } = chefWith();
    const edited = [...asked(3)];
    edited[2] = user('q2, edited');
    const step1 = [...asked(3), call('t1', 'SIG_C1')]; // 6
    const step2 = [...step1, result('t1', 'r1')]; // 7
    const step3 = [...edited, ...step2.slice(5), call('t2', 'SIG_C2')]; // 8, q2 edited
    const step4 = [...step3, result('t2', 'r2')]; // 9
    await converse(chef, [asked(1), asked(2), asked(3)]);

    // 60 came back for [q1 … q3], and the tool turn waits on it: 70, 80. From the edit on the
    // report describes no window — 80, then 90, all under the raw window of 100 — for as long
    // as the turn lasts, not just for the compile that made the edit.
    chef.reportTokenUsage(60);
    await converse(chef, [step1, step2, step3, step4]);

    expect(compressionModel).not.toHaveBeenCalled();
    expect(breaks.map((b) => b.reason)).toEqual(['history']);
  });

  it('counts no more tokens than 4.x without a finite context window', async () => {
    const counted = async (appendOnly: boolean) => {
      const tokenizer = vi.fn((messages: Message[]) => messages.length * 10);
      const { chef } = chefWith({
        appendOnly,
        janitor: { contextWindow: Number.POSITIVE_INFINITY, tokenizer },
      });
      await converse(chef, [asked(1), asked(2), asked(3)]);
      return tokenizer.mock.calls.length;
    };

    expect(await counted(true)).toBe(await counted(false));
  });

  it('summarizes what the last usage report did not see, whatever that report says', async () => {
    // No tokenizer: the runner's own reading is the report alone.
    const { chef, compressionModel } = chefWith({
      janitor: { contextWindow: 1000, triggerRatio: 0.5 },
    });
    // The host ran a whole tool step and came back with the next question in one go.
    const resumed = [
      ...asked(2),
      call('t1', 'SIG_C1'),
      result('t1', 'x'.repeat(8000)),
      reply('a2', 'SIG_2'),
      user('q3'),
    ];
    await converse(chef, [asked(1), asked(2)]);

    chef.reportTokenUsage(100);
    const [compacted] = await converse(chef, [resumed]);

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(compacted.messages).toEqual([text('user', SUMMARY(1)), text('user', 'q3')]);
  });
});

describe('appendOnly overflow: a history resumed from a compaction block', () => {
  it.each([
    'openai',
    'gemini',
  ] as const)('keeps the opening user turn before the block on a text target (%s)', async (target) => {
    const { chef, breaks, invariants } = chefWith();
    // The block a previous session got back, behind the user turn fromAnthropic opens with.
    const { history: block } = fromAnthropic([
      {
        role: 'assistant',
        content: [{ type: 'compaction', content: 'EARLIER', signature: 'SIG_0' }],
      },
    ] as unknown as MessageParam[]);

    const payloads = await converse(
      chef,
      [1, 2, 3, 4, 5].map((n) => [...block, ...asked(n)]),
      target,
    );

    expect(breaks.map((b) => b.reason)).toContain('compaction');
    for (const payload of payloads) {
      const [first, second] = (payload as OpenAIPayload).messages.filter(
        (m) => m.role !== 'system',
      );
      expect(JSON.stringify(first)).toContain('"role":"user"');
      expect(JSON.stringify(first)).toContain('[Conversation continues]');
      expect(JSON.stringify(second)).toContain('EARLIER');
    }
    // Each compile that reported no checkpoint repeats the one before it.
    payloads.forEach((payload, i) => {
      if (i > 0 && !payload.meta?.prefix?.break) {
        expect(checkPrefixContinuity(payloads[i - 1], payload)).toEqual({ ok: true });
      }
    });
    expect(invariants).toEqual([]);
  });
});

describe('appendOnly overflow: strategies that keep no turn', () => {
  it('lands reset() as a head of its notice, the pending request dropped as in 4.x', async () => {
    const { chef, breaks } = chefWith({}, () => reset());

    const payloads = await converse(chef, [1, 2, 3, 4, 5].map(asked));

    expect(payloads[3].messages).toEqual([text('user', RESET(payloads[2].meta?.windowId))]);
    expect(payloads[4].messages).toEqual([...payloads[3].messages, answer(4), text('user', 'q5')]);
    expect(breaks.map((b) => [b.reason, b.strippedThinking])).toEqual([['compaction', 0]]);
    expectAppendOnly(payloads.slice(3));
  });

  it('lands the reset() a chain falls back to, with the pinned messages after its notice', async () => {
    const pinned = [...asked(4)];
    pinned[2] = { ...pinned[2], pinned: true };
    const { chef } = chefWith({}, () =>
      chain(
        summarize({
          compressionModel: async () => {
            throw new Error('model down');
          },
        }),
        reset(),
      ),
    );

    const payloads = await converse(
      chef,
      [1, 2, 3, 4].map((n) => pinned.slice(0, 2 * n - 1)),
    );

    expect(payloads[3].messages).toEqual([
      text('user', RESET(payloads[2].meta?.windowId)),
      text('user', 'q2'),
    ]);
  });

  it('keeps only the last turn when summarize() has no compression model', async () => {
    const { chef } = chefWith({}, () =>
      summarize({ split: 'recent-turns', preserveRecentMessages: 1 }),
    );

    const payloads = await converse(chef, [1, 2, 3, 4, 5].map(asked));

    expect(payloads[3].messages).toEqual([text('user', 'q4')]);
    expect(payloads[3].meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 0 });
    expect(payloads[4].messages).toEqual([text('user', 'q4'), answer(4), text('user', 'q5')]);
  });
});

describe('appendOnly overflow: window lineage', () => {
  it('keys the anchored() document by the window each compaction opens', async () => {
    const { chef, compressionModel } = chefWith({}, (compressionModel) =>
      anchored({ compressionModel, split: 'recent-turns', preserveRecentMessages: 1 }),
    );

    const payloads = await converse(chef, [1, 2, 3, 4, 5, 6, 7].map(asked));
    const [first, second] = [payloads[3].meta?.windowId, payloads[6].meta?.windowId];

    expect(compressionModel).toHaveBeenCalledTimes(2);
    expect(compressionModel.mock.calls[1][0].at(-1)?.content).toContain(
      '<anchor>\nSUMMARY 1\n</anchor>',
    );
    expect(chef.snapshot().modules.janitor.strategy).toEqual({
      anchorDoc: 'SUMMARY 2',
      anchors: { [String(first)]: 'SUMMARY 1', [String(second)]: 'SUMMARY 2' },
    });
  });

  it('reports a checkpoint in the window it applied to: one found before the compaction in the old one', async () => {
    const { chef, breaks } = chefWith();
    const [, , before] = await converse(chef, [1, 2, 3].map(asked));

    // The host edited q2 and the system prompt changed; the window is over budget too.
    const edited = [...asked(4)];
    edited[2] = user('q2, edited');
    chef.setSystemPrompt([{ role: 'system', content: 'You are thorough.' }]);
    const [compacted] = await converse(chef, [edited]);

    const [old, opened] = [before.meta?.windowId, compacted.meta?.windowId];
    expect(opened).not.toBe(old);
    expect(breaks).toEqual([
      { reason: 'history', at: 2, signed: false, strippedThinking: 2, windowId: old },
      { ...COMPACTED, strippedThinking: 0, windowId: opened },
      { reason: 'system', at: 0, signed: false, strippedThinking: 0, windowId: opened },
    ]);
    expect(compacted.meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 2 });
  });
});

describe('appendOnly overflow: only a landed compaction changes the window', () => {
  it('ignores the history an onBeforeCompress hook rewrote when nothing landed', async () => {
    const warn = vi.fn();
    const { chef, breaks } = chefWith(
      {
        logger: { warn },
        janitor: {
          ...JANITOR,
          onBeforeCompress: (history) =>
            history.map((m) =>
              m.role === 'user' ? { ...m, content: m.content.toUpperCase() } : m,
            ),
        },
      },
      () =>
        summarize({
          compressionModel: async () => {
            throw new Error('model down');
          },
          split: 'recent-turns',
          preserveRecentMessages: 1,
        }),
    );
    const setup = (c: ContextChef, turn: number) => {
      c.setDynamicState(State, { step: Math.max(1, turn - 2) });
    };

    // Over budget from asked(4) on, retried once with the state changed again.
    const payloads = await converse<OpenAIPayload>(
      chef,
      [1, 2, 3, 4, 4].map(asked),
      'openai',
      setup,
    );

    expect(contents(payloads[3]).slice(-2)).toEqual(['q4', `${state(2, 2)}\n\n${ANCHOR}`]);
    expect(contents(payloads[4]).slice(-2)).toEqual([
      'q4',
      `${state(2, 2)}\n\n${ANCHOR}\n\n${state(3, 3)}\n\n${ANCHOR}`,
    ]);
    expectAppendOnly(payloads.slice(0, 4));
    expect(breaks).toEqual([]);
    const moved = warn.mock.calls.filter(([message]) =>
      String(message).includes('moved or rewritten'),
    );
    expect(moved).toEqual([]);
  });

  it.each([
    ['anthropic', []],
    ['openai', ['compaction']],
  ])('leaves overflow to the provider where server() can, and lands its fallback elsewhere (%s)', async (target, reasons) => {
    const { chef, breaks } = chefWith({}, (compressionModel) =>
      server(undefined, { fallback: keepLast(1)(compressionModel) }),
    );

    await converse(chef, [1, 2, 3, 4].map(asked), target);

    expect(breaks.map((b) => b.reason)).toEqual(reasons);
  });
});

describe('appendOnly overflow: a signed strategy reads the window as it was sent', () => {
  /** Records the wire it is handed and changes nothing. */
  function recorder(seen: Array<OverflowInput['wire']>): OverflowStrategy {
    return {
      name: 'recorder',
      async apply(input) {
        seen.push(input.wire);
        return {
          history: input.history,
          evicted: [],
          span: [],
          meta: { strategy: 'recorder', windowId: input.window.current, changed: false },
        };
      },
    };
  }
  // Every window is over the trigger.
  const over = { janitor: { contextWindow: 100, triggerRatio: 0.6, tokenizer: () => 1000 } };

  it('renders the window up to any index as the last payload sent it, with its system and tools', async () => {
    const seen: Array<OverflowInput['wire']> = [];
    const { chef } = chefWith(over, () => recorder(seen));
    chef.registerTools([search]);
    chef.setDynamicState(State, { step: 1 });

    const [first, second] = await converse(chef, [1, 2, 3].map(asked));

    // Nothing was sent before the first compile.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]?.target).toBe('anthropic');
    // [q1, state, a1, q2]: the first request was [q1, state].
    expect(seen[1]?.renderPrefix(2)).toEqual(wire(first));
    expect(seen[2]?.renderPrefix(4)).toEqual(wire(second));
  });

  it('leaves out the thinking a checkpoint stripped, as it was sent', async () => {
    const seen: Array<OverflowInput['wire']> = [];
    const { chef } = chefWith(over, () => recorder(seen));
    const edited = [...asked(4)];
    edited[2] = user('q2, edited');

    // The edit strips a2's thinking from the third request on.
    const [, , third] = await converse(chef, [asked(1), asked(2), edited.slice(0, 5), edited]);

    expect(signatures(third)).toEqual(['SIG_1']);
    expect(seen[3]?.renderPrefix(5)).toEqual(wire(third));
  });

  it('renders a turn fromAnthropic parsed byte for byte as it was sent', async () => {
    const seen: Array<OverflowInput['wire']> = [];
    const { chef } = chefWith(over, () => recorder(seen));
    const cited = {
      type: 'text',
      text: 'a1',
      citations: [{ url: 'https://example.com', type: 'web_search_result_location' }],
    };
    const sent = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'SIG_A' }, cited],
      },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      { role: 'user', content: 'q3' },
    ] as unknown as MessageParam[];

    const [, second] = await converse(chef, [
      fromAnthropic(sent.slice(0, 1)).history,
      fromAnthropic(sent.slice(0, 3)).history,
      fromAnthropic(sent).history,
    ]);

    expect(JSON.stringify(seen[2]?.renderPrefix(3).messages)).toBe(JSON.stringify(second.messages));
  });

  it('is not offered on a target that signs nothing', async () => {
    const seen: Array<OverflowInput['wire']> = [];
    const { chef } = chefWith(over, () => recorder(seen));

    await converse(chef, [1, 2, 3].map(asked), 'openai');

    expect(seen).toEqual([undefined, undefined, undefined]);
  });
});
