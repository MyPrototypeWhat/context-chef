/**
 * The reset notice is the only thing the model reads about the span that just
 * left, so what it claims has to be true whether or not an archive exists.
 */

import { describe, expect, it } from 'vitest';
import { Assembler, type ChefConfig, ContextChef } from '../index';
import type { ChefLogger, Message } from '../types';
import { reset } from './reset';
import type { OverflowInput } from './types';

const tokenizer = (messages: Message[]): number => messages.length * 10;

const history = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `msg-${i + 1}`,
  }));

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

/** In-memory VFS adapter — keeps the archive off the filesystem. */
const memoryVfs = () => {
  const files = new Map<string, string>();
  return {
    write: async (filename: string, content: string) => {
      files.set(filename, content);
    },
    read: async (filename: string) => files.get(filename) ?? null,
    exists: async (filename: string) => files.has(filename),
  };
};

const silent: ChefLogger = { warn: () => {} };

const chefWith = (overflow: ChefConfig['overflow'], tools?: ChefConfig['tools']) =>
  new ContextChef({
    logger: silent,
    vfs: { threshold: 999999, adapter: memoryVfs() },
    janitor: { contextWindow: 30, triggerRatio: 1, tokenizer },
    overflow,
    tools,
  }).setHistory(history(5));

describe('reset() — the default notice claims nothing about an archive', () => {
  it('states the reset and the lineage, and nothing about archiving', async () => {
    const result = await reset().apply(makeInput());

    expect(result.summary).toBe(
      'Context window reset (window w_first). Earlier conversation was cleared from the window.',
    );
    expect(result.summary).not.toContain('archiv');
  });

  it('names the closed window and its predecessor', async () => {
    const result = await reset().apply(
      makeInput({ window: { first: 'w_a', previous: 'w_a', current: 'w_b' } }),
    );

    expect(result.summary).toBe(
      'Context window reset (window w_b; previous w_a). Earlier conversation was cleared from the window.',
    );
  });

  it('the archive fact reaches the model once, from the runner that owns it', async () => {
    const payload = await chefWith({ strategy: reset(), archive: 'vfs' }).compile({
      target: 'openai',
    });
    const wire = Assembler.stringifyPayload(payload);

    expect(wire).toContain('Earlier conversation was cleared from the window.');
    const uri = wire.match(/context:\/\/vfs\/[a-z0-9_.-]+/i)?.[0];
    expect(uri).toBeDefined();
    expect(wire).toContain(`archived in full at ${uri}`);
    expect(wire.match(/archived in full/g)).toHaveLength(1);
  });

  it('says nothing about an archive when none is configured', async () => {
    const payload = await chefWith({ strategy: reset() }).compile({ target: 'openai' });
    const wire = Assembler.stringifyPayload(payload);

    expect(wire).toContain('Earlier conversation was cleared from the window.');
    expect(wire).not.toContain('archiv');
    expect(wire).not.toContain('context://vfs/');
  });

  it('says nothing about an archive under the unified vocabulary either', async () => {
    // Unified re-renders the notice through the summary wrapper even with no
    // citation to add, so the claim has to survive a second pass.
    const payload = await chefWith({ strategy: reset() }, 'unified').compile({ target: 'openai' });
    const wire = Assembler.stringifyPayload(payload);

    expect(wire).toContain('Earlier conversation was cleared from the window.');
    expect(wire).not.toContain('archiv');
  });

  it('uses a caller notice verbatim', async () => {
    const result = await reset({ notice: 'Starting over.' }).apply(makeInput());

    expect(result.summary).toBe('Starting over.');
  });
});
