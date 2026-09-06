/**
 * The overflow axis at the chef level: every deprecated option must produce
 * exactly the payload its `overflow.strategy` replacement produces, and the
 * runner concerns (budget, breaker, hooks) must keep behaving.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  Assembler,
  anchored,
  type BudgetInfo,
  background,
  type ChefConfig,
  ContextChef,
  type JanitorConfig,
  type OverflowRunner,
  type OverflowStrategy,
  server,
  summarize,
} from '../src/index';
import type { ChefLogger, Message, TargetPayload } from '../src/types';

/** Alias conflicts and no-tokenizer paths warn by design; keep the output clean. */
const silent: ChefLogger = { warn: () => {} };

const SUMMARY = '<summary>ALIAS EQUIVALENCE</summary>';
const compressionModel = async (): Promise<string> => SUMMARY;
const tokenizer = (messages: Message[]): number => messages.length * 10;

/** Runner-side options — these stay on `janitor` in every spelling. */
const runnerConfig: JanitorConfig = { contextWindow: 60, triggerRatio: 1, tokenizer };

/** Long enough that a summary actually shrinks the span (shrink-guard floor). */
const longHistory = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `turn-${i + 1}: ${'context '.repeat(200)}`,
  }));

const TARGETS = ['openai', 'anthropic', 'gemini'] as const;

/**
 * The wire payload, serialized. `meta` is compile-time observability — memory
 * keys, the active skill, the window id — and the window id is unique per
 * chef, so comparing two instances' payloads means comparing what actually
 * goes to the provider.
 */
const wire = (payload: TargetPayload): string => {
  const { meta: _meta, ...rest } = payload;
  return Assembler.stringifyPayload(rest);
};

const chefWith = (config: ChefConfig): ContextChef =>
  new ContextChef({ logger: silent, ...config })
    .setSystemPrompt([{ role: 'system', content: 'You are a careful assistant.' }])
    .setHistory(longHistory(9));

/** Lets a background job settle: one macrotask flushes the whole promise chain. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Compiles both spellings against every target and asserts byte-identical
 * payloads. A fresh chef per target — warn-once flags and the transform cache
 * are per-instance state that would otherwise leak across targets.
 */
async function expectEquivalent(
  legacy: () => ContextChef,
  modern: () => ContextChef,
  options: { compiles?: number; mustContain?: (target: (typeof TARGETS)[number]) => string } = {},
): Promise<void> {
  const { compiles = 1, mustContain = () => 'ALIAS EQUIVALENCE' } = options;
  for (const target of TARGETS) {
    const a = legacy();
    const b = modern();
    let legacyPayload = '';
    let modernPayload = '';
    for (let i = 0; i < compiles; i++) {
      legacyPayload = wire(await a.compile({ target }));
      modernPayload = wire(await b.compile({ target }));
      await flush();
    }
    expect(modernPayload).toBe(legacyPayload);
    expect(legacyPayload).toContain(mustContain(target));
  }
}

describe('overflow aliases — one payload, two spellings', () => {
  it("compressionMode: 'rewrite' === summarize()", async () => {
    await expectEquivalent(
      () =>
        chefWith({
          janitor: {
            ...runnerConfig,
            compressionMode: 'rewrite',
            compressionModel,
            preserveRatio: 0.3,
          },
        }),
      () =>
        chefWith({
          janitor: runnerConfig,
          overflow: { strategy: summarize({ compressionModel, preserveRatio: 0.3 }) },
        }),
    );
  });

  it("compressionMode: 'incremental-anchored' === anchored()", async () => {
    await expectEquivalent(
      () =>
        chefWith({
          janitor: {
            ...runnerConfig,
            compressionMode: 'incremental-anchored',
            compressionModel,
            preserveRatio: 0.3,
          },
        }),
      () =>
        chefWith({
          janitor: runnerConfig,
          overflow: { strategy: anchored({ compressionModel, preserveRatio: 0.3 }) },
        }),
    );
  });

  it("compressionScheduling: 'background' === background()", async () => {
    await expectEquivalent(
      () =>
        chefWith({
          janitor: {
            ...runnerConfig,
            compressionScheduling: 'background',
            compressionModel,
            preserveRatio: 0.3,
          },
        }),
      () =>
        chefWith({
          janitor: runnerConfig,
          overflow: { strategy: background(summarize({ compressionModel, preserveRatio: 0.3 })) },
        }),
      // First compile starts the job, second swaps the summary in.
      { compiles: 2 },
    );
  });

  it('the summarizer options === the options of summarize()', async () => {
    const policy = {
      compressionModel,
      preserveRatio: 0.3,
      compressionGuidelines: ['Preserve ticket IDs verbatim.'],
      customCompressionInstructions: 'Focus on unresolved issues.',
      minShrinkRatio: 0.2,
      toolResultStubThreshold: 5000,
      validateCompression: () => true,
    };
    await expectEquivalent(
      () => chefWith({ janitor: { ...runnerConfig, ...policy } }),
      () => chefWith({ janitor: runnerConfig, overflow: { strategy: summarize(policy) } }),
    );
  });

  it('janitor.archive === overflow.archive', async () => {
    const archive = () => {
      const spans: string[] = [];
      return {
        spans,
        store: (serialized: string) => {
          spans.push(serialized);
          return 'context://vfs/fixed-uri.txt';
        },
      };
    };
    const legacyArchive = archive();
    const modernArchive = archive();

    await expectEquivalent(
      () =>
        chefWith({
          janitor: {
            ...runnerConfig,
            compressionModel,
            preserveRatio: 0.3,
            archive: legacyArchive,
          },
        }),
      () =>
        chefWith({
          janitor: runnerConfig,
          overflow: {
            strategy: summarize({ compressionModel, preserveRatio: 0.3 }),
            archive: modernArchive,
          },
        }),
      { mustContain: () => 'context://vfs/fixed-uri.txt' },
    );
    expect(modernArchive.spans).toEqual(legacyArchive.spans);
  });

  it("contextManagement.strategy: 'server' === server(config, { fallback })", async () => {
    const serverConfig = { edits: [{ type: 'compact_20260112' }] };
    const fallback = () => summarize({ compressionModel, preserveRatio: 0.3 });

    await expectEquivalent(
      () =>
        chefWith({
          contextManagement: { strategy: 'server', server: serverConfig },
          janitor: { ...runnerConfig, compressionModel, preserveRatio: 0.3 },
        }),
      () =>
        chefWith({
          janitor: runnerConfig,
          overflow: { strategy: server(serverConfig, { fallback: fallback() }) },
        }),
      // The Anthropic target is server-managed and never compresses; the
      // others fall back to client-side summarization.
      {
        mustContain: (target) =>
          target === 'anthropic' ? 'compact_20260112' : 'ALIAS EQUIVALENCE',
      },
    );
  });

  it('the server strategy delegates to its fallback off the Anthropic target', async () => {
    const managed = await chefWith({
      overflow: {
        strategy: server(undefined, {
          fallback: summarize({ compressionModel, preserveRatio: 0.3 }),
        }),
      },
      janitor: runnerConfig,
    }).compile({ target: 'anthropic' });
    const unmanaged = await chefWith({
      overflow: {
        strategy: server(undefined, {
          fallback: summarize({ compressionModel, preserveRatio: 0.3 }),
        }),
      },
      janitor: runnerConfig,
    }).compile({ target: 'openai' });

    expect(Assembler.stringifyPayload(managed)).not.toContain('ALIAS EQUIVALENCE');
    expect(managed.messages).toHaveLength(9);
    expect(Assembler.stringifyPayload(unmanaged)).toContain('ALIAS EQUIVALENCE');
  });

  it('overflow.strategy wins over the deprecated options, and says so once', async () => {
    const warn = vi.fn();
    const never = vi.fn();
    const chef = new ContextChef({
      logger: { warn },
      janitor: {
        ...runnerConfig,
        compressionMode: 'incremental-anchored',
        compressionModel: never,
      },
      overflow: { strategy: summarize({ compressionModel, preserveRatio: 0.3 }) },
    }).setHistory(longHistory(9));

    await chef.compile({ target: 'openai' });
    await chef.compile({ target: 'openai' });

    expect(never).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('overflow.strategy is configured together with');
  });
});

describe('overflow runner', () => {
  it('hands the before-overflow slot the numbers the runner decides on', async () => {
    let budget: BudgetInfo | undefined;
    const chef = new ContextChef({
      logger: silent,
      janitor: { contextWindow: 100, tokenizer, compressionModel },
    }).setHistory(longHistory(3));
    chef.use('before-overflow', (ctx) => {
      budget = ctx.budget;
    });

    // Reported usage beats the tokenizer's 30 under the default 'max' rule —
    // the slot sees the same figure the overflow decision uses.
    chef.reportTokenUsage(500);
    await chef.compile({ target: 'openai' });

    expect(budget).toEqual({ limit: 100, current: 500, trigger: 70, remaining: -430 });
  });

  it('keeps the legacy onBeforeCompress signature, including its history replacement', async () => {
    const seen: Array<{ currentTokens: number; limit: number }> = [];
    const chef = new ContextChef({
      logger: silent,
      janitor: {
        contextWindow: 30,
        tokenizer,
        compressionModel,
        onBeforeCompress: (history, tokenInfo) => {
          seen.push(tokenInfo);
          return history.slice(-2);
        },
      },
    }).setHistory(longHistory(5));

    const payload = await chef.compile({ target: 'openai' });

    // 2 × 10 tokens is under the 21-token trigger, so the hook's replacement
    // is what compiles — no compression on top of it.
    expect(seen).toEqual([{ currentTokens: 50, limit: 21 }]);
    expect(payload.messages).toHaveLength(2);
  });

  it('counts strategy rejections toward the circuit breaker', async () => {
    let runner: OverflowRunner | undefined;
    const applied = vi.fn();
    const flaky: OverflowStrategy = {
      name: 'flaky',
      attach(installed) {
        runner = installed;
      },
      async apply(input) {
        applied();
        runner?.fail('flaky strategy rejected the compression');
        return {
          history: input.history,
          evicted: [],
          meta: {
            strategy: 'flaky',
            windowId: input.window.current,
            changed: false,
            reason: 'rejected',
          },
        };
      },
    };

    const chef = new ContextChef({
      logger: silent,
      janitor: { contextWindow: 30, tokenizer },
      overflow: { strategy: flaky },
    }).setHistory(longHistory(5));

    for (let i = 0; i < 5; i++) await chef.compile({ target: 'openai' });

    expect(applied).toHaveBeenCalledTimes(3);
  });
});

/**
 * The v5 adversarial review found seven ways the overflow axis lied about what
 * it had done. Each one is pinned here.
 */
describe('overflow — v5 review fixes', () => {
  const serverConfig = { edits: [{ type: 'compact_20260112' }] };

  it('janitor.strategy = server() is server-managed, exactly like overflow.strategy', async () => {
    await expectEquivalent(
      () => chefWith({ janitor: { ...runnerConfig, strategy: server(serverConfig) } }),
      () => chefWith({ janitor: runnerConfig, overflow: { strategy: server(serverConfig) } }),
      // Nothing compresses on the Anthropic target (the provider does it) and
      // nothing compresses off it either (no fallback), so the history itself
      // is what both payloads must agree on.
      { mustContain: (target) => (target === 'anthropic' ? 'compact_20260112' : 'turn-1') },
    );

    const payload = await chefWith({
      janitor: { ...runnerConfig, strategy: server(serverConfig) },
    }).compile({ target: 'anthropic' });

    expect(payload.context_management).toEqual(serverConfig);
    expect(payload.betas).toEqual(['compact-2026-01-12']);
  });

  it('warns about a server strategy on an unmanaged target in the janitor spelling too', async () => {
    const warn = vi.fn();
    const chef = new ContextChef({
      logger: { warn },
      janitor: { ...runnerConfig, strategy: server(serverConfig) },
    }).setHistory(longHistory(9));

    await chef.compile({ target: 'openai' });
    await chef.compile({ target: 'openai' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('no server-side context management implementation');
  });

  it('reports a forced overflow the server-managed target dropped', async () => {
    const warn = vi.fn();
    const invariants: Array<{ phase: string; message: string }> = [];
    const chef = new ContextChef({
      logger: { warn },
      janitor: runnerConfig,
      overflow: { strategy: server(serverConfig) },
    }).setHistory(longHistory(9));
    chef.on('pipeline:invariant', (event) => {
      invariants.push(event);
    });

    chef.requestNewContext();
    await chef.compile({ target: 'anthropic' });

    expect(invariants).toHaveLength(1);
    expect(invariants[0].phase).toBe('overflow');
    expect(invariants[0].message).toContain('the compile target is server-managed');
    expect(warn).toHaveBeenCalledTimes(1);

    // Still one-shot: the request was answered, badly, by that compile.
    chef.requestNewContext();
    await chef.compile({ target: 'anthropic' });
    expect(invariants).toHaveLength(2);
    await chef.compile({ target: 'anthropic' });
    expect(invariants).toHaveLength(2);
    // Warned once per kind, not once per compile.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports a forced overflow a before-overflow handler vetoed', async () => {
    const warn = vi.fn();
    const invariants: Array<{ phase: string; message: string }> = [];
    const chef = new ContextChef({
      logger: { warn },
      janitor: { contextWindow: 1_000_000, tokenizer },
      overflow: { strategy: summarize({ compressionModel }) },
    }).setHistory(longHistory(4));
    chef.on('pipeline:invariant', (event) => {
      invariants.push(event);
    });
    chef.use('before-overflow', () => false);

    chef.requestNewContext();
    await chef.compile({ target: 'openai' });

    expect(invariants).toHaveLength(1);
    expect(invariants[0].message).toContain('before-overflow handler vetoed');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once when nothing can compress: no tokenizer, no model, no strategy', () => {
    const warn = vi.fn();
    new ContextChef({ logger: { warn }, janitor: { contextWindow: 1000 } });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('No tokenizer and no compressionModel configured');

    const quiet = vi.fn();
    new ContextChef({ logger: { warn: quiet }, janitor: { contextWindow: 1000, tokenizer } });
    new ContextChef({
      logger: { warn: quiet },
      janitor: { contextWindow: 1000, compressionModel },
    });
    new ContextChef({
      logger: { warn: quiet },
      janitor: { contextWindow: 1000, strategy: summarize({ compressionModel }) },
    });
    new ContextChef({
      logger: { warn: quiet },
      janitor: { contextWindow: 1000 },
      overflow: { strategy: summarize({ compressionModel }) },
    });

    expect(quiet).not.toHaveBeenCalled();
  });

  it('reports and archives the whole compressed span, pinned turns included', async () => {
    const stored: Array<{ serialized: string; messageCount: number }> = [];
    const onCompress = vi.fn();
    const messages = longHistory(9);
    messages[1] = { ...messages[1], pinned: true };

    const chef = new ContextChef({
      logger: silent,
      janitor: { ...runnerConfig, onCompress },
      overflow: {
        strategy: summarize({ compressionModel, preserveRatio: 0.3 }),
        archive: {
          store: (serialized, meta) => {
            stored.push({ serialized, messageCount: meta.messageCount });
            return 'context://vfs/fixed-uri.txt';
          },
        },
      },
    }).setHistory(messages);

    const payload = await chef.compile({ target: 'openai' });

    // The span is turns 1–8; the pinned turn 2 sits inside it and is
    // re-inserted verbatim, but it is still part of what the summary covers.
    const [summary, truncatedCount, details] = onCompress.mock.calls[0];
    const span = details.compressedMessages as Message[];
    expect(span.map((m: Message) => m.content)).toEqual(messages.slice(0, 8).map((m) => m.content));
    expect(span[1].pinned).toBe(true);
    expect(truncatedCount).toBe(8);
    expect(JSON.stringify(summary)).toContain('ALIAS EQUIVALENCE');

    // The archived transcript is the same contiguous span — no hole where the
    // pinned turn was — and the citation the MODEL reads counts it.
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].serialized).messages).toHaveLength(8);
    expect(stored[0].messageCount).toBe(8);
    expect(Assembler.stringifyPayload(payload)).toContain(
      'The 8 compacted messages are archived in full at context://vfs/fixed-uri.txt',
    );
    // What LEFT the window is still the 7 unpinned turns: the pinned one is
    // back in the window, right after the summary.
    expect(payload.messages[1].content).toBe(messages[1].content);
    expect(chef.snapshot().history[1].pinned).toBe(true);
  });

  it('archives a span whose every turn is pinned', async () => {
    const stored: string[] = [];
    const messages = longHistory(9).map((m, i) => (i < 8 ? { ...m, pinned: true } : m));

    const chef = new ContextChef({
      logger: silent,
      janitor: runnerConfig,
      overflow: {
        strategy: summarize({ compressionModel, preserveRatio: 0.3 }),
        archive: {
          store: (serialized) => {
            stored.push(serialized);
            return 'context://vfs/all-pinned.txt';
          },
        },
      },
    }).setHistory(messages);

    await chef.compile({ target: 'openai' });

    // Nothing was evicted — and the span the summary stands for is still
    // stored, exactly as it was before 4.2.
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]).messages).toHaveLength(8);
  });

  it('a forced overflow folds every turn but the one the request lives in', async () => {
    for (const strategy of [summarize({ compressionModel }), anchored({ compressionModel })]) {
      const chef = new ContextChef({
        logger: silent,
        janitor: { contextWindow: 1_000_000, tokenizer },
        overflow: { strategy },
      }).setHistory(longHistory(21));

      // Twenty-one turns and a million tokens of headroom: the preserve rules
      // would keep every one of them, which is the case new_context exists for.
      chef.requestNewContext();
      const payload = await chef.compile({ target: 'openai' });

      expect(payload.messages).toHaveLength(2);
      expect(payload.messages[0].content).toContain('ALIAS EQUIVALENCE');
      expect(payload.messages[1].content).toContain('turn-21');
    }
  });

  it('declines a forced overflow that would leave the pending request nothing to sit in', async () => {
    const compressed: boolean[] = [];
    const chef = new ContextChef({
      logger: silent,
      janitor: { contextWindow: 1_000_000, tokenizer },
      overflow: { strategy: summarize({ compressionModel }) },
    }).setHistory(longHistory(1));
    chef.on('compress:end', (event) => {
      compressed.push(event.compressed);
    });

    chef.requestNewContext();
    const payload = await chef.compile({ target: 'openai' });

    expect(payload.messages).toHaveLength(1);
    expect(compressed).toEqual([false]);
  });
});
