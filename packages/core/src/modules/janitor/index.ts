import { Prompts } from '../../prompts';
import type { ChefLogger, CompactOptions, Message } from '../../types';
import { estimateObject } from '../../utils/tokenUtils';

const DEFAULT_PRESERVE_RATIO = 0.8;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 1;
const MAX_CONSECUTIVE_COMPRESSION_FAILURES = 3;
/**
 * Compression triggers at this fraction of `contextWindow` by default.
 * "Pre-rot": model quality degrades well before the hard window limit, so
 * compressing early keeps the model in its reliable range. Set
 * `triggerRatio: 1` to restore the pre-4.0 trigger-at-window behavior.
 */
const DEFAULT_TRIGGER_RATIO = 0.7;
/**
 * A compression result must shrink the compressed span's character length by
 * at least this ratio by default, or it is treated as a failed compression.
 * Guards against the "compression that doesn't shrink" death loop observed in
 * production agents (each turn re-triggers compression, costs grow unbounded).
 */
const DEFAULT_MIN_SHRINK_RATIO = 0.5;
/**
 * The shrink guard only applies to spans at least this long. A tiny span
 * cannot meaningfully shrink below a well-formed summary's natural length,
 * and the death-loop scenario the guard prevents only occurs on large spans.
 */
const MIN_SHRINK_GUARD_SPAN_CHARS = 2000;

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

// ─── Constraint pinning ───

/**
 * Returns the set of message indices protected by pinning, turn-scoped:
 * pinning any message of an atomic turn protects every message of that turn,
 * so an assistant+tool_calls unit and its tool results stay coherent.
 */
function collectPinnedTurnIndices(history: Message[]): Set<number> {
  const pinned = new Set<number>();
  // Fast path: no pinned messages at all (the common case) — skip grouping.
  if (!history.some((m) => m.pinned)) return pinned;
  for (const turn of groupIntoTurns(history)) {
    let hasPinned = false;
    for (let i = turn.startIndex; i < turn.endIndex; i++) {
      if (history[i].pinned) {
        hasPinned = true;
        break;
      }
    }
    if (hasPinned) {
      for (let i = turn.startIndex; i < turn.endIndex; i++) pinned.add(i);
    }
  }
  return pinned;
}

/**
 * Content-equivalence check for the background-compression staleness test.
 * Object identity alone is too brittle — pipeline stages (transformToolResult,
 * compact) may recreate message objects without changing their meaning, and a
 * recreated-but-identical boundary must not discard a finished job.
 */
function messagesEquivalent(a: Message | undefined, b: Message | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.role === b.role && a.content === b.content && a.tool_call_id === b.tool_call_id;
}

/** Extracts the pinned (turn-scoped) messages of a slice, in original order. */
function extractPinnedMessages(messages: Message[]): Message[] {
  const indices = collectPinnedTurnIndices(messages);
  if (indices.size === 0) return [];
  return messages.filter((_, i) => indices.has(i));
}

/**
 * Splits a slice into its pinned (turn-scoped) messages and the rest, both in
 * original order. Used by durable compaction to move pinned turns out of the
 * summarize range so they survive verbatim.
 */
export function partitionPinnedMessages(messages: Message[]): {
  pinned: Message[];
  rest: Message[];
} {
  const indices = collectPinnedTurnIndices(messages);
  if (indices.size === 0) return { pinned: [], rest: messages };
  const pinned: Message[] = [];
  const rest: Message[] = [];
  messages.forEach((m, i) => {
    (indices.has(i) ? pinned : rest).push(m);
  });
  return { pinned, rest };
}

// ─── Attachment stripping for compression ───

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

    const placeholders = msg.attachments
      .map((att) => Prompts.getAttachmentPlaceholder(att.mediaType, att.filename))
      .join('\n');
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
export function buildToolNameMap(messages: Message[]): Map<string, string> {
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
 * Where compressed spans are archived for reversible compression.
 * `store` receives the serialized span (`JSON.stringify({version: 1, messages})`)
 * and returns a URI the summary will cite (e.g. `context://vfs/...`).
 */
export interface CompressionArchiveConfig {
  store: (serialized: string, meta: { messageCount: number }) => string | Promise<string>;
}

/**
 * Fields shared by every JanitorConfig variant. Not exported on its own —
 * downstream callers should use {@link JanitorConfig}.
 */
interface JanitorConfigBase {
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
  /** Persistent anchor document ('incremental-anchored' mode). Null when absent. */
  anchorDoc?: string | null;
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

export interface SummarizeHistoryOptions {
  /** Extra instructions appended to (not replacing) the default compaction
   *  prompt — the default <analysis>/<summary> scaffolding is always kept. */
  customCompressionInstructions?: string;
  /** Replace tool-result content longer than this many chars with a one-line
   *  metadata stub before summarizing (saves summarizer tokens). */
  toolResultStubThreshold?: number;
  /** Numbered domain guidelines injected after the base instruction and
   *  before customCompressionInstructions. See JanitorConfig.compressionGuidelines. */
  compressionGuidelines?: string[];
  /** Replace the BASE instruction (default CONTEXT_COMPACTION_INSTRUCTION).
   *  The replacement must keep the <analysis>/<summary> output contract —
   *  used internally for the anchored-compaction instruction. */
  baseInstruction?: string;
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

  let instruction = opts.baseInstruction ?? Prompts.CONTEXT_COMPACTION_INSTRUCTION;
  const guidelines = (opts.compressionGuidelines ?? []).map((g) => g.trim()).filter(Boolean);
  if (guidelines.length > 0) {
    instruction += `\n\nDomain Guidelines:\n${guidelines.map((g, i) => `${i + 1}. ${g}`).join('\n')}`;
  }
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

/**
 * In-flight background compression job (compressionScheduling: 'background').
 *
 * `toCompress` is the compressed span — always `history.slice(0, splitIndex)`
 * and never empty — so the staleness check derives its split index and its
 * boundary messages from it rather than storing them a second time.
 */
interface BackgroundCompressionJob {
  settled: boolean;
  /** Head to splice in ([summaryMessage, ...pinned]) or null on failure. */
  head: Message[] | null;
  /** Anchor update to apply at swap time ('incremental-anchored' mode). */
  anchorUpdate: string | null;
  toCompress: Message[];
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
  /** Persistent anchor document ('incremental-anchored' mode). */
  private _anchorDoc: string | null = null;
  /** Pending background summarization ('background' scheduling). Not snapshotted. */
  private _pendingBackground?: BackgroundCompressionJob;

  constructor(private config: JanitorConfig) {
    // Warn if feedTokenUsage path is likely used without a compressionModel
    if (!config.tokenizer && !config.compressionModel) {
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
  }

  /** Resolved archive config — the 'vfs' shorthand is only usable via ContextChef wiring. */
  private get _archive(): CompressionArchiveConfig | undefined {
    return typeof this.config.archive === 'object' ? this.config.archive : undefined;
  }

  public snapshotState(): JanitorSnapshot {
    return {
      externalTokenUsage: this._externalTokenUsage,
      suppressNextCompression: this._suppressNextCompression,
      consecutiveFailures: this._consecutiveFailures,
      anchorDoc: this._anchorDoc,
    };
  }

  public restoreState(state: JanitorSnapshot): void {
    this._externalTokenUsage = state.externalTokenUsage;
    this._suppressNextCompression = state.suppressNextCompression;
    this._consecutiveFailures = state.consecutiveFailures ?? 0;
    this._anchorDoc = state.anchorDoc ?? null;
    // A pending background job belongs to the pre-restore timeline — drop it.
    this._pendingBackground = undefined;
  }

  /**
   * Resets the Janitor's internal state.
   * Called when rolling history is explicitly cleared by the developer.
   */
  public reset(): void {
    this._externalTokenUsage = null;
    this._suppressNextCompression = false;
    this._consecutiveFailures = 0;
    this._anchorDoc = null;
    this._pendingBackground = undefined;
  }

  /** Current anchor document ('incremental-anchored' mode), for observability. */
  public getAnchorDoc(): string | null {
    return this._anchorDoc;
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
   * Structured in three phases: `_prepareCompression` (budget evaluation +
   * developer hook), `_summarize` (model call + quality guards + archive),
   * and finalization (summary application + onCompress + suppression), which
   * runs inline here for blocking scheduling or in `_trySwapInBackgroundResult`
   * for background scheduling.
   *
   * Guarantees:
   * - Pinned (turn-scoped) messages inside the compressed span are re-inserted
   *   verbatim after the summary, never summarized away.
   * - A failed/rejected/non-shrinking summary leaves history UNCHANGED and
   *   counts toward the circuit breaker; after
   *   MAX_CONSECUTIVE_COMPRESSION_FAILURES consecutive failures compress()
   *   short-circuits entirely.
   */
  public async compress(history: Message[]): Promise<Message[]> {
    // 0. Background job bookkeeping (background scheduling only)
    const swapped = await this._trySwapInBackgroundResult(history);
    if (swapped) return swapped;
    if (this._pendingBackground) {
      // Job still running — don't stack a second evaluation on top of it.
      return history;
    }

    // Circuit breaker: bail out if compression is consistently failing.
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_COMPRESSION_FAILURES) {
      return history;
    }

    // 1. Prepare: budget evaluation + onBeforeCompress hook
    const prepared = await this._prepareCompression(history);
    if (prepared.splitIndex === null) return prepared.history;
    const { splitIndex } = prepared;
    history = prepared.history;

    const toCompress = history.slice(0, splitIndex);
    const toKeep = history.slice(splitIndex);
    if (toCompress.length === 0) return history;

    // Pinned (turn-scoped) messages survive verbatim in all outcomes below.
    const pinned = extractPinnedMessages(toCompress);

    // 2a. No compression model: drop the span (placeholder summary via
    //     onCompress only), keeping pinned messages.
    if (!this.config.compressionModel) {
      await this._fireOnCompress(
        { role: 'system', content: Prompts.getFallbackCompressionSummary(toCompress.length) },
        toCompress.length,
        { compressedMessages: toCompress },
      );
      this._suppressNextCompression = true;
      return [...pinned, ...toKeep];
    }

    // 2b. Background scheduling: kick the summarization off and return
    //     history unchanged; a later compress() call swaps the result in.
    if ((this.config.compressionScheduling ?? 'blocking') === 'background') {
      this._startBackgroundJob(toCompress, toKeep, pinned);
      return history;
    }

    // 2c. Blocking: summarize now.
    const result = await this._summarize(toCompress, toKeep);
    if (result === null) return history; // guard/model failure — unchanged

    // 3. Finalize (anchor updates apply only when the summary is applied)
    this._applyAnchorUpdate(result.anchorUpdate);
    await this._fireOnCompress(result.summaryMessage, toCompress.length, {
      compressedMessages: toCompress,
    });
    this._suppressNextCompression = true;
    return [result.summaryMessage, ...pinned, ...toKeep];
  }

  /**
   * Phase 1: evaluates the budget and runs the onBeforeCompress hook.
   * Returns the (possibly hook-modified) history and the split index, or
   * `splitIndex: null` when no compression is needed.
   */
  private async _prepareCompression(
    history: Message[],
  ): Promise<{ history: Message[]; splitIndex: number | null }> {
    const evaluation = this.evaluateBudget(history);
    if (evaluation === null) return { history, splitIndex: null };

    let { splitIndex } = evaluation;
    const { currentTokens, limit } = evaluation;

    // Fire onBeforeCompress hook — developer gets a chance to intervene
    const hook = this.config.onBeforeCompress;
    if (hook) {
      let modified: Message[] | null | undefined;
      try {
        modified = await hook(history, { currentTokens, limit });
      } catch (error) {
        // Same degradation stance as onCompress: a broken hook must not fail
        // compile(). A throw is treated as "return null" — the failure recipe
        // the return contract already documents — so default compression
        // proceeds.
        (this.config.logger ?? console).warn(
          '[context-chef] onBeforeCompress hook threw — proceeding with default compression',
          error,
        );
        modified = null;
      }

      if (modified != null) {
        // Re-evaluate with the developer-modified history
        const reEval = this.evaluateBudget(modified);
        if (reEval === null) return { history: modified, splitIndex: null };
        history = modified;
        splitIndex = reEval.splitIndex;
      }
    }

    return { history, splitIndex };
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
   * The effective trigger threshold is `contextWindow * triggerRatio`
   * (default 0.7 — "pre-rot"). In the tokenizer path, `preserveRatio` is
   * applied to that same effective budget so post-compression usage lands
   * safely below the trigger point (no compress-every-turn thrash).
   *
   * Uses turn-based grouping: messages are grouped into atomic turns
   * (assistant+tool_calls+tool_results as one unit), and splits only happen
   * on turn boundaries. This guarantees tool pair integrity and valid
   * message alternation without post-hoc corrections.
   */
  private evaluateBudget(
    history: Message[],
  ): { splitIndex: number; currentTokens: number; limit: number } | null {
    if (history.length === 0) return null;

    // E10: Skip check once after a successful compression to avoid cascading re-compression.
    if (this._suppressNextCompression) {
      this._suppressNextCompression = false;
      return null;
    }

    const limit = this.config.contextWindow * (this.config.triggerRatio ?? DEFAULT_TRIGGER_RATIO);
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

      if (effectiveTokens <= limit) {
        return null;
      }

      const preserveTarget = Math.floor(
        limit * (this.config.preserveRatio ?? DEFAULT_PRESERVE_RATIO),
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
      return { splitIndex, currentTokens: effectiveTokens, limit };
    }

    // ─── FeedTokenUsage path: simple total comparison, keep last N turns ───
    const currentTokens = this._externalTokenUsage ?? estimateObject(history);
    this._externalTokenUsage = null;

    if (currentTokens <= limit) {
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
    return { splitIndex, currentTokens, limit };
  }

  /**
   * Phase 2: produce the summary message for a compressed span, applying
   * quality guards, archiving, and anchor bookkeeping.
   *
   * Returns the ready summary Message, or null on ANY failure — model throw,
   * shrink-guard rejection, or validateCompression rejection. Every failure
   * increments the circuit breaker and leaves history for the caller to
   * return UNCHANGED (never a lossy placeholder truncation — the pre-4.0
   * behavior of dropping the span with a bare notice applied only to the
   * model-throw path and made a bad situation worse).
   */
  private async _summarize(
    toCompress: Message[],
    toKeep: Message[],
  ): Promise<{ summaryMessage: Message; anchorUpdate: string | null } | null> {
    const compressionModel = this.config.compressionModel;
    if (!compressionModel) return null;
    const logger = this.config.logger ?? console;
    const anchored = this.config.compressionMode === 'incremental-anchored';

    // ── Model call
    let summaryText: string;
    try {
      summaryText = await summarizeHistory(toCompress, compressionModel, {
        customCompressionInstructions: this.config.customCompressionInstructions,
        toolResultStubThreshold: this.config.toolResultStubThreshold,
        compressionGuidelines: this.config.compressionGuidelines,
        baseInstruction: anchored
          ? Prompts.getAnchoredCompactionInstruction(this._anchorDoc)
          : undefined,
      });
    } catch (error) {
      return this._compressionFailed('compression model failed', error);
    }

    // ── Shrink guard: a summary that doesn't shrink the span is a failure.
    //    Only applied to spans >= MIN_SHRINK_GUARD_SPAN_CHARS — tiny spans
    //    can't shrink below a well-formed summary's natural length, and the
    //    death loop this prevents only occurs on large spans.
    //    Span size counts everything the summarizer consumes: content,
    //    thinking, AND tool-call arguments (write/edit tools routinely carry
    //    the bulk of a coding-agent span in `arguments`).
    //    Anchored mode compares GROWTH, not absolute size — the anchor is
    //    cumulative, so comparing it against only the newly evicted span
    //    would inevitably trip the breaker in healthy long sessions.
    const minShrink = this.config.minShrinkRatio ?? DEFAULT_MIN_SHRINK_RATIO;
    if (minShrink > 0) {
      const spanChars = toCompress.reduce(
        (sum, m) =>
          sum +
          m.content.length +
          (m.thinking?.thinking.length ?? 0) +
          (m.tool_calls?.reduce((s, tc) => s + tc.function.arguments.length, 0) ?? 0),
        0,
      );
      const allowance = (1 - minShrink) * spanChars;
      const effectiveSize = anchored
        ? summaryText.length - (this._anchorDoc?.length ?? 0)
        : summaryText.length;
      if (spanChars >= MIN_SHRINK_GUARD_SPAN_CHARS && effectiveSize > allowance) {
        return this._compressionFailed(
          `compression result failed the shrink guard (${anchored ? 'anchor growth' : 'summary'} ` +
            `${effectiveSize} chars vs span ${spanChars} chars, minShrinkRatio ${minShrink})`,
        );
      }
    }

    // ── Validation gate
    if (this.config.validateCompression) {
      let valid: boolean;
      try {
        valid = await this.config.validateCompression(summaryText, {
          compressed: toCompress,
          kept: toKeep,
        });
      } catch (error) {
        logger.warn(
          '[context-chef] validateCompression threw — treating the summary as rejected',
          error,
        );
        valid = false;
      }
      if (!valid) {
        return this._compressionFailed('compression summary rejected by validateCompression');
      }
    }

    // ── Success: breaker reset (model-health signal — a later stale discard
    //    doesn't change that the model succeeded) + best-effort archive.
    //    The anchor is NOT written here: it is applied by the caller at
    //    application time, so a background job discarded as stale can never
    //    pollute the anchor with content that stays live in history.
    this._consecutiveFailures = 0;

    let citation = '';
    const archive = this._archive;
    if (archive) {
      try {
        const serialized = JSON.stringify({ version: 1, messages: toCompress });
        const uri = await archive.store(serialized, { messageCount: toCompress.length });
        citation = `\n\n${Prompts.getArchiveCitation(uri, toCompress.length)}`;
      } catch (error) {
        logger.warn(
          '[context-chef] compression archive store failed — proceeding without a citation',
          error,
        );
      }
    }

    return {
      summaryMessage: {
        role: 'user',
        content: Prompts.getCompactSummaryWrapper(summaryText + citation),
      },
      anchorUpdate: anchored ? summaryText : null,
    };
  }

  /**
   * Records a compression failure: counts it toward the circuit breaker and
   * warns with the shared "history left unchanged" wording. Returns null so
   * every failure path in {@link _summarize} can `return` it directly.
   */
  private _compressionFailed(reason: string, ...details: unknown[]): null {
    this._consecutiveFailures++;
    (this.config.logger ?? console).warn(
      `[context-chef] ${reason} — history left unchanged ` +
        `(failure ${this._consecutiveFailures}/${MAX_CONSECUTIVE_COMPRESSION_FAILURES} toward circuit breaker)`,
      ...details,
    );
    return null;
  }

  /** Applies a successful summarization's anchor update ('incremental-anchored'). */
  private _applyAnchorUpdate(anchorUpdate: string | null): void {
    if (anchorUpdate !== null) {
      this._anchorDoc = anchorUpdate;
    }
  }

  /** Kicks off a background summarization job ('background' scheduling). */
  private _startBackgroundJob(toCompress: Message[], toKeep: Message[], pinned: Message[]): void {
    const job: BackgroundCompressionJob = {
      settled: false,
      head: null,
      anchorUpdate: null,
      toCompress,
    };
    this._pendingBackground = job;
    void this._summarize(toCompress, toKeep)
      .then((result) => {
        if (result !== null) {
          job.head = [result.summaryMessage, ...pinned];
          job.anchorUpdate = result.anchorUpdate;
        }
      })
      .catch((error) => {
        // _summarize handles its own failures; this is a belt-and-braces net.
        (this.config.logger ?? console).warn(
          '[context-chef] background compression job crashed unexpectedly',
          error,
        );
      })
      .finally(() => {
        job.settled = true;
      });
  }

  /**
   * Applies a finished background job to the current history, if it is still
   * applicable. Returns the swapped history, or null when there is nothing to
   * apply (no job, job unsettled, job failed, or job stale — the compressed
   * span is no longer a prefix of the current history, checked by message
   * identity).
   */
  private async _trySwapInBackgroundResult(history: Message[]): Promise<Message[] | null> {
    const job = this._pendingBackground;
    if (!job?.settled) return null;
    this._pendingBackground = undefined;
    if (!job.head) return null; // failed job — breaker already counted it

    const splitIndex = job.toCompress.length;
    const stillPrefix =
      history.length >= splitIndex &&
      messagesEquivalent(history[0], job.toCompress[0]) &&
      messagesEquivalent(history[splitIndex - 1], job.toCompress[splitIndex - 1]);
    if (!stillPrefix) return null; // stale — discard, fall through to fresh evaluation

    // Finalize at application time (not at computation time): the anchor and
    // persistence consumers only see summaries that actually entered history.
    // onCompress is awaited so the persistence contract matches blocking mode.
    this._applyAnchorUpdate(job.anchorUpdate);
    await this._fireOnCompress(job.head[0], job.toCompress.length, {
      compressedMessages: job.toCompress,
    });
    this._suppressNextCompression = true;
    return [...job.head, ...history.slice(splitIndex)];
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
      (this.config.logger ?? console).warn(
        '[context-chef] onCompress hook threw — compression result is kept, but your sink may have missed this summary',
        error,
      );
    }
  }
}
