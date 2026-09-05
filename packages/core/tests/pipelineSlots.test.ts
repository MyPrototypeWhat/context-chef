import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Assembler, type BudgetInfo, ContextChef, type OverflowResult } from '../src/index';
import type { Message, TargetPayload } from '../src/types';

const makeTokenizer =
  (tokensPerMsg: number) =>
  (messages: Message[]): number =>
    messages.length * tokensPerMsg;

const buildHistory = (count: number): Message[] =>
  Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `msg-${i + 1}`,
  }));

/** A chef whose history is over budget, so the overflow phase compresses. */
const overflowingChef = (): ContextChef =>
  new ContextChef({
    janitor: {
      contextWindow: 30,
      tokenizer: makeTokenizer(10),
      compressionModel: async () => '<history_summary>SUMMARY</history_summary>',
    },
  }).setHistory(buildHistory(5));

describe('pipeline slots — registration', () => {
  it('runs handlers in registration order across slots', async () => {
    const order: string[] = [];
    const chef = new ContextChef().setHistory([{ role: 'user', content: 'hi' }]);

    chef
      .use('before-overflow', () => {
        order.push('before-overflow');
      })
      .use('after-overflow', () => {
        order.push('after-overflow');
      })
      .use('before-assemble', () => {
        order.push('before-assemble-1');
      })
      .use('before-assemble', () => {
        order.push('before-assemble-2');
      })
      .use('after-assemble', (messages) => {
        order.push('after-assemble');
        return messages;
      })
      .use('before-adapt', () => {
        order.push('before-adapt');
      })
      .use('after-adapt', () => {
        order.push('after-adapt');
      });

    await chef.compile({ target: 'openai' });

    expect(order).toEqual([
      'before-overflow',
      'after-overflow',
      'before-assemble-1',
      'before-assemble-2',
      'after-assemble',
      'before-adapt',
      'after-adapt',
    ]);
  });

  it('unuse removes one registration and leaves the others', async () => {
    const calls: string[] = [];
    const first = () => {
      calls.push('first');
    };
    const second = () => {
      calls.push('second');
    };
    const chef = new ContextChef().setHistory([{ role: 'user', content: 'hi' }]);

    chef.use('before-adapt', first).use('before-adapt', second);
    chef.unuse('before-adapt', first);
    await chef.compile({ target: 'openai' });

    expect(calls).toEqual(['second']);
  });

  it('unuse of an unregistered handler is a no-op', async () => {
    const chef = new ContextChef().setHistory([{ role: 'user', content: 'hi' }]);
    expect(chef.unuse('after-adapt', () => undefined)).toBe(chef);
    await expect(chef.compile({ target: 'openai' })).resolves.toBeDefined();
  });
});

describe('pipeline slots — overflow', () => {
  it('before-overflow receives the budget reading', async () => {
    let budget: BudgetInfo | undefined;
    const chef = overflowingChef();
    chef.use('before-overflow', (ctx) => {
      budget = ctx.budget;
    });

    await chef.compile({ target: 'openai' });

    // 5 messages × 10 tokens against a 30-token window at the default 0.7 trigger.
    expect(budget).toEqual({ limit: 30, current: 50, trigger: 21, remaining: -29 });
  });

  it('compresses by default', async () => {
    const compress = vi.fn();
    const chef = overflowingChef();
    chef.on('compress', compress);

    const payload = await chef.compile({ target: 'openai' });

    expect(compress).toHaveBeenCalledTimes(1);
    expect(payload.messages.length).toBeLessThan(5);
  });

  it('a before-overflow handler returning false skips compression', async () => {
    const compress = vi.fn();
    const chef = overflowingChef();
    chef.on('compress', compress);
    chef.use('before-overflow', () => false);

    const payload = await chef.compile({ target: 'openai' });

    expect(compress).not.toHaveBeenCalled();
    expect(payload.messages).toHaveLength(5);
  });

  it('after-overflow reports what left the window', async () => {
    let result: OverflowResult | null | undefined;
    const chef = overflowingChef();
    chef.use('after-overflow', (ctx) => {
      result = ctx.result;
    });

    await chef.compile({ target: 'openai' });

    expect(result?.meta.changed).toBe(true);
    expect(result?.meta.windowId).toMatch(/^w_/);
    expect(result?.evicted.length).toBeGreaterThan(0);
    expect(result?.summary).toContain('SUMMARY');
  });

  it('after-overflow reports null when the phase was skipped', async () => {
    let result: OverflowResult | null | undefined;
    const chef = overflowingChef();
    chef
      .use('before-overflow', () => false)
      .use('after-overflow', (ctx) => {
        result = ctx.result;
      });

    await chef.compile({ target: 'openai' });

    expect(result).toBeNull();
  });
});

describe('pipeline slots — assemble and adapt', () => {
  it('before-assemble injections accumulate into one implicit_context block', async () => {
    const chef = new ContextChef().setHistory([{ role: 'user', content: 'question' }]);
    chef
      .use('before-assemble', (ctx) => {
        ctx.inject('<snippet>one</snippet>');
      })
      .use('before-assemble', (ctx) => {
        ctx.inject('<snippet>two</snippet>');
      });

    const payload = await chef.compile({ target: 'openai' });
    const tail = String(payload.messages.at(-1)?.content);

    expect(tail).toContain(
      '<implicit_context>\n<snippet>one</snippet>\n\n<snippet>two</snippet>\n</implicit_context>',
    );
  });

  it('before-assemble sees the post-overflow history', async () => {
    let seen = 0;
    const chef = overflowingChef();
    chef.use('before-assemble', (ctx) => {
      seen = ctx.history.length;
    });

    await chef.compile({ target: 'openai' });

    expect(seen).toBeLessThan(5);
  });

  it('after-assemble transforms are applied and chained', async () => {
    const chef = new ContextChef()
      .setSystemPrompt([{ role: 'system', content: 'sys' }])
      .setHistory([{ role: 'user', content: 'keep' }]);

    chef
      .use('after-assemble', (messages) => [...messages, { role: 'user', content: 'added-1' }])
      .use('after-assemble', async (messages) => [
        ...messages,
        { role: 'user', content: 'added-2' },
      ]);

    const payload = await chef.compile({ target: 'openai' });

    expect(payload.messages.map((m) => m.content)).toEqual(['sys', 'keep', 'added-1', 'added-2']);
  });

  it('before-adapt sees the assembled messages, tail stitch included', async () => {
    let seen: readonly Message[] = [];
    const chef = new ContextChef()
      .setHistory([{ role: 'user', content: 'question' }])
      .setDynamicState(z.object({ file: z.string() }), { file: 'a.ts' });
    chef.use('before-adapt', (messages) => {
      seen = messages;
    });

    await chef.compile({ target: 'openai' });

    expect(seen).toHaveLength(1);
    expect(seen[0].content).toContain('<dynamic_state>');
    expect(seen[0].content).toContain('<file>a.ts</file>');
  });

  it('after-adapt sees the finished payload', async () => {
    let seen: TargetPayload | undefined;
    const chef = new ContextChef().setHistory([{ role: 'user', content: 'hi' }]);
    chef.use('after-adapt', (payload) => {
      seen = payload;
    });

    const payload = await chef.compile({ target: 'openai' });

    expect(seen).toBe(payload);
    expect(seen?.meta).toBeDefined();
  });

  it('a throwing slot handler fails the compile (errors are not isolated)', async () => {
    const chef = new ContextChef().setHistory([{ role: 'user', content: 'hi' }]);
    chef.use('after-adapt', () => {
      throw new Error('boom');
    });

    await expect(chef.compile({ target: 'openai' })).rejects.toThrow('boom');
  });
});

describe('pipeline slots — legacy hook equivalence', () => {
  const setUp = (chef: ContextChef): ContextChef =>
    chef
      .setSystemPrompt([{ role: 'system', content: 'You are an expert.' }])
      .setHistory([
        { role: 'user', content: 'Fix the bug.' },
        { role: 'assistant', content: 'Sure.' },
        { role: 'user', content: 'Where?' },
      ])
      .setDynamicState(z.object({ activeFile: z.string() }), { activeFile: 'auth.ts' });

  it('onBeforeCompile === use(before-assemble) + inject', async () => {
    const retrieved = '<related_code>function verify() {}</related_code>';

    const legacy = setUp(new ContextChef({ onBeforeCompile: async () => retrieved }));
    const modern = setUp(new ContextChef());
    modern.use('before-assemble', (ctx) => {
      ctx.inject(retrieved);
    });

    for (const target of ['openai', 'anthropic', 'gemini'] as const) {
      const a = await legacy.compile({ target });
      const b = await modern.compile({ target });
      expect(Assembler.stringifyPayload(b)).toBe(Assembler.stringifyPayload(a));
      expect(Assembler.stringifyPayload(a)).toContain('implicit_context');
    }
  });

  it('transformContext === use(after-assemble)', async () => {
    const drop = (messages: Message[]): Message[] => messages.filter((m) => m.content !== 'Sure.');

    const legacy = setUp(new ContextChef({ transformContext: drop }));
    const modern = setUp(new ContextChef());
    modern.use('after-assemble', drop);

    for (const target of ['openai', 'anthropic', 'gemini'] as const) {
      const a = await legacy.compile({ target });
      const b = await modern.compile({ target });
      expect(Assembler.stringifyPayload(b)).toBe(Assembler.stringifyPayload(a));
      expect(Assembler.stringifyPayload(a)).not.toContain('Sure.');
    }
  });

  it('legacy hooks run before handlers registered later with use()', async () => {
    const order: string[] = [];
    const chef = new ContextChef({
      onBeforeCompile: () => {
        order.push('legacy');
        return null;
      },
    }).setHistory([{ role: 'user', content: 'hi' }]);
    chef.use('before-assemble', () => {
      order.push('use');
    });

    await chef.compile({ target: 'openai' });

    expect(order).toEqual(['legacy', 'use']);
  });
});
