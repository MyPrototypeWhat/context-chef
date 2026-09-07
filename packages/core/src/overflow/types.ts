/**
 * The overflow axis: what leaves the context window when it fills up.
 *
 * A strategy is handed the in-window history plus the budget that was blown
 * and returns the new window contents together with everything that left it.
 * Archiving, budget evaluation, the circuit breaker and the `compress:*`
 * events stay with the runner ({@link Janitor}) — a strategy is pure policy.
 */

import type { ChefLogger, Message } from '../types';

/**
 * Token budget of one compile, as read by the overflow runner.
 *
 * `limit` is the raw context window; `trigger` is the threshold compression
 * actually fires at (`limit * triggerRatio`). `current` is the runner's own
 * reading — the configured tokenizer combined with the last
 * `feedTokenUsage()` value according to `usagePreference`, or the built-in
 * heuristic when neither is available.
 */
export interface BudgetInfo {
  /** Raw context window in tokens (`janitor.contextWindow`). */
  limit: number;
  /** Estimated tokens the current history occupies. */
  current: number;
  /** Effective trigger threshold: `limit * triggerRatio`. */
  trigger: number;
  /** Headroom before the trigger. Negative once history is over budget. */
  remaining: number;
}

/**
 * Lineage of the context window an overflow operates on.
 *
 * The runner ({@link Janitor}) owns exactly one of these per session and moves
 * it forward whenever an overflow result actually enters the window: the id
 * that was `current` becomes `previous`, and a fresh id takes its place. A
 * result computed speculatively and then discarded (a stale `background()`
 * job) never moves it — the chain records windows that existed, not windows
 * that were considered.
 *
 * Strategies key their per-window state by `current` (see `anchored()`), and
 * `CompileMeta.windowId` reports it, so the same id identifies a window in
 * strategy state, compile metadata and the `reset()` notice.
 */
export interface WindowLineage {
  /** The first window of this lineage. Fixed for the life of the lineage. */
  readonly first: string;
  /** The window `current` replaced. Absent until the first overflow lands. */
  previous?: string;
  /** The window in effect right now. */
  current: string;
}

/** Opaque, sortable-enough id for one context window. */
export function createWindowId(): string {
  return `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A lineage at its first window. */
export function createWindowLineage(): WindowLineage {
  const id = createWindowId();
  return { first: id, current: id };
}

/**
 * Closes the current window and opens the next one, IN PLACE — everything
 * holding the lineage (the compile context, a strategy that captured it from
 * its input) sees the new id without being handed a new object.
 */
export function advanceWindow(window: WindowLineage): WindowLineage {
  window.previous = window.current;
  window.current = createWindowId();
  return window;
}

/** Everything a strategy needs to decide what leaves the window. */
export interface OverflowInput {
  /** In-window history, after `transform-tool-results`. */
  history: Message[];
  /** The budget reading that triggered this overflow. */
  budget: BudgetInfo;
  /** The runner's tokenizer (the configured one, or the built-in heuristic). */
  tokenizer: (messages: Message[]) => number;
  /**
   * Messages that must survive verbatim, turn-scoped: pinning any message of
   * an atomic turn protects the whole turn. A subset of `history`, in original
   * order, by reference — compare with `===`/a `Set`, not by value.
   */
  pinned: readonly Message[];
  window: WindowLineage;
  /**
   * This overflow was REQUESTED, not triggered: `chef.requestNewContext()` or
   * the `new_context` tool. The budget reading is still the real one, so a
   * strategy that sizes its preserved tail against it would keep the whole
   * history when there is headroom — exactly the case the request exists for.
   * Under `forced` a strategy closes the window as far as it can instead,
   * leaving only what the pending request needs.
   */
  forced?: boolean;
  signal?: AbortSignal;
}

/** What a strategy did to the window. */
export interface OverflowResult {
  /** The new in-window history. */
  history: Message[];
  /**
   * The messages that left the window. Pinned messages re-inserted into
   * `history` are NOT here: they never left.
   */
  evicted: Message[];
  /**
   * The span the summary COVERS — every message the strategy compressed,
   * including pinned ones it re-inserted into `history` verbatim. This is what
   * the runner archives, counts in the citation and reports through
   * `onCompress`: the archived span has to be a contiguous transcript, and a
   * consumer persisting `compressedMessages` must not silently lose the pinned
   * turns that sat inside it.
   *
   * Required, so every strategy states what its result stands for: a superset
   * of `evicted` whenever pinned messages were re-inserted, equal to it
   * otherwise, and empty — like `evicted` — in a result that changed nothing.
   */
  span: Message[];
  /**
   * The summary text the strategy produced, WITHOUT the continuation wrapper.
   *
   * When set, `history[0]` is that text rendered through
   * {@link renderSummaryMessage}: the runner re-renders it in place when the
   * archive post-step has a citation to append, which is why the raw text
   * travels alongside the message instead of only inside it.
   */
  summary?: string;
  meta: {
    /** Name of the strategy that produced this result. */
    strategy: string;
    /**
     * The window this overflow ACTED ON — `input.window.current`, read while
     * the strategy ran. The window it opens does not exist yet at that point:
     * the runner allocates it only once the result lands, and reports it as
     * `CompileMeta.windowId`.
     */
    windowId: string;
    /** False when the window is untouched — `history` is then the input array. */
    changed: boolean;
    /** Why nothing changed, or how the change was produced. */
    reason?: string;
  };
}

/**
 * The runner's services, installed on a strategy via
 * {@link OverflowStrategy.attach}. Failure accounting belongs to the runner
 * (one circuit breaker per Janitor, whatever strategy is installed), but only
 * the strategy knows what counts as a failure — a model that threw, a summary
 * that did not shrink, a validator that said no.
 */
export interface OverflowRunner {
  /**
   * Records a failed compression attempt: warns with the shared "history left
   * unchanged" wording and counts it toward the circuit breaker.
   */
  fail(reason: string, ...details: unknown[]): void;
  /** Records a usable result — resets the circuit breaker. */
  succeed(): void;
  readonly logger: ChefLogger;
}

/** Fallback services for a strategy used outside a Janitor. */
export const detachedRunner: OverflowRunner = {
  fail(reason, ...details) {
    console.warn(`[context-chef] ${reason} — history left unchanged`, ...details);
  },
  succeed() {},
  logger: console,
};

/**
 * A history overflow policy. Built-ins live in `src/overflow/`
 * (`summarize`, `anchored`, `server`, `reset`, `chain`, `background`);
 * anything with an `apply` of this shape can be passed as
 * `ChefConfig.overflow.strategy`.
 */
export interface OverflowStrategy {
  readonly name: string;
  apply(input: OverflowInput): Promise<OverflowResult>;
  /**
   * Called by the runner when a result of {@link apply} actually entered the
   * window. `apply` may run speculatively — `background()` computes off-turn
   * and drops the result when it goes stale — so state a strategy derives
   * from its own output (an `anchored()` anchor document) is published here,
   * never inside `apply`.
   *
   * The runner has already advanced the lineage by then: reading
   * `input.window.current` inside `commit` gives the id of the window this
   * result OPENS, which is the key a per-window strategy state belongs under.
   */
  commit?(result: OverflowResult): void;
  /**
   * Whether a result computed earlier is waiting to enter the window — the
   * off-turn strategies (`background()`) only. The runner asks before it
   * evaluates the budget: a summary that is already paid for lands on the next
   * compile whatever the window currently costs, because holding it means the
   * model keeps paying for the span it replaces.
   */
  pending?(): boolean;
  /** Serializable state, for `Janitor.snapshotState()`. Stateless strategies omit it. */
  snapshot?(): unknown;
  /** Restores {@link snapshot} output. `restore(undefined)` resets to the initial state. */
  restore?(state: unknown): void;
  /** @internal The runner installs its circuit breaker and logger here. */
  attach?(runner: OverflowRunner): void;
}

/**
 * Where evicted spans are archived for reversible overflow.
 * `store` receives the serialized span (`JSON.stringify({version: 1, messages})`)
 * and returns a URI the summary will cite (e.g. `context://vfs/...`).
 */
export interface CompressionArchiveConfig {
  store: (serialized: string, meta: { messageCount: number }) => string | Promise<string>;
}

/**
 * The handoff budget: tokens held back above the trigger so the model gets one
 * turn to persist state into the context store before the library evicts
 * mechanically.
 *
 * While the remaining headroom sits inside this band, the compile pipeline
 * delivers one notice through the tail channel — once per window, so a long
 * stretch near the trigger does not repeat it every turn. Validated at chef
 * construction by {@link validateHandoffConfig}.
 */
export interface HandoffConfig {
  /** Tokens reserved above the trigger. A positive integer. */
  budgetTokens: number;
  /**
   * Notice template. Every `{n_remaining}` is replaced with the headroom left
   * before the trigger. At most 2000 UTF-8 bytes; defaults to
   * {@link Prompts.HANDOFF_NOTICE_TEMPLATE}.
   */
  prompt?: string;
}

/** The "nothing happened" result, for strategies that decline to act. */
export function unchanged(input: OverflowInput, strategy: string, reason: string): OverflowResult {
  return {
    history: input.history,
    evicted: [],
    span: [],
    meta: { strategy, windowId: input.window.current, changed: false, reason },
  };
}
