import { Prompts } from '../../prompts';
import type { Attachment, ChefLogger, CompactOptions, Message } from '../../types';
import { estimateObject } from '../../utils/tokenUtils';

const DEFAULT_PRESERVE_RATIO = 0.8;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 1;
const MAX_CONSECUTIVE_COMPRESSION_FAILURES = 3;

// ─── Turn-based grouping ───

export interface Turn {
  startIndex: number;
  endIndex: number; // exclusive
}

/**
 * Groups a flat message array into atomic "turns."
 *
 * Grouping rules:
 * - user message → single-message turn
 * - system message → single-message turn
 * - assistant (no tool_calls) → single-message turn
 * - assistant (with tool_calls) + all subsequent tool results → one atomic turn
 *
 * Splitting on turn boundaries guarantees tool pair integrity and
 * eliminates the need for post-hoc adjustSplitIndex corrections.
 */
export function groupIntoTurns(history: Message[]): Turn[] {
  const turns: Turn[] = [];
  let i = 0;

  while (i < history.length) {
    const msg = history[i];

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Atomic turn: assistant + all subsequent tool results
      const start = i;
      i++;
      while (i < history.length && history[i].role === 'tool') {
        i++;
      }
      turns.push({ startIndex: start, endIndex: i });
    } else {
      // Single-message turn: user, system, or plain assistant
      turns.push({ startIndex: i, endIndex: i + 1 });
      i++;
    }
  }

  return turns;
}

// ─── Attachment stripping for compression ───

/**
 * Builds a single-line text placeholder for an attachment.
 * Includes the filename when available so the summary can reference it by name.
 *
 *   { mediaType: 'image/png', filename: 'photo.png' }   → '[image: photo.png]'
 *   { mediaType: 'image/png' }                          → '[image]'
 *   { mediaType: 'application/pdf', filename: 'r.pdf' } → '[document: r.pdf]'
 *   { mediaType: 'application/pdf' }                    → '[document]'
 *   { mediaType: '' }                                  → '[attachment]'
 *
 * Categorization mirrors Claude Code's binary image-vs-document split — keeping
 * the placeholder vocabulary small reduces surprises for the compression model.
 */
function attachmentToPlaceholder(att: Attachment): string {
  const mt = att.mediaType.toLowerCase();
  const kind = mt.startsWith('image/') ? 'image' : mt ? 'document' : 'attachment';
  return att.filename ? `[${kind}: ${att.filename}]` : `[${kind}]`;
}

/**
 * Replaces media attachments with text placeholders for the compression model.
 *
 * The compression model never sees binary attachment data — it only sees text
 * markers like `[image]` or `[document: report.pdf]` prepended to the message
 * content. This avoids shipping base64 payloads through the compression call
 * (which can balloon token cost and trip prompt-too-long limits on the
 * compression call itself), while still letting the summarizer note that
 * media existed at this point in the conversation.
 *
 * Pure function — does not mutate the input array or any Message inside it.
 * Messages without attachments pass through by reference (no allocation).
 *
 * Modeled on Claude Code's `stripImagesFromMessages` strategy.
 */
function stripAttachmentsForCompression(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (!msg.attachments?.length) return msg;

    const placeholders = msg.attachments.map(attachmentToPlaceholder).join('\n');
    const newContent = msg.content ? `${placeholders}\n${msg.content}` : placeholders;

    const { attachments: _attachments, ...rest } = msg;
    return { ...rest, content: newContent };
  });
}

/**
 * Builds a map from `tool_call_id` → tool name by walking the messages and
 * collecting the names declared on every assistant turn's `tool_calls`.
 * The same map covers all tool messages because tool_call ids are unique
 * per invocation.
 */
function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        map.set(tc.id, tc.function.name);
      }
    }
  }
  return map;
}

/**
 * Replaces large tool-result content with a metadata stub for the
 * compression model.
 *
 * The summarizer only needs to know "what happened" at each turn — feeding
 * it 87 KB of raw `fs_read` output wastes tokens and tends to drown the
 * actual conversation arc in noise. Each oversized tool message is
 * rewritten to a one-line stub like
 * `[Tool fs_read returned 87123 chars; omitted before summarization]`,
 * preserving tool name + size so the summary can still reference the
 * operation meaningfully. tool_use ↔ tool_result pairing is structurally
 * preserved.
 *
 * Tool name is resolved from the preceding assistant turn's
 * `tool_calls[].function.name` via `tool_call_id` — falls back to
 * `'unknown'` if the link is missing.
 *
 * Pure function — does not mutate inputs. Only acts on `role: 'tool'`
 * messages whose content length exceeds `threshold`.
 */
function stripLargeToolResultsForCompression(messages: Message[], threshold: number): Message[] {
  const nameMap = buildToolNameMap(messages);
  return messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    if (msg.content.length <= threshold) return msg;
    const name = (msg.tool_call_id && nameMap.get(msg.tool_call_id)) ?? 'unknown';
    const stub = `[Tool ${name} returned ${msg.content.length} chars; omitted before summarization]`;
    return { ...msg, content: stub };
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
   * The model's context window size (in tokens).
   * Compression is triggered when token usage exceeds this value.
   */
  contextWindow: number;

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
   * Contract: must not throw or reject. Errors propagate out of compile() — there
   * is no fallback path. Wrap your logic in try/catch if it can fail.
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
   * Contract: must not throw or reject. Errors propagate out of compile() — return
   * null on failure to fall back to default LLM compression rather than throwing.
   */
  onBeforeCompress?: (
    history: Message[],
    tokenInfo: { currentTokens: number; limit: number },
  ) => Message[] | null | undefined | Promise<Message[] | null | undefined>;

  /**
   * @deprecated Use `onBeforeCompress` instead. Will be removed in the next major version.
   */
  onBudgetExceeded?: (
    history: Message[],
    tokenInfo: { currentTokens: number; limit: number },
  ) => Message[] | null | undefined | Promise<Message[] | null | undefined>;
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
  let clearThinking = false;

  for (const target of options.clear) {
    if (target === 'tool-result') {
      clearToolResult = true;
    } else if (target === 'thinking') {
      clearThinking = true;
    } else if (typeof target === 'object' && target.target === 'tool-result') {
      clearToolResult = true;
      toolResultKeepRecent = target.keepRecent;
    }
  }

  // Build the set of tool message indices to skip (keepRecent)
  let toolResultSkipSet: Set<number> | undefined;
  if (clearToolResult && toolResultKeepRecent !== undefined) {
    const keepCount = Math.max(1, toolResultKeepRecent);
    // Collect indices of all tool messages (in order)
    const toolIndices: number[] = [];
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'tool') {
        toolIndices.push(i);
      }
    }
    // The last keepCount tool messages are preserved
    const preserveIndices = toolIndices.slice(-keepCount);
    toolResultSkipSet = new Set(preserveIndices);
  }

  return history.map((msg, idx) => {
    let result = msg;

    if (clearToolResult && msg.role === 'tool') {
      // Skip (preserve) if this index is in the keepRecent set
      if (!toolResultSkipSet?.has(idx)) {
        result = { ...result, content: '[Old tool result content cleared]' };
      }
    }

    if (clearThinking && msg.role === 'assistant') {
      if (msg.thinking || msg.redacted_thinking) {
        // Set to undefined rather than destructure-delete: keeps Message typing
        // clean (adapters use truthy checks, undefined is dropped by JSON.stringify).
        result = { ...result, thinking: undefined, redacted_thinking: undefined };
      }
    }

    return result;
  });
}

export interface SummarizeHistoryOptions {
  /** Extra instructions appended to (not replacing) the default compaction
   *  prompt — the default <analysis>/<summary> scaffolding is always kept. */
  customCompressionInstructions?: string;
  /** Replace tool-result content longer than this many chars with a one-line
   *  metadata stub before summarizing (saves summarizer tokens). */
  toolResultStubThreshold?: number;
}

/**
 * Produce a compression summary for a slice of conversation `messages`, using
 * the same pipeline as the in-flight `compress` path: tool-result stubbing →
 * attachment stripping → trailing instruction → `<summary>` extraction. Returns
 * the extracted summary text (after `formatCompactSummary` strips `<analysis>`
 * and unwraps `<summary>`) — the caller wraps it (e.g. with
 * `Prompts.getCompactSummaryWrapper`) if it wants the continuation framing.
 *
 * Stateless: no circuit breaker, no fallback. THROWS if `compress` throws —
 * callers decide their own degradation. `Janitor.executeCompression` delegates
 * here and keeps its own try/catch + circuit breaker.
 *
 * An empty `messages` slice returns `''` without invoking `compress`.
 *
 * @param messages   The slice to summarize (conversation only; exclude the
 *                   standing system prompt).
 * @param compress   Model callback `(messages) => Promise<string>`. It MUST
 *                   map `tool` roles and assistant tool-calls to plain
 *                   user/assistant text — providers reject raw `tool` roles, so
 *                   a naive passthrough will break on tool messages. If you use
 *                   ai-sdk-middleware, call `summarizeMessages(prompt, model)`
 *                   instead of building this manually; its internal
 *                   `createCompressionAdapter` is the reference flattener.
 */
export async function summarizeHistory(
  messages: Message[],
  compress: (messages: Message[]) => Promise<string>,
  opts: SummarizeHistoryOptions = {},
): Promise<string> {
  if (messages.length === 0) return '';

  let instruction = Prompts.CONTEXT_COMPACTION_INSTRUCTION;
  const extra = opts.customCompressionInstructions?.trim();
  if (extra) {
    instruction += `\n\nAdditional Instructions:\n${extra}`;
  }

  const stubbed =
    opts.toolResultStubThreshold !== undefined
      ? stripLargeToolResultsForCompression(messages, opts.toolResultStubThreshold)
      : messages;

  const compressionMessages: Message[] = [
    ...stripAttachmentsForCompression(stubbed),
    { role: 'user', content: instruction },
  ];

  const raw = await compress(compressionMessages);
  return Prompts.formatCompactSummary(raw);
}

export class Janitor {
  /** Externally reported token count from the last API response. */
  private _externalTokenUsage: number | null = null;
  /** Suppresses the next compression check after a successful compression (E10). */
  private _suppressNextCompression = false;
  /**
   * Circuit breaker counter — incremented on compressionModel failure, reset on success.
   * When it reaches MAX_CONSECUTIVE_COMPRESSION_FAILURES, compress() becomes a no-op
   * to prevent hammering a broken compression model on every turn.
   */
  private _consecutiveFailures = 0;

  constructor(private config: JanitorConfig) {
    // Warn if feedTokenUsage path is likely used without a compressionModel
    if (!config.tokenizer && !config.compressionModel) {
      (config.logger ?? console).warn(
        '[Janitor] Warning: No tokenizer and no compressionModel configured. ' +
          'In the feedTokenUsage path, compression without a compressionModel will discard old messages ' +
          'with only a placeholder summary. Consider providing a compressionModel for meaningful context preservation.',
      );
    }
  }

  public snapshotState(): JanitorSnapshot {
    return {
      externalTokenUsage: this._externalTokenUsage,
      suppressNextCompression: this._suppressNextCompression,
      consecutiveFailures: this._consecutiveFailures,
    };
  }

  public restoreState(state: JanitorSnapshot): void {
    this._externalTokenUsage = state.externalTokenUsage;
    this._suppressNextCompression = state.suppressNextCompression;
    this._consecutiveFailures = state.consecutiveFailures ?? 0;
  }

  /**
   * Resets the Janitor's internal state.
   * Called when rolling history is explicitly cleared by the developer.
   */
  public reset(): void {
    this._externalTokenUsage = null;
    this._suppressNextCompression = false;
    this._consecutiveFailures = 0;
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
   * Compresses the rolling history when token budget is exceeded.
   *
   * Two paths:
   * - Tokenizer path: precise splitIndex based on per-turn token costs.
   * - FeedTokenUsage path: full compression, keeping only the last N turns.
   *
   * Circuit breaker: if the compressionModel has failed MAX_CONSECUTIVE_COMPRESSION_FAILURES
   * times in a row, compress() returns history unchanged to avoid futile retries.
   */
  public async compress(history: Message[]): Promise<Message[]> {
    // Circuit breaker: bail out if compression is consistently failing.
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_COMPRESSION_FAILURES) {
      return history;
    }

    const evaluation = this.evaluateBudget(history);
    if (evaluation === null) return history;

    let { splitIndex } = evaluation;
    const { currentTokens } = evaluation;

    // Fire onBeforeCompress hook — developer gets a chance to intervene
    const hook = this.config.onBeforeCompress ?? this.config.onBudgetExceeded;
    if (hook) {
      const modified = await hook(history, {
        currentTokens,
        limit: this.config.contextWindow,
      });

      if (modified != null) {
        // Re-evaluate with the developer-modified history
        const reEval = this.evaluateBudget(modified);
        if (reEval === null) return modified;
        history = modified;
        splitIndex = reEval.splitIndex;
      }
    }

    return this.executeCompression(history, splitIndex);
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
   * Evaluates token budgets and returns the split index for compression,
   * or null if no compression is needed.
   *
   * Uses turn-based grouping: messages are grouped into atomic turns
   * (assistant+tool_calls+tool_results as one unit), and splits only happen
   * on turn boundaries. This guarantees tool pair integrity and valid
   * message alternation without post-hoc corrections.
   */
  private evaluateBudget(history: Message[]): { splitIndex: number; currentTokens: number } | null {
    if (history.length === 0) return null;

    // E10: Skip check once after a successful compression to avoid cascading re-compression.
    if (this._suppressNextCompression) {
      this._suppressNextCompression = false;
      return null;
    }

    const turns = groupIntoTurns(history);

    // ─── Tokenizer path: precise per-message calculation ───
    if (this.config.tokenizer) {
      const tokenizerTokens = this.config.tokenizer(history);
      const fedTokens = this._externalTokenUsage;
      this._externalTokenUsage = null;

      // Trigger source selection — see UsagePreferenceWithTokenizer JSDoc for
      // when each branch is the right call. Default 'max' preserves the
      // historical Math.max behavior for callers that do not opt in.
      const preference = this.config.usagePreference ?? 'max';
      let effectiveTokens: number;
      switch (preference) {
        case 'feedFirst':
          effectiveTokens = fedTokens ?? tokenizerTokens;
          break;
        case 'tokenizerFirst':
          effectiveTokens = tokenizerTokens;
          break;
        default:
          effectiveTokens = Math.max(tokenizerTokens, fedTokens ?? 0);
      }

      if (effectiveTokens <= this.config.contextWindow) {
        return null;
      }

      const preserveTarget = Math.floor(
        this.config.contextWindow * (this.config.preserveRatio ?? DEFAULT_PRESERVE_RATIO),
      );

      // Iterate turns from the tail, accumulating token costs per turn
      let accumulatedTokens = 0;
      let splitTurn = turns.length;

      for (let t = turns.length - 1; t >= 0; t--) {
        const turnMessages = history.slice(turns[t].startIndex, turns[t].endIndex);
        const turnTokens = this.config.tokenizer(turnMessages);
        if (accumulatedTokens + turnTokens > preserveTarget) {
          break;
        }
        accumulatedTokens += turnTokens;
        splitTurn = t;
      }

      // Keep at least 1 turn if a single turn exceeds the preserve budget
      if (splitTurn === turns.length && turns.length > 0) {
        splitTurn = turns.length - 1;
      }

      if (splitTurn <= 0) return null;

      const splitIndex = turns[splitTurn].startIndex;
      return { splitIndex, currentTokens: effectiveTokens };
    }

    // ─── FeedTokenUsage path: simple total comparison, keep last N turns ───
    const currentTokens = this._externalTokenUsage ?? estimateObject(history);
    this._externalTokenUsage = null;

    if (currentTokens <= this.config.contextWindow) {
      return null;
    }

    // Keep the last N turns (not messages), compress everything else
    const keepCount = Math.min(
      this.config.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES,
      turns.length,
    );
    const splitTurn = turns.length - keepCount;

    if (splitTurn <= 0) return null;

    const splitIndex = turns[splitTurn].startIndex;
    return { splitIndex, currentTokens };
  }

  private async executeCompression(history: Message[], splitIndex: number): Promise<Message[]> {
    const toCompress = history.slice(0, splitIndex);
    const toKeep = history.slice(splitIndex);

    if (!this.config.compressionModel) {
      if (this.config.onCompress) {
        await this.config.onCompress(
          { role: 'system', content: Prompts.getFallbackCompressionSummary(toCompress.length) },
          toCompress.length,
          { compressedMessages: toCompress },
        );
      }
      this._suppressNextCompression = true;
      return [...toKeep];
    }

    if (toCompress.length === 0) {
      return history;
    }

    const compressionModel = this.config.compressionModel;

    let summaryText: string;
    try {
      summaryText = await summarizeHistory(toCompress, compressionModel, {
        customCompressionInstructions: this.config.customCompressionInstructions,
        toolResultStubThreshold: this.config.toolResultStubThreshold,
      });
      // Reset circuit breaker on success.
      this._consecutiveFailures = 0;
    } catch (error) {
      // Increment circuit breaker. After MAX_CONSECUTIVE_COMPRESSION_FAILURES,
      // compress() will short-circuit to avoid futile retries.
      this._consecutiveFailures++;
      summaryText =
        Prompts.getFallbackCompressionSummary(toCompress.length) +
        `\n(Compression failed: ${error})`;
    }

    const summaryMessage: Message = {
      role: 'user',
      content: Prompts.getCompactSummaryWrapper(summaryText),
    };

    if (this.config.onCompress) {
      await this.config.onCompress(summaryMessage, toCompress.length, {
        compressedMessages: toCompress,
      });
    }

    // E10: Suppress the immediate next compression check.
    this._suppressNextCompression = true;

    return [summaryMessage, ...toKeep];
  }
}
