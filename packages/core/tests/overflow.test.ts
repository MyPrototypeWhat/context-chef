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
