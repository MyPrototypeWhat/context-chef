/**
 * The overflow axis at the chef level: every deprecated option must produce
 * exactly the payload its `overflow.strategy` replacement produces, and the
 * runner concerns (budget, breaker, hooks) must keep behaving.
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it, vi } from 'vitest';
import {
  Assembler,
  anchored,
  type BudgetInfo,
  background,
  type ChefConfig,
  ContextChef,
  chain,
  fromAnthropic,
  type JanitorConfig,
  type OverflowResult,
  type OverflowRunner,
  type OverflowStrategy,
  server,
  summarize,
} from '../src/index';
import type {
  AnthropicPayload,
  ChefLogger,
  Message,
  OpenAIPayload,
  TargetPayload,
} from '../src/types';
import { estimateObject } from '../src/utils/tokenUtils';

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
          span: [],
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

  it('lands nothing for a compile aborted while it compresses', async () => {
    const controller = new AbortController();
    const onCompress = vi.fn();
    const chef = new ContextChef({
      logger: silent,
      janitor: {
        ...runnerConfig,
        onCompress,
        compressionModel: async () => {
          controller.abort();
          return SUMMARY;
        },
      },
    }).setHistory(longHistory(8));
    const events: string[] = [];
    chef.on('compress', () => {
      events.push('compress');
    });
    chef.on('compress:end', () => {
      events.push('compress:end');
    });
    const before = chef.snapshot().modules.janitor.window;

    await expect(
      chef.compile({ target: 'openai', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(onCompress).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(chef.snapshot().modules.janitor.window).toEqual(before);
  });

  it('keeps a finished background job for the next compile when one is aborted before it lands', async () => {
    const summarizer = vi.fn(compressionModel);
    const onCompress = vi.fn();
    const chef = new ContextChef({
      logger: silent,
      janitor: { ...runnerConfig, onCompress },
      overflow: {
        strategy: background(summarize({ compressionModel: summarizer, preserveRatio: 0.3 })),
      },
    });
    // Starts the job, which finishes off-turn.
    await chef.setHistory(longHistory(9)).compile({ target: 'openai' });
    await flush();

    const controller = new AbortController();
    const abort = () => controller.abort();
    chef.on('compress:start', abort);
    await expect(
      chef.setHistory(longHistory(9)).compile({ target: 'openai', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    chef.off('compress:start', abort);
    const payload = await chef.setHistory(longHistory(9)).compile({ target: 'openai' });

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(onCompress).toHaveBeenCalledTimes(1);
    expect(String(payload.messages[0].content)).toContain('ALIAS EQUIVALENCE');
  });

  it('keeps a finished background job in a chain aborted during an earlier step', async () => {
    const summarizer = vi.fn(compressionModel);
    let abortWith: AbortController | null = null;
    // Declines every time, and aborts the compile when told to.
    const declines: OverflowStrategy = {
      name: 'declines',
      async apply(input) {
        abortWith?.abort();
        return {
          history: input.history,
          evicted: [],
          span: [],
          meta: { strategy: 'declines', windowId: input.window.current, changed: false },
        };
      },
    };
    const chef = new ContextChef({
      logger: silent,
      janitor: runnerConfig,
      overflow: {
        strategy: chain(
          declines,
          background(summarize({ compressionModel: summarizer, preserveRatio: 0.3 })),
        ),
      },
    });
    await chef.setHistory(longHistory(9)).compile({ target: 'openai' });
    await flush();

    abortWith = new AbortController();
    await expect(
      chef.setHistory(longHistory(9)).compile({ target: 'openai', signal: abortWith.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    abortWith = null;
    const payload = await chef.setHistory(longHistory(9)).compile({ target: 'openai' });

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(String(payload.messages[0].content)).toContain('ALIAS EQUIVALENCE');
  });

  it('keeps a background job running when the compile that started it is aborted, and lands it next', async () => {
    const warn = vi.fn();
    const controller = new AbortController();
    // The user presses stop while the job's summary is being written.
    const summarizer = vi.fn(async () => {
      controller.abort();
      return SUMMARY;
    });
    const onCompress = vi.fn();
    const chef = new ContextChef({
      logger: { warn },
      janitor: { ...runnerConfig, onCompress },
      overflow: {
        strategy: background(summarize({ compressionModel: summarizer, preserveRatio: 0.3 })),
      },
    });

    await expect(
      chef.setHistory(longHistory(9)).compile({ target: 'openai', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    const payload = await chef.setHistory(longHistory(9)).compile({ target: 'openai' });

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(onCompress).toHaveBeenCalledTimes(1);
    expect(String(payload.messages[0].content)).toContain('ALIAS EQUIVALENCE');
    expect(warn).not.toHaveBeenCalled();
  });

  it('stops a running background job on clearHistory(): its model failing afterwards counts nothing', async () => {
    const warn = vi.fn();
    let fail: (error: Error) => void = () => {};
    const chef = new ContextChef({
      logger: { warn },
      janitor: runnerConfig,
      overflow: {
        strategy: background(
          summarize({
            compressionModel: () =>
              new Promise<string>((_, reject) => {
                fail = reject;
              }),
            preserveRatio: 0.3,
          }),
        ),
      },
    });
    await chef.setHistory(longHistory(9)).compile({ target: 'openai' });

    chef.clearHistory();
    fail(new Error('model down'));
    await flush();

    expect(warn).not.toHaveBeenCalled();
    expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(0);
  });

  /** How a pending `validateCompression` call ends. */
  interface Verdict {
    resolve(valid: boolean): void;
    reject(error: Error): void;
  }

  it.each([
    ['rejects the summary', (verdict: Verdict) => verdict.resolve(false)],
    ['throws', (verdict: Verdict) => verdict.reject(new Error('judge down'))],
  ])('stops a background job on clearHistory() while validateCompression runs, which then %s: nothing is counted', async (_, end) => {
    const warn = vi.fn();
    const onCompress = vi.fn();
    let verdict: Verdict = { resolve: () => {}, reject: () => {} };
    const validateCompression = vi.fn(
      () =>
        new Promise<boolean>((resolve, reject) => {
          verdict = { resolve, reject };
        }),
    );
    const chef = new ContextChef({
      logger: { warn },
      janitor: { ...runnerConfig, onCompress },
      overflow: {
        strategy: background(
          summarize({ compressionModel, preserveRatio: 0.3, validateCompression }),
        ),
      },
    });
    await chef.setHistory(longHistory(9)).compile({ target: 'openai' });
    await vi.waitFor(() => expect(validateCompression).toHaveBeenCalled());

    chef.clearHistory();
    end(verdict);
    await flush();

    expect(warn).not.toHaveBeenCalled();
    expect(onCompress).not.toHaveBeenCalled();
    expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(0);
  });

  it('counts nothing for a compile aborted while validateCompression runs', async () => {
    const warn = vi.fn();
    const onCompress = vi.fn();
    const controller = new AbortController();
    const chef = new ContextChef({
      logger: { warn },
      janitor: { ...runnerConfig, onCompress },
      overflow: {
        strategy: summarize({
          compressionModel,
          preserveRatio: 0.3,
          validateCompression: async () => {
            controller.abort();
            return false;
          },
        }),
      },
    });

    await expect(
      chef.setHistory(longHistory(9)).compile({ target: 'openai', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(warn).not.toHaveBeenCalled();
    expect(onCompress).not.toHaveBeenCalled();
    expect(chef.snapshot().modules.janitor.consecutiveFailures).toBe(0);
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

  it('carries the pinned turn in `span` but not in `evicted`', async () => {
    const onCompress = vi.fn();
    const stored: number[] = [];
    const messages = longHistory(9);
    messages[1] = { ...messages[1], pinned: true };
    const inner = summarize({ compressionModel, preserveRatio: 0.3 });
    let captured: OverflowResult | undefined;

    const chef = new ContextChef({
      logger: silent,
      janitor: { ...runnerConfig, onCompress },
      overflow: {
        strategy: {
          name: 'capture',
          apply: async (input) => {
            captured = await inner.apply(input);
            return captured;
          },
        },
        archive: {
          store: (_serialized, meta) => {
            stored.push(meta.messageCount);
            return 'context://vfs/pinned-span.txt';
          },
        },
      },
    }).setHistory(messages);

    await chef.compile({ target: 'openai' });

    if (!captured) throw new Error('the strategy never ran');
    const contents = (list: Message[]): string[] => list.map((m) => m.content as string);
    expect(contents(captured.span)).toContain(messages[1].content);
    expect(contents(captured.evicted)).not.toContain(messages[1].content);
    expect(captured.evicted).toHaveLength(captured.span.length - 1);

    // Everything downstream counts the span, never `evicted`.
    expect(onCompress.mock.calls[0][1]).toBe(captured.span.length);
    expect(stored).toEqual([captured.span.length]);
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

describe('overflow — a call made only to land a finished job', () => {
  it('runs only the chain steps that have one: nothing new is summarized below the trigger', async () => {
    const first = vi
      .fn()
      .mockRejectedValueOnce(new Error('API down'))
      .mockResolvedValue('<summary>FIRST</summary>');
    const second = vi.fn(async () => '<summary>SECOND</summary>');
    const keepOne = { split: 'recent-turns', preserveRecentMessages: 1 } as const;
    const chef = new ContextChef({
      logger: silent,
      // No tokenizer: the reported usage, else the built-in estimate of a few short messages.
      janitor: { contextWindow: 10_000 },
      overflow: {
        strategy: chain(
          summarize({ compressionModel: first, ...keepOne }),
          background(summarize({ compressionModel: second, ...keepOne })),
        ),
      },
    });
    const history: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
    ];

    // Over the trigger: the first step fails, and the background step starts its job.
    chef.reportTokenUsage(20_000);
    await chef.setHistory(history).compile({ target: 'openai' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Within budget: the runner calls only so the finished job can land.
    const payload = await chef.setHistory(history).compile({ target: 'openai' });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(payload.messages.map((m) => String(m.content))).toEqual([
      expect.stringContaining('SECOND'),
      'q3',
    ]);
  });
});

describe('overflow — a history resumed from a compaction block', () => {
  it('keeps the block first: the summary, and its archive citation, go after it', async () => {
    const onCompress = vi.fn();
    // A session stored as Anthropic messages, opening with the block a compaction returned.
    const { history } = fromAnthropic([
      { role: 'assistant', content: [{ type: 'compaction', content: 'EARLIER' }] },
      ...longHistory(9).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ] as MessageParam[]);

    const chef = new ContextChef({
      logger: silent,
      janitor: { ...runnerConfig, onCompress },
      overflow: {
        strategy: summarize({ compressionModel, preserveRatio: 0.3 }),
        archive: { store: () => 'context://vfs/fixed-uri.txt' },
      },
    }).setHistory(history);

    const payload = (await chef.compile({ target: 'anthropic' })) as AnthropicPayload;

    expect(payload.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'compaction', content: 'EARLIER' }],
    });
    const summary = JSON.stringify(payload.messages[1]);
    expect(summary).toContain('ALIAS EQUIVALENCE');
    expect(summary).toContain('archived in full at context://vfs/fixed-uri.txt');
    expect(payload.messages).toHaveLength(3);
    expect(JSON.stringify(onCompress.mock.calls[0][0])).toContain('ALIAS EQUIVALENCE');
  });

  it.each([
    false,
    true,
  ])('compacts nothing when the turns it keeps leave only the block before them (appendOnly %s)', async (appendOnly) => {
    // The first request after the resume, over the trigger: the block is a large summary.
    const { history } = fromAnthropic([
      {
        role: 'assistant',
        content: [
          { type: 'compaction', content: `EARLIER ${'x'.repeat(400)}`, signature: 'SIG_0' },
        ],
      },
      { role: 'user', content: 'q1' },
    ] as unknown as MessageParam[]);
    const model = vi.fn(async () => '<summary>SUM</summary>');
    const chef = new ContextChef({
      appendOnly,
      logger: silent,
      janitor: {
        contextWindow: 100,
        triggerRatio: 1,
        tokenizer: (messages) => JSON.stringify(messages).length / 4,
      },
      overflow: { strategy: summarize({ compressionModel: model, preserveRecentMessages: 2 }) },
    }).setHistory(history);

    const [first, retry] = [
      (await chef.compile({ target: 'anthropic' })) as AnthropicPayload,
      (await chef.compile({ target: 'anthropic' })) as AnthropicPayload,
    ];

    expect(model).not.toHaveBeenCalled();
    for (const payload of [first, retry]) {
      expect(payload.messages).toEqual([
        {
          role: 'assistant',
          content: [
            { type: 'compaction', content: `EARLIER ${'x'.repeat(400)}`, signature: 'SIG_0' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      ]);
    }
  });

  it('keeps the opening user turn before the block, so a text target still opens with it', async () => {
    const { history } = fromAnthropic([
      { role: 'assistant', content: [{ type: 'compaction', content: 'EARLIER' }] },
      ...longHistory(9).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ] as MessageParam[]);

    const chef = new ContextChef({
      logger: silent,
      janitor: runnerConfig,
      overflow: {
        strategy: summarize({ compressionModel, preserveRatio: 0.3 }),
        archive: { store: () => 'context://vfs/fixed-uri.txt' },
      },
    }).setHistory(history);

    const payload = (await chef.compile({ target: 'openai' })) as OpenAIPayload;

    expect(payload.messages[0]).toEqual({ role: 'user', content: history[0].content });
    expect(String(payload.messages[1].content)).toContain('EARLIER');
    // The summary, with its archive citation, is the message after the block.
    expect(String(payload.messages[2].content)).toContain('ALIAS EQUIVALENCE');
    expect(String(payload.messages[2].content)).toContain(
      'archived in full at context://vfs/fixed-uri.txt',
    );
  });
});

// In-flight overflow: the host keeps its full history and passes it to
// setHistory every turn; the summary is recomputed per call (README,
// "Durable compaction"). Before the fix, the call after each compression
// skipped the budget check and sent the full history.
describe('overflow — host passes its full history every turn', () => {
  const turn = (i: number): Message[] => [
    { role: 'user', content: `q${i}: ${'context '.repeat(200)}` },
    { role: 'assistant', content: `a${i}: ${'context '.repeat(200)}` },
  ];

  it('keeps every payload within the budget', async () => {
    const chef = new ContextChef({
      logger: silent,
      janitor: { ...runnerConfig, compressionModel },
    });
    const full: Message[] = [];
    const sizes: number[] = [];

    for (let i = 1; i <= 6; i++) {
      full.push(...turn(i));
      chef.setHistory([...full, { role: 'user', content: `next ${i}` }]);
      const payload = await chef.compile({ target: 'openai' });
      sizes.push((payload as { messages: unknown[] }).messages.length);
    }

    // runnerConfig: 10 tokens per message, budget 60 → at most 6 messages.
    expect(sizes.every((n) => n <= 6)).toBe(true);
  });

  it('still ignores a usage report that predates the compression', async () => {
    // The usage of the request sent before the compression comes back while
    // the summary is being written.
    const reporting = async (): Promise<string> => {
      chef.reportTokenUsage(500);
      return compressionModel();
    };
    let store = longHistory(8);
    const chef = new ContextChef({
      logger: silent,
      janitor: {
        ...runnerConfig,
        compressionModel: reporting,
        onCompress: (summary, count) => {
          store = [summary, ...store.slice(count)];
        },
      },
    });
    let compressions = 0;
    chef.on('compress:end', ({ compressed }) => {
      if (compressed) compressions++;
    });

    await chef.setHistory(store).compile({ target: 'openai' });
    expect(compressions).toBe(1);

    // The host now holds the compressed history.
    await chef.setHistory(store).compile({ target: 'openai' });
    expect(compressions).toBe(1);
  });

  it('acts on a usage report of the compressed history the host kept', async () => {
    let store = longHistory(8);
    const chef = new ContextChef({
      logger: silent,
      janitor: {
        ...runnerConfig,
        compressionModel,
        // The host persists each compression in its store.
        onCompress: (summary, count) => {
          store = [summary, ...store.slice(count)];
        },
      },
    });
    let compressions = 0;
    chef.on('compress:end', ({ compressed }) => {
      if (compressed) compressions++;
    });

    await chef.setHistory(store).compile({ target: 'openai' });

    // It goes on from what it kept. Six messages are 60 by the tokenizer, at
    // the budget; the report of the compressed request says 500.
    store = [...store, ...longHistory(6).slice(store.length)];
    chef.reportTokenUsage(500);
    await chef.setHistory(store).compile({ target: 'openai' });
    expect(compressions).toBe(2);
  });

  it('keeps every payload within the budget without a tokenizer, its usage reported back', async () => {
    const chef = new ContextChef({
      logger: silent,
      janitor: { contextWindow: 2000, compressionModel },
    });
    const full: Message[] = [];
    const compressed: boolean[] = [];

    for (let i = 1; i <= 8; i++) {
      full.push(...turn(i));
      const history: Message[] = [...full, { role: 'user', content: `next ${i}` }];
      const payload = (await chef
        .setHistory(history)
        .compile({ target: 'openai' })) as OpenAIPayload;
      compressed.push(payload.messages.length < history.length);
      // What the provider counted for the request it was sent.
      chef.reportTokenUsage(estimateObject(payload.messages));
    }

    // Once the window outgrew the budget, every request after it is compressed.
    const first = compressed.indexOf(true);
    expect(first).toBeGreaterThan(0);
    expect(compressed.slice(first).every(Boolean)).toBe(true);
  });
});
