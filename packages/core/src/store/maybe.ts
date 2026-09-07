import type { MaybePromise } from './types';

/**
 * Applies `fn` to a sync-or-async value without forcing the synchronous path
 * to become asynchronous. This is what lets one Store serve both
 * `Offloader.offload()` (sync) and `Offloader.offloadAsync()` from the same code.
 */
export function chain<A, B>(
  value: MaybePromise<A>,
  fn: (a: A) => MaybePromise<B>,
): MaybePromise<B> {
  return value instanceof Promise ? value.then(fn) : fn(value);
}
