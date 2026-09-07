/**
 * `background()` — summarize off-turn and swap the result in later.
 */

import type { Message } from '../types';
import { messagesEquivalent } from './turns';
import {
  detachedRunner,
  type OverflowInput,
  type OverflowResult,
  type OverflowRunner,
  type OverflowStrategy,
  unchanged,
} from './types';

/**
 * An in-flight background job.
 *
 * `source` is the history the job was computed against — the staleness check
 * and the swap-in both derive their split index from it rather than storing it
 * a second time.
 */
interface BackgroundJob {
  settled: boolean;
  /** The inner strategy's result, or null while it runs and when it failed. */
  result: OverflowResult | null;
  source: Message[];
}

/**
 * Length of the common suffix of `a` and `b`, by object identity.
 *
 * Strategies keep the tail of the history they were handed BY REFERENCE, so
 * the common suffix of a result and the history it was computed from is
 * exactly the part that was preserved — everything before it is the span the
 * summary replaced. A strategy that recreates its tail degrades gracefully:
 * the swap-in then reuses the job's own tail instead of rebasing onto newer
 * messages.
 */
function commonSuffixLength(a: readonly Message[], b: readonly Message[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

export interface BackgroundOverflowStrategy extends OverflowStrategy {
  /** @internal The in-flight job, for the runner's background bookkeeping. */
  readonly pendingJob: { settled: boolean } | undefined;
}

/**
 * Moves `inner` off the critical path: the first over-budget compile returns
 * history UNCHANGED and starts the summarization in the background; a later
 * compile swaps the finished result in.
 *
 * The swap only happens while the result still applies — the compressed span
 * must still be the head of the current history, checked by content
 * equivalence rather than object identity (pipeline stages like
 * `transformToolResult` and `compact` recreate message objects without
 * changing their meaning, and a recreated-but-identical boundary must not
 * discard a finished job). Newer turns appended in the meantime are kept: the
 * summary replaces the span, the current tail stays.
 *
 * A discarded job leaves no trace: the inner strategy publishes state through
 * `commit`, which only ever runs for a result that entered the window, so an
 * `anchored()` anchor never absorbs a summary that was thrown away.
 *
 * Background state does not survive `snapshot()` / `restore()`.
 */
export function background(inner: OverflowStrategy): BackgroundOverflowStrategy {
  let job: BackgroundJob | undefined;
  let runner: OverflowRunner = detachedRunner;
  const name = `background(${inner.name})`;
  /** Rebased result → the inner result it was built from, for `commit`. */
  const rebased = new WeakMap<OverflowResult, OverflowResult>();

  const start = (input: OverflowInput): void => {
    const started: BackgroundJob = { settled: false, result: null, source: input.history };
    job = started;
    void inner
      .apply(input)
      .then((result) => {
        started.result = result;
      })
      .catch((error) => {
        // The inner strategy handles its own failures; this is a
        // belt-and-braces net for one that throws instead.
        runner.logger.warn('[context-chef] background compression job crashed unexpectedly', error);
      })
      .finally(() => {
        started.settled = true;
      });
  };

  /** The finished job applied to the current history, or null if it no longer applies. */
  const swapIn = (finished: BackgroundJob, input: OverflowInput): OverflowResult | null => {
    const result = finished.result;
    if (!result?.meta.changed) return null; // failed job — the breaker already counted it

    const keptCount = commonSuffixLength(result.history, finished.source);
    const splitIndex = finished.source.length - keptCount;
    const stillApplies =
      splitIndex > 0 &&
      input.history.length >= splitIndex &&
      messagesEquivalent(input.history[0], finished.source[0]) &&
      messagesEquivalent(input.history[splitIndex - 1], finished.source[splitIndex - 1]);
    if (!stillApplies) return null;

    const swapped: OverflowResult = {
      ...result,
      history: [
        ...result.history.slice(0, result.history.length - keptCount),
        ...input.history.slice(splitIndex),
      ],
      meta: { ...result.meta, strategy: name, windowId: input.window.current },
    };
    rebased.set(swapped, result);
    return swapped;
  };

  return {
    name,

    async apply(input: OverflowInput): Promise<OverflowResult> {
      if (job) {
        // Job still running — don't stack a second evaluation on top of it.
        if (!job.settled) return unchanged(input, name, 'background compression in flight');
        const finished = job;
        job = undefined;
        const swapped = swapIn(finished, input);
        if (swapped) return swapped;
        // The model did its work off-turn; the history simply moved under it.
        // The runner credits a result that lands, and this one never will, so
        // without this a flaky model interleaved with fast-moving history
        // would walk the breaker open on jobs that all succeeded.
        if (finished.result?.meta.changed) runner.succeed();
        // Failed or stale — discard it and evaluate fresh, unless the window
        // is not over the trigger: the runner then called in only to give the
        // finished job its chance, and starting another one would buy a
        // summary nobody asked for.
        if (!input.forced && input.budget.remaining >= 0) {
          return unchanged(input, name, 'within budget — the finished job no longer applies');
        }
      }
      start(input);
      return unchanged(input, name, 'background compression started');
    },

    commit(result) {
      inner.commit?.(rebased.get(result) ?? result);
    },

    snapshot: () => inner.snapshot?.(),

    restore(state) {
      // A pending job belongs to the pre-restore timeline — drop it. Its
      // promise keeps running and settles into an orphaned job object that
      // nothing reads.
      job = undefined;
      inner.restore?.(state);
    },

    attach(installed) {
      runner = installed;
      inner.attach?.(installed);
    },

    /**
     * A finished job with a usable result is waiting. Whether it still applies
     * to the current history is settled in `apply` — the check needs that
     * history, and this is asked before the runner has decided to run at all.
     */
    pending(): boolean {
      return job?.settled === true && job.result?.meta.changed === true;
    },

    get pendingJob(): { settled: boolean } | undefined {
      return job;
    },
  };
}
