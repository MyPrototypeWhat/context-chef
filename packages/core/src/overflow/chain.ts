/**
 * `chain()` — escalation: try the next strategy when the previous one did not
 * get the window under control.
 */

import type { Message } from '../types';
import { type OverflowInput, type OverflowResult, type OverflowStrategy, unchanged } from './types';

/**
 * Runs strategies in order, moving on when the previous one changed nothing
 * OR left the history still above the trigger. Stops at the first strategy
 * that brings the window back under budget.
 *
 * The classic use is escalation: summarize normally, and when summarization
 * declines — a model outage, a summary that failed the shrink guard — fall
 * back to something that always works.
 *
 * @example
 * overflow: { strategy: chain(summarize({ compressionModel }), reset()) }
 */
export function chain(...strategies: OverflowStrategy[]): OverflowStrategy {
  const name = `chain(${strategies.map((s) => s.name).join('>')})`;
  /** Composed result → the steps that produced it, for `commit`. */
  const steps = new WeakMap<OverflowResult, Array<[OverflowStrategy, OverflowResult]>>();

  return {
    name,
    async apply(input: OverflowInput): Promise<OverflowResult> {
      let history = input.history;
      let pinned = input.pinned;
      const evicted: Message[] = [];
      let summary: string | undefined;
      let reason: string | undefined;
      const contributions: Array<[OverflowStrategy, OverflowResult]> = [];

      for (const strategy of strategies) {
        const result = await strategy.apply({ ...input, history, pinned });
        if (!result.meta.changed) {
          reason = result.meta.reason;
          continue;
        }

        contributions.push([strategy, result]);
        history = result.history;
        evicted.push(...result.evicted);
        summary = result.summary;
        // Pinned messages that are still in the window stay protected for the
        // strategies that come after this one.
        const inWindow = new Set(history);
        pinned = input.pinned.filter((m) => inWindow.has(m));

        if (input.tokenizer(history) <= input.budget.trigger) {
          reason = undefined;
          break;
        }
        reason = `still above the trigger after ${strategy.name}`;
      }

      if (contributions.length === 0) {
        return unchanged(input, name, reason ?? 'no strategy changed the window');
      }

      const composed: OverflowResult = {
        history,
        evicted,
        summary,
        meta: { strategy: name, windowId: input.window.current, changed: true, reason },
      };
      steps.set(composed, contributions);
      return composed;
    },

    commit(result) {
      for (const [strategy, step] of steps.get(result) ?? []) strategy.commit?.(step);
    },

    snapshot: () => strategies.map((s) => s.snapshot?.()),

    restore(state) {
      const states = Array.isArray(state) ? state : [];
      strategies.forEach((s, i) => {
        s.restore?.(states[i]);
      });
    },

    attach(runner) {
      for (const s of strategies) s.attach?.(runner);
    },
  };
}
