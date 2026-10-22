import type { BudgetInfo, OverflowResult, OverflowWire } from '../overflow/types';
import type { Message } from '../types';
import type { PrefixLedger } from './ledger';
import type { PrefixHead } from './types';

/**
 * What an append-only window needs of the overflow runner. A `Janitor` is
 * one; so is the compile pipeline's host, which forwards to the chef's.
 */
export interface WindowRunner {
  /** One overflow pass over `history`, handed the timing this module decided. */
  overflow(
    history: Message[],
    options: {
      signal?: AbortSignal;
      force?: boolean;
      appendOnly?: boolean;
      midToolTurn?: boolean;
      pastLimit?: boolean;
      collapse?: boolean;
      wire?: OverflowWire;
    },
  ): Promise<OverflowResult>;
  /** The installed strategy is signed: handed a wire, it never waits for a tool turn to end. */
  readonly signedOverflow: boolean;
  /** The request about to be sent, counted on top of the last report (`appended`), or whole. */
  readRequestBudget(history: Message[], appended: Message[] | null): BudgetInfo;
  /** The raw context window. */
  readonly contextWindow: number;
  /** Drops a reported usage that may predate the last landed compression (E10). */
  dropStaleUsage(): void;
}

/** A pass of the runner over the window, and the head it puts in front of the host history when it landed. */
export interface WindowCompaction {
  /** `null` while a compaction waits for a tool turn to end. */
  readonly result: OverflowResult | null;
  /** Present when the result landed: the caller applies it as a `compaction` checkpoint. */
  readonly head?: PrefixHead;
}

/**
 * `appendOnly`: one overflow pass over `window`, the window `ledger` renders
 * over the host `history`, or none while a compaction waits for a tool turn
 * to end. A result that lands comes back with its head; the caller applies
 * it as a `compaction` checkpoint, so its head replaces the host messages it
 * summarized in every later window and nothing is summarized again until the
 * window is over budget once more. In the middle of a tool turn a compaction
 * waits for the turn to end, unless it cannot wait; then the whole window
 * collapses into the summary. One the provider signs (`onDemandCompaction`,
 * handed a `wire`) waits for nothing and strips nothing.
 */
export async function compactWindow(
  ledger: PrefixLedger,
  history: readonly Message[],
  window: Message[],
  runner: WindowRunner,
  options: { signal?: AbortSignal; forced?: boolean; wire?: OverflowWire } = {},
): Promise<WindowCompaction> {
  const { signal, forced = false, wire } = options;
  const midTurn = inToolTurn(history, ledger.head);
  // A signed strategy handed a wire waits for no tool turn to end.
  const waits = midTurn && !(runner.signedOverflow && wire !== undefined);
  const timing = compactionTiming(ledger, runner, window, forced, waits);
  if (timing === 'wait') return { result: null };
  const result = await runner.overflow(window, {
    signal,
    force: forced,
    appendOnly: true,
    midToolTurn: midTurn,
    pastLimit: timing === 'past-limit',
    collapse: timing === 'collapse',
    wire,
  });
  if (!result.meta.changed) return { result };
  return { result, head: compactionHead(window, result, history, ledger) };
}

/**
 * When a compaction may land (D3). Between turns, as in 4.x. There, once the
 * request about to be sent is past the raw context window (`'past-limit'`),
 * nothing may wait for a later compile, a background job included, and the
 * runner's own verdict, which may read only an earlier report, does not
 * decide. While a tool turn is in progress (`midTurn`) it waits for the turn
 * to end: the turns it keeps lose their thinking, and the one in progress
 * still needs it. It cannot wait once the model asked for a new window or
 * the request is past the raw context window; then it collapses the whole
 * window.
 *
 * A signed strategy, handed a wire, has nothing to wait for: the turns it
 * keeps keep their thinking, the one in progress included, so it lands in a
 * tool turn as it does between turns, and is told it is in one
 * (`midToolTurn`) for a fallback it may run instead.
 */
function compactionTiming(
  ledger: PrefixLedger,
  runner: WindowRunner,
  window: Message[],
  forced: boolean,
  midTurn: boolean,
): 'now' | 'past-limit' | 'wait' | 'collapse' {
  if (midTurn && forced) return 'collapse';
  const past = pastLimit(ledger, runner, window);
  if (!midTurn) return past ? 'past-limit' : 'now';
  return past ? 'collapse' : 'wait';
}

/**
 * Whether the request about to be sent is past the raw context window. With
 * none configured (the default) nothing is read: nothing can be past it.
 *
 * Reading consumes no reported usage, so a compile that waits leaves it for
 * the one that ends the turn — except one that predates the last landing,
 * which the first reading after it drops (E10). A report describes the
 * request it came back for, possibly several compiles ago, so everything the
 * window gained since that request is counted on top of it. Once a message of
 * that request changed, the report counts a payload that no longer exists,
 * and the whole window is counted locally instead.
 */
function pastLimit(ledger: PrefixLedger, runner: WindowRunner, window: Message[]): boolean {
  runner.dropStaleUsage();
  if (!Number.isFinite(runner.contextWindow)) return false;
  // A usage fed past `reportTokenUsage()` is taken to cover the window last
  // committed; one that describes none of the window is no report at all.
  const covered = ledger.reportCovers() ?? ledger.stable();
  const { current, limit } = runner.readRequestBudget(
    window,
    covered > 0 ? window.slice(covered) : null,
  );
  return current > limit;
}

/**
 * Whether a tool turn is in progress: the host history after the head ends,
 * past any system messages, in tool results or in tool calls not answered yet.
 */
function inToolTurn(history: readonly Message[], head?: PrefixHead): boolean {
  for (let i = history.length - 1; i >= (head?.cut ?? 0); i--) {
    const message = history[i];
    if (message.role === 'system') continue;
    return (
      message.role === 'tool' || (message.role === 'assistant' && !!message.tool_calls?.length)
    );
  }
  return false;
}

/**
 * The head a landed result puts in front of the host history. A strategy
 * keeps the end of the window it was handed by reference, so the first host
 * message of that kept end is where the host history resumes (`cut`), and
 * everything the result puts before it is the replacement: the summary,
 * pinned messages put back, and whatever of the previous head it kept.
 * Events kept ahead of that message go with what was summarized — the ledger
 * drops entries that render before `host[cut]`, and the caller states their
 * sources again. A result that kept no host message replaces them all.
 * A result the provider signed is a signed head: nothing is stripped.
 */
function compactionHead(
  window: readonly Message[],
  result: OverflowResult,
  history: readonly Message[],
  ledger: PrefixLedger,
): PrefixHead {
  const landed = result.history;
  const previous = ledger.head?.replacement ?? [];
  // The window is the head, then the host messages from its cut with the
  // events among them: walk it to find which messages are host ones.
  let next = ledger.head?.cut ?? 0;
  const hostIndex = window.map((message) =>
    next < history.length && message === history[next] ? next++ : -1,
  );
  let kept = 0;
  while (
    kept < window.length &&
    kept < landed.length &&
    window[window.length - 1 - kept] === landed[landed.length - 1 - kept]
  ) {
    kept++;
  }
  const start = window.length - kept;
  let first = start;
  while (first < window.length && hostIndex[first] === -1) first++;
  return {
    cut: first < window.length ? hostIndex[first] : history.length,
    replacement: [
      ...landed.slice(0, landed.length - kept),
      ...window.slice(start, first).filter((message) => previous.includes(message)),
    ],
    signed: result.meta.signed !== undefined,
  };
}
