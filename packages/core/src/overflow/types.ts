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
 * Lineage of the context window an overflow operates on. Phase 1 allocates one
 * id per chef; Phase 3 turns this into a real chain (`previous` recorded on
 * every overflow that changed the window).
 */
export interface OverflowWindow {
  readonly first: string;
  current: string;
  previous?: string;
}

/** Opaque, sortable-enough id for one context window. */
export function createWindowId(): string {
  return `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
  window: OverflowWindow;
  signal?: AbortSignal;
}

/** What a strategy did to the window. */
export interface OverflowResult {
  /** The new in-window history. */
  history: Message[];
  /**
   * The messages that left the window — the archive input. Pinned messages
   * re-inserted into `history` are NOT here: they never left.
   */
  evicted: Message[];
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
   */
  commit?(result: OverflowResult): void;
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
 * Reserved for the handoff budget (`docs/architecture-v5.md` §5): tokens held
 * back above the trigger so the model gets one turn to persist state into the
 * context store before the library evicts mechanically.
 *
 * Declared now so the 4.2 config shape is final. The field is accepted and
 * IGNORED until the handoff phase ships.
 */
export interface HandoffConfig {
  /** Tokens reserved above the trigger. Must be > 0. */
  budgetTokens?: number;
  /** Notice template; `{n_remaining}` is substituted. Defaults to a built-in prompt. */
  prompt?: string;
}

/** The "nothing happened" result, for strategies that decline to act. */
export function unchanged(input: OverflowInput, strategy: string, reason: string): OverflowResult {
  return {
    history: input.history,
    evicted: [],
    meta: { strategy, windowId: input.window.current, changed: false, reason },
  };
}
