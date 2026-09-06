import { readAnchorDoc } from '../../overflow/anchored';
import type { BackgroundOverflowStrategy } from '../../overflow/background';
import { resolveOverflowStrategy } from '../../overflow/resolve';
import { renderSummaryMessage } from '../../overflow/summary';
import {
  buildToolNameMap,
  collectPinnedTurnIndices,
  extractPinnedMessages,
} from '../../overflow/turns';
import {
  advanceWindow,
  type BudgetInfo,
  type CompressionArchiveConfig,
  createWindowLineage,
  type OverflowInput,
  type OverflowResult,
  type OverflowRunner,
  type OverflowStrategy,
  type WindowLineage,
} from '../../overflow/types';
import { Prompts } from '../../prompts';
import type { ChefLogger, CompactOptions, Message } from '../../types';
import { estimateObject } from '../../utils/tokenUtils';
import { LEGACY_VOCABULARY, type Vocabulary } from '../../vocabulary';

/**
 * Turn grouping, pinning and the summarization primitives live in
 * `src/overflow/` since 4.2 — every strategy shares them. Re-exported here so
 * the 4.x import paths keep resolving.
 */
export { type SummarizeHistoryOptions, summarizeHistory } from '../../overflow/summary';
export {
  buildToolNameMap,
  groupIntoTurns,
  partitionPinnedMessages,
  type Turn,
} from '../../overflow/turns';
export type {
  BudgetInfo,
  CompressionArchiveConfig,
  OverflowInput,
  OverflowResult,
  OverflowStrategy,
  WindowLineage,
};

const MAX_CONSECUTIVE_COMPRESSION_FAILURES = 3;

/**
 * Compression triggers at this fraction of `contextWindow` by default.
 * "Pre-rot": model quality degrades well before the hard window limit, so
 * compressing early keeps the model in its reliable range. Set
 * `triggerRatio: 1` to restore the pre-4.0 trigger-at-window behavior.
 */
const DEFAULT_TRIGGER_RATIO = 0.7;

/** Strips `<think>...</think>` reasoning blocks emitted inline by some reasoning models. */
const REASONING_TAG_RE = /<think>[\s\S]*?<\/think>/gi;

/** Placeholder written by compact()'s tool-result clearing. */
const CLEARED_TOOL_RESULT_PLACEHOLDER = '[Old tool result content cleared]';

/**
 * Role-flattens history for a text-only compression model: tool results
 * become user messages describing the result, and assistant tool calls are
 * appended to the assistant text. This is the canonical implementation of
 * the role-flattening contract documented on {@link summarizeHistory} —
 * plain chat-completion endpoints reject `tool` roles and `tool_calls`
 * fields, so a `compress` callback must flatten before forwarding.
 */
export function flattenForCompression(
  messages: Message[],
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user' as const,
        content: `[Tool result${m.tool_call_id ? ` (${m.tool_call_id})` : ''}: ${m.content}]`,
      };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const toolCallsDesc = m.tool_calls
        .map((tc) => `[Called tool: ${tc.function.name}(${tc.function.arguments})]`)
        .join('\n');
      return {
        role: 'assistant' as const,
        content: m.content ? `${m.content}\n${toolCallsDesc}` : toolCallsDesc,
      };
    }
    const role =
      m.role === 'system' || m.role === 'user' || m.role === 'assistant' ? m.role : 'user';
    return { role, content: m.content };
  });
}

/**
 * Strategy for choosing the trigger token count when both a local tokenizer
 * and an externally-reported usage value (via `feedTokenUsage()`) are
 * available. Only meaningful in the tokenizer path.
 *
 * - `'max'` (default): `max(tokenizer, fed)`. Most conservative — any
 *   over-budget signal triggers compression. Backward-compatible.
 * - `'feedFirst'`: prefer fed when present, fall back to tokenizer. Use when
 *   the API's reported usage is authoritative and the local tokenizer
 *   over-estimates (e.g. shared config across providers, some of which
 *   report usage and some of which need tokenizer fallback).
 * - `'tokenizerFirst'`: ignore fed entirely, always use tokenizer. Use when
 *   fed values would mislead the budget decision (e.g. they include tokens
 *   that will not be in the next call).
 */
export type UsagePreferenceWithTokenizer = 'max' | 'feedFirst' | 'tokenizerFirst';

/**
 * Strategy for the no-tokenizer path. `'tokenizerFirst'` is excluded by
 * design — it would have no source to read from. Both `'max'` and
 * `'feedFirst'` are runtime no-ops here (only fed/heuristic available),
 * but allowing both lets you ship one config that works across providers
 * with and without tokenizers.
 */
export type UsagePreferenceWithoutTokenizer = 'max' | 'feedFirst';

/** Boundary metadata for onCompress — maps the summary back to exact messages. */
export interface CompressionDetails {
  /**
   * The messages removed from history, now represented by the summary:
   * the prefix slice [0, truncatedCount) of the input history (after any
   * onBeforeCompress modification). Match these back to your own store by
   * identity (e.g. tool_call_id) or content — indices into this internal
   * array are deliberately not exposed, since consumers don't hold it.
   * In the no-compressionModel fallback these messages are dropped and the
   * summary message is NOT inserted into the returned history —
   * persistence layers should still record the boundary.
   */
  compressedMessages: Message[];
}

/**
 * Fields shared by every JanitorConfig variant. Not exported on its own —
 * downstream callers should use {@link JanitorConfig}.
 */
interface JanitorConfigBase {
  /**
   * The overflow policy: what leaves the window when the budget is blown.
   *
   * Defaults to the policy described by the `compression*` fields below —
   * `summarize()`, or `anchored()` under `compressionMode:
   * 'incremental-anchored'`, wrapped in `background()` under
   * `compressionScheduling: 'background'`. Setting this REPLACES them; the
   * runner concerns (`contextWindow`, `tokenizer`, `triggerRatio`,
   * `usagePreference`, `archive`, `onCompress`, `onBeforeCompress`) keep
   * applying whatever the strategy is.
   *
   * @example
   * strategy: chain(summarize({ compressionModel }), reset())
   */
  strategy?: OverflowStrategy;

  /**
   * The model's context window size (in tokens).
   * Compression is triggered when token usage exceeds
   * `contextWindow * triggerRatio` (default 0.7 — see {@link triggerRatio}).
   */
  contextWindow: number;

  /**
   * Fraction of `contextWindow` at which compression triggers (0–1].
   * Default 0.7: model quality degrades well before the hard window limit
   * ("pre-rot"), so compressing early keeps the model in its reliable range.
   * Set to 1 to restore the pre-4.0 trigger-at-window behavior.
   *
   * In the tokenizer path, `preserveRatio` is applied to this effective
   * trigger budget (`contextWindow * triggerRatio`), not to the raw window.
   */
  triggerRatio?: number;

  /**
   * A compression result must shrink the compressed span's character length
   * by at least this ratio (0–1, default 0.5). A summary failing the check is
   * treated as a failed compression: history is returned unchanged and the
   * failure counts toward the circuit breaker — so a summarizer that echoes
   * its input trips the breaker instead of looping forever. Set to 0 to
   * disable the check.
   */
  minShrinkRatio?: number;

  /**
   * Structured domain guidelines appended (numbered) to the compression
   * prompt, after the default scaffolding and before
   * `customCompressionInstructions`. Same additive contract: the
   * `<analysis>`/`<summary>` parsing scaffolding is always preserved.
   *
   * @example
   * compressionGuidelines: [
   *   'Preserve all file paths and ticket IDs verbatim.',
   *   'Record why each abandoned approach failed.',
   * ]
   */
  compressionGuidelines?: string[];

  /**
   * Summary generation strategy:
   * - `'rewrite'` (default): each compression regenerates the whole summary
   *   from the evicted span (previous summaries get re-summarized when they
   *   fall into a later evicted span).
   * - `'incremental-anchored'`: the Janitor maintains a persistent "anchor
   *   document"; each compression summarizes ONLY the newly evicted span and
   *   merges it into the anchor. Avoids the drift/loss of repeated whole-
   *   summary rewrites and keeps the summary prefix stable for caching.
   *   The anchor survives snapshot()/restore() and clears on reset().
   *
   * @deprecated Use `overflow.strategy` — `summarize(opts)` for `'rewrite'`,
   * `anchored(opts)` for `'incremental-anchored'`. This field builds exactly
   * that and keeps working; it is removed in 5.0.
   */
  compressionMode?: 'rewrite' | 'incremental-anchored';

  /**
   * Compression scheduling:
   * - `'blocking'` (default): `compress()` awaits summarization.
   * - `'background'`: the first over-budget `compress()` returns history
   *   UNCHANGED and starts summarization in the background; a later
   *   `compress()` call swaps the finished summary in, but only if the
   *   compressed span is still a prefix of the current history (checked by
   *   message identity) — otherwise the result is discarded and the budget
   *   is re-evaluated fresh. Background state does not survive
   *   snapshot()/restore().
   *
   * @deprecated Use `overflow.strategy: background(<strategy>)`. This field
   * applies exactly that wrapper and keeps working; it is removed in 5.0.
   */
  compressionScheduling?: 'blocking' | 'background';

  /**
   * Post-summarization validation gate. Return `false` to REJECT the summary:
   * rejection is treated as a compression failure (history unchanged, circuit
   * breaker incremented). Use to check that forward intent and load-bearing
   * facts survived (trajectory-grounded validation). A throwing/rejecting
   * hook is treated as `false` with a logged warning.
   */
  validateCompression?: (
    summary: string,
    info: { compressed: Message[]; kept: Message[] },
  ) => boolean | Promise<boolean>;

  /**
   * Reversible compression: archive the full pre-compression span and cite
   * the archive URI in the summary, so exact details remain retrievable
   * (pair with `getRecallToolDefinition()` + `chef.resolveRecall()`).
   *
   * Pass `'vfs'` under ContextChef to store spans in the configured VFS
   * (ContextChef wires the store automatically). A standalone Janitor needs
   * the object form with an explicit `store`. Archiving is best-effort: a
   * failing store logs a warning and the compression proceeds without a
   * citation.
   *
   * @deprecated Use `overflow.archive` — archiving is strategy-agnostic now
   * (whatever a strategy evicts is what gets stored). This field is the same
   * setting under its old name and keeps working; it is removed in 5.0.
   */
  archive?: CompressionArchiveConfig | 'vfs';

  /**
   * [Tokenizer path only] The ratio of contextWindow to preserve for recent messages.
   * Defaults to DEFAULT_PRESERVE_RATIO (keep 80% of contextWindow worth of recent messages).
   */
  preserveRatio?: number;

  /**
   * [FeedTokenUsage path only] Number of recent turns to keep when compressing.
   * A "turn" is an atomic unit: a single message, or an assistant with tool_calls
   * plus all its subsequent tool results. Defaults to 1.
   */
  preserveRecentMessages?: number;

  /**
   * Async hook to call a low-cost LLM (e.g. gpt-4o-mini) to summarize the truncated messages.
   * If not provided, a simple placeholder message is used.
   *
   * Contract: may reject. After {@link MAX_CONSECUTIVE_COMPRESSION_FAILURES}
   * consecutive failures, compress() short-circuits and becomes a no-op until
   * the next successful compression or an explicit janitor.reset() / chef.clearHistory().
   * The failure counter is preserved across snapshot()/restore().
   */
  compressionModel?: (messagesToCompress: Message[]) => Promise<string>;

  /** Sink for degradation warnings. Defaults to `console`. */
  logger?: ChefLogger;

  /**
   * Replace tool-result content longer than this many characters with a
   * one-line metadata stub (`[Tool name returned N chars; omitted before
   * summarization]`) before the to-be-summarized history is sent to the
   * compression model. Saves summarizer tokens on big tool outputs while
   * preserving "what happened" semantics for the summary.
   *
   * Only affects content sent to the compression model — recent (preserved)
   * tool results, and tool results below the threshold, pass through
   * unchanged. tool_use ↔ tool_result pairing is structurally preserved.
   *
   * Default: undefined (disabled). Recommended starting value: `5000`.
   */
  toolResultStubThreshold?: number;

  /**
   * Additional focused instructions appended to the default compression prompt.
   * Does NOT replace the default — the scaffolding that enforces the
   * <analysis>/<summary> contract is always preserved. This is appended as an
   * "Additional Instructions" section before the compression model is called.
   *
   * Use this to steer the summary toward specific domain concerns without
   * breaking the parsing contract.
   *
   * @example
   * customCompressionInstructions: 'Focus on customer sentiment, unresolved issues, and any commitments made. Preserve ticket IDs verbatim.'
   */
  customCompressionInstructions?: string;

  /**
   * Hook triggered ONLY when compression actually happens.
   * Useful for UI loaders ("Compressing memory..."), logging, or saving the compressed state.
   *
   * @param summaryMessage - The message inserted in place of the compressed history.
   * @param truncatedCount - Number of messages removed from history.
   * @param details - Boundary metadata: the exact messages that were replaced,
   *   useful for persistence layers that need to map the summary back to their store.
   *
   * Contract: should not throw or reject. As a safety net, a throwing hook is
   * caught and logged via `logger` — the compression result is kept and
   * compile() continues, but your sink may have missed the summary.
   */
  onCompress?: (
    summaryMessage: Message,
    truncatedCount: number,
    details: CompressionDetails,
  ) => void | Promise<void>;

  /**
   * Hook triggered when the token budget is exceeded, BEFORE LLM compression.
   * Return a modified Message[] to replace the history before compression proceeds,
   * or return null/undefined to let the default compression handle it.
   *
   * Contract: should not throw or reject. As a safety net, a throwing hook is
   * caught and logged via `logger`, then treated as if it returned null —
   * default compression proceeds (the same failure recipe the return
   * contract documents). Mirrors the `onCompress` degradation stance.
   */
  onBeforeCompress?: (
    history: Message[],
    tokenInfo: { currentTokens: number; limit: number },
  ) => Message[] | null | undefined | Promise<Message[] | null | undefined>;

  /**
   * The wording the summary that replaces a compressed span is written in.
   * `ContextChef` passes the vocabulary it resolved from `ChefConfig.tools`;
   * a standalone Janitor leaves it unset and keeps the 4.x wrapper.
   *
   * @internal
   */
  vocabulary?: Vocabulary;
}

/**
 * Tokenizer-path config. Enables precise per-message token calculation and
 * the precise per-turn split based on `preserveRatio`. Both `usagePreference`
 * values that depend on a tokenizer (`'tokenizerFirst'`) are allowed here.
 *
 * The tokenizer is called with both the full history AND individual messages
 * (for per-turn cost calculation), so it must handle arbitrary Message[] inputs.
 *
 * Contract: must not throw. Errors propagate out of compile() — there is no
 * fallback path. Return 0 on failure if you need to swallow the error yourself.
 *
 * @example
 * tokenizer: (msgs) => msgs.reduce((sum, m) => sum + encode(JSON.stringify(m)).length, 0)
 */
export interface JanitorConfigWithTokenizer extends JanitorConfigBase {
  tokenizer: (messages: Message[]) => number;
  usagePreference?: UsagePreferenceWithTokenizer;
}

/**
 * No-tokenizer config. Compression is driven entirely by `feedTokenUsage()`
 * (or a coarse heuristic when no fed value is present). The split is
 * coarse — keep last `preserveRecentMessages` turns, summarize the rest.
 *
 * `usagePreference: 'tokenizerFirst'` is intentionally NOT a member of the
 * value union: with no tokenizer present it would have nothing to read from,
 * so the type system rejects it at compile time.
 */
export interface JanitorConfigWithoutTokenizer extends JanitorConfigBase {
  tokenizer?: undefined;
  usagePreference?: UsagePreferenceWithoutTokenizer;
}

/**
 * Discriminated on the presence of `tokenizer`. The branch determines which
 * `usagePreference` values are allowed:
 *
 * - With tokenizer: `'max' | 'feedFirst' | 'tokenizerFirst'`
 * - Without tokenizer: `'max' | 'feedFirst'`
 */
export type JanitorConfig = JanitorConfigWithTokenizer | JanitorConfigWithoutTokenizer;

export interface JanitorSnapshot {
  externalTokenUsage: number | null;
  suppressNextCompression: boolean;
  consecutiveFailures: number;
  /**
   * Persistent anchor document ('incremental-anchored' mode). Null when absent.
   *
   * @deprecated Read {@link strategy} instead — this is the anchored
   * strategy's state lifted to a named field, kept so snapshots taken before
   * 4.2 still restore their anchor.
   */
  anchorDoc?: string | null;
  /**
   * Opaque state of the installed {@link OverflowStrategy}
   * (`strategy.snapshot()`). Absent for stateless strategies. Must stay
   * structured-clonable: consumers persist whole snapshots.
   */
  strategy?: unknown;
  /**
   * The window lineage at snapshot time. Absent in snapshots taken before
   * 4.2 — those restore onto a fresh lineage.
   */
  window?: WindowLineage;
}

/**
 * Pure implementation behind {@link Janitor.compact}: replaces cleared
 * content with placeholders instead of deleting messages, preserving
 * structure and tool-call pairing. Usable without a Janitor instance.
 */
export function compactMessages(history: Message[], options: CompactOptions): Message[] {
  // Parse targets: separate simple strings from object configs
  let clearToolResult = false;
  let toolResultKeepRecent: number | undefined;
  let toolFilter: string[] | undefined;
  let exemptTools: string[] | undefined;
  let clearThinking = false;
  let clearReasoningTags = false;

  for (const target of options.clear) {
    if (target === 'tool-result') {
      clearToolResult = true;
    } else if (target === 'thinking') {
      clearThinking = true;
    } else if (target === 'reasoning-tags') {
      clearReasoningTags = true;
    } else if (typeof target === 'object' && target.target === 'tool-result') {
      clearToolResult = true;
      toolResultKeepRecent = target.keepRecent;
      toolFilter = target.toolFilter;
      exemptTools = target.exemptTools;
    }
  }

  // Pinned protection is turn-scoped and applies to every clearing target.
  const pinnedIndices = collectPinnedTurnIndices(history);

  // Tool-name resolution only when a name-based filter is in play.
  const nameMap = toolFilter || exemptTools ? buildToolNameMap(history) : undefined;

  const isClearableToolResult = (idx: number, msg: Message): boolean => {
    if (pinnedIndices.has(idx)) return false;
    if (nameMap) {
      const name = msg.tool_call_id ? nameMap.get(msg.tool_call_id) : undefined;
      if (toolFilter && (name === undefined || !toolFilter.includes(name))) return false;
      if (exemptTools && name !== undefined && exemptTools.includes(name)) return false;
    }
    return true;
  };

  // keepRecent counts within the CLEARABLE set (post pinning/filter/exemption)
  let toolResultSkipSet: Set<number> | undefined;
  if (clearToolResult && toolResultKeepRecent !== undefined) {
    const keepCount = Math.max(1, toolResultKeepRecent);
    const clearableIndices: number[] = [];
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role === 'tool' && isClearableToolResult(i, msg)) {
        clearableIndices.push(i);
      }
    }
    // The last keepCount clearable tool messages are preserved
    toolResultSkipSet = new Set(clearableIndices.slice(-keepCount));
  }

  return history.map((msg, idx) => {
    let result = msg;

    if (clearToolResult && msg.role === 'tool' && isClearableToolResult(idx, msg)) {
      // Skip (preserve) if this index is in the keepRecent set. Idempotent:
      // an already-cleared message keeps its object identity, so repeated
      // compact() passes don't churn references (which would defeat the
      // background-compression staleness check and similar identity users).
      if (!toolResultSkipSet?.has(idx) && result.content !== CLEARED_TOOL_RESULT_PLACEHOLDER) {
        result = { ...result, content: CLEARED_TOOL_RESULT_PLACEHOLDER };
      }
    }

    if (clearThinking && msg.role === 'assistant' && !pinnedIndices.has(idx)) {
      if (msg.thinking || msg.redacted_thinking) {
        // Set to undefined rather than destructure-delete: keeps Message typing
        // clean (adapters use truthy checks, undefined is dropped by JSON.stringify).
        result = { ...result, thinking: undefined, redacted_thinking: undefined };
      }
    }

    if (clearReasoningTags && msg.role === 'assistant' && !pinnedIndices.has(idx)) {
      const stripped = result.content.replace(REASONING_TAG_RE, '');
      if (stripped !== result.content) {
        result = { ...result, content: stripped.replace(/\n{3,}/g, '\n\n').trim() };
      }
    }

    return result;
  });
}
/**
 * The overflow runner.
 *
 * Everything that is true of *any* overflow policy lives here: reading the
 * token budget, deciding that the window is over it, running the installed
 * {@link OverflowStrategy}, archiving what left, reporting the boundary
 * through `onCompress`, and the circuit breaker that stops a broken
 * compression model from being hammered every turn. What to actually drop or
 * rewrite is the strategy's business — see `src/overflow/`.
 */
export class Janitor {
  /** Externally reported token count from the last API response. */
  private _externalTokenUsage: number | null = null;
  /** Suppresses the next compression check after a successful compression (E10). */
  private _suppressNextCompression = false;
  /**
   * Circuit breaker counter — incremented when the strategy rejects a
   * compression, reset when it produces a usable one. At
   * MAX_CONSECUTIVE_COMPRESSION_FAILURES, compress() becomes a no-op to
   * prevent hammering a broken compression model on every turn.
   */
  private _consecutiveFailures = 0;
  /** The installed overflow policy. */
  private readonly _strategy: OverflowStrategy;
  /**
   * The window lineage of this session. The runner owns it because the runner
   * is what decides that an overflow actually landed: it moves forward at
   * commit time, never on a result that was computed and then discarded.
   */
  private _window: WindowLineage;
  /** The wording landed summaries are rendered in. */
  private readonly _vocabulary: Vocabulary;

  constructor(private config: JanitorConfig) {
    // Warn if feedTokenUsage path is likely used without a compressionModel
    if (!config.tokenizer && !config.compressionModel && !config.strategy) {
      (config.logger ?? console).warn(
        '[Janitor] Warning: No tokenizer and no compressionModel configured. ' +
          'In the feedTokenUsage path, compression without a compressionModel will discard old messages ' +
          'with only a placeholder summary. Consider providing a compressionModel for meaningful context preservation.',
      );
    }
    if (config.archive === 'vfs') {
      (config.logger ?? console).warn(
        "[Janitor] archive: 'vfs' requires ContextChef wiring (it substitutes the VFS-backed " +
          'store). This standalone Janitor has no VFS — archiving is disabled. Pass an ' +
          'explicit { store } to archive on a standalone Janitor.',
      );
    }

    this._vocabulary = config.vocabulary ?? LEGACY_VOCABULARY;
    this._strategy = config.strategy ?? resolveOverflowStrategy(config);
    this._strategy.attach?.(this._createRunner());
    this._window = createWindowLineage();
  }

  /**
   * The window lineage this runner is on. Live — `current` moves as overflows
   * land, so hold the object rather than a copy of `current`.
   */
  public get window(): WindowLineage {
    return this._window;
  }

  /** Resolved archive config — the 'vfs' shorthand is only usable via ContextChef wiring. */
  private get _archive(): CompressionArchiveConfig | undefined {
    return typeof this.config.archive === 'object' ? this.config.archive : undefined;
  }

  private get _logger(): ChefLogger {
    return this.config.logger ?? console;
  }

  /**
   * The services the installed strategy reports through. Failure accounting is
   * the runner's (one breaker per Janitor, whatever strategy is installed);
   * only the strategy knows what counts as a failure.
   */
  private _createRunner(): OverflowRunner {
    const janitor = this;
    return {
      fail(reason, ...details) {
        janitor._consecutiveFailures++;
        janitor._logger.warn(
          `[context-chef] ${reason} — history left unchanged ` +
            `(failure ${janitor._consecutiveFailures}/${MAX_CONSECUTIVE_COMPRESSION_FAILURES} toward circuit breaker)`,
          ...details,
        );
      },
      succeed() {
        janitor._consecutiveFailures = 0;
      },
      get logger() {
        return janitor._logger;
      },
    };
  }

  /**
   * The in-flight background job, when `background()` is the installed
   * strategy — bookkeeping only, and named for the 4.1 field it replaces.
   *
   * @internal
   */
  public get _pendingBackground(): { settled: boolean } | undefined {
    return (this._strategy as Partial<BackgroundOverflowStrategy>).pending;
  }

  public snapshotState(): JanitorSnapshot {
    const strategy = this._strategy.snapshot?.();
    const snapshot: JanitorSnapshot = {
      externalTokenUsage: this._externalTokenUsage,
      suppressNextCompression: this._suppressNextCompression,
      consecutiveFailures: this._consecutiveFailures,
      anchorDoc: readAnchorDoc(strategy),
      // Copied: the lineage keeps moving after the snapshot is taken, and a
      // snapshot that moved with it would restore the wrong window.
      window: { ...this._window },
    };
    if (strategy !== undefined) snapshot.strategy = strategy;
    return snapshot;
  }

  public restoreState(state: JanitorSnapshot): void {
    this._externalTokenUsage = state.externalTokenUsage;
    this._suppressNextCompression = state.suppressNextCompression;
    this._consecutiveFailures = state.consecutiveFailures ?? 0;
    // A snapshot taken before 4.2 has no lineage. Restoring one starts a fresh
    // one rather than keeping this runner's: the restored history is not the
    // history the current window was built from.
    this._window = state.window ? { ...state.window } : createWindowLineage();
    // Pre-4.2 snapshots carry only the anchor document; from 4.2 the strategy
    // round-trips its own opaque state. A pending background job belongs to
    // the pre-restore timeline — the strategy drops it.
    this._strategy.restore?.(
      state.strategy ?? (state.anchorDoc == null ? undefined : { anchorDoc: state.anchorDoc }),
    );
  }

  /**
   * Resets the Janitor's internal state.
   * Called when rolling history is explicitly cleared by the developer.
   */
  public reset(): void {
    this._externalTokenUsage = null;
    this._suppressNextCompression = false;
    this._consecutiveFailures = 0;
    // A cleared history is a new conversation, not a continuation of the old
    // window chain — the lineage starts over with it.
    this._window = createWindowLineage();
    // `restore(undefined)` is the strategies' "back to initial" contract.
    this._strategy.restore?.(undefined);
  }

  /** Current anchor document ('incremental-anchored' mode), for observability. */
  public getAnchorDoc(): string | null {
    return readAnchorDoc(this._strategy.snapshot?.());
  }

  /**
   * Feeds an externally-reported token count (e.g. from the LLM API response).
   * Used in the feedTokenUsage path: when this value exceeds contextWindow,
   * compression is triggered on the next compress() call.
   * The value is consumed after use.
   */
  public feedTokenUsage(tokenCount: number): void {
    this._externalTokenUsage = tokenCount;
  }

  /**
   * Reads the token budget without touching any state.
   *
   * The number the overflow decision is made against, exposed so observers
   * (the `before-overflow` slot) see the same figures the runner does. Unlike
   * the decision itself it does NOT consume the fed usage value, so it can be
   * called any number of times per turn.
   */
  public readBudget(history: Message[]): BudgetInfo {
    const limit = this.config.contextWindow;
    const trigger = limit * (this.config.triggerRatio ?? DEFAULT_TRIGGER_RATIO);
    const fedTokens = this._externalTokenUsage;

    let current: number;
    if (this.config.tokenizer) {
      const tokenizerTokens = this.config.tokenizer(history);
      // Trigger source selection — see UsagePreferenceWithTokenizer JSDoc for
      // when each branch is the right call. Default 'max' preserves the
      // historical Math.max behavior for callers that do not opt in.
      switch (this.config.usagePreference ?? 'max') {
        case 'feedFirst':
          current = fedTokens ?? tokenizerTokens;
          break;
        case 'tokenizerFirst':
          current = tokenizerTokens;
          break;
        default:
          current = Math.max(tokenizerTokens, fedTokens ?? 0);
      }
    } else {
      current = fedTokens ?? estimateObject(history);
    }

    return { limit, current, trigger, remaining: trigger - current };
  }

  /**
   * Compresses the rolling history when the token budget is exceeded.
   *
   * {@link overflow} without the reporting — kept as the 4.x entry point.
   *
   * @param options `force: true` applies the strategy whatever the budget says
   *   (`chef.requestNewContext()` / the `new_context` tool).
   */
  public async compress(history: Message[], options: { force?: boolean } = {}): Promise<Message[]> {
    return (await this.overflow(history, options)).history;
  }

  /**
   * One overflow pass: budget evaluation → `onBeforeCompress` → the installed
   * strategy → archive → `onCompress`.
   *
   * Guarantees, whatever the strategy:
   * - Pinned (turn-scoped) messages are handed to the strategy separately and
   *   are expected back verbatim; the built-ins re-insert them after the
   *   summary and never evict them.
   * - A rejected compression leaves history UNCHANGED and counts toward the
   *   circuit breaker; after MAX_CONSECUTIVE_COMPRESSION_FAILURES consecutive
   *   failures this becomes a no-op until the next success or an explicit
   *   reset()/restoreState().
   * - The window lineage moves forward exactly when a result lands, so
   *   `windowId` identifies a window that really existed.
   *
   * @param options `force: true` skips the budget test (and the one-shot
   *   post-compression suppression) and applies the strategy regardless — the
   *   `new_context` path. The circuit breaker still applies: a strategy that
   *   just failed three times in a row does not get hammered on request.
   */
  public async overflow(
    history: Message[],
    options: { signal?: AbortSignal; force?: boolean } = {},
  ): Promise<OverflowResult> {
    const { signal, force = false } = options;
    const idle = (reason: string, current: Message[] = history): OverflowResult => ({
      history: current,
      evicted: [],
      meta: {
        strategy: this._strategy.name,
        windowId: this._window.current,
        changed: false,
        reason,
      },
    });

    // Circuit breaker: bail out if compression is consistently failing.
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_COMPRESSION_FAILURES) {
      return idle(
        `circuit breaker open after ${MAX_CONSECUTIVE_COMPRESSION_FAILURES} consecutive compression failures`,
      );
    }

    const prepared = await this._prepareOverflow(history, force);
    if (!prepared.budget) {
      return idle(
        force ? 'nothing to overflow — history is empty' : 'within budget',
        prepared.history,
      );
    }

    const result = await this._strategy.apply({
      history: prepared.history,
      budget: prepared.budget,
      tokenizer: this.config.tokenizer ?? estimateObject,
      pinned: extractPinnedMessages(prepared.history),
      window: this._window,
      signal,
    });
    if (!result.meta.changed) return result;

    // This result is entering the window: it closes the window the strategy
    // worked on and opens the next one. Advanced before `commit` so state the
    // strategy derives from its own output (an anchor document) is filed under
    // the window that will read it back — and only ever for a result that
    // landed, since a stale background job reports `changed: false` and never
    // reaches this line.
    advanceWindow(this._window);
    this._strategy.commit?.(result);

    // Archive is strategy-agnostic: whatever left the window is what gets
    // stored, and the citation goes back into the summary that replaced it.
    const archived = await this._landResult(result);
    await this._fireOnCompress(
      archived.summary === undefined
        ? {
            role: 'system',
            content: Prompts.getFallbackCompressionSummary(archived.evicted.length),
          }
        : archived.history[0],
      archived.evicted.length,
      { compressedMessages: archived.evicted },
    );
    this._suppressNextCompression = true;
    return archived;
  }

  /**
   * Budget evaluation plus the onBeforeCompress hook. `budget: null` means no
   * overflow is needed — `history` is still returned because the hook may have
   * replaced it on the way.
   */
  private async _prepareOverflow(
    history: Message[],
    force: boolean,
  ): Promise<{ history: Message[]; budget: BudgetInfo | null }> {
    const budget = this._evaluateBudget(history, force);
    if (!budget) return { history, budget: null };

    const hook = this.config.onBeforeCompress;
    if (!hook) return { history, budget };

    // Fire onBeforeCompress hook — developer gets a chance to intervene
    let modified: Message[] | null | undefined;
    try {
      modified = await hook(history, { currentTokens: budget.current, limit: budget.trigger });
    } catch (error) {
      // Same degradation stance as onCompress: a broken hook must not fail
      // compile(). A throw is treated as "return null" — the failure recipe
      // the return contract already documents — so default compression
      // proceeds.
      this._logger.warn(
        '[context-chef] onBeforeCompress hook threw — proceeding with default compression',
        error,
      );
      modified = null;
    }
    if (modified == null) return { history, budget };

    // Re-evaluate with the developer-modified history
    return { history: modified, budget: this._evaluateBudget(modified, force) };
  }

  /**
   * Decides whether the window is over budget, consuming the one-shot state
   * that decision depends on (the fed usage value, the E10 suppression flag).
   * Returns the reading when compression should run, null otherwise.
   *
   * The effective trigger threshold is `contextWindow * triggerRatio`
   * (default 0.7 — "pre-rot"), which is also what the strategies size their
   * preserved tail against, so post-compression usage lands safely below the
   * trigger point (no compress-every-turn thrash).
   *
   * `force` skips the verdict, not the reading: the strategy still needs a
   * budget to size its preserved tail against. An empty history is the one
   * case force cannot override — there is nothing to overflow.
   */
  private _evaluateBudget(history: Message[], force: boolean): BudgetInfo | null {
    if (history.length === 0) return null;

    // E10: Skip check once after a successful compression to avoid cascading
    // re-compression. The one-shot flag is consumed either way — a forced
    // overflow answers for this turn, so the suppression has done its job.
    const suppressed = this._suppressNextCompression;
    this._suppressNextCompression = false;
    if (suppressed && !force) return null;

    const budget = this.readBudget(history);
    this._externalTokenUsage = null;
    return force || budget.remaining < 0 ? budget : null;
  }

  /**
   * Finishes a result that is entering the window: archive the evicted span,
   * then re-render the summary message with everything only the runner knows —
   * the archive citation, and the window lineage the result just moved.
   *
   * A strategy renders its summary speculatively (a `background()` job may
   * never land), so the final wording is settled here. Under the legacy
   * vocabulary with nothing to cite there is nothing to settle, and the
   * strategy's own message is kept.
   */
  private async _landResult(result: OverflowResult): Promise<OverflowResult> {
    const citation = await this._archiveEvicted(result);
    if (result.summary === undefined) return result;
    if (citation === '' && this._vocabulary.mode === 'legacy') return result;

    const history = [...result.history];
    history[0] = renderSummaryMessage(result.summary, citation, this._vocabulary, this._window);
    return { ...result, history };
  }

  /**
   * Reversible compression: stores the evicted span and returns the citation
   * line to append to the summary that replaced it. Best-effort — a failing
   * store logs a warning and the compression proceeds without a citation.
   */
  private async _archiveEvicted(result: OverflowResult): Promise<string> {
    const archive = this._archive;
    if (!archive || result.evicted.length === 0) return '';

    try {
      const serialized = JSON.stringify({ version: 1, messages: result.evicted });
      const uri = await archive.store(serialized, { messageCount: result.evicted.length });
      // Nothing to cite it in — the strategy evicted without summarizing.
      if (result.summary === undefined) return '';
      return `\n\n${Prompts.getArchiveCitation(uri, result.evicted.length)}`;
    } catch (error) {
      this._logger.warn(
        '[context-chef] compression archive store failed — proceeding without a citation',
        error,
      );
      return '';
    }
  }

  /**
   * Mechanically strips content from history based on the specified clear targets.
   * Pure function — no LLM call, no side effects, no state mutation.
   *
   * **Interaction with `compress`:** If you want tool-result content trimmed
   * *before* it reaches the compression model, prefer
   * `JanitorConfig.toolResultStubThreshold` over `compact({ clear: ['tool-result'] })`.
   * The stub-threshold path operates inside compress on the same boundary that
   * compress uses, so the "preserve recent / summarize old" split stays
   * coherent. Using `compact` with a separate `keepRecent` cursor risks the
   * two windows disagreeing — recent tool results may end up cleared, or
   * summarizer input may end up empty, depending on which boundary is
   * tighter. Use `compact` for `thinking` (where this concern doesn't apply)
   * or when you're not running `compress` at all.
   *
   * Recommended combinations:
   * - compact alone: clear both `thinking` and `tool-result` freely
   * - compress alone: turn-based summarization handles everything; pair with
   *   `toolResultStubThreshold` to mechanically trim large tool results
   *   inside the to-be-summarized portion
   * - compact + compress: clear `thinking` only in compact, leave tool-result
   *   trimming to `toolResultStubThreshold`
   *
   * @example
   * // Clear all tool results and thinking (compact only, no compress)
   * history = janitor.compact(history, { clear: ['tool-result', 'thinking'] });
   *
   * // Keep the 5 most recent tool results, clear the rest
   * history = janitor.compact(history, { clear: [{ target: 'tool-result', keepRecent: 5 }] });
   *
   * // When using with compress — clear thinking only, configure stub threshold
   * // on the Janitor for tool-result trimming
   * history = janitor.compact(history, { clear: ['thinking'] });
   * history = await janitor.compress(history);
   */
  public compact(history: Message[], options: CompactOptions): Message[] {
    return compactMessages(history, options);
  }

  /**
   * Invokes the `onCompress` hook, downgrading a throwing/rejecting hook to a
   * logger warning. The hook is an observation/persistence sink — its failure
   * must not discard an already-computed compression or fail compile().
   */
  private async _fireOnCompress(
    summaryMessage: Message,
    truncatedCount: number,
    details: CompressionDetails,
  ): Promise<void> {
    if (!this.config.onCompress) return;
    try {
      await this.config.onCompress(summaryMessage, truncatedCount, details);
    } catch (error) {
      this._logger.warn(
        '[context-chef] onCompress hook threw — compression result is kept, but your sink may have missed this summary',
        error,
      );
    }
  }
}
