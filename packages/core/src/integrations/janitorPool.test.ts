import { describe, expect, it, vi } from 'vitest';
import type { Janitor } from '../modules/janitor';
import type { Message } from '../types';
import { createJanitorPool, type JanitorPoolConfig } from './janitorPool';

const history = (count: number): Message[] =>
  Array.from({ length: count }, (_, i) => ({ role: 'user' as const, content: `msg-${i + 1}` }));

/** Host format for these tests: the plain content strings. */
const toHostMessages = (messages: Message[]): string[] => messages.map((m) => m.content);

function config(overrides: Partial<JanitorPoolConfig<string[]>> = {}): JanitorPoolConfig<string[]> {
  return {
    contextWindow: 100,
    toHostMessages,
    persistenceWarning: (firedCount) => `fired ${firedCount}× without onCompress`,
    logger: { warn: vi.fn() },
    ...overrides,
  };
}

/** Drives one compression on `janitor` by reporting usage above the budget. */
async function compressOnce(janitor: Janitor) {
  janitor.feedTokenUsage(10_000);
  await janitor.compress(history(4));
}

describe('createJanitorPool', () => {
  it('returns null when no option signals compression intent', () => {
    expect(createJanitorPool(config())).toBeNull();
  });

  it.each([
    'compress',
    'onCompress',
    'onBeforeCompress',
  ] as const)('requires a contextWindow once %s is configured', (option) => {
    expect(() => createJanitorPool(config({ contextWindow: undefined, [option]: {} }))).toThrow(
      /`contextWindow` is required/,
    );
  });

  it('creates one Janitor per session key and reuses it', () => {
    const pool = createJanitorPool(config({ compress: {} }));
    if (!pool) throw new Error('expected a pool');

    expect(pool.get('a')).toBe(pool.get('a'));
    expect(pool.get('a')).not.toBe(pool.get('b'));
    expect(pool.size).toBe(2);
  });

  it('evicts least-recently-used sessions beyond maxSessions', () => {
    const pool = createJanitorPool(config({ compress: {}, maxSessions: 1 }));
    if (!pool) throw new Error('expected a pool');

    pool.get('a');
    pool.get('b');
    expect(pool.size).toBe(1);
  });

  it('warns once, from the third compression, when no onCompress is configured', async () => {
    const logger = { warn: vi.fn() };
    const pool = createJanitorPool(
      config({ compress: {}, logger, compressionModel: async () => 'summary' }),
    );
    if (!pool) throw new Error('expected a pool');
    const persistenceWarns = () =>
      logger.warn.mock.calls.filter(([m]) => String(m).includes('without onCompress'));

    // One fire per session — a Janitor suppresses its own next compression.
    // The count is per pool, so it spans sessions.
    await compressOnce(pool.get('s1'));
    await compressOnce(pool.get('s2'));
    expect(persistenceWarns()).toEqual([]);

    await compressOnce(pool.get('s3'));
    await compressOnce(pool.get('s4'));
    expect(persistenceWarns()).toEqual([['fired 3× without onCompress']]);
  });

  it('forwards the summary and the host-shaped compressed slice to onCompress, silently', async () => {
    const logger = { warn: vi.fn() };
    const onCompress = vi.fn();
    const pool = createJanitorPool(
      config({ compress: {}, logger, onCompress, compressionModel: async () => 'summary' }),
    );
    if (!pool) throw new Error('expected a pool');

    for (const session of ['s1', 's2', 's3', 's4']) await compressOnce(pool.get(session));

    expect(onCompress).toHaveBeenCalledTimes(4);
    const [summary, truncatedCount, details] = onCompress.mock.calls[0];
    expect(typeof summary).toBe('string');
    expect(truncatedCount).toBeGreaterThan(0);
    expect(details.compressedMessages).toEqual(expect.arrayContaining(['msg-1']));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('without onCompress'));
  });

  it("sanitizes usagePreference 'tokenizerFirst' to 'max' when no tokenizer is configured", () => {
    const logger = { warn: vi.fn() };
    const pool = createJanitorPool(
      config({ compress: { usagePreference: 'tokenizerFirst' }, logger }),
    );
    if (!pool) throw new Error('expected a pool');

    pool.get('s1');
    pool.get('s2');

    // Construction-time nag: identical for every pooled Janitor, so logged once.
    expect(
      logger.warn.mock.calls.filter(([m]) => String(m).includes('usagePreference')),
    ).toHaveLength(1);
  });

  it('keeps tokenizerFirst when a tokenizer is configured', () => {
    const logger = { warn: vi.fn() };
    const pool = createJanitorPool(
      config({
        compress: { usagePreference: 'tokenizerFirst' },
        tokenizer: (messages) => messages.length,
        logger,
      }),
    );
    if (!pool) throw new Error('expected a pool');

    pool.get('s1');
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('usagePreference'));
  });
});
