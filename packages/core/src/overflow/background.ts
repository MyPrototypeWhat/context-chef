/**
 * `background()` — summarize off-turn and swap the result in later.
 */

import { sameOnWire, wireDigest } from '../prefix/ledger';
import type { Message } from '../types';
import { extractPinnedMessages, messagesEquivalent } from './turns';
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
  /**
   * `appendOnly`: each message of `source` as the job read it, taken when it
   * started — a host may change the very object afterwards.
   */
  read?: readonly MessageRead[];
}

/** What a job read of one message: its wire digest, and whether it was pinned. */
interface MessageRead {
  readonly digest: string;
  readonly pinned: boolean;
}

function readOf(messages: readonly Message[]): MessageRead[] {
  return messages.map((message) => ({ digest: wireDigest(message), pinned: !!message.pinned }));
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

/**
 * Whether `job`, whose first `splitIndex` messages of its `source` it
 * summarized, still applies to `input.history`.
 *
 * The `appendOnly` window only grows at its end until a checkpoint rewrites
 * it, so there a job is fresh exactly while the window still starts with
 * what the job read: every message the same on the wire as when the job
 * started, compared by the ledger's digest whether or not it is the same
 * object — the ledger renders its events anew on every compile, a host may
 * move a cache breakpoint, and a host may also edit the very object the job
 * read — and in the span it summarized, pinned exactly when the job started,
 * since what was pinned went back verbatim and what was not into the
 * summary. A 4.x history may be recreated and compacted in place, so only
 * the two ends of the span are compared, by content.
 */
function stillApplies(job: BackgroundJob, input: OverflowInput, splitIndex: number): boolean {
  const { history } = input;
  if (input.appendOnly) {
    const read = job.read ?? readOf(job.source);
    return (
      read.length <= history.length &&
      read.every(
        ({ digest, pinned }, i) =>
          (i >= splitIndex || pinned === !!history[i].pinned) && digest === wireDigest(history[i]),
      )
    );
  }
  const { source } = job;
  return (
    history.length >= splitIndex &&
    messagesEquivalent(history[0], source[0]) &&
    messagesEquivalent(history[splitIndex - 1], source[splitIndex - 1])
  );
}

/**
 * Whether a signed `result` may still land on `input.history`, whose first
 * `splitIndex` messages it replaces: the provider signed it over the request
 * those messages made then, so the wire must still render them as that
 * request — a system prompt or tool list changed since, or thinking stripped
 * since, is a request it was never signed over. Unsigned results always may.
 */
function stillSigned(result: OverflowResult, input: OverflowInput, splitIndex: number): boolean {
  const signed = result.meta.signed;
  if (!signed) return true;
  const { wire } = input;
  return (
    wire?.history === input.history && sameOnWire(wire.renderPrefix(splitIndex), signed.request)
  );
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
 * Under `appendOnly` the compile pipeline calls in only between turns, so a
 * job starts and lands only there, never while a tool turn is in progress —
 * unless `inner` is signed, whose results need not wait for a turn to end.
 * It still applies while the window it ran on is the start of the current
 * one — the window only grew; a checkpoint that rewrote anything in it, the
 * turns the job kept included, makes it stale. A signed job also needs the
 * wire to render the request it was signed over exactly as before: a system
 * prompt or tool list changed since rewrites no message, but it is a request
 * the provider never signed. Two windows cannot wait a
 * compile for a job. One that collapses gets `inner` on the spot, and any
 * job, on an earlier window, is dropped. A request past the raw context
 * window (`pastLimit`) takes a finished job that still applies — and `inner`
 * on top of it when what the job leaves still counts past the window — and
 * otherwise gets `inner` on the spot too, in place of a job starting, in
 * flight or gone stale.
 *
 * Background state does not survive `snapshot()` / `restore()`.
 */
export function background(inner: OverflowStrategy): BackgroundOverflowStrategy {
  let job: BackgroundJob | undefined;
  let runner: OverflowRunner = detachedRunner;
  const name = `background(${inner.name})`;
  /** A result this strategy returned → the inner results it was built from, for `commit`. */
  const built = new WeakMap<OverflowResult, OverflowResult[]>();

  /**
   * `inner` applied on this compile, reported under this strategy's name, for
   * a window that cannot wait for a job. Any job is dropped; a finished one
   * did its work, it just has no window left to land in.
   */
  const now = async (input: OverflowInput): Promise<OverflowResult> => {
    if (job?.result?.meta.changed) runner.succeed();
    job = undefined;
    const result = await inner.apply(input);
    const named: OverflowResult = { ...result, meta: { ...result.meta, strategy: name } };
    built.set(named, [result]);
    return named;
  };

  /**
   * A landed job under `pastLimit`, with `inner` run on the window it leaves
   * when that still counts past the raw context window: both are one
   * overflow, covering what either summarized and leaving what the second
   * left. When the second changes nothing, the job still lands, but `partial`:
   * the window is past the raw context window all the same, and whatever
   * failure the second counted stays counted. The job is credited before the
   * second runs, so that failure is the only one counted.
   *
   * A signed job's block was never sent, so no request can be signed over
   * the window it leaves: `inner` runs on the window this compile was handed
   * instead, and what it returns takes the job's place.
   */
  const fitLanded = async (
    landed: OverflowResult,
    input: OverflowInput,
  ): Promise<OverflowResult> => {
    if (input.tokenizer(landed.history) <= input.budget.limit) return landed;
    runner.succeed();
    const steps = built.get(landed) ?? [landed];
    const again = await inner.apply(
      landed.meta.signed
        ? input
        : {
            ...input,
            history: landed.history,
            // Read off the landed window as the runner reads its own: what the job
            // put back as pinned is the job's copy, not the object the host handed in.
            pinned: extractPinnedMessages(landed.history),
          },
    );
    if (!again.meta.changed) {
      const partial: OverflowResult = { ...landed, meta: { ...landed.meta, partial: true } };
      built.set(partial, steps);
      return partial;
    }
    if (landed.meta.signed) {
      const named: OverflowResult = { ...again, meta: { ...again.meta, strategy: name } };
      built.set(named, [again]);
      return named;
    }
    const both: OverflowResult = {
      history: again.history,
      evicted: [...landed.evicted, ...again.evicted],
      span: [...new Set([...landed.span, ...again.span])],
      summary: again.summary,
      meta: landed.meta,
    };
    built.set(both, [...steps, again]);
    return both;
  };

  const start = (input: OverflowInput): void => {
    const started: BackgroundJob = {
      settled: false,
      result: null,
      source: input.history,
      ...(input.appendOnly ? { read: readOf(input.history) } : {}),
    };
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
    if (
      splitIndex <= 0 ||
      !stillApplies(finished, input, splitIndex) ||
      !stillSigned(result, input, splitIndex)
    ) {
      return null;
    }

    const swapped: OverflowResult = {
      ...result,
      history: [
        ...result.history.slice(0, result.history.length - keptCount),
        ...input.history.slice(splitIndex),
      ],
      meta: { ...result.meta, strategy: name, windowId: input.window.current },
    };
    built.set(swapped, [result]);
    return swapped;
  };

  return {
    name,
    ...(inner.signed ? { signed: true as const } : {}),
    parts: [inner],

    async apply(input: OverflowInput): Promise<OverflowResult> {
      if (input.collapse) return now(input);
      if (job?.settled) {
        const finished = job;
        job = undefined;
        const swapped = swapIn(finished, input);
        if (swapped) return input.pastLimit ? fitLanded(swapped, input) : swapped;
        // The model did its work off-turn; the history simply moved under it.
        // The runner credits a result that lands, and this one never will, so
        // without this a flaky model interleaved with fast-moving history
        // would walk the breaker open on jobs that all succeeded.
        if (finished.result?.meta.changed) runner.succeed();
        // Failed or stale — discard it and evaluate fresh, unless the window
        // is not over the trigger: the runner then called in only to give the
        // finished job its chance, and starting another one would buy a
        // summary nobody asked for.
        if (!input.forced && !input.pastLimit && input.budget.remaining >= 0) {
          return unchanged(input, name, 'within budget — the finished job no longer applies');
        }
      } else if (job && !input.pastLimit) {
        // Job still running — don't stack a second evaluation on top of it.
        return unchanged(input, name, 'background compression in flight');
      }
      if (input.pastLimit) return now(input);
      start(input);
      return unchanged(input, name, 'background compression started');
    },

    commit(result) {
      for (const step of built.get(result) ?? [result]) inner.commit?.(step);
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
