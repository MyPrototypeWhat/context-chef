import { describe, expect, it, vi } from 'vitest';
import { TypedEventEmitter } from './eventEmitter';

interface TestEvents {
  hello: { name: string };
  count: { n: number };
}

describe('TypedEventEmitter', () => {
  it('on + emit delivers payload to handler', async () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const handler = vi.fn();

    emitter.on('hello', handler);
    await emitter.emit('hello', { name: 'world' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ name: 'world' });
  });

  it('supports multiple handlers on the same event', async () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('hello', h1);
    emitter.on('hello', h2);
    await emitter.emit('hello', { name: 'test' });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('off removes handler — no longer called on emit', async () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const handler = vi.fn();

    emitter.on('hello', handler);
    emitter.off('hello', handler);
    await emitter.emit('hello', { name: 'ignored' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('off only removes the specific handler', async () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const removed = vi.fn();
    const kept = vi.fn();

    emitter.on('hello', removed);
    emitter.on('hello', kept);
    emitter.off('hello', removed);
    await emitter.emit('hello', { name: 'test' });

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('emit on event with no listeners is a no-op', async () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    await expect(emitter.emit('hello', { name: 'nobody' })).resolves.toBeUndefined();
  });

  it('events are isolated by name', async () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const helloHandler = vi.fn();
    const countHandler = vi.fn();

    emitter.on('hello', helloHandler);
    emitter.on('count', countHandler);
    await emitter.emit('hello', { name: 'test' });

    expect(helloHandler).toHaveBeenCalledTimes(1);
    expect(countHandler).not.toHaveBeenCalled();
  });

  it('supports async handlers (awaited sequentially)', async () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const order: number[] = [];

    emitter.on('count', async ({ n }) => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(n);
    });
    emitter.on('count', async () => {
      order.push(999);
    });

    await emitter.emit('count', { n: 1 });

    // First handler (slow) should finish before second handler runs
    expect(order).toEqual([1, 999]);
  });

  it('on() returns this for chaining', () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const result = emitter.on('hello', () => {});
    expect(result).toBe(emitter);
  });

  it('off() returns this for chaining', () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const result = emitter.off('hello', () => {});
    expect(result).toBe(emitter);
  });
});
