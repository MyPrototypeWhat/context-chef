import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types';
import { anchored } from './anchored';
import { type BackgroundOverflowStrategy, background } from './background';
import { chain } from './chain';
import { reset } from './reset';
import { isServerStrategy, server } from './server';
import { summarize } from './summarize';
import type { OverflowInput, OverflowResult, OverflowRunner, OverflowStrategy } from './types';

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
    // The notice names the window it closed — there is no previous one here.
    expect(result.summary).toBe(
      'Context window reset (window w_first). Earlier conversation was archived.',
    );
  });

  it('names the closed window and its predecessor in the notice', async () => {
    const [strategy] = attached(reset());

    const result = await strategy.apply(
      makeInput({ window: { first: 'w_a', previous: 'w_a', current: 'w_b' } }),
    );

    expect(result.summary).toBe(
      'Context window reset (window w_b; previous w_a). Earlier conversation was archived.',
    );
    expect(result.meta.windowId).toBe('w_b');
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
});

describe('background()', () => {
  const settled = (strategy: BackgroundOverflowStrategy) =>
    vi.waitFor(() => {
      if (!strategy.pending?.settled) throw new Error('not settled');
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
    expect(strategy.pending).toBeDefined();
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
    expect(strategy.pending).toBeDefined();

    strategy.restore?.(undefined);
    expect(strategy.pending).toBeUndefined();
  });
});
