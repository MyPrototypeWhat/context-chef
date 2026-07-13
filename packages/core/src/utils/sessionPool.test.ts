import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_KEY,
  dedupeConstructionWarnings,
  normalizeSessionKey,
  SessionPool,
} from './sessionPool';

describe('SessionPool', () => {
  it('returns the same instance for the same key', () => {
    let n = 0;
    const pool = new SessionPool(() => ({ id: n++ }));

    const first = pool.get('a');
    expect(pool.get('a')).toBe(first);
    expect(first.id).toBe(0);
  });

  it('creates distinct instances per key', () => {
    let n = 0;
    const pool = new SessionPool(() => ({ id: n++ }));

    expect(pool.get('a').id).toBe(0);
    expect(pool.get('b').id).toBe(1);
  });

  it('evicts the least-recently-used entry beyond maxSize', () => {
    let n = 0;
    const pool = new SessionPool(() => ({ id: n++ }), { maxSize: 2 });

    const a = pool.get('a'); // id 0
    pool.get('b'); // id 1
    pool.get('a'); // touch a — b becomes LRU
    pool.get('c'); // id 2 — evicts b

    expect(pool.get('a')).toBe(a); // still cached
    expect(pool.get('b').id).toBe(3); // was evicted, recreated
  });

  it('exposes the current entry count', () => {
    const pool = new SessionPool(() => ({}), { maxSize: 10 });
    pool.get('a');
    pool.get('b');
    expect(pool.size).toBe(2);
  });

  it('rejects zero, negative, and non-integer maxSize', () => {
    expect(() => new SessionPool(() => ({}), { maxSize: 0 })).toThrow(RangeError);
    expect(() => new SessionPool(() => ({}), { maxSize: -1 })).toThrow(RangeError);
    expect(() => new SessionPool(() => ({}), { maxSize: 1.5 })).toThrow(RangeError);
    expect(() => new SessionPool(() => ({}), { maxSize: Number.NaN })).toThrow(RangeError);
  });

  it('accepts maxSize 1 and still caches the single entry', () => {
    const pool = new SessionPool(() => ({}), { maxSize: 1 });
    expect(pool.get('a')).toBe(pool.get('a'));
  });
});

describe('normalizeSessionKey', () => {
  it('passes non-empty strings through', () => {
    expect(normalizeSessionKey('user-1')).toBe('user-1');
  });

  it('maps absent values to the default key without flagging', () => {
    const onInvalid = vi.fn();
    expect(normalizeSessionKey(undefined, onInvalid)).toBe(DEFAULT_SESSION_KEY);
    expect(normalizeSessionKey(null, onInvalid)).toBe(DEFAULT_SESSION_KEY);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('maps present-but-unusable values to the default key and flags them', () => {
    const onInvalid = vi.fn();
    expect(normalizeSessionKey('', onInvalid)).toBe(DEFAULT_SESSION_KEY);
    expect(normalizeSessionKey(42, onInvalid)).toBe(DEFAULT_SESSION_KEY);
    expect(normalizeSessionKey({ id: 'x' }, onInvalid)).toBe(DEFAULT_SESSION_KEY);
    expect(onInvalid).toHaveBeenCalledTimes(3);
  });
});

describe('dedupeConstructionWarnings', () => {
  it('dedupes identical construction-time warnings across instances but passes runtime warnings through', () => {
    const warn = vi.fn();
    const factory = dedupeConstructionWarnings({ warn }, (constructionLogger) => {
      constructionLogger.warn('config nag');
      return { logger: constructionLogger };
    });

    const first = factory();
    factory();
    expect(warn).toHaveBeenCalledTimes(1); // nag fired once despite two constructions

    first.logger.warn('runtime issue');
    first.logger.warn('runtime issue');
    expect(warn).toHaveBeenCalledTimes(3); // post-construction warnings never deduped
  });
});
