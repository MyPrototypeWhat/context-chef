import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicAdapter,
  anthropicCompactionMessage,
  fromAnthropic,
} from '../adapters/anthropicAdapter';
import { OpenAIAdapter } from '../adapters/openAIAdapter';
import type { Message } from '../types';
import { anchored } from './anchored';
import { type BackgroundOverflowStrategy, background } from './background';
import { chain } from './chain';
import { reset } from './reset';
import { isServerStrategy, server } from './server';
import { summarize } from './summarize';
import { extractPinnedMessages, groupIntoTurns } from './turns';
import {
  type OverflowInput,
  type OverflowResult,
  type OverflowRunner,
  type OverflowStrategy,
  unchanged,
} from './types';

const tokenizer = (messages: Message[]): number => messages.length * 10;

const history = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `msg-${i + 1}`,
  }));

/** Over-budget input: 5 messages × 10 tokens against a trigger of 20. */
const makeInput = (overrides: Partial<OverflowInput> = {}): OverflowInput => {
  const messages = overrides.history ?? history(5);
  return {
    history: messages,
    budget: {
      limit: 30,
      current: tokenizer(messages),
      trigger: 20,
      remaining: 20 - tokenizer(messages),
    },
    tokenizer,
    pinned: [],
    window: { first: 'w_first', current: 'w_first' },
    ...overrides,
  };
};

/** A runner stub that records what the strategy reported. */
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

describe('summarize()', () => {
  const model = async () => '<summary>THE SUMMARY</summary>';

  it('replaces the old turns with the summary and reports what left', async () => {
    const [strategy] = attached(
      summarize({ compressionModel: model, split: 'recent-turns', preserveRecentMessages: 1 }),
    );
    const input = makeInput();

    const result = await strategy.apply(input);

    expect(result.meta.changed).toBe(true);
    expect(result.meta.strategy).toBe('summarize');
    expect(result.meta.windowId).toBe('w_first');
    expect(result.summary).toBe('THE SUMMARY');
    expect(result.history[0].content).toContain('THE SUMMARY');
    expect(result.history.at(-1)?.content).toBe('msg-5');
    expect(result.evicted.map((m) => m.content)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });

  it("the ratio split keeps as many recent turns as fit in the trigger's preserve budget", async () => {
    const [strategy] = attached(
      summarize({ compressionModel: model, split: 'ratio', preserveRatio: 0.5 }),
    );

    // preserveTarget = floor(20 × 0.5) = 10 → one 10-token turn survives.
    const result = await strategy.apply(makeInput());

    expect(result.evicted).toHaveLength(4);
    expect(result.history).toHaveLength(2);
  });

  it('re-inserts pinned messages verbatim and never evicts them', async () => {
    const messages = history(5);
    messages[1] = { ...messages[1], pinned: true };
    const [strategy] = attached(
      summarize({ compressionModel: model, split: 'recent-turns', preserveRecentMessages: 1 }),
    );

    const result = await strategy.apply(makeInput({ history: messages, pinned: [messages[1]] }));

    expect(result.history[1]).toBe(messages[1]);
    expect(result.evicted).not.toContain(messages[1]);
  });

  it('drops the span without a summary when no compressionModel is configured', async () => {
    const [strategy] = attached(summarize({ split: 'recent-turns' }));

    const result = await strategy.apply(makeInput());

    expect(result.meta.changed).toBe(true);
    expect(result.summary).toBeUndefined();
    expect(result.history.map((m) => m.content)).toEqual(['msg-5']);
  });

  it('leaves the breaker accounting to the runner on success', async () => {
    // The runner clears the count for any result that lands, so a successful
    // summary reports nothing — see Janitor.overflow().
    const [strategy, runner] = attached(
      summarize({ compressionModel: model, split: 'recent-turns', preserveRecentMessages: 1 }),
    );

    const result = await strategy.apply(makeInput());

    expect(result.meta.changed).toBe(true);
    expect(runner.successes).toBe(0);
    expect(runner.failures).toEqual([]);
  });

  it('reports a non-shrinking summary to the runner and leaves history alone', async () => {
    const long = [
      { role: 'user' as const, content: 'x'.repeat(3000) },
      { role: 'assistant' as const, content: 'answer' },
      { role: 'user' as const, content: 'next' },
    ];
    const [strategy, runner] = attached(
      summarize({
        compressionModel: async () => 'y'.repeat(3000),
        split: 'recent-turns',
        preserveRecentMessages: 1,
      }),
    );

    const result = await strategy.apply(makeInput({ history: long }));

    expect(result.meta.changed).toBe(false);
    expect(result.history).toBe(long);
    expect(runner.failures[0]).toContain('shrink guard');
  });

  it('reports a rejected summary and a throwing model to the runner', async () => {
    const [rejected, rejectedRunner] = attached(
      summarize({
        compressionModel: model,
        split: 'recent-turns',
        validateCompression: () => false,
      }),
    );
    const [thrown, thrownRunner] = attached(
      summarize({
        compressionModel: async () => {
          throw new Error('API down');
        },
        split: 'recent-turns',
      }),
    );

    expect((await rejected.apply(makeInput())).meta.changed).toBe(false);
    expect((await thrown.apply(makeInput())).meta.changed).toBe(false);
    expect(rejectedRunner.failures[0]).toContain('validateCompression');
    expect(thrownRunner.failures[0]).toContain('compression model failed');
  });

  it('spans the whole compressed range, pinned messages included', async () => {
    const messages = history(5);
    messages[1] = { ...messages[1], pinned: true };
    const [strategy] = attached(
      summarize({ compressionModel: model, split: 'recent-turns', preserveRecentMessages: 1 }),
    );

    const result = await strategy.apply(makeInput({ history: messages, pinned: [messages[1]] }));

    // `evicted` is what LEFT; `span` is what the summary now stands for.
    expect(result.evicted).toHaveLength(3);
    expect(result.span).toEqual(messages.slice(0, 4));
    expect(result.span).toContain(messages[1]);
  });

  it('folds every turn but the last one when the overflow was forced', async () => {
    const [strategy] = attached(
      // A preserve budget that would keep the whole history: a forced overflow
      // ignores it — the request is the model saying the work is finished.
      summarize({ compressionModel: model, split: 'ratio', preserveRatio: 100 }),
    );

    const idle = await strategy.apply(makeInput());
    expect(idle.meta.changed).toBe(false);

    const forced = await strategy.apply(makeInput({ forced: true }));

    expect(forced.meta.changed).toBe(true);
    expect(forced.history).toHaveLength(2);
    expect(forced.history.at(-1)?.content).toBe('msg-5');
    expect(forced.span).toHaveLength(4);
  });

  it('summarizes every turn, the last one included, when it collapses the window', async () => {
    const [strategy] = attached(
      summarize({ compressionModel: model, split: 'recent-turns', preserveRecentMessages: 3 }),
    );
    const input = makeInput({ collapse: true, forced: true });

    const result = await strategy.apply(input);

    expect(result.meta.changed).toBe(true);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].content).toContain('THE SUMMARY');
    expect(result.span).toEqual(input.history);
    expect(result.evicted).toEqual(input.history);
  });

  it('still puts pinned messages back after the summary when it collapses', async () => {
    const [strategy] = attached(summarize({ compressionModel: model }));
    const messages = history(5);
    messages[1] = { ...messages[1], pinned: true };

    const result = await strategy.apply(
      makeInput({ history: messages, pinned: [messages[1]], collapse: true }),
    );

    expect(result.history.slice(1)).toEqual([messages[1]]);
    expect(result.span).toEqual(messages);
  });

  it('keeps a tool call still waiting for its result when it collapses the window', async () => {
    const [strategy] = attached(summarize({ compressionModel: model }));
    const call: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } },
        { id: 't2', type: 'function', function: { name: 'search', arguments: '{}' } },
      ],
    };
    // One of its two results is in.
    const answered: Message = { role: 'tool', content: 'r1', tool_call_id: 't1' };
    const messages = [...history(3), call, answered];

    const result = await strategy.apply(makeInput({ history: messages, collapse: true }));

    expect(result.history.slice(1)).toEqual([call, answered]);
    expect(result.span).toEqual(history(3));
  });

  it('declines a forced overflow with only the pending turn in the window', async () => {
    const [strategy] = attached(summarize({ compressionModel: model }));

    const result = await strategy.apply(makeInput({ history: history(1), forced: true }));

    expect(result.meta.changed).toBe(false);
    expect(result.meta.reason).toContain('forced overflow');
  });

  it('changes nothing when the preserved tail already covers the whole history', async () => {
    const [strategy] = attached(
      summarize({ compressionModel: model, split: 'recent-turns', preserveRecentMessages: 10 }),
    );

    const result = await strategy.apply(makeInput());

    expect(result.meta.changed).toBe(false);
    expect(result.history).toEqual(history(5));
  });
});

describe('anchored()', () => {
  /** Captures the instruction the compression model was handed. */
  const capturingModel = (reply: () => string) => {
    const instructions: string[] = [];
    return {
      instructions,
      model: async (messages: Message[]) => {
        instructions.push(String(messages.at(-1)?.content));
        return reply();
      },
    };
  };

  it('merges each compression into the anchor document', async () => {
    let round = 0;
    const { instructions, model } = capturingModel(() => `<summary>ANCHOR-v${++round}</summary>`);
    const [strategy] = attached(anchored({ compressionModel: model, split: 'recent-turns' }));

    const first = await strategy.apply(makeInput());
    strategy.commit?.(first);
    const second = await strategy.apply(makeInput({ history: history(7) }));
    strategy.commit?.(second);

    expect(instructions[0]).toContain('No anchor document exists yet');
    expect(instructions[1]).toContain('ANCHOR-v1');
    // Both commits landed on the same fixture window, so the lineage holds one
    // anchor; `anchorDoc` is the flat projection the Janitor snapshot keeps.
    expect(strategy.snapshot?.()).toEqual({
      anchorDoc: 'ANCHOR-v2',
      anchors: { w_first: 'ANCHOR-v2' },
    });
  });

  it('leaves the anchor untouched until the result is committed', async () => {
    const { model } = capturingModel(() => '<summary>UNCOMMITTED</summary>');
    const [strategy] = attached(anchored({ compressionModel: model, split: 'recent-turns' }));

    await strategy.apply(makeInput());

    expect(strategy.snapshot?.()).toEqual({ anchorDoc: null, anchors: {} });
  });

  it('round-trips the anchor through snapshot/restore and clears on restore(undefined)', async () => {
    const { model } = capturingModel(() => '<summary>KEEP ME</summary>');
    const [strategy] = attached(anchored({ compressionModel: model, split: 'recent-turns' }));

    strategy.commit?.(await strategy.apply(makeInput()));
    const state = strategy.snapshot?.();

    strategy.restore?.(undefined);
    expect(strategy.snapshot?.()).toEqual({ anchorDoc: null, anchors: {} });

    strategy.restore?.(state);
    expect(strategy.snapshot?.()).toEqual({
      anchorDoc: 'KEEP ME',
      anchors: { w_first: 'KEEP ME' },
    });
  });

  it('keys the anchor by window, and adopts a pre-4.2 anchor into the live window', async () => {
    const { instructions, model } = capturingModel(() => '<summary>NEXT</summary>');
    const [strategy] = attached(anchored({ compressionModel: model, split: 'recent-turns' }));

    // A snapshot written before window ids existed carries a bare anchor.
    strategy.restore?.({ anchorDoc: 'LEGACY' });
    await strategy.apply(makeInput({ window: { first: 'w_a', current: 'w_b', previous: 'w_a' } }));

    expect(instructions[0]).toContain('LEGACY');
    expect(strategy.snapshot?.()).toEqual({ anchorDoc: 'LEGACY', anchors: { w_b: 'LEGACY' } });

    // A window with no anchor of its own starts from nothing — the adopted
    // legacy document belongs to w_b now.
    await strategy.apply(makeInput({ window: { first: 'w_a', current: 'w_c' } }));
    expect(instructions[1]).toContain('No anchor document exists yet');
  });
});

describe('reset()', () => {
  it('keeps only the pinned messages and evicts the rest', async () => {
    const messages = history(5);
    messages[1] = { ...messages[1], pinned: true };
    const [strategy] = attached(reset());

    const result = await strategy.apply(makeInput({ history: messages, pinned: [messages[1]] }));

    expect(result.meta.changed).toBe(true);
    expect(result.history).toHaveLength(2);
    expect(result.history[0].content).toContain('Context window reset');
    expect(result.history[1]).toBe(messages[1]);
    expect(result.evicted).toHaveLength(4);
    // The result names the window the strategy worked on; what the notice
    // says about it is reset.test.ts's contract.
    expect(result.meta.windowId).toBe('w_first');
  });

  it('keeps a tool call still waiting for its result when it collapses the window, and only then', async () => {
    const call: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }],
    };
    const messages = [...history(3), call];
    const [strategy] = attached(reset());

    const collapsed = await strategy.apply(makeInput({ history: messages, collapse: true }));
    const evicted = await strategy.apply(makeInput({ history: messages }));

    expect(collapsed.history.slice(1)).toEqual([call]);
    expect(collapsed.evicted).toEqual(history(3));
    expect(evicted.history).toHaveLength(1);
  });

  it('uses a caller notice verbatim', async () => {
    const [strategy] = attached(reset({ notice: 'Starting over.' }));

    const result = await strategy.apply(makeInput());

    expect(result.summary).toBe('Starting over.');
  });

  it('changes nothing when there is nothing but pinned messages', async () => {
    const messages = history(2).map((m) => ({ ...m, pinned: true }));
    const [strategy] = attached(reset());

    const result = await strategy.apply(makeInput({ history: messages, pinned: messages }));

    expect(result.meta.changed).toBe(false);
    expect(result.history).toBe(messages);
  });
});

describe('a compaction block the window opens with', () => {
  const model = async () => '<summary>THE SUMMARY</summary>';
  // The block a resumed Anthropic session opens with, pinned as fromAnthropic parses it, and a
  // pinned question after it: q3 is the turn kept.
  const opened = (): Message[] => {
    const messages = [
      anthropicCompactionMessage({ type: 'compaction', content: 'EARLIER', signature: 'SIG_0' }),
      ...history(5),
    ];
    messages[3] = { ...messages[3], pinned: true };
    return messages;
  };

  it.each([
    ['summarize()', () => summarize({ compressionModel: model, split: 'recent-turns' })],
    ['anchored()', () => anchored({ compressionModel: model, split: 'recent-turns' })],
  ])('stays first: %s puts its summary after it, and the other pinned messages after that', async (_, build) => {
    const [strategy] = attached(build());
    const messages = opened();

    const result = await strategy.apply(
      makeInput({ history: messages, pinned: extractPinnedMessages(messages) }),
    );

    expect(result.history.map((m) => m.content)).toEqual([
      '',
      result.history[1].content,
      'msg-3',
      'msg-5',
    ]);
    expect(result.history[0]).toBe(messages[0]);
    expect(result.history[1].content).toContain('THE SUMMARY');
  });

  it.each([
    ['reset()', () => reset(), {}],
    ['summarize() collapsing without a model', () => summarize(), { collapse: true as const }],
  ])('stays first: %s puts its notice after it', async (_, build, overrides) => {
    const [strategy] = attached(build());
    const messages = opened();

    const result = await strategy.apply(
      makeInput({ history: messages, pinned: extractPinnedMessages(messages), ...overrides }),
    );

    expect(result.history[0]).toBe(messages[0]);
    expect(result.history[1].content).toContain('Context window reset');
    expect(result.history.slice(2)).toEqual([messages[3]]);
  });

  /** [placeholder, block] as fromAnthropic resumes a block, then `rest`. */
  const opening = (...rest: Message[]): Message[] => [
    ...fromAnthropic([
      {
        role: 'assistant',
        content: [{ type: 'compaction', content: 'EARLIER', signature: 'SIG_0' }],
      },
    ] as unknown as MessageParam[]).history,
    ...rest,
  ];
  const waiting: Message = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 't1', type: 'function', function: { name: 's', arguments: '{}' } }],
  };

  it.each([
    [
      'summarize(), recent turns',
      () => summarize({ compressionModel: model, preserveRecentMessages: 4 }),
      opening(...history(3)),
      {},
    ],
    [
      'anchored(), recent turns',
      () => anchored({ compressionModel: model, split: 'recent-turns', preserveRecentMessages: 4 }),
      opening(...history(3)),
      {},
    ],
    [
      'summarize(), ratio',
      () => summarize({ compressionModel: model, preserveRatio: 1 }),
      opening(...history(1)),
      {},
    ],
    [
      'summarize(), forced',
      () => summarize({ compressionModel: model }),
      opening(...history(1)),
      { forced: true },
    ],
    [
      'summarize(), collapsing up to a call waiting for its result',
      () => summarize({ compressionModel: model }),
      opening(waiting),
      { collapse: true as const },
    ],
    [
      'summarize(), a block with no placeholder',
      () => summarize({ compressionModel: model, preserveRecentMessages: 2 }),
      opening(...history(2)).slice(1),
      {},
    ],
  ])('compresses nothing when its split falls in or right after the block the window opens with: %s', async (_, build, messages, overrides) => {
    const [strategy] = attached(build());

    const result = await strategy.apply(
      makeInput({ history: messages, pinned: extractPinnedMessages(messages), ...overrides }),
    );

    expect(result.meta.changed).toBe(false);
    expect(result.history).toBe(messages);
  });

  it('keeps the pair whole for reset(), which compresses around pinned messages', async () => {
    const [strategy] = attached(reset());
    const messages = opening(...history(2));

    const result = await strategy.apply(
      makeInput({ history: messages, pinned: extractPinnedMessages(messages) }),
    );

    expect(result.history.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(result.history[2].content).toContain('Context window reset');
    expect(result.history).toHaveLength(3);
  });

  it.each([
    ['summarize()', () => summarize({ compressionModel: model, split: 'recent-turns' }), 'SUMMARY'],
    ['anchored()', () => anchored({ compressionModel: model, split: 'recent-turns' }), 'SUMMARY'],
    ['reset()', () => reset(), 'Context window reset'],
  ])('keeps the opening user turn fromAnthropic puts before it, so text targets still open with one: %s', async (_, build, said) => {
    const block = { type: 'compaction', content: 'EARLIER', signature: 'SIG_0' };
    const { history: resumed } = fromAnthropic([
      { role: 'assistant', content: [block] },
    ] as unknown as MessageParam[]);
    const [strategy] = attached(build());
    const messages = [...resumed, ...history(5)];

    const result = await strategy.apply(
      makeInput({ history: messages, pinned: extractPinnedMessages(messages) }),
    );

    expect(result.history[0]).toBe(messages[0]);
    expect(result.history[1]).toBe(messages[1]);
    expect(result.history[2].content).toContain(said === 'SUMMARY' ? 'THE SUMMARY' : said);
    expect(result.evicted).not.toContain(messages[0]);
    expect(new OpenAIAdapter().compile(result.history).messages[0].role).toBe('user');
    // The Anthropic target skips it: the block is still the first message it sends.
    expect(new AnthropicAdapter().compile(result.history).messages[0]).toEqual({
      role: 'assistant',
      content: [block],
    });
  });
});

describe('server()', () => {
  it('is recognisable to the pipeline and carries its provider config', () => {
    const strategy = server({ edits: [{ type: 'compact_20260112' }] });

    expect(isServerStrategy(strategy)).toBe(true);
    expect(strategy.config).toEqual({ edits: [{ type: 'compact_20260112' }] });
    expect(isServerStrategy(reset())).toBe(false);
  });

  it('runs its fallback when it is applied at all — apply only happens off a server-managed target', async () => {
    const strategy = server(undefined, { fallback: reset() });

    const result = await strategy.apply(makeInput());

    expect(result.meta.changed).toBe(true);
    expect(result.meta.strategy).toBe('reset');
  });

  it('leaves history alone with a reason when no fallback is configured', async () => {
    const result = await server().apply(makeInput());

    expect(result.meta.changed).toBe(false);
    expect(result.meta.reason).toContain('no server-side context management');
  });
});

describe('chain()', () => {
  it('runs only the steps with a result waiting on a call made just to land it', async () => {
    const model = vi.fn(async () => '<summary>NEW</summary>');
    const landing: OverflowStrategy = {
      name: 'landing',
      pending: () => true,
      apply: vi.fn(async (input: OverflowInput) => {
        const span = input.history.slice(0, -1);
        return {
          history: input.history.slice(-1),
          evicted: span,
          span,
          meta: { strategy: 'landing', windowId: input.window.current, changed: true },
        };
      }),
    };
    const [strategy] = attached(
      chain(summarize({ compressionModel: model, split: 'recent-turns' }), landing),
    );

    const landed = await strategy.apply(makeInput({ pendingOnly: true }));

    expect(model).not.toHaveBeenCalled();
    expect(landing.apply).toHaveBeenCalledTimes(1);
    expect(landed.history.map((m) => m.content)).toEqual(['msg-5']);
  });

  it('escalates to the next strategy when the first one declines', async () => {
    const long = [
      { role: 'user' as const, content: 'x'.repeat(3000) },
      { role: 'assistant' as const, content: 'answer' },
      { role: 'user' as const, content: 'next' },
    ];
    // An echo model never shrinks, so the shrink guard rejects it.
    const strategy = chain(
      summarize({
        compressionModel: async () => 'y'.repeat(3000),
        split: 'recent-turns',
        preserveRecentMessages: 1,
      }),
      reset(),
    );
    const [attachedChain, runner] = attached(strategy);

    const result = await attachedChain.apply(makeInput({ history: long }));

    expect(runner.failures[0]).toContain('shrink guard');
    expect(result.meta.changed).toBe(true);
    expect(result.meta.strategy).toBe('chain(summarize>reset)');
    expect(result.history[0].content).toContain('Context window reset');
    expect(result.evicted).toHaveLength(3);
  });

  it('stops at the first strategy that brings the window under the trigger', async () => {
    const later = vi.fn();
    const strategy = chain(
      summarize({
        compressionModel: async () => '<summary>S</summary>',
        split: 'recent-turns',
        preserveRecentMessages: 1,
      }),
      { name: 'never', apply: later as never },
    );
    const [attachedChain] = attached(strategy);

    // 5 messages → summary + 1 kept = 20 tokens, exactly the trigger.
    const result = await attachedChain.apply(makeInput());

    expect(later).not.toHaveBeenCalled();
    expect(result.history).toHaveLength(2);
  });

  it('unions the spans of every step that ran', async () => {
    const messages = history(5);
    messages[1] = { ...messages[1], pinned: true };
    const strategy = chain(
      summarize({
        compressionModel: async () => '<summary>S</summary>',
        split: 'recent-turns',
        preserveRecentMessages: 2,
      }),
      reset(),
    );
    const [attachedChain] = attached(strategy);

    const result = await attachedChain.apply(
      makeInput({ history: messages, pinned: [messages[1]] }),
    );

    // The pinned message survived both steps, so it never shows up in
    // `evicted` — but the summary and then the reset notice both stand for it.
    expect(result.evicted).not.toContain(messages[1]);
    expect(result.span).toContain(messages[1]);
    expect(result.span.slice(0, 3)).toEqual(messages.slice(0, 3));
    // Every message is counted once, however many steps compressed it.
    expect(new Set(result.span).size).toBe(result.span.length);
  });

  it.each([
    ['changes nothing', false],
    ['changes the window too', true],
  ])('passes on a partial step when the step after it %s', async (_, changes) => {
    // Drops the oldest message, but a step it needed failed.
    const partial: OverflowStrategy = {
      name: 'partial',
      async apply(input) {
        const [oldest, ...rest] = input.history;
        return {
          history: rest,
          evicted: [oldest],
          span: [oldest],
          meta: {
            strategy: 'partial',
            windowId: input.window.current,
            changed: true,
            partial: true,
          },
        };
      },
    };
    const declines: OverflowStrategy = {
      name: 'declines',
      apply: async (input) => unchanged(input, 'declines', 'nothing to do'),
    };
    const [strategy] = attached(chain(partial, changes ? reset() : declines));

    // 4 messages after the first step are still over the trigger of 20: the second step runs.
    const result = await strategy.apply(makeInput());

    expect(result.meta).toMatchObject({ changed: true, partial: true });
  });

  it.each([
    ['without appendOnly', {}],
    ['under appendOnly', { appendOnly: true as const }],
  ])('keeps for the next step what a landed job put back as pinned, though the host handed in copies (%s)', async (_, mode) => {
    const inBackground = background(
      summarize({
        compressionModel: async () => '<summary>S1</summary>',
        split: 'recent-turns',
        preserveRecentMessages: 1,
      }),
    );
    const [strategy] = attached(chain(inBackground, reset()));
    const source: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2', pinned: true },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
    ];
    await strategy.apply(
      makeInput({ history: source, pinned: extractPinnedMessages(source), ...mode }),
    );
    await vi.waitFor(() => {
      if (!inBackground.pendingJob?.settled) throw new Error('not settled');
    });

    // The job lands [S1, q2, q3, a3, q4], its q2 the object it read, not the host's copy. That
    // is still over the trigger, so reset() runs on it.
    const current: Message[] = [
      ...source.map((message) => ({ ...message })),
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'q4' },
    ];
    const result = await strategy.apply(
      makeInput({ history: current, pinned: extractPinnedMessages(current), ...mode }),
    );

    expect(result.meta.strategy).toBe('chain(background(summarize)>reset)');
    expect(result.history[0].content).toContain('Context window reset');
    expect(result.history.slice(1).map((message) => message.content)).toEqual(['q2']);
  });

  it('keeps a message the caller pinned for the next step, though nothing flags it', async () => {
    // Drops the oldest message it was not asked to keep.
    const dropOne: OverflowStrategy = {
      name: 'drop-one',
      async apply(input) {
        const kept = new Set(input.pinned);
        const dropped = input.history.find((message) => !kept.has(message)) as Message;
        return {
          history: input.history.filter((message) => message !== dropped),
          evicted: [dropped],
          span: [dropped],
          meta: { strategy: 'drop-one', windowId: input.window.current, changed: true },
        };
      },
    };
    const [strategy] = attached(chain(dropOne, reset()));
    const messages = history(5);

    // 4 messages after the first step are still over the trigger of 20: reset() runs.
    const result = await strategy.apply(makeInput({ history: messages, pinned: [messages[4]] }));

    expect(result.history[0].content).toContain('Context window reset');
    expect(result.history.slice(1)).toEqual([messages[4]]);
  });
});

describe('background()', () => {
  const settled = (strategy: BackgroundOverflowStrategy) =>
    vi.waitFor(() => {
      if (!strategy.pendingJob?.settled) throw new Error('not settled');
    });

  const inner = () =>
    summarize({
      compressionModel: async () => '<summary>BG</summary>',
      split: 'recent-turns',
      preserveRecentMessages: 1,
    });

  it('starts a job on the first call and swaps the result in on a later one', async () => {
    const [strategy] = attached(background(inner()));
    const messages = history(5);

    const first = await strategy.apply(makeInput({ history: messages }));
    expect(first.meta.changed).toBe(false);
    expect(first.history).toBe(messages);

    await settled(strategy);
    const second = await strategy.apply(makeInput({ history: messages }));

    expect(second.meta.changed).toBe(true);
    expect(second.history[0].content).toContain('BG');
    expect(second.history.at(-1)?.content).toBe('msg-5');
  });

  it('discard() drops a finished job unlanded, crediting nothing', async () => {
    const [strategy, runner] = attached(background(inner()));
    const messages = history(5);

    await strategy.apply(makeInput({ history: messages }));
    await settled(strategy);
    strategy.discard?.();

    expect(strategy.pending?.()).toBe(false);
    expect(strategy.pendingJob).toBeUndefined();
    expect(runner.successes).toBe(0);
  });

  it.each([
    ['collapse', { collapse: true as const }],
    ['pastLimit', { pastLimit: true as const }],
  ])('lands the job as it is on a call made only to land it, %s or not', async (_, where) => {
    const model = vi.fn(async () => '<summary>BG</summary>');
    const [strategy] = attached(
      background(
        summarize({ compressionModel: model, split: 'recent-turns', preserveRecentMessages: 1 }),
      ),
    );

    await strategy.apply(makeInput({ history: history(5) }));
    await settled(strategy);
    // Past an open breaker: the landed window [BG, msg-5, …, msg-9] is past the raw window
    // of 30, but nothing new may run — neither the collapse nor the refit.
    const landed = await strategy.apply(
      makeInput({ history: history(9), pendingOnly: true, ...where }),
    );

    expect(model).toHaveBeenCalledTimes(1);
    expect(landed.history.map((m) => m.content).slice(1)).toEqual([
      'msg-5',
      'msg-6',
      'msg-7',
      'msg-8',
      'msg-9',
    ]);
  });

  it('starts nothing on a call made only to land a job that no longer applies', async () => {
    const model = vi.fn(async () => '<summary>BG</summary>');
    const [strategy, runner] = attached(
      background(summarize({ compressionModel: model, split: 'recent-turns' })),
    );

    await strategy.apply(makeInput({ history: history(5) }));
    await settled(strategy);
    // Over the trigger, but the runner called past an open breaker only to land the job.
    const after = await strategy.apply(
      makeInput({ history: history(6).reverse(), pendingOnly: true }),
    );

    expect(after.meta.changed).toBe(false);
    expect(strategy.pendingJob).toBeUndefined();
    expect(model).toHaveBeenCalledTimes(1);
    expect(runner.successes).toBe(1);
  });

  it('rebases the swap onto turns that arrived while the job ran', async () => {
    const [strategy] = attached(background(inner()));

    await strategy.apply(makeInput({ history: history(5) }));
    await settled(strategy);
    const result = await strategy.apply(makeInput({ history: history(7) }));

    expect(result.history[0].content).toContain('BG');
    expect(result.history.slice(1).map((m) => m.content)).toEqual(['msg-5', 'msg-6', 'msg-7']);
  });

  it('discards a stale result and starts a fresh job instead', async () => {
    const [strategy] = attached(background(inner()));

    await strategy.apply(makeInput({ history: history(5) }));
    await settled(strategy);

    const edited = history(5);
    edited[0] = { ...edited[0], content: 'edited-msg-1' };
    const result = await strategy.apply(makeInput({ history: edited }));

    expect(result.meta.changed).toBe(false);
    expect(result.history).toBe(edited);
    expect(strategy.pendingJob).toBeDefined();
  });

  it('never lets a discarded job touch the anchor document', async () => {
    let round = 0;
    const strategy = background(
      anchored({
        compressionModel: async () => `<summary>ANCHOR-v${++round}</summary>`,
        split: 'recent-turns',
        preserveRecentMessages: 1,
      }),
    ) as BackgroundOverflowStrategy;
    attached(strategy);

    await strategy.apply(makeInput({ history: history(5) }));
    await settled(strategy);
    expect(strategy.snapshot?.()).toEqual({ anchorDoc: null, anchors: {} });

    const edited = history(5);
    edited[0] = { ...edited[0], content: 'edited-msg-1' };
    await strategy.apply(makeInput({ history: edited }));

    expect(strategy.snapshot?.()).toEqual({ anchorDoc: null, anchors: {} });
  });

  it('commits the inner strategy only for the result that entered the window', async () => {
    const strategy = background(
      anchored({
        compressionModel: async () => '<summary>APPLIED</summary>',
        split: 'recent-turns',
        preserveRecentMessages: 1,
      }),
    ) as BackgroundOverflowStrategy;
    attached(strategy);
    const messages = history(5);

    await strategy.apply(makeInput({ history: messages }));
    await settled(strategy);
    const swapped: OverflowResult = await strategy.apply(makeInput({ history: messages }));
    strategy.commit?.(swapped);

    expect(strategy.snapshot?.()).toEqual({
      anchorDoc: 'APPLIED',
      anchors: { w_first: 'APPLIED' },
    });
  });

  it('drops a pending job on restore', async () => {
    const strategy = background(
      summarize({ compressionModel: () => new Promise<string>(() => {}), split: 'recent-turns' }),
    );
    attached(strategy);

    await strategy.apply(makeInput());
    expect(strategy.pendingJob).toBeDefined();

    strategy.restore?.(undefined);
    expect(strategy.pendingJob).toBeUndefined();
  });
});

describe("appendOnly: the chef's events in the window", () => {
  const model = async () => '<summary>THE SUMMARY</summary>';
  const user = (content: string): Message => ({ role: 'user', content });
  const reply = (content: string): Message => ({ role: 'assistant', content });
  const call = (...ids: string[]): Message => ({
    role: 'assistant',
    content: '',
    tool_calls: ids.map((id) => ({
      id,
      type: 'function' as const,
      function: { name: 'search', arguments: '{}' },
    })),
  });
  const result = (id: string): Message => ({ role: 'tool', content: `r-${id}`, tool_call_id: id });
  /** The two kinds of message the prefix ledger renders: a user event, a positional system one. */
  const event = (content: string): Message => ({ role: 'user', content, _chef_event: true });
  const systemEvent = (content: string): Message => ({
    role: 'system',
    content,
    _positional: true,
    _chef_event: true,
  });
  const spans = (messages: Message[]) =>
    groupIntoTurns(messages).map(({ startIndex, endIndex }) => [startIndex, endIndex]);
  const keepLast = (turns: number) =>
    summarize({ compressionModel: model, split: 'recent-turns', preserveRecentMessages: turns });

  describe('groupIntoTurns()', () => {
    it('puts an event in the turn it follows, and leaves a host system message a turn of its own', () => {
      const messages: Message[] = [
        user('q1'),
        event('state 1'),
        systemEvent('docs'),
        call('c1'),
        result('c1'),
        event('state 2'),
        reply('a2'),
        user('q3'),
        { role: 'system', content: 'The host wrote this.', _positional: true },
        reply('a3'),
      ];

      expect(spans(messages)).toEqual([
        [0, 3],
        [3, 6],
        [6, 7],
        [7, 8],
        [8, 9],
        [9, 10],
      ]);
    });

    it('keeps a tool result after an event with its call, and an event that opens the window on its own', () => {
      const messages = [
        event('state 1'),
        call('c1', 'c2'),
        result('c1'),
        event('state 2'),
        result('c2'),
        systemEvent('docs'),
      ];

      expect(spans(messages)).toEqual([
        [0, 1],
        [1, 6],
      ]);
    });
  });

  describe('where a strategy cuts', () => {
    it.each([
      ['the last turn', {}],
      ['a forced overflow', { forced: true }],
    ])('keeps the pending question with the event after it (%s)', async (_, options) => {
      const [strategy] = attached(keepLast(1));
      const messages = [user('q1'), reply('a1'), user('q2'), event('state')];

      const kept = await strategy.apply(makeInput({ history: messages, ...options }));

      expect(kept.history.slice(1)).toEqual(messages.slice(2));
      expect(kept.span).toEqual(messages.slice(0, 2));
    });

    it('never starts the kept turns with an event', async () => {
      const [strategy] = attached(keepLast(3));
      const messages = [
        user('q1'),
        event('state'),
        reply('a1'),
        user('q2'),
        systemEvent('docs'),
        reply('a2'),
        user('q3'),
      ];

      const kept = await strategy.apply(makeInput({ history: messages }));

      // The last 3 turns are [q2, docs], a2 and q3.
      expect(kept.history.slice(1)).toEqual(messages.slice(3));
      expect(kept.span).toEqual(messages.slice(0, 3));
    });

    it.each([
      ['summarize()', () => summarize({ compressionModel: model })],
      ['reset()', () => reset()],
    ])('%s keeps a tool call waiting for its result with the event after it when it collapses', async (_, make) => {
      const [strategy] = attached(make());
      const messages = [user('q1'), reply('a1'), user('q2'), call('c1'), event('state')];

      const collapsed = await strategy.apply(makeInput({ history: messages, collapse: true }));

      expect(collapsed.history.slice(1)).toEqual(messages.slice(3));
      expect(collapsed.span).toEqual(messages.slice(0, 3));
    });

    it('puts a pinned turn back without the events after it, which the ledger states again', async () => {
      const [strategy] = attached(keepLast(1));
      const pinned: Message = { ...user('q1'), pinned: true };
      const messages = [pinned, event('state'), reply('a1'), user('q2')];

      const kept = await strategy.apply(
        makeInput({ history: messages, pinned: extractPinnedMessages(messages) }),
      );

      expect(kept.history.slice(1)).toEqual([pinned, messages[3]]);
      expect(kept.evicted).toEqual(messages.slice(1, 3));
    });
  });

  describe('background()', () => {
    const settled = (strategy: BackgroundOverflowStrategy) =>
      vi.waitFor(() => {
        if (!strategy.pendingJob?.settled) throw new Error('not settled');
      });
    const inBackground = () => background(keepLast(1));
    // 7 messages against a trigger of 20: over budget. The job keeps q3.
    const source = [
      user('q1'),
      event('state 1'),
      reply('a1'),
      user('q2'),
      event('state 2'),
      reply('a2'),
      user('q3'),
    ];
    /** The window compiled again: the ledger renders its events anew. */
    const again = (messages: Message[]) =>
      messages.map((message) => (message._chef_event ? { ...message } : message));

    it('lands a job once the window only grew at its end, keeping the turns that arrived', async () => {
      const [strategy] = attached(inBackground());
      await strategy.apply(makeInput({ history: source, appendOnly: true }));
      await settled(strategy);

      const arrived = [event('state 3'), reply('a3'), user('q4')];
      const current = [...again(source), ...arrived];
      const landed = await strategy.apply(makeInput({ history: current, appendOnly: true }));

      expect(landed.meta.changed).toBe(true);
      expect(landed.history[0].content).toContain('THE SUMMARY');
      expect(landed.history.slice(1)).toEqual(current.slice(6));
      expect(landed.history[1]).toBe(current[6]);
    });

    it.each([
      ['it summarized', 3],
      ['it kept', 6],
    ])('drops a job once a message %s changed, and starts another', async (_, index) => {
      const [strategy] = attached(inBackground());
      await strategy.apply(makeInput({ history: source, appendOnly: true }));
      await settled(strategy);

      const current = [...again(source), reply('a3'), user('q4')];
      current[index] = { ...current[index], content: 'edited' };
      const stale = await strategy.apply(makeInput({ history: current, appendOnly: true }));

      expect(stale.meta.changed).toBe(false);
      expect(stale.history).toBe(current);
      expect(strategy.pendingJob?.settled).toBe(false);
    });

    it.each([
      ['a cache breakpoint', { _cache_breakpoint: true }],
      ['host metadata', { trace: 'request-7' }],
    ])('lands a job however the host moved %s, which no provider is sent', async (_, field) => {
      const [strategy] = attached(inBackground());
      // The host puts it on a copy of the newest message, every compile.
      await strategy.apply(
        makeInput({
          history: [...source.slice(0, 6), { ...source[6], ...field }],
          appendOnly: true,
        }),
      );
      await settled(strategy);

      const current = [...again(source), reply('a3'), { ...user('q4'), ...field }];
      const landed = await strategy.apply(makeInput({ history: current, appendOnly: true }));

      expect(landed.meta.changed).toBe(true);
      expect(landed.history.slice(1)).toEqual(current.slice(6));
    });

    it('lands a job whose kept turn was pinned since: nothing it summarized changed', async () => {
      const [strategy] = attached(inBackground());
      await strategy.apply(makeInput({ history: source, appendOnly: true }));
      await settled(strategy);

      const current = [...again(source), reply('a3'), user('q4')];
      current[6] = { ...current[6], pinned: true };
      const landed = await strategy.apply(
        makeInput({ history: current, appendOnly: true, pinned: extractPinnedMessages(current) }),
      );

      expect(landed.meta.changed).toBe(true);
      expect(landed.history.slice(1)).toEqual(current.slice(6));
    });

    it('drops a job once a message it summarized was pinned since', async () => {
      const [strategy] = attached(inBackground());
      await strategy.apply(makeInput({ history: source, appendOnly: true }));
      await settled(strategy);

      const current = [...again(source), reply('a3'), user('q4')];
      current[3] = { ...current[3], pinned: true };
      const stale = await strategy.apply(
        makeInput({ history: current, appendOnly: true, pinned: extractPinnedMessages(current) }),
      );

      expect(stale.meta.changed).toBe(false);
    });

    it('drops a job once a message it summarized was pinned in place since', async () => {
      const [strategy] = attached(inBackground());
      const messages = source.map((message) => ({ ...message }));
      await strategy.apply(makeInput({ history: messages, appendOnly: true }));
      await settled(strategy);

      // The host sets the flag on the very object the job read.
      messages[3].pinned = true;
      const current = [...messages, reply('a3'), user('q4')];
      const stale = await strategy.apply(
        makeInput({ history: current, appendOnly: true, pinned: extractPinnedMessages(current) }),
      );

      expect(stale.meta.changed).toBe(false);
    });

    it.each([
      ['it summarized', 3],
      ['it kept', 6],
    ])('drops a job once the host edited a message %s in place since', async (_, index) => {
      const [strategy] = attached(inBackground());
      const messages = source.map((message) => ({ ...message }));
      await strategy.apply(makeInput({ history: messages, appendOnly: true }));
      await settled(strategy);

      // The very object the job read now says something else.
      messages[index].content = 'edited';
      const stale = await strategy.apply(
        makeInput({ history: [...messages, reply('a3'), user('q4')], appendOnly: true }),
      );

      expect(stale.meta.changed).toBe(false);
    });

    it('lands a job on a window the host built anew with every message the same', async () => {
      const [strategy] = attached(inBackground());
      await strategy.apply(makeInput({ history: source, appendOnly: true }));
      await settled(strategy);

      const current = structuredClone([...source, reply('a3'), user('q4')]);
      const landed = await strategy.apply(makeInput({ history: current, appendOnly: true }));

      expect(landed.meta.changed).toBe(true);
      expect(landed.history.slice(1)).toEqual(current.slice(6));
    });

    describe('when the request is past the raw context window (pastLimit)', () => {
      const pastLimit = (messages: Message[]) =>
        makeInput({ history: messages, appendOnly: true, pastLimit: true });

      it('runs the inner strategy now instead of starting a job', async () => {
        const [strategy] = attached(inBackground());

        const now = await strategy.apply(pastLimit(source));

        expect(now.meta).toMatchObject({ changed: true, strategy: 'background(summarize)' });
        expect(now.history.slice(1)).toEqual([source[6]]);
        expect(strategy.pendingJob).toBeUndefined();
      });

      it('runs the inner strategy now instead of waiting for the job in flight, which it drops', async () => {
        const compressionModel = vi
          .fn<(messages: Message[]) => Promise<string>>()
          .mockImplementationOnce(() => new Promise<string>(() => {}))
          .mockResolvedValue('<summary>NOW</summary>');
        const [strategy] = attached(
          background(
            summarize({ compressionModel, split: 'recent-turns', preserveRecentMessages: 1 }),
          ),
        );
        await strategy.apply(makeInput({ history: source, appendOnly: true }));

        const current = [...again(source), reply('a3'), user('q4')];
        const now = await strategy.apply(pastLimit(current));

        expect(now.history[0].content).toContain('NOW');
        expect(now.history.slice(1)).toEqual([current[8]]);
        expect(strategy.pendingJob).toBeUndefined();
      });

      it('runs the inner strategy now in place of a stale job, credited once, whatever the runner read', async () => {
        const [strategy, runner] = attached(inBackground());
        await strategy.apply(makeInput({ history: source, appendOnly: true }));
        await settled(strategy);

        const current = [...again(source), reply('a3'), user('q4')];
        current[3] = { ...current[3], content: 'edited' };
        // The runner's own reading, an earlier report, is under the trigger.
        const now = await strategy.apply({
          ...pastLimit(current),
          budget: { limit: 30, current: 10, trigger: 20, remaining: 10 },
        });

        expect(now.meta.changed).toBe(true);
        expect(now.span).toContain(current[3]);
        expect(runner.successes).toBe(1);
        expect(strategy.pendingJob).toBeUndefined();
      });

      it('lands a finished job that applies as it is when its window fits: its summary is paid for', async () => {
        const [strategy] = attached(inBackground());
        await strategy.apply(makeInput({ history: source, appendOnly: true }));
        await settled(strategy);

        // [summary, q3, a3, q4] is 40 tokens against a raw window of 50.
        const current = [...again(source), reply('a3'), user('q4')];
        const landed = await strategy.apply({
          ...pastLimit(current),
          budget: { limit: 50, current: 90, trigger: 20, remaining: -70 },
        });

        expect(landed.history.slice(1)).toEqual(current.slice(6));
      });

      it('runs the inner strategy on the window a finished job leaves when that is still past it', async () => {
        let round = 0;
        const committed: Array<string | undefined> = [];
        const summarizing = summarize({
          compressionModel: async () => `<summary>S${++round}</summary>`,
          split: 'recent-turns',
          preserveRecentMessages: 1,
        });
        const [strategy] = attached(
          background({
            name: 'spy',
            apply: (input) => summarizing.apply(input),
            commit: (result) => {
              committed.push(result.summary);
            },
          }),
        );
        await strategy.apply(makeInput({ history: source, appendOnly: true }));
        await settled(strategy);

        // The job leaves [S1, q3, a3, q4, a4, q5]: 60 tokens against a raw window of 30.
        const current = [...again(source), reply('a3'), user('q4'), reply('a4'), user('q5')];
        const fitted = await strategy.apply(pastLimit(current));
        strategy.commit?.(fitted);

        expect(fitted.meta).toMatchObject({ changed: true, strategy: 'background(spy)' });
        expect(fitted.summary).toBe('S2');
        expect(fitted.history.slice(1)).toEqual([current[10]]);
        expect(fitted.span.slice(0, 6)).toEqual(source.slice(0, 6));
        expect(fitted.span.slice(-4)).toEqual(current.slice(6, 10));
        expect(committed).toEqual(['S1', 'S2']);
      });

      it.each([
        [
          'summarize()',
          () => {
            let round = 0;
            return summarize({
              compressionModel: async () => `<summary>S${++round}</summary>`,
              split: 'recent-turns',
              preserveRecentMessages: 1,
            });
          },
          ['q2', 'q5'],
        ],
        ['reset()', () => reset(), ['q2']],
      ])('keeps through a %s refit what the job put back as pinned, whatever objects the host handed in', async (_, make, kept) => {
        const [strategy] = attached(background(make()));
        const pinned = [
          user('q1'),
          reply('a1'),
          { ...user('q2'), pinned: true },
          reply('a2'),
          user('q3'),
        ];
        await strategy.apply(
          makeInput({ history: pinned, appendOnly: true, pinned: extractPinnedMessages(pinned) }),
        );
        await settled(strategy);

        // The host builds every message anew for this request; the job leaves 6 or 7 of them,
        // past a raw window of 30 tokens.
        const current = [
          ...pinned.map((message) => ({ ...message })),
          reply('a3'),
          user('q4'),
          reply('a4'),
          user('q5'),
        ];
        const fitted = await strategy.apply({
          ...pastLimit(current),
          pinned: extractPinnedMessages(current),
        });

        expect(fitted.history.slice(1).map((message) => message.content)).toEqual(kept);
      });

      it('lands a job whose refit fails as partial, the failure still counted', async () => {
        const compressionModel = vi
          .fn<(messages: Message[]) => Promise<string>>()
          .mockResolvedValueOnce('<summary>S1</summary>')
          .mockRejectedValue(new Error('model down'));
        const [strategy, runner] = attached(
          background(
            summarize({ compressionModel, split: 'recent-turns', preserveRecentMessages: 1 }),
          ),
        );
        await strategy.apply(makeInput({ history: source, appendOnly: true }));
        await settled(strategy);

        const current = [...again(source), reply('a3'), user('q4'), reply('a4'), user('q5')];
        const landed = await strategy.apply(pastLimit(current));

        expect(landed.meta).toMatchObject({ changed: true, partial: true });
        expect(landed.history.slice(1)).toEqual(current.slice(6));
        expect(runner.failures).toEqual(['compression model failed']);
      });
    });

    it('still compares only the ends of the span it summarized without appendOnly (4.x)', async () => {
      const [strategy] = attached(inBackground());
      await strategy.apply(makeInput({ history: history(7) }));
      await settled(strategy);

      // The job kept msg-7: msg-1 and msg-6 are the ends of its span.
      const current = history(9);
      current[3] = { ...current[3], content: 'edited' };
      const landed = await strategy.apply(makeInput({ history: current }));

      expect(landed.meta.changed).toBe(true);
    });

    it('collapses the window itself, dropping the job still running', async () => {
      const compressionModel = vi
        .fn<(messages: Message[]) => Promise<string>>()
        .mockImplementationOnce(() => new Promise<string>(() => {}))
        .mockResolvedValue('<summary>COLLAPSED</summary>');
      const [strategy] = attached(
        background(
          summarize({ compressionModel, split: 'recent-turns', preserveRecentMessages: 1 }),
        ),
      );
      await strategy.apply(makeInput({ history: source, appendOnly: true }));

      const current = [...again(source), call('c1'), result('c1')];
      const collapsed = await strategy.apply(
        makeInput({ history: current, appendOnly: true, collapse: true }),
      );

      expect(collapsed.meta).toMatchObject({ changed: true, strategy: 'background(summarize)' });
      expect(collapsed.history).toHaveLength(1);
      expect(collapsed.history[0].content).toContain('COLLAPSED');
      expect(collapsed.span).toEqual(current);
      expect(strategy.pendingJob).toBeUndefined();
    });

    it('collapses the window itself instead of landing a finished job, and commits the collapse', async () => {
      let round = 0;
      const [strategy, runner] = attached(
        background(
          anchored({
            compressionModel: async () => `<summary>ANCHOR-v${++round}</summary>`,
            split: 'recent-turns',
            preserveRecentMessages: 1,
          }),
        ),
      );
      await strategy.apply(makeInput({ history: source, appendOnly: true }));
      await settled(strategy);

      const current = [...again(source), call('c1'), result('c1')];
      const collapsed = await strategy.apply(
        makeInput({ history: current, appendOnly: true, collapse: true }),
      );
      strategy.commit?.(collapsed);

      expect(collapsed.history).toHaveLength(1);
      expect(collapsed.history[0].content).toContain('ANCHOR-v2');
      expect(strategy.snapshot?.()).toEqual({
        anchorDoc: 'ANCHOR-v2',
        anchors: { w_first: 'ANCHOR-v2' },
      });
      // The job succeeded; it just never landed.
      expect(runner.successes).toBe(1);
    });

    it('reports the inner strategy declining a collapse under its own name', async () => {
      const [strategy] = attached(inBackground());

      const declined = await strategy.apply(
        makeInput({ history: [call('c1')], appendOnly: true, collapse: true }),
      );

      expect(declined.meta).toMatchObject({ changed: false, strategy: 'background(summarize)' });
      expect(declined.meta.reason).toContain('nothing to collapse');
      expect(strategy.pendingJob).toBeUndefined();
    });
  });
});
