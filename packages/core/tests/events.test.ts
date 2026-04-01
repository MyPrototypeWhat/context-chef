import { describe, expect, it, vi } from 'vitest';
import { type ChefEvents, ContextChef } from '../src/index';
import { InMemoryStore } from '../src/modules/memory/inMemoryStore';
import type { Message } from '../src/types';

const makeTokenizer =
  (tokensPerMsg: number) =>
  (messages: Message[]): number =>
    messages.length * tokensPerMsg;

const buildHistory = (count: number): Message[] =>
  Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `msg-${i + 1}`,
  }));

// ═══════════════════════════════════════════════════════
// compile:start / compile:done
// ═══════════════════════════════════════════════════════

describe('ContextChef events — compile lifecycle', () => {
  it('emits compile:start with systemPrompt and history', async () => {
    const chef = new ContextChef();
    const handler = vi.fn();

    chef.on('compile:start', handler);
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]);
    chef.setHistory([{ role: 'user', content: 'hello' }]);
    await chef.compile({ target: 'openai' });

    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0][0] as ChefEvents['compile:start'];
    expect(payload.systemPrompt).toHaveLength(1);
    expect(payload.history).toHaveLength(1);
  });

  it('emits compile:done with the final payload', async () => {
    const chef = new ContextChef();
    const handler = vi.fn();

    chef.on('compile:done', handler);
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]);
    chef.setHistory([{ role: 'user', content: 'hello' }]);
    await chef.compile({ target: 'openai' });

    expect(handler).toHaveBeenCalledTimes(1);
    const { payload } = handler.mock.calls[0][0] as ChefEvents['compile:done'];
    expect(payload.messages.length).toBeGreaterThan(0);
  });

  it('compile:start fires before compile:done', async () => {
    const chef = new ContextChef();
    const order: string[] = [];

    chef.on('compile:start', () => {
      order.push('start');
    });
    chef.on('compile:done', () => {
      order.push('done');
    });

    chef.setHistory([{ role: 'user', content: 'hi' }]);
    await chef.compile({ target: 'openai' });

    expect(order).toEqual(['start', 'done']);
  });
});

// ═══════════════════════════════════════════════════════
// compress event
// ═══════════════════════════════════════════════════════

describe('ContextChef events — compress', () => {
  it('emits compress event when Janitor compresses', async () => {
    const handler = vi.fn();
    const chef = new ContextChef({
      janitor: {
        contextWindow: 30,
        tokenizer: makeTokenizer(10),
        compressionModel: async () => '<history_summary>COMPRESSED</history_summary>',
      },
    });

    chef.on('compress', handler);
    chef.setHistory(buildHistory(5));
    await chef.compile({ target: 'openai' });

    expect(handler).toHaveBeenCalledTimes(1);
    const { summary, truncatedCount } = handler.mock.calls[0][0] as ChefEvents['compress'];
    expect(summary.role).toBe('user');
    expect(summary.content).toContain('COMPRESSED');
    expect(truncatedCount).toBeGreaterThan(0);
  });

  it('does NOT emit compress when no compression needed', async () => {
    const handler = vi.fn();
    const chef = new ContextChef({
      janitor: {
        contextWindow: 999999,
        tokenizer: makeTokenizer(10),
        compressionModel: async () => 'summary',
      },
    });

    chef.on('compress', handler);
    chef.setHistory(buildHistory(3));
    await chef.compile({ target: 'openai' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('user onCompress callback and event both fire', async () => {
    const callbackOrder: string[] = [];
    const userOnCompress = vi.fn(() => {
      callbackOrder.push('callback');
    });

    const chef = new ContextChef({
      janitor: {
        contextWindow: 30,
        tokenizer: makeTokenizer(10),
        compressionModel: async () => '<history_summary>S</history_summary>',
        onCompress: userOnCompress,
      },
    });

    chef.on('compress', () => {
      callbackOrder.push('event');
    });

    chef.setHistory(buildHistory(5));
    await chef.compile({ target: 'openai' });

    expect(userOnCompress).toHaveBeenCalledTimes(1);
    expect(callbackOrder).toEqual(['callback', 'event']);
  });
});

// ═══════════════════════════════════════════════════════
// memory:changed / memory:expired events
// ═══════════════════════════════════════════════════════

describe('ContextChef events — memory', () => {
  it('emits memory:changed on createMemory', async () => {
    const handler = vi.fn();
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });

    chef.on('memory:changed', handler);
    await chef.getMemory().createMemory('lang', 'TS');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual({
      type: 'set',
      key: 'lang',
      value: 'TS',
      oldValue: null,
    });
  });

  it('emits memory:changed on deleteMemory', async () => {
    const handler = vi.fn();
    const chef = new ContextChef({ memory: { store: new InMemoryStore() } });

    await chef.getMemory().set('key', 'val');
    chef.on('memory:changed', handler);
    await chef.getMemory().deleteMemory('key');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: 'delete',
      key: 'key',
      value: null,
      oldValue: 'val',
    });
  });

  it('emits memory:expired during compile when entry expires', async () => {
    const handler = vi.fn();
    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), defaultTTL: 1 },
    });

    await chef.getMemory().set('temp', 'will expire');
    chef.on('memory:expired', handler);

    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]);
    chef.setHistory([{ role: 'user', content: 'hi' }]);

    // First compile: turn 0→1, not expired yet
    await chef.compile({ target: 'openai' });
    expect(handler).not.toHaveBeenCalled();

    // Second compile: turn 1→2, sweep checks turnCount=1, 1 >= 1 → expired
    await chef.compile({ target: 'openai' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].key).toBe('temp');
    expect(handler.mock.calls[0][0].value).toBe('will expire');
  });

  it('user onMemoryChanged callback and event both fire', async () => {
    const callbackOrder: string[] = [];
    const userCallback = vi.fn(() => {
      callbackOrder.push('callback');
    });

    const chef = new ContextChef({
      memory: { store: new InMemoryStore(), onMemoryChanged: userCallback },
    });

    chef.on('memory:changed', () => {
      callbackOrder.push('event');
    });

    await chef.getMemory().set('key', 'val');

    expect(userCallback).toHaveBeenCalledTimes(1);
    expect(callbackOrder).toEqual(['callback', 'event']);
  });

  it('user onMemoryExpired callback and event both fire', async () => {
    const callbackOrder: string[] = [];
    const userCallback = vi.fn(() => {
      callbackOrder.push('callback');
    });

    const chef = new ContextChef({
      memory: {
        store: new InMemoryStore(),
        defaultTTL: 1,
        onMemoryExpired: userCallback,
      },
    });

    await chef.getMemory().set('temp', 'bye');
    chef.on('memory:expired', () => {
      callbackOrder.push('event');
    });

    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]);
    chef.setHistory([{ role: 'user', content: 'hi' }]);

    // Advance past expiry
    await chef.compile({ target: 'openai' });
    await chef.compile({ target: 'openai' });

    expect(userCallback).toHaveBeenCalledTimes(1);
    expect(callbackOrder).toEqual(['callback', 'event']);
  });
});

// ═══════════════════════════════════════════════════════
// off — unsubscribe
// ═══════════════════════════════════════════════════════

describe('ContextChef events — off', () => {
  it('off prevents handler from being called', async () => {
    const chef = new ContextChef();
    const handler = vi.fn();

    chef.on('compile:start', handler);
    chef.off('compile:start', handler);

    chef.setHistory([{ role: 'user', content: 'hi' }]);
    await chef.compile({ target: 'openai' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('on returns this for chaining', () => {
    const chef = new ContextChef();
    const result = chef.on('compile:start', () => {});
    expect(result).toBe(chef);
  });

  it('off returns this for chaining', () => {
    const chef = new ContextChef();
    const result = chef.off('compile:start', () => {});
    expect(result).toBe(chef);
  });
});
