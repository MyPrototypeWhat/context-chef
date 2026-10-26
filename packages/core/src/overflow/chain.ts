/**
 * `chain()` — escalation: try the next strategy when the previous one did not
 * get the window under control.
 */

import type { Message } from '../types';
import { extractPinnedMessages } from './turns';
import { type OverflowInput, type OverflowResult, type OverflowStrategy, unchanged } from './types';

/**
 * Runs strategies in order, moving on when the previous one changed nothing
 * OR left the history still above the trigger. Stops at the first strategy
 * that brings the window back under budget.
 *
 * A call made only so a finished result can land (`pendingOnly`) runs only
 * the steps holding one: nothing new is summarized for it.
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
    ...(strategies.length > 0 && strategies.every((s) => s.signed)
      ? { signed: true as const }
      : {}),
    parts: strategies,
    async apply(input: OverflowInput): Promise<OverflowResult> {
      let history = input.history;
      let pinned = input.pinned;
      const handed = new Set(input.pinned);
      const evicted: Message[] = [];
      /** Every message any step compressed, in order, each one once. */
      const span = new Set<Message>();
      let summary: string | undefined;
      let reason: string | undefined;
      const contributions: Array<[OverflowStrategy, OverflowResult]> = [];
      // A call made only to land a finished result goes to the steps holding one.
      const runnable = input.pendingOnly
        ? strategies.filter((strategy) => strategy.pending?.() === true)
        : strategies;

      for (const strategy of runnable) {
        // A compile aborted during an earlier step sends nothing: a later step
        // must not take a finished background job only for it to be thrown away.
        input.signal?.throwIfAborted();
        const result = await strategy.apply({ ...input, history, pinned });
        if (!result.meta.changed) {
          reason = result.meta.reason;
          continue;
        }

        contributions.push([strategy, result]);
        history = result.history;
        evicted.push(...result.evicted);
        for (const message of result.span) span.add(message);
        summary = result.summary;
        // Pinned messages that are still in the window stay protected for the
        // strategies that come after this one: those the caller handed in, and
        // those the window flags as the runner reads them — a landed
        // background job put back its own copies, not the host's objects.
        const derived = new Set(extractPinnedMessages(history));
        pinned = history.filter((m) => handed.has(m) || derived.has(m));

        if (input.tokenizer(history) <= input.budget.trigger) {
          reason = undefined;
          break;
        }
        reason = `still above the trigger after ${strategy.name}`;
      }

      if (contributions.length === 0) {
        return unchanged(input, name, reason ?? 'no strategy changed the window');
      }

      // A step that landed without a step it needed stays partial whatever came
      // after it, so the runner keeps the failure it counted.
      const partial = contributions.some(([, step]) => step.meta.partial);
      // A signed result is the window only while no other step changed it.
      const signed = contributions.length === 1 ? contributions[0][1].meta.signed : undefined;
      const composed: OverflowResult = {
        history,
        evicted,
        span: [...span],
        summary,
        meta: {
          strategy: name,
          windowId: input.window.current,
          changed: true,
          reason,
          ...(partial ? { partial: true as const } : {}),
          ...(signed ? { signed } : {}),
        },
      };
      steps.set(composed, contributions);
      return composed;
    },

    commit(result) {
      for (const [strategy, step] of steps.get(result) ?? []) strategy.commit?.(step);
    },

    // A wrapped `background()` anywhere in the chain still has to be able to
    // land its finished job.
    pending: () => strategies.some((s) => s.pending?.() === true),

    discard() {
      for (const s of strategies) s.discard?.();
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
