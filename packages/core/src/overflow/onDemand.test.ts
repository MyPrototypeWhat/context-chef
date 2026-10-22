import { describe, expect, it, vi } from 'vitest';
import {
  type AnthropicCompactionBlock,
  anthropicCompactionMessage,
} from '../adapters/anthropicAdapter';
import type { AnthropicPayload, Message, ToolDefinition } from '../types';
import { background } from './background';
import { chain } from './chain';
import {
  combinesServerAndOnDemand,
  type OnDemandCompactionRequest,
  type OnDemandCompactor,
  onDemandCompaction,
} from './onDemand';
import { reset } from './reset';
import { server } from './server';
import { summarize } from './summarize';
import { extractPinnedMessages } from './turns';
import type {
  OverflowInput,
  OverflowResult,
  OverflowRunner,
  OverflowStrategy,
  OverflowWire,
} from './types';

const user = (content: string): Message => ({ role: 'user', content });
const reply = (content: string, signature: string): Message => ({
  role: 'assistant',
  content,
  thinking: { thinking: `Reasoning signed ${signature}.`, signature },
});
const call = (signature: string, ...ids: string[]): Message => ({
  role: 'assistant',
  content: '',
  thinking: { thinking: 'Search first.', signature },
  tool_calls: ids.map((id) => ({
    id,
    type: 'function',
    function: { name: 'search', arguments: '{}' },
  })),
});
const result = (id: string): Message => ({ role: 'tool', content: `r-${id}`, tool_call_id: id });
const event = (content: string): Message => ({
  role: 'system',
  content,
  _positional: true,
  _chef_event: true,
});

/** q1 a1 q2 a2 q3: two answered requests and one pending. */
const conversation = (): Message[] => [
  user('q1'),
  reply('a1', 'SIG_1'),
  user('q2'),
  reply('a2', 'SIG_2'),
  user('q3'),
];

const search: ToolDefinition = {
  name: 'search',
  description: 'Search the web',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
};

/**
 * A wire over `history`, as the overflow phase hands it: each message
 * rendered as its role and text, behind the system prompt and tools sent.
 */
function wireOver(
  history: Message[],
  system = 'You are terse.',
  betas?: string[],
): OverflowWire & { renderPrefix: ReturnType<typeof vi.fn> } {
  return {
    target: 'anthropic',
    history,
    renderPrefix: vi.fn(
      (end: number): AnthropicPayload => ({
        system: [{ type: 'text', text: system }],
        messages: history.slice(0, end).map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: [{ type: 'text', text: m.content }],
        })),
        tools: [search],
        ...(betas ? { betas } : {}),
      }),
    ),
  };
}

const tokenizer = (messages: Message[]): number => messages.length * 10;

/** Over the trigger of 20, under the raw window of 1000: a compaction is due, nothing is past the window. */
const inputOver = (history: Message[], overrides: Partial<OverflowInput> = {}): OverflowInput => ({
  history,
  budget: {
    limit: 1000,
    current: tokenizer(history),
    trigger: 20,
    remaining: 20 - tokenizer(history),
  },
  tokenizer,
  pinned: extractPinnedMessages(history),
  window: { first: 'w_1', current: 'w_1' },
  appendOnly: true,
  wire: wireOver(history),
  ...overrides,
});

const block = (n: number): AnthropicCompactionBlock => ({
  type: 'compaction',
  content: `SUMMARY ${n}`,
  signature: `SIG_COMPACTION_${n}`,
});

/** A compactor that answers block 1, 2, … in turn, as the API does once it compacted. */
const compactor = () => {
  let n = 0;
  return vi.fn<OnDemandCompactor>(async () => ({
    stop_reason: 'compaction',
    content: [block(++n)],
  }));
};

const fakeRunner = (): OverflowRunner & { failures: string[]; successes: number } => {
  const failures: string[] = [];
  return {
    failures,
    successes: 0,
    fail(reason) {
      failures.push(reason);
    },
    succeed() {
      this.successes++;
    },
    logger: { warn: () => {} },
  };
};

const attached = <S extends OverflowStrategy>(strategy: S): [S, ReturnType<typeof fakeRunner>] => {
  const runner = fakeRunner();
  strategy.attach?.(runner);
  return [strategy, runner];
};

/** The request the compactor was handed on its `n`th call. */
const requested = (compact: ReturnType<typeof compactor>, n = 1): OnDemandCompactionRequest =>
  compact.mock.calls[n - 1][0];

describe('onDemandCompaction()', () => {
  it('asks to compact the request already sent before the last reply, and keeps that reply on', async () => {
    const compact = compactor();
    const [strategy] = attached(onDemandCompaction({ compact }));
    const history = conversation();
    const input = inputOver(history);

    const landed = await strategy.apply(input);

    // [q1, a1, q2] was the request a2 answered.
    const sent = input.wire?.renderPrefix(3);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(requested(compact)).toEqual({
      payload: sent,
      compaction: { type: 'summarize' },
      betas: ['compact-2026-09-04'],
    });
    expect(requested(compact).payload).not.toHaveProperty('context_management');
    expect(landed.history).toEqual([anthropicCompactionMessage(block(1)), history[3], history[4]]);
    expect(landed.history[1]).toBe(history[3]);
    expect(landed.history[2]).toBe(history[4]);
    expect(landed.evicted).toEqual(history.slice(0, 3));
    expect(landed.span).toEqual(history.slice(0, 3));
    expect(landed.summary).toBeUndefined();
    expect(landed.meta).toEqual({
      strategy: 'onDemandCompaction',
      windowId: 'w_1',
      changed: true,
      signed: { request: sent },
    });
  });

  it.each([
    [0, 5],
    [1, 3],
    [2, 1],
  ])('keeps %i turn(s), each a reply to a user turn and what follows it', async (keepRecentTurns, cut) => {
    const compact = compactor();
    const [strategy] = attached(onDemandCompaction({ compact, keepRecentTurns }));
    const history = conversation();

    const landed = await strategy.apply(inputOver(history));

    expect(requested(compact).payload.messages).toHaveLength(cut);
    expect(landed.history.slice(1)).toEqual(history.slice(cut));
  });

  it('compacts nothing when the window holds no more turns than it keeps', async () => {
    const compact = compactor();
    const [strategy, runner] = attached(onDemandCompaction({ compact, keepRecentTurns: 3 }));
    const input = inputOver(conversation());

    const landed = await strategy.apply(input);

    expect(compact).not.toHaveBeenCalled();
    expect(landed.history).toBe(input.history);
    expect(landed.meta.changed).toBe(false);
    expect(landed.meta.reason).toMatch(/3 kept turns/);
    expect(runner.failures).toEqual([]);
  });

  it('cuts in a tool loop at the call whose results are still coming in', async () => {
    const compact = compactor();
    const [strategy] = attached(onDemandCompaction({ compact }));
    const history = [
      user('q1'),
      call('SIG_C1', 't1', 't2'),
      result('t1'),
      result('t2'),
      call('SIG_C2', 't3'),
      result('t3'),
    ];

    const landed = await strategy.apply(inputOver(history));

    expect(requested(compact).payload.messages).toHaveLength(4);
    expect(landed.history.slice(1)).toEqual(history.slice(4));
  });

  it('never summarizes a tool call without its result', async () => {
    const compact = compactor();
    const [strategy] = attached(onDemandCompaction({ compact }));
    // t2 never got its result: the summary may not end after t1's.
    const history = [
      user('q1'),
      call('SIG_C1', 't1', 't2'),
      result('t1'),
      reply('a1', 'SIG_1'),
      user('q2'),
    ];

    const landed = await strategy.apply(inputOver(history));

    expect(requested(compact).payload.messages).toHaveLength(1);
    expect(landed.history.slice(1)).toEqual(history.slice(1));
  });

  it('cuts after the system messages a user turn ends with, never at one', async () => {
    const compact = compactor();
    const [strategy] = attached(onDemandCompaction({ compact, keepRecentTurns: 2 }));
    const history = [
      user('q1'),
      event('<dynamic_state rev="1"/>'),
      reply('a1', 'SIG_1'),
      user('q2'),
      reply('a2', 'SIG_2'),
      user('q3'),
    ];

    const landed = await strategy.apply(inputOver(history));

    // The block and the turns it keeps have no system message between them.
    expect(requested(compact).payload.messages).toHaveLength(2);
    expect(landed.history.slice(1)).toEqual(history.slice(2));
  });

  it('summarizes the compaction before it, pinned as it is', async () => {
    const compact = compactor();
    const [strategy] = attached(onDemandCompaction({ compact }));
    const history = [
      anthropicCompactionMessage(block(0)),
      reply('a2', 'SIG_2'),
      user('q3'),
      reply('a3', 'SIG_3'),
      user('q4'),
    ];

    const landed = await strategy.apply(inputOver(history));

    expect(landed.span).toEqual(history.slice(0, 3));
    expect(landed.history).toEqual([anthropicCompactionMessage(block(1)), ...history.slice(3)]);
  });

  it('puts no pinned message back between the block and the turns it keeps', async () => {
    const compact = compactor();
    const [strategy] = attached(onDemandCompaction({ compact }));
    const history = conversation();
    history[2] = { ...user('q2'), pinned: true };

    const landed = await strategy.apply(inputOver(history));

    expect(landed.history).toEqual([anthropicCompactionMessage(block(1)), ...history.slice(3)]);
    expect(landed.evicted).toContain(history[2]);
  });

  it('collapses as far as a cut can go: everything, or up to a call still waiting for its result', async () => {
    const compact = compactor();
    const [strategy] = attached(onDemandCompaction({ compact }));
    const loop = [...conversation(), call('SIG_C3', 't3'), result('t3')];
    const waiting = [...conversation(), call('SIG_C3', 't3')];

    const all = await strategy.apply(inputOver(loop, { collapse: true }));
    const upToCall = await strategy.apply(inputOver(waiting, { collapse: true }));

    expect(requested(compact, 1).payload.messages).toHaveLength(7);
    expect(all.history).toEqual([anthropicCompactionMessage(block(1))]);
    expect(requested(compact, 2).payload.messages).toHaveLength(5);
    expect(upToCall.history).toEqual([anthropicCompactionMessage(block(2)), waiting[5]]);
  });

  it('sends instructions that replace the default prompt, up to 16,384 characters', async () => {
    const compact = compactor();
    const [strategy] = attached(
      onDemandCompaction({ compact, instructions: 'Keep every file path.' }),
    );

    await strategy.apply(inputOver(conversation()));

    expect(requested(compact).compaction).toEqual({
      type: 'summarize',
      instructions: 'Keep every file path.',
    });
    expect(() => onDemandCompaction({ compact, instructions: 'x'.repeat(16_384) })).not.toThrow();
    expect(() => onDemandCompaction({ compact, instructions: 'x'.repeat(16_385) })).toThrow(
      /16,384/,
    );
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
  ])('rejects keepRecentTurns %s at construction', (keepRecentTurns) => {
    expect(() => onDemandCompaction({ compact: compactor(), keepRecentTurns })).toThrow(
      /keepRecentTurns/,
    );
  });

  it('adds the compaction beta to the ones the request already needs', async () => {
    const compact = compactor();
    const [strategy] = attached(onDemandCompaction({ compact }));
    const history = conversation();
    const clearAt = 'mid-conversation-system-clear-at-2026-08-21';

    await strategy.apply(
      inputOver(history, { wire: wireOver(history, 'You are terse.', [clearAt]) }),
    );

    expect(requested(compact).betas).toEqual([clearAt, 'compact-2026-09-04']);
  });

  it('keeps what it signed over out of the host’s reach', async () => {
    const compact = vi.fn<OnDemandCompactor>(async (request) => {
      (request.payload.messages as unknown[]).push({ role: 'user', content: 'edited' });
      return { stop_reason: 'compaction', content: [block(1)] };
    });
    const [strategy] = attached(onDemandCompaction({ compact }));
    const input = inputOver(conversation());

    const landed = await strategy.apply(input);

    expect(landed.meta.signed?.request).toEqual(input.wire?.renderPrefix(3));
  });

  it('renders the request before it waits for anything, so a job reads the window it started on', () => {
    const compact = vi.fn<OnDemandCompactor>(() => new Promise(() => {}));
    const [strategy] = attached(onDemandCompaction({ compact }));
    const input = inputOver(conversation());

    void strategy.apply(input);

    expect(input.wire?.renderPrefix).toHaveBeenCalledWith(3);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'stops for another reason',
      async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure.' }] }),
      /stopped with 'end_turn'/,
    ],
    [
      'returns no signed block',
      async () => ({ stop_reason: 'compaction', content: [{ type: 'compaction', content: 'S' }] }),
      /no signed compaction block/,
    ],
    [
      'throws',
      async () => {
        throw new Error('overloaded');
      },
      /request failed/,
    ],
  ] as const)('counts a compaction that %s as a failure and leaves the window alone', async (_, answer, reason) => {
    const [strategy, runner] = attached(onDemandCompaction({ compact: vi.fn(answer) }));
    const input = inputOver(conversation());

    const landed = await strategy.apply(input);

    expect(runner.failures).toHaveLength(1);
    expect(runner.failures[0]).toMatch(reason);
    expect(landed.history).toBe(input.history);
    expect(landed.meta.changed).toBe(false);
  });

  describe('where nothing was sent that a compaction could be signed over', () => {
    const declined = async (input: OverflowInput): Promise<OverflowResult> => ({
      history: input.history,
      evicted: [],
      span: [],
      meta: { strategy: 'fallback', windowId: input.window.current, changed: false },
    });

    it.each([
      ['no wire (another target, or nothing sent yet)', undefined],
      ['a wire for another target', { ...wireOver([]), target: 'openai' }],
    ])('runs the fallback on %s', async (_, wire) => {
      const compact = compactor();
      const fallback: OverflowStrategy = { name: 'fallback', apply: vi.fn(declined) };
      const [strategy] = attached(onDemandCompaction({ compact, fallback }));
      const input = inputOver(conversation(), { wire });

      await strategy.apply(input);

      expect(fallback.apply).toHaveBeenCalledWith(input);
      expect(compact).not.toHaveBeenCalled();
    });

    it('says why nothing happened without a fallback', async () => {
      const [strategy] = attached(onDemandCompaction({ compact: compactor() }));
      const input = inputOver(conversation(), { wire: undefined });

      const landed = await strategy.apply(input);

      expect(landed.meta.changed).toBe(false);
      expect(landed.meta.reason).toMatch(/no fallback strategy/);
    });

    it('compacts nothing of a window rewritten after the wire rendered it', async () => {
      const compact = compactor();
      const fallback: OverflowStrategy = { name: 'fallback', apply: vi.fn(declined) };
      const [strategy, runner] = attached(onDemandCompaction({ compact, fallback }));
      const history = conversation();
      const input = inputOver([...history], { wire: wireOver(history) });

      const landed = await strategy.apply(input);

      expect(compact).not.toHaveBeenCalled();
      expect(fallback.apply).not.toHaveBeenCalled();
      expect(landed.meta.changed).toBe(false);
      expect(landed.meta.reason).toMatch(/rewritten/);
      expect(runner.failures).toEqual([]);
    });
  });

  it('is named after its fallback, as server() is', () => {
    const compact = compactor();
    expect(onDemandCompaction({ compact }).name).toBe('onDemandCompaction');
    expect(onDemandCompaction({ compact, fallback: reset() }).name).toBe(
      'onDemandCompaction(fallback: reset)',
    );
  });
});

describe('signed strategies', () => {
  const od = () => onDemandCompaction({ compact: compactor() });

  it('marks onDemandCompaction() signed, and every combinator that only ever runs it', () => {
    expect(od().signed).toBe(true);
    expect(background(od()).signed).toBe(true);
    expect(chain(od(), background(od())).signed).toBe(true);
    expect(server(undefined, { fallback: od() }).signed).toBe(true);

    expect(chain(od(), reset()).signed).toBeUndefined();
    expect(server().signed).toBeUndefined();
    expect(background(summarize()).signed).toBeUndefined();
  });

  it('passes on the signed result a chain lands with no other step', async () => {
    const compact = compactor();
    const strategy = chain(onDemandCompaction({ compact }), reset());
    const input = inputOver(conversation(), {
      budget: { limit: 1000, current: 50, trigger: 1000, remaining: 950 },
    });

    const landed = await strategy.apply(input);

    expect(landed.meta.signed).toEqual({ request: input.wire?.renderPrefix(3) });
  });

  it.each([
    ['server() falling back to it', () => server(undefined, { fallback: od() })],
    [
      'it falling back to server()',
      () => onDemandCompaction({ compact: compactor(), fallback: server() }),
    ],
    ['both inside a chain', () => chain(summarize(), server(), background(od()))],
  ])('finds server() and onDemandCompaction() in one configuration: %s', (_, strategy) => {
    expect(combinesServerAndOnDemand(strategy())).toBe(true);
  });

  it.each([
    ['server() alone', () => server(undefined, { fallback: summarize() })],
    ['onDemandCompaction() alone', () => background(chain(od(), reset()))],
  ])('finds no conflict in %s', (_, strategy) => {
    expect(combinesServerAndOnDemand(strategy())).toBe(false);
  });
});

describe('background(onDemandCompaction())', () => {
  /** A compactor whose answers the test releases one by one. */
  const held = () => {
    const releases: Array<() => void> = [];
    let n = 0;
    const compact = vi.fn<OnDemandCompactor>(() => {
      const answer = { stop_reason: 'compaction', content: [block(++n)] };
      return new Promise((resolve) => releases.push(() => resolve(answer)));
    });
    const release = async () => {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { compact, release };
  };

  it('lands a finished job on the window it started on and what was appended since', async () => {
    const { compact, release } = held();
    const [strategy] = attached(background(onDemandCompaction({ compact })));
    const started = conversation();
    const grown = [...started, reply('a3', 'SIG_3'), user('q4')];

    const first = await strategy.apply(inputOver(started));
    await release();
    const landed = await strategy.apply(inputOver(grown));

    expect(first.meta.reason).toBe('background compression started');
    expect(landed.history).toEqual([anthropicCompactionMessage(block(1)), ...grown.slice(3)]);
    expect(landed.meta.strategy).toBe('background(onDemandCompaction)');
    expect(landed.meta.signed).toEqual({ request: requested(compact).payload });
  });

  it('drops a finished job once the window renders the request it signed otherwise', async () => {
    const { compact, release } = held();
    const [strategy, runner] = attached(background(onDemandCompaction({ compact })));
    const started = conversation();
    const grown = [...started, reply('a3', 'SIG_3'), user('q4')];

    await strategy.apply(inputOver(started));
    await release();
    // A system checkpoint since: the same messages, sent behind another system prompt.
    const after = await strategy.apply(
      inputOver(grown, { wire: wireOver(grown, 'You are terse. Answer in French.') }),
    );

    expect(after.meta.changed).toBe(false);
    expect(after.meta.reason).toBe('background compression started');
    expect(compact).toHaveBeenCalledTimes(2);
    // The job did its work, it just has nothing left to land on.
    expect(runner.successes).toBe(1);
  });

  it('drops a finished job offered a window the wire does not render', async () => {
    const { compact, release } = held();
    const [strategy] = attached(background(onDemandCompaction({ compact })));
    const started = conversation();
    const grown = [...started, reply('a3', 'SIG_3'), user('q4')];

    await strategy.apply(inputOver(started));
    await release();
    // An onBeforeCompress hook handed the runner a copy of the window it was given.
    const after = await strategy.apply(inputOver([...grown], { wire: wireOver(grown) }));

    expect(after.meta.changed).toBe(false);
  });

  it('requests the window it was handed again when a job it lands is still past the raw window', async () => {
    const { compact, release } = held();
    const [strategy, runner] = attached(background(onDemandCompaction({ compact })));
    const started = conversation();
    const grown = [...started, reply('a3', 'SIG_3'), user('q4'), reply('a4', 'SIG_4'), user('q5')];
    // The landed window [block, a2, q3, a3, q4, a4, q5] counts 70: past a raw window of 60.
    const past = inputOver(grown, {
      pastLimit: true,
      budget: { limit: 60, current: 90, trigger: 40, remaining: -50 },
    });

    await strategy.apply(inputOver(started));
    await release();
    const refit = strategy.apply(past);
    await release();
    const landed = await refit;

    // Only the window handed in has a wire to render it: the job's own head was never sent.
    expect(compact).toHaveBeenCalledTimes(2);
    expect(requested(compact, 2).payload).toEqual(past.wire?.renderPrefix(7));
    expect(landed.history).toEqual([anthropicCompactionMessage(block(2)), ...grown.slice(7)]);
    expect(landed.meta.signed).toEqual({ request: requested(compact, 2).payload });
    expect(landed.meta.strategy).toBe('background(onDemandCompaction)');
    expect(runner.successes).toBe(1);
  });
});
