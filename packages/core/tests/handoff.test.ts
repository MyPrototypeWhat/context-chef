/**
 * The handoff budget and `new_context` at the chef level: one notice per
 * window through the tail channel, and a forced overflow that does not wait
 * for the budget.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type ChefConfig,
  ContextChef,
  getNewContextToolDefinition,
  type OverflowStrategy,
} from '../src/index';
import type { ChefLogger, Message, TargetPayload } from '../src/types';

const silent: ChefLogger = { warn: () => {} };

const tokenizer = (messages: Message[]): number => messages.length * 10;

const history = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `turn-${i + 1}: ${'context '.repeat(200)}`,
  }));

const compressionModel = async (): Promise<string> => '<summary>COMPRESSED</summary>';

const NOTICE = 'HANDOFF — {n_remaining} tokens left';

/**
 * Trigger at 100 tokens, 10 per message: a history of N messages leaves
 * `100 - 10N` of headroom, which is what the handoff band is measured against.
 */
const chefWith = (config: ChefConfig = {}, messages = 8): ContextChef =>
  new ContextChef({
    logger: silent,
    janitor: { contextWindow: 100, triggerRatio: 1, tokenizer, compressionModel },
    overflow: { handoff: { budgetTokens: 30, prompt: NOTICE } },
    ...config,
  })
    .setSystemPrompt([{ role: 'system', content: 'You are a careful assistant.' }])
    .setHistory(history(messages));

const text = (payload: TargetPayload): string => JSON.stringify(payload.messages);

describe('handoff budget', () => {
  it('delivers the notice once per window, with the headroom substituted', async () => {
    const chef = chefWith();

    const first = await chef.compile({ target: 'openai' });
    const second = await chef.compile({ target: 'openai' });

    expect(text(first)).toContain('HANDOFF — 20 tokens left');
    // Rendered by the announcement machinery, under the reserved internal id.
    expect(text(first)).toContain('__handoff__');
    expect(text(second)).not.toContain('HANDOFF');

    // In the tail, not in the cacheable prefix: it is volatile by definition.
    const tail = first.messages.filter((m) => m.role === 'user').pop();
    expect(JSON.stringify(tail)).toContain('HANDOFF');
    expect(JSON.stringify(first.messages[0])).not.toContain('HANDOFF');
  });

  it('stays quiet above the band and speaks again once a new window enters it', async () => {
    // 12 messages is over the trigger: the notice goes out and the same
    // compile overflows, which opens the next window.
    const chef = chefWith({}, 12);

    const overflowing = await chef.compile({ target: 'openai' });
    expect(text(overflowing)).toContain('HANDOFF');

    // New window, but plenty of headroom — nothing to announce.
    chef.setHistory(history(3));
    const roomy = await chef.compile({ target: 'openai' });
    expect(text(roomy)).not.toContain('HANDOFF');

    // Back inside the band, still the same window as the quiet compile.
    chef.setHistory(history(8));
    const tight = await chef.compile({ target: 'openai' });
    expect(text(tight)).toContain('HANDOFF — 20 tokens left');
  });

  it('is silent without a handoff budget', async () => {
    const chef = chefWith({ overflow: {} });

    expect(text(await chef.compile({ target: 'openai' }))).not.toContain('HANDOFF');
  });

  it('never announces on a server-managed compile', async () => {
    const chef = chefWith({ contextManagement: { strategy: 'server' } });

    // Anthropic compacts server-side: the library cannot say how much headroom
    // is left before it does.
    expect(text(await chef.compile({ target: 'anthropic' }))).not.toContain('HANDOFF');
    // The same chef on a target with no server-side compaction falls back to
    // the client strategy — and to the notice that goes with it.
    expect(text(await chef.compile({ target: 'openai' }))).toContain('HANDOFF');
  });

  it('leaves no trace on the chef', async () => {
    const chef = chefWith();
    chef.announce('tools:added', 'Tools newly available: grep');

    const payload = await chef.compile({ target: 'openai' });

    expect(text(payload)).toContain('HANDOFF');
    expect(chef.getAnnouncements()).toEqual([
      { id: 'tools:added', content: 'Tools newly available: grep', channel: 'auto' },
    ]);
    expect(chef.snapshot().announcements).toEqual(chef.getAnnouncements());
  });

  it('rides the announcement channel of the target', async () => {
    // 'auto' resolves per target — the notice reaches the model either way.
    expect(text(await chefWith().compile({ target: 'anthropic' }))).toContain('HANDOFF');
    expect(text(await chefWith().compile({ target: 'gemini' }))).toContain('HANDOFF');
  });

  it('carries the once-per-window flag through snapshot/restore', async () => {
    const live = chefWith();
    expect(text(await live.compile({ target: 'openai' }))).toContain('HANDOFF');

    // Same window, a fresh chef: the notice this window already got must not
    // be re-issued just because the session was rebuilt from its snapshot —
    // the canonical one-chef-per-request pattern does exactly this.
    const restored = chefWith().restore(live.snapshot());
    expect(text(await restored.compile({ target: 'openai' }))).not.toContain('HANDOFF');
  });

  it('re-issues the notice for a window that had not been noticed when the snapshot was taken', async () => {
    // 12 messages is over the trigger: this compile notices window 1 and
    // overflows into window 2.
    const chef = chefWith({}, 12);
    await chef.compile({ target: 'openai' });

    // Window 2 is inside the band but has not been noticed yet.
    chef.setHistory(history(8));
    const snap = chef.snapshot();
    expect(text(await chef.compile({ target: 'openai' }))).toContain('HANDOFF');

    // Rolling back to before that notice rolls the flag back with it.
    chef.restore(snap);
    expect(text(await chef.compile({ target: 'openai' }))).toContain('HANDOFF');
  });

  it('rejects a budget that cannot work, at construction', () => {
    expect(() => chefWith({ overflow: { handoff: { budgetTokens: 0 } } })).toThrow(
      /positive integer/,
    );
    expect(() => chefWith({ overflow: { handoff: { budgetTokens: 100, prompt: '  ' } } })).toThrow(
      /prompt is empty/,
    );
    expect(() =>
      chefWith({ overflow: { handoff: { budgetTokens: 100, prompt: 'x'.repeat(2001) } } }),
    ).toThrow(/over the 2000-byte cap/);
  });
});

describe('new_context', () => {
  /** A strategy that always evicts the oldest message, so a forced run shows. */
  const spyStrategy = (): { strategy: OverflowStrategy; applied: () => number } => {
    const applied = vi.fn();
    return {
      applied: () => applied.mock.calls.length,
      strategy: {
        name: 'spy',
        async apply(input) {
          applied();
          return {
            history: input.history.slice(1),
            evicted: input.history.slice(0, 1),
            span: input.history.slice(0, 1),
            meta: { strategy: 'spy', windowId: input.window.current, changed: true },
          };
        },
      },
    };
  };

  const roomy = (strategy: OverflowStrategy): ContextChef =>
    new ContextChef({
      logger: silent,
      janitor: { contextWindow: 1_000_000, tokenizer },
      overflow: { strategy },
    }).setHistory(history(4));

  it('forces the strategy on a history that is nowhere near the budget', async () => {
    const { strategy, applied } = spyStrategy();
    const chef = roomy(strategy);

    const idle = await chef.compile({ target: 'openai' });
    expect(applied()).toBe(0);

    chef.requestNewContext();
    const forced = await chef.compile({ target: 'openai' });
    expect(applied()).toBe(1);
    expect(forced.meta?.windowId).not.toBe(idle.meta?.windowId);

    // One request, one compile.
    await chef.compile({ target: 'openai' });
    expect(applied()).toBe(1);
  });

  it('is still vetoable by a before-overflow handler', async () => {
    const { strategy, applied } = spyStrategy();
    const chef = roomy(strategy);
    const veto = (): false => false;
    chef.use('before-overflow', veto);

    chef.requestNewContext();
    await chef.compile({ target: 'openai' });
    expect(applied()).toBe(0);

    // The request was answered by that compile, veto and all — lifting the
    // veto does not resurrect it.
    chef.unuse('before-overflow', veto);
    await chef.compile({ target: 'openai' });
    expect(applied()).toBe(0);
  });

  it('exposes a parameterless, reference-stable definition', () => {
    expect(getNewContextToolDefinition()).toBe(getNewContextToolDefinition());
    expect(getNewContextToolDefinition()).toEqual({
      name: 'new_context',
      description: expect.stringContaining('Start a new context window'),
    });
  });
});
