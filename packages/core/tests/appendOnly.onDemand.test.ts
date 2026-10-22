/**
 * `onDemandCompaction()` under `ChefConfig.appendOnly`: the request the model
 * already answered goes back to Anthropic as it was sent, and the signed
 * block that comes back replaces it — a checkpoint that strips nothing, so
 * the turns kept after the block keep their thinking.
 *
 * Conversations are compiled turn by turn from the first request, as an agent
 * loop does; every expected message is worked out by hand. The tokenizer
 * counts 10 tokens a message against a trigger of 60 and a raw window of 100,
 * so a window of 7 messages is over the trigger.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  anthropicCompactionMessage,
  background,
  type ChefConfig,
  type ChefEvents,
  ContextChef,
  chain,
  checkPrefixContinuity,
  type OnDemandCompactionRequest,
  type OnDemandCompactor,
  type OverflowStrategy,
  onDemandCompaction,
  Prompts,
  reset,
  server,
  summarize,
} from '../src/index';
import type {
  AnthropicPayload,
  ChefLogger,
  Message,
  TargetPayload,
  ToolDefinition,
} from '../src/types';

const silent: ChefLogger = { warn: () => {} };

const user = (content: string): Message => ({ role: 'user', content });
const reply = (content: string, signature: string): Message => ({
  role: 'assistant',
  content,
  thinking: { thinking: `Reasoning signed ${signature}.`, signature },
});
const call = (id: string, signature: string): Message => ({
  role: 'assistant',
  content: '',
  thinking: { thinking: 'Search first.', signature },
  tool_calls: [{ id, type: 'function', function: { name: 'search', arguments: '{}' } }],
});
const result = (id: string, content: string): Message => ({
  role: 'tool',
  content,
  tool_call_id: id,
});

/** q1 a1 q2 a2 …: reply i is signed SIG_i. One array, so every turn shares the host's objects. */
const conversation = (pinned: string[] = []): ((n: number) => Message[]) => {
  const qa: Message[] = [user('q1')];
  for (let i = 1; i < 12; i++) qa.push(reply(`a${i}`, `SIG_${i}`), user(`q${i + 1}`));
  for (const message of qa) if (pinned.includes(message.content)) message.pinned = true;
  return (n) => qa.slice(0, 2 * n - 1);
};
const asked = conversation();

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
/** The `n`th compaction block, as the API returned it and as every later request replays it. */
const block = (n: number) => ({
  type: 'compaction' as const,
  content: `SUMMARY ${n}`,
  signature: `SIG_COMPACTION_${n}`,
});
const compacted = (n: number) => ({ role: 'assistant', content: [block(n)] });
const SUMMARY = (n: number) => Prompts.getCompactSummaryWrapper(`SUMMARY ${n}`);
const BETA = 'compact-2026-09-04';
const SIGNED = { reason: 'compaction', at: 0, signed: true, strippedThinking: 0 } as const;

const search: ToolDefinition = {
  name: 'search',
  description: 'Search the web',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
};
const State = z.object({ step: z.number() });
const state = (step: number, rev: number) =>
  `<dynamic_state rev="${rev}">\n  <step>${step}</step>\n</dynamic_state>`;

const tokenizer = (messages: Message[]): number => messages.length * 10;
const JANITOR = { contextWindow: 100, triggerRatio: 0.6, tokenizer };

type CompressionModel = (messages: Message[]) => Promise<string>;
type Build = (compact: OnDemandCompactor, compressionModel: CompressionModel) => OverflowStrategy;

/** Signed, keeping the last turn; `summarize()` keeping the last turn where nothing can be signed. */
const signedKeepingOne: Build = (compact, compressionModel) =>
  onDemandCompaction({
    compact,
    fallback: summarize({ compressionModel, split: 'recent-turns', preserveRecentMessages: 1 }),
  });

/**
 * A chef that checks the pipeline invariants and records what it reports. Its
 * compactor answers block 1, 2, … in turn; its fallback's compression model
 * `SUMMARY 1`, `SUMMARY 2`, ….
 */
function chefWith(config: ChefConfig = {}, strategy: Build = signedKeepingOne) {
  let blocks = 0;
  const compact = vi.fn<OnDemandCompactor>(async () => ({
    stop_reason: 'compaction',
    content: [block(++blocks)],
  }));
  let summaries = 0;
  const compressionModel = vi.fn(async () => `<summary>SUMMARY ${++summaries}</summary>`);
  const chef = new ContextChef({
    logger: silent,
    appendOnly: true,
    pipelineChecks: true,
    janitor: JANITOR,
    overflow: { strategy: strategy((...args) => compact(...args), compressionModel) },
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
  return { chef, compact, compressionModel, breaks, invariants };
}

/** Compiles each turn in order, as the agent loop does; `settle` lets background work finish in between. */
async function converse<P extends TargetPayload = AnthropicPayload>(
  chef: ContextChef,
  turns: Message[][],
  { target = 'anthropic', settle = false }: { target?: string; settle?: boolean } = {},
): Promise<P[]> {
  const payloads: P[] = [];
  for (const history of turns) {
    payloads.push((await chef.setHistory(history).compile({ target })) as P);
    if (settle) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return payloads;
}

function expectAppendOnly(payloads: TargetPayload[]) {
  for (let i = 1; i < payloads.length; i++) {
    expect(checkPrefixContinuity(payloads[i - 1], payloads[i])).toEqual({ ok: true });
  }
}

/** What reaches the provider: the payload without `meta`. */
const wire = (payload: TargetPayload): Omit<TargetPayload, 'meta'> => {
  const { meta: _meta, ...rest } = payload;
  return rest;
};

/** The signatures of the thinking blocks sent, in order. */
const signatures = (payload: AnthropicPayload): string[] =>
  payload.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .flatMap((b) => (b.type === 'thinking' ? [b.signature] : []));

const requested = (
  compact: ReturnType<typeof chefWith>['compact'],
  n = 1,
): OnDemandCompactionRequest => compact.mock.calls[n - 1][0];

describe('appendOnly onDemandCompaction(): the request it compacts is the one sent', () => {
  it('asks for the window up to the reply it keeps, byte for byte as the last payloads sent it', async () => {
    const { chef, compact } = chefWith();
    chef.registerTools([search]);
    chef.setDynamicState(State, { step: 1 });

    // asked(4) is [q1, state, a1, …, a3, q4], over the trigger: a3 is the reply it keeps,
    // and [q1, state, a1, q2, a2, q3] the request a3 answered — the third payload.
    const payloads = await converse(chef, [1, 2, 3, 4].map(asked));

    expect(compact).toHaveBeenCalledTimes(1);
    const request = requested(compact);
    expect(request.payload).toEqual(wire(payloads[2]));
    expect(JSON.stringify(request.payload.messages)).toBe(JSON.stringify(payloads[2].messages));
    expect(request.compaction).toEqual({ type: 'summarize' });
    expect(request.betas).toEqual([BETA]);
    expect(request.payload).not.toHaveProperty('context_management');
  });

  it('asks for a request that ends in a positional system event, as it was sent', async () => {
    const { chef, compact } = chefWith(
      { janitor: { contextWindow: 200, triggerRatio: 0.6, tokenizer } },
      (compact) => onDemandCompaction({ compact }),
    );

    // The state changes every turn: each request ends in its own positional system event.
    // asked(5) is [q1, state 1, a1, …, q5, state 5]: 14 messages, over the trigger of 120.
    const payloads: AnthropicPayload[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      chef.setDynamicState(State, { step: n }, { placement: 'system' });
      payloads.push(...(await converse(chef, [asked(n)])));
    }

    // a4 is the reply kept; the request it answered was the fourth payload.
    expect(compact).toHaveBeenCalledTimes(1);
    const request = requested(compact).payload;
    expect(request).toEqual(wire(payloads[3]));
    expect(request.messages.at(-1)).toEqual({
      role: 'system',
      content: [{ type: 'text', text: `${state(4, 4)}\n\n${Prompts.EVENT_STATE_ANCHOR}` }],
    });
    expect(payloads[4].messages.slice(0, 2)).toEqual([compacted(1), answer(4)]);
  });

  it('compacts a request that starts with the block it returned last time', async () => {
    const { chef, compact } = chefWith();

    const payloads = await converse(chef, [1, 2, 3, 4, 5, 6].map(asked));

    // [block 1, a3, q4, a4, q5, a5, q6]: [block 1, …, q5] is the fifth payload.
    expect(compact).toHaveBeenCalledTimes(2);
    expect(requested(compact, 2).payload.messages).toEqual(payloads[4].messages);
    expect(requested(compact, 2).payload.messages[0]).toEqual(compacted(1));
    expect(payloads[5].messages).toEqual([compacted(2), answer(5), text('user', 'q6')]);
  });
});

describe('appendOnly onDemandCompaction(): a signed checkpoint strips nothing', () => {
  it('sends the block first, as returned, and keeps the thinking of the turns after it', async () => {
    const { chef, breaks, invariants } = chefWith();

    const payloads = await converse(chef, [1, 2, 3, 4, 5].map(asked));
    const [, , , landed, next] = payloads;

    expect(landed.messages).toEqual([compacted(1), answer(3), text('user', 'q4')]);
    expect(landed.betas).toEqual([BETA]);
    expect(landed.meta?.prefix?.break).toEqual(SIGNED);
    expect(breaks).toEqual([{ ...SIGNED, windowId: landed.meta?.windowId }]);
    expect(next.messages).toEqual([...landed.messages, answer(4), text('user', 'q5')]);
    expect(next.betas).toEqual([BETA]);
    expect(signatures(next)).toEqual(['SIG_3', 'SIG_4']);
    expectAppendOnly(payloads.slice(0, 3));
    expectAppendOnly(payloads.slice(3));
    expect(invariants).toEqual([]);
  });

  it('lands in the middle of a tool turn, which keeps its thinking', async () => {
    const { chef, compact, breaks } = chefWith();
    // asked(3) fits; the tool step after it is over the trigger.
    const loop = [...asked(3), call('t1', 'SIG_C1'), result('t1', 'r1')];
    const done = [...loop, reply('a3', 'SIG_3'), user('q4')];

    const payloads = await converse(chef, [asked(1), asked(2), asked(3), loop, done]);

    expect(requested(compact).payload).toEqual(wire(payloads[2]));
    expect(payloads[3].messages).toEqual([
      compacted(1),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Search first.', signature: 'SIG_C1' },
          { type: 'text', text: '' },
          { type: 'tool_use', id: 't1', name: 'search', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }] },
    ]);
    expect(signatures(payloads[4])).toEqual(['SIG_C1', 'SIG_3']);
    expect(breaks.map((b) => [b.reason, b.signed])).toEqual([['compaction', true]]);
    expectAppendOnly(payloads.slice(3));
  });

  it('keeps no turn when asked to: the block stands for the whole window', async () => {
    const { chef } = chefWith({}, (compact) => onDemandCompaction({ compact, keepRecentTurns: 0 }));

    const [, , , landed, next] = await converse(chef, [1, 2, 3, 4, 5].map(asked));

    expect(landed.messages).toEqual([compacted(1)]);
    expect(next.messages).toEqual([compacted(1), answer(4), text('user', 'q5')]);
  });

  it('keeps stripped the thinking of what it keeps of an unsigned head before it', async () => {
    const pinnedA1 = conversation(['a1']);
    const { chef, compact, compressionModel } = chefWith({}, (compact, compressionModel) =>
      chain(
        onDemandCompaction({ compact, keepRecentTurns: 2 }),
        summarize({ compressionModel, split: 'recent-turns', preserveRecentMessages: 1 }),
      ),
    );
    compact.mockImplementationOnce(async () => ({ stop_reason: 'end_turn', content: [] }));

    // The first compaction fails, and summarize() lands [SUMMARY 1, a1, q4] in its place:
    // a1, put back after the summary, goes without its thinking from then on.
    const payloads = await converse(chef, [1, 2, 3, 4].map(pinnedA1));
    chef.requestNewContext();
    const [next] = await converse(chef, [pinnedA1(5)]);

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(signatures(payloads[2])).toEqual(['SIG_1', 'SIG_2']);
    expect(payloads[3].messages).toEqual([
      text('user', SUMMARY(1)),
      text('assistant', 'a1'),
      text('user', 'q4'),
    ]);
    // Two turns kept: a1 and what follows it, a4 and what follows it.
    expect(requested(compact, 2).payload.messages).toEqual([text('user', SUMMARY(1))]);
    expect(next.messages).toEqual([
      compacted(1),
      text('assistant', 'a1'),
      text('user', 'q4'),
      answer(4),
      text('user', 'q5'),
    ]);
    expect(signatures(next)).toEqual(['SIG_4']);
  });

  it('reports the block to onCompress, for the summarized span', async () => {
    const onCompress = vi.fn();
    const { chef } = chefWith({ janitor: { ...JANITOR, onCompress } });

    await converse(chef, [1, 2, 3, 4].map(asked));

    expect(onCompress).toHaveBeenCalledTimes(1);
    expect(onCompress).toHaveBeenCalledWith(anthropicCompactionMessage(block(1)), 5, {
      compressedMessages: asked(4).slice(0, 5),
      // What to write back to persist it: the block the window now opens with.
      replacement: [anthropicCompactionMessage(block(1))],
    });
  });
});

describe('appendOnly onDemandCompaction(): a response that is no compaction', () => {
  it('leaves the window alone and counts toward the circuit breaker', async () => {
    const warn = vi.fn();
    // A raw window of 200 nothing here reaches; the trigger is still 60.
    const { chef, compact, breaks } = chefWith(
      { logger: { warn }, janitor: { contextWindow: 200, triggerRatio: 0.3, tokenizer } },
      (compact) => onDemandCompaction({ compact }),
    );
    compact.mockImplementation(async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Here is a summary.' }],
    }));

    const payloads = await converse(chef, [1, 2, 3, 4, 5, 6, 7].map(asked));

    // Three failures open the breaker: the seventh compile asks for nothing.
    expect(compact).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "[context-chef] on-demand compaction stopped with 'end_turn', not 'compaction' — history left unchanged (failure 1/3 toward circuit breaker)",
      "[context-chef] on-demand compaction stopped with 'end_turn', not 'compaction' — history left unchanged (failure 2/3 toward circuit breaker)",
      "[context-chef] on-demand compaction stopped with 'end_turn', not 'compaction' — history left unchanged (failure 3/3 toward circuit breaker)",
    ]);
    expect(payloads[3].messages).toHaveLength(7);
    expect(breaks).toEqual([]);
    expectAppendOnly(payloads);
  });

  it('runs the fallback past the raw window, through the open breaker', async () => {
    const { chef, compact, compressionModel } = chefWith({
      janitor: { contextWindow: 200, triggerRatio: 0.3, tokenizer },
    });
    compact.mockImplementation(async () => ({ stop_reason: 'end_turn', content: [] }));

    const payloads = await converse(chef, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(asked));

    // asked(4) to asked(6) fail and open the breaker; asked(7) to asked(10) fit the raw window
    // and ask for nothing. asked(11) can't go out as it is: the signed attempt fails again,
    // and the fallback summarizes.
    expect(compact).toHaveBeenCalledTimes(4);
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(payloads[9].messages).toHaveLength(19);
    expect(payloads[10].messages).toEqual([text('user', SUMMARY(1)), text('user', 'q11')]);
    expect(payloads[11].messages).toEqual([
      ...payloads[10].messages,
      answer(11),
      text('user', 'q12'),
    ]);
    expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(0);
  });
});

describe('appendOnly onDemandCompaction(): pinned messages it summarized', () => {
  const PINNED_Q2 = (rev: number) =>
    `<pinned_messages rev="${rev}">\n${Prompts.PINNED_RESTATED}\n\n<message role="user">q2</message>\n</pinned_messages>`;

  it('says them again after the turns it keeps, never between those and the block', async () => {
    const pinnedQ2 = conversation(['q2']);
    const { chef, invariants } = chefWith();

    const payloads = await converse(chef, [1, 2, 3, 4, 5].map(pinnedQ2));
    const [, , , landed, next] = payloads;

    expect(landed.messages).toEqual([
      compacted(1),
      answer(3),
      text('user', 'q4'),
      text('user', PINNED_Q2(1)),
    ]);
    expect(next.messages).toEqual([...landed.messages, answer(4), text('user', 'q5')]);
    expectAppendOnly(payloads.slice(3));
    expect(invariants).toEqual([]);
  });

  it('says them again once the next compaction summarizes what said them', async () => {
    const pinnedQ2 = conversation(['q2']);
    const { chef, compact } = chefWith();

    const payloads = await converse(chef, [1, 2, 3, 4, 5, 6].map(pinnedQ2));

    // [block 1, a3, q4, pinned, a4, q5, a5, q6]: the pinned event goes into block 2.
    expect(requested(compact, 2).payload.messages).toEqual(payloads[4].messages);
    expect(payloads[5].messages).toEqual([
      compacted(2),
      answer(5),
      text('user', 'q6'),
      text('user', PINNED_Q2(1)),
    ]);
  });

  it('withdraws what it said again once the host unpins it', async () => {
    const pinnedQ2 = conversation(['q2']);
    const { chef } = chefWith();

    const [, , , landed] = await converse(chef, [1, 2, 3, 4].map(pinnedQ2));
    pinnedQ2(2)[2].pinned = false;
    const [next] = await converse(chef, [pinnedQ2(5)]);

    expect(next.messages).toEqual([
      ...landed.messages,
      answer(4),
      text('user', 'q5'),
      text(
        'user',
        '<pinned_messages rev="2" withdrawn="true">The messages restated earlier as pinned are no longer pinned.</pinned_messages>',
      ),
    ]);
  });

  it('says nothing again of a compaction the host history resumes from, pinned as it is', async () => {
    // A history kept from an earlier session opens with the block that session got back.
    const resumed = (n: number) => [anthropicCompactionMessage(block(0)), ...asked(n)];
    const { chef, compact } = chefWith();

    const payloads = await converse(chef, [1, 2, 3, 4].map(resumed));

    expect(requested(compact).payload.messages).toEqual(payloads[2].messages);
    expect(requested(compact).payload.messages[0]).toEqual(compacted(0));
    expect(payloads[3].messages).toEqual([compacted(1), answer(3), text('user', 'q4')]);
    // Every request replays a signed block, the resumed one first: each one carries its beta.
    expect(payloads.map((p) => p.betas)).toEqual([[BETA], [BETA], [BETA], [BETA]]);
  });

  it('says nothing again of a pinned message the turns it keeps hold', async () => {
    const pinnedA3 = conversation(['a3']);
    const { chef } = chefWith();

    const [, , , landed] = await converse(chef, [1, 2, 3, 4].map(pinnedA3));

    expect(landed.messages).toEqual([compacted(1), answer(3), text('user', 'q4')]);
  });
});

describe('appendOnly onDemandCompaction(): an unsigned compaction after a signed one', () => {
  const failing = async () => ({ stop_reason: 'end_turn', content: [] });

  it('keeps the block first, the summary of a chained summarize() after it', async () => {
    const { chef, compact, breaks, invariants } = chefWith({}, (compact, compressionModel) =>
      chain(
        onDemandCompaction({ compact }),
        summarize({ compressionModel, split: 'recent-turns', preserveRecentMessages: 1 }),
      ),
    );

    // Block 1 lands on asked(4); the attempt on asked(6) fails, and summarize() takes over.
    await converse(chef, [1, 2, 3, 4, 5].map(asked));
    compact.mockImplementation(failing);
    const payloads = await converse(chef, [asked(6), asked(7)]);

    expect(payloads[0].messages).toEqual([
      compacted(1),
      text('user', SUMMARY(1)),
      text('user', 'q6'),
    ]);
    expect(payloads[1].messages).toEqual([...payloads[0].messages, answer(6), text('user', 'q7')]);
    // The block is still sent, signed: so is its beta.
    expect(payloads.map((p) => p.betas)).toEqual([[BETA], [BETA]]);
    expect(breaks.map((b) => [b.reason, b.signed])).toEqual([
      ['compaction', true],
      ['compaction', false],
    ]);
    expect(invariants).toEqual([]);
  });

  it("keeps the block's beta once its own fallback summarized after it", async () => {
    const { chef, compact, breaks } = chefWith();

    // Block 1 lands on asked(4); no attempt after it is signed, so past the raw window the
    // fallback summarizes behind the block.
    await converse(chef, [1, 2, 3, 4].map(asked));
    compact.mockImplementation(failing);
    const payloads = await converse(chef, [5, 6, 7, 8, 9, 10].map(asked));

    expect(breaks.map((b) => [b.reason, b.signed])).toContainEqual(['compaction', false]);
    for (const payload of payloads) {
      expect(payload.messages[0]).toEqual(compacted(1));
      expect(payload.betas).toEqual([BETA]);
    }
  });

  it('keeps the block first, the notice of a chained reset() after it', async () => {
    const { chef, compact } = chefWith({}, (compact) =>
      chain(onDemandCompaction({ compact }), reset()),
    );

    await converse(chef, [1, 2, 3, 4, 5].map(asked));
    compact.mockImplementation(failing);
    const [after] = await converse(chef, [asked(6)]);

    expect(after.messages).toHaveLength(2);
    expect(after.messages[0]).toEqual(compacted(1));
    expect(JSON.stringify(after.messages[1])).toContain('Context window reset');
  });
});

describe('appendOnly onDemandCompaction(): where nothing can be signed', () => {
  it('runs its fallback on a target that signs nothing', async () => {
    const { chef, compact, compressionModel } = chefWith();

    const payloads = await converse(chef, [1, 2, 3, 4].map(asked), { target: 'openai' });

    expect(compact).not.toHaveBeenCalled();
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(payloads[3].messages.map((m) => m.content)).toEqual([
      'You are terse.',
      SUMMARY(1),
      'q4',
    ]);
  });

  it('runs its fallback before the first request, and compacts signed from then on', async () => {
    const { chef, compact, compressionModel, breaks } = chefWith();

    // Nothing was sent before asked(4); [SUMMARY 1, q4, a4, …, q7] is over the trigger again.
    const payloads = await converse(chef, [4, 5, 6, 7].map(asked));

    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(requested(compact).payload.messages).toEqual(payloads[2].messages);
    expect(payloads[3].messages).toEqual([compacted(1), answer(6), text('user', 'q7')]);
    // The first compile meets replies its ledger never saw: a `ledger` checkpoint first.
    expect(breaks.map((b) => [b.reason, b.signed])).toEqual([
      ['ledger', false],
      ['compaction', false],
      ['compaction', true],
    ]);
  });
});

describe('appendOnly onDemandCompaction(): where it cannot sign, the fallback runs where it may', () => {
  /** An onBeforeCompress hook that hands the runner a copy: nothing in it was sent as such. */
  const rewriting = { janitor: { ...JANITOR, onBeforeCompress: async (h: Message[]) => [...h] } };
  // asked(3) fits; a tool step after it is over the trigger, below the raw window.
  const loop = [...asked(3), call('t1', 'SIG_C1'), result('t1', 'r1')];
  // Four tool messages after asked(4): 11 messages, past the raw window in a tool turn.
  const pastInLoop = [
    ...asked(4),
    call('t1', 'SIG_C1'),
    result('t1', 'r1'),
    call('t2', 'SIG_C2'),
    result('t2', 'r2'),
  ];

  it('runs it at a turn boundary once a hook rewrote the window', async () => {
    const { chef, compact, compressionModel, breaks } = chefWith(rewriting);

    const payloads = await converse(chef, [1, 2, 3, 4].map(asked));

    expect(compact).not.toHaveBeenCalled();
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(payloads[3].messages).toEqual([text('user', SUMMARY(1)), text('user', 'q4')]);
    expect(breaks.map((b) => [b.reason, b.signed])).toEqual([['compaction', false]]);
  });

  it('waits in a tool turn below the raw window, counting nothing, and runs it at the boundary', async () => {
    const warn = vi.fn();
    const { chef, compact, compressionModel } = chefWith({ ...rewriting, logger: { warn } });
    const done = [...loop, reply('a3', 'SIG_3'), user('q4')];

    const payloads = await converse(chef, [asked(1), asked(2), asked(3), loop, done]);

    expect(payloads[3].messages).toHaveLength(7);
    expect(signatures(payloads[3])).toEqual(['SIG_1', 'SIG_2', 'SIG_C1']);
    expect(warn).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(compressionModel).toHaveBeenCalledTimes(1);
    expect(payloads[4].messages).toEqual([text('user', SUMMARY(1)), text('user', 'q4')]);
  });

  it.each([
    ['at a turn boundary', asked(6), [text('user', SUMMARY(1)), text('user', 'q6')]],
    ['in a tool turn, collapsing it', pastInLoop, [text('user', SUMMARY(1))]],
  ])('runs it past the raw window %s once a hook rewrote the window', async (_, past, expected) => {
    const { chef, compact } = chefWith(rewriting);

    const payloads = await converse(chef, [asked(1), asked(2), past]);

    expect(compact).not.toHaveBeenCalled();
    expect(payloads[2].messages).toEqual(expected);
  });

  describe('past the raw window in a tool turn', () => {
    const failing = async () => ({ stop_reason: 'end_turn', content: [] });
    const failed =
      "[context-chef] on-demand compaction stopped with 'end_turn', not 'compaction' — history left unchanged (failure 1/3 toward circuit breaker)";
    const tooFew =
      '[context-chef] on-demand compaction: the window holds no turn to compact ahead of the 9 kept turns, ' +
      'and no fallback strategy is configured — history left unchanged (failure 1/3 toward circuit breaker)';

    it.each([
      ['fails', {}, failing, failed],
      ['has too few turns to keep', { keepRecentTurns: 9 }, undefined, undefined],
    ] as const)('collapses through the fallback once the compaction %s', async (_, options, answer, warned) => {
      const warn = vi.fn();
      const { chef, compact } = chefWith({ logger: { warn } }, (compact, compressionModel) =>
        onDemandCompaction({
          compact,
          ...options,
          fallback: summarize({
            compressionModel,
            split: 'recent-turns',
            preserveRecentMessages: 1,
          }),
        }),
      );
      if (answer) compact.mockImplementation(answer);

      const payloads = await converse(chef, [asked(1), asked(2), pastInLoop]);

      expect(payloads[2].messages).toEqual([text('user', SUMMARY(1))]);
      expect(warn.mock.calls.map(([message]) => message)).toEqual(warned ? [warned] : []);
    });

    it.each([
      ['fails', {}, failing, failed],
      ['has too few turns to keep', { keepRecentTurns: 9 }, undefined, tooFew],
    ] as const)('sends the window as it is without a fallback, counting it, once the compaction %s', async (_, options, answer, warned) => {
      const warn = vi.fn();
      const { chef, compact } = chefWith({ logger: { warn } }, (compact) =>
        onDemandCompaction({ compact, ...options }),
      );
      if (answer) compact.mockImplementation(answer);

      const payloads = await converse(chef, [asked(1), asked(2), pastInLoop]);

      expect(payloads[2].messages).toHaveLength(11);
      expect(warn.mock.calls.map(([message]) => message)).toEqual([warned]);
    });
  });
});

describe('appendOnly onDemandCompaction() with server()', () => {
  const compact: OnDemandCompactor = async () => ({ stop_reason: null, content: [] });
  const od = (fallback?: OverflowStrategy) => onDemandCompaction({ compact, fallback });

  it.each([
    ['server() falling back to it', () => server(undefined, { fallback: od() })],
    ['it falling back to server()', () => od(server())],
    ['both in a chain', () => chain(server(), background(od()))],
  ])('warns once, at construction: %s', async (_, strategy) => {
    const warn = vi.fn();
    const chef = new ContextChef({
      logger: { warn },
      appendOnly: true,
      janitor: JANITOR,
      overflow: { strategy: strategy() },
    });
    await chef.setHistory(asked(1)).compile({ target: 'anthropic' });
    await chef.setHistory(asked(2)).compile({ target: 'anthropic' });

    const warned = warn.mock.calls.filter(([message]) =>
      String(message).includes('onDemandCompaction'),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0][0]).toMatch(/server\(\).*never both run/);
  });

  it('says nothing of a configuration with one of them', () => {
    const warn = vi.fn();
    new ContextChef({ logger: { warn }, overflow: { strategy: chain(od(), reset()) } });
    new ContextChef({ logger: { warn }, overflow: { strategy: server() } });

    expect(warn.mock.calls.filter(([m]) => String(m).includes('onDemandCompaction'))).toEqual([]);
  });
});

describe('appendOnly onDemandCompaction({ fallback: background(...) }): a fallback job waiting to land', () => {
  const inBackground: Build = (compact, compressionModel) =>
    onDemandCompaction({
      compact,
      fallback: background(
        summarize({ compressionModel, split: 'recent-turns', preserveRecentMessages: 1 }),
      ),
    });

  it('drops the job once a signed compaction lands, and compacts only over budget after that', async () => {
    const { chef, compact, compressionModel } = chefWith({}, inBackground);

    const sizes: number[] = [];
    const calls: number[] = [];
    for (const n of [4, 5, 6, 7, 8]) {
      const [payload] = await converse(chef, [asked(n)], { settle: true });
      sizes.push(payload.messages.length);
      calls.push(compact.mock.calls.length);
    }

    // asked(4) is the first request: nothing to sign over, so the fallback starts a job.
    // asked(5) is over the trigger: block 1 lands, and the finished job is dropped unlanded.
    // asked(6) fits, so nothing is asked for; asked(7) is over the trigger again.
    expect(calls).toEqual([0, 1, 1, 2, 2]);
    expect(sizes).toEqual([7, 3, 5, 3, 5]);
    expect(compressionModel).toHaveBeenCalledTimes(1);
  });

  it('lets nothing but the waiting job past an open breaker', async () => {
    const warn = vi.fn();
    // A raw window of 200 nothing here reaches; the trigger is still 60.
    const { chef, compact, compressionModel } = chefWith(
      { logger: { warn }, janitor: { contextWindow: 200, triggerRatio: 0.3, tokenizer } },
      inBackground,
    );
    let release: () => void = () => {};
    compressionModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('<summary>SUMMARY 1</summary>');
        }),
    );
    compact.mockImplementation(async () => ({ stop_reason: 'end_turn', content: [] }));

    // asked(4) is the first request: the fallback's job starts, and its model takes its time.
    // The next three are over the trigger, and every compaction fails: the breaker opens.
    await converse(chef, [4, 5, 6, 7].map(asked), { settle: true });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [landed] = await converse(chef, [asked(8)]);

    expect(compact).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('circuit breaker'))).toHaveLength(3);
    expect(landed.messages[0]).toEqual(text('user', SUMMARY(1)));
  });

  it('lands the waiting job past the raw window as any compaction there, and fits what it leaves', async () => {
    // A trigger of 30 against a raw window of 100.
    const { chef, compact, compressionModel } = chefWith(
      { janitor: { contextWindow: 100, triggerRatio: 0.3, tokenizer } },
      inBackground,
    );
    let release: () => void = () => {};
    compressionModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('<summary>JOB</summary>');
        }),
    );
    compact.mockImplementation(async () => ({ stop_reason: 'end_turn', content: [] }));

    // asked(3) is the first request: the fallback's job starts on it. Three failed compactions
    // after it open the breaker, below the raw window.
    await converse(chef, [3, 4, 5, 5].map(asked), { settle: true });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The host comes back at q9: 17 messages. The job leaves [JOB, q3 … q9], 14, still past the
    // raw window, so the window it leaves is summarized in the same compile.
    const [landed] = await converse(chef, [asked(9)]);

    expect(compact).toHaveBeenCalledTimes(4);
    expect(compressionModel).toHaveBeenCalledTimes(2);
    // The second summary is of the window the job left, its summary first.
    expect(JSON.stringify(compressionModel.mock.calls[1])).toContain('JOB');
    expect(landed.messages).toEqual([text('user', SUMMARY(1)), text('user', 'q9')]);
    expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(0);
  });

  it('never asks again while the window fits, and leaves the breaker to stand', async () => {
    // Tokens are characters here: q1 alone is over the trigger.
    const qa: Message[] = [user('x'.repeat(80))];
    for (let i = 1; i < 12; i++) qa.push(reply(`a${i}`, `SIG_${i}`), user(`q${i + 1}`));
    const long = (n: number) => qa.slice(0, 2 * n - 1);
    const characters = (messages: Message[]) =>
      messages.reduce((n, message) => n + message.content.length, 0);
    const warn = vi.fn();
    const { chef, compact, compressionModel } = chefWith(
      {
        logger: { warn },
        janitor: { contextWindow: 100, triggerRatio: 0.6, tokenizer: characters },
      },
      (compact, compressionModel) =>
        onDemandCompaction({
          compact,
          keepRecentTurns: 2,
          fallback: background(
            summarize({ compressionModel, split: 'recent-turns', preserveRecentMessages: 1 }),
          ),
        }),
    );
    let release: () => void = () => {};
    compressionModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('<summary>FALLBACK</summary>');
        }),
    );

    const calls: number[] = [];
    for (let n = 1; n <= 11; n++) {
      if (n === 3) release();
      // From the seventh request on, every compaction would fail.
      if (n === 7)
        compact.mockImplementation(async () => ({ stop_reason: 'end_turn', content: [] }));
      await converse(chef, [long(n)], { settle: true });
      calls.push(compact.mock.calls.length);
    }

    // long(2) has too few turns to keep two: the fallback starts a job. long(3) is still over
    // the trigger, so block 1 lands over it; the window fits from then on.
    expect(calls).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('appendOnly background(onDemandCompaction())', () => {
  it('lands the job with the turns that arrived while it ran', async () => {
    const { chef, compact, breaks } = chefWith({}, (compact) =>
      background(onDemandCompaction({ compact })),
    );

    const payloads = await converse(chef, [1, 2, 3, 4, 5].map(asked), { settle: true });

    // The job started on asked(4) and asked for [q1, …, q3]; a4 and q5 came after it.
    expect(compact).toHaveBeenCalledTimes(1);
    expect(requested(compact).payload).toEqual(wire(payloads[2]));
    expect(payloads[3].messages).toHaveLength(7);
    expect(payloads[4].messages).toEqual([
      compacted(1),
      answer(3),
      text('user', 'q4'),
      answer(4),
      text('user', 'q5'),
    ]);
    expect(breaks.map((b) => [b.reason, b.signed])).toEqual([['compaction', true]]);
    expectAppendOnly(payloads.slice(0, 4));
  });

  it.each([
    [
      'the system prompt',
      'system',
      (chef: ContextChef) =>
        chef.setSystemPrompt([{ role: 'system', content: 'You are terse. Answer in French.' }]),
    ],
    ['the tool list', 'tools', (chef: ContextChef) => chef.registerTools([search])],
  ] as const)('drops the job when %s changed while it ran', async (_, reason, change) => {
    let release: () => void = () => {};
    const { chef, compact, breaks } = chefWith({}, (compact) =>
      background(onDemandCompaction({ compact })),
    );
    compact.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ stop_reason: 'compaction', content: [block(1)] });
        }),
    );

    await converse(chef, [1, 2, 3, 4].map(asked));
    change(chef);
    await converse(chef, [asked(5)]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A retry of asked(5): the finished job is offered the window it no longer applies to.
    const [after] = await converse(chef, [asked(5)]);

    // The job asked for [q1, …, q3] behind a system prompt and tools no request sends now,
    // and a new one starts on the window as it is.
    expect(compact).toHaveBeenCalledTimes(2);
    expect(after.messages).toHaveLength(9);
    expect(breaks.map((b) => b.reason)).toEqual([reason]);
  });
});
