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
  type ChefConfig,
  type ChefEvents,
  ContextChef,
  checkPrefixContinuity,
  fromAnthropic,
  InMemoryBackend,
  type ITargetAdapter,
  OpenAIAdapter,
  type OverflowInput,
  type OverflowStrategy,
  Prompts,
  server,
  summarize,
} from '../src/index';
import type {
  AnthropicPayload,
  ChefLogger,
  Message,
  OpenAIPayload,
  TargetPayload,
  ToolDefinition,
} from '../src/types';

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

  it('keeps the request a new window asked for between turns answers', async () => {
    const { chef } = chefWith();
    await converse(chef, [asked(1), asked(2)]);

    chef.requestNewContext();
    const [compacted] = await converse(chef, [asked(3)]);

    expect(compacted.messages).toEqual([text('user', SUMMARY(1)), text('user', 'q3')]);
    expect(compacted.meta?.prefix?.break).toEqual({ ...COMPACTED, strippedThinking: 0 });
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
    const { chef, breaks } = chefWith({ janitor: { ...JANITOR, triggerRatio: 0.8 } }, keepLast(4));
    const setup = (c: ContextChef, turn: number) => {
      if (turn === 1) c.setDynamicState(State, { step: 1 });
      if (turn === 3) c.announce('docs', 'Docs are indexed.', { channel: 'user_tail' });
    };

    // [q1, state, a1, q2, a2, q3, docs, a3, q4]: 9 messages, the last 4 turns kept from q3 on.
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

  it('summarizes an event the kept turns start with, and states its source again', async () => {
    const { chef } = chefWith({ janitor: { ...JANITOR, triggerRatio: 0.8 } }, keepLast(3));
    const setup = (c: ContextChef, turn: number) => {
      if (turn === 1) c.setDynamicState(State, { step: 1 });
      if (turn === 3) c.announce('docs', 'Docs are indexed.', { channel: 'user_tail' });
    };

    // The last 3 turns are [docs, a3, q4]: the window resumes at a3, the event goes with q1…q3.
    const payloads = await converse<OpenAIPayload>(chef, [1, 2, 3, 4].map(asked), 'openai', setup);

    expect(contents(payloads[3])).toEqual([
      'You are terse.',
      SUMMARY(1),
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
