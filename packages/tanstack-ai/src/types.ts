import type {
  ChefLogger,
  ClearTarget,
  IntegrationOverflowOptions,
  Message,
  Skill,
  StorageBackend,
  Store,
  VFSStorageAdapter,
} from '@context-chef/core';
import type {
  AnyTextAdapter,
  ChatMiddlewareContext,
  ModelMessage,
  SystemPrompt,
} from '@tanstack/ai';

export interface TruncateOptions {
  /** Character count threshold to trigger truncation. */
  threshold: number;
  /** Characters to preserve from the start. Default: 0 */
  headChars?: number;
  /** Characters to preserve from the end. Default: 1000 */
  tailChars?: number;
  /**
   * Storage adapter for persisting original content before truncation.
   * When provided, truncated output includes a `context://vfs/` URI for retrieval.
   *
   * @deprecated Pass `store` instead — one backend serves `vfs`, `archive`,
   *   `memory` and `notes`. A legacy adapter still works: it is wrapped with
   *   `Store.fromVfsAdapter`.
   */
  storage?: VFSStorageAdapter;
  /**
   * The context store backing the `vfs` namespace: a `StorageBackend`
   * (`InMemoryBackend`, `FileSystemBackend`, your own) or a pre-built `Store`
   * shared with an archive. Takes precedence over `storage`.
   *
   * As with `storage`, truncated output carries a `context://vfs/` URI, which
   * `chef.resolveRecall(uri)` — or the `context` tool's `view` — reads back.
   */
  store?: StorageBackend | Store;
  /**
   * Per-tool overrides applied on top of the defaults above.
   *
   * - String entry → preserve: never truncate this tool's result. Storage
   *   is bypassed entirely (nothing written to VFS).
   * - Object entry → override `threshold` / `headChars` / `tailChars` for
   *   that tool only. Storage behavior unchanged.
   *
   * Tools not listed fall back to the top-level defaults. If the same
   * `name` appears more than once, the last entry wins (a bare string
   * after an object discards that object → becomes preserve).
   *
   * The lookup key is the tool's name. It is read from `msg.name` when set,
   * otherwise resolved from the preceding assistant turn's
   * `toolCalls[].function.name` via `toolCallId`. The standard
   * UIMessage → ModelMessage path constructs tool messages without `name`,
   * so this fallback is what makes `perTool` work for typical chat()
   * consumers. If neither signal is present, the tool falls through to
   * the top-level defaults.
   *
   * Notes:
   * - Wildcards / globs are NOT supported.
   * - `storage` cannot be overridden per-tool.
   * - `perTool` only affects the truncate step; a preserved message may
   *   still be dropped by `compact`, summarized by `compress`, or
   *   rewritten by `transformContext`.
   */
  perTool?: Array<
    | string
    | {
        name: string;
        threshold?: number;
        headChars?: number;
        tailChars?: number;
      }
  >;
}

/**
 * History compression via LLM summarization.
 *
 * **Persistence:** the middleware compresses the engine's in-flight message
 * state — it rewrites what the model sees but does NOT mutate your own
 * message store. For a sustained over-budget conversation, persist the
 * summary via {@link ContextChefOptions.onCompress} (replace the compressed
 * slice in your store) or use `compactTanStackMessages` for durable
 * compaction. The middleware warns once if compression keeps firing without
 * `onCompress`.
 */
export interface CompressOptions {
  /** A cheap TanStack AI adapter used for summarization (e.g. openaiText('gpt-4o-mini')). */
  adapter: AnyTextAdapter;
  /** Ratio of context window to preserve for recent messages. Default: 0.8 */
  preserveRatio?: number;
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
   * by at least this ratio (0–1). Default 0.5. A summary failing the check
   * is treated as a failed compression: history is left unchanged and the
   * failure counts toward the circuit breaker — so a summarizer that echoes
   * its input trips the breaker instead of looping forever. Set to 0 to
   * disable the check.
   */
  minShrinkRatio?: number;
  /**
   * Replace tool-result content longer than this many characters with a
   * one-line metadata stub (`[Tool name returned N chars; omitted before
   * summarization]`) before the to-be-summarized history is sent to the
   * compression model. Recent (preserved) tool results are untouched.
   *
   * Saves summarizer tokens on big tool outputs while preserving the
   * "what happened" semantics needed for a useful summary. Default:
   * undefined (disabled). Recommended starting value: `5000`.
   */
  toolResultStubThreshold?: number;
  /**
   * Strategy for choosing the trigger token count when both a `tokenizer`
   * and an externally-reported usage value are available.
   *
   * - `'max'` (default): use the higher of the two — most conservative.
   * - `'feedFirst'`: prefer reported usage when present, fall back to
   *   tokenizer. Use when API-reported usage is authoritative and the
   *   tokenizer over-estimates (e.g. shared config across providers, some
   *   of which report usage and some do not).
   * - `'tokenizerFirst'`: ignore reported usage entirely. Requires a
   *   `tokenizer` to be configured; otherwise it is sanitized to `'max'`
   *   at construction time with a warning via the configured logger.
   */
  usagePreference?: 'max' | 'feedFirst' | 'tokenizerFirst';
}

/**
 * Mechanical compaction options — zero LLM cost.
 * Removes reasoning, tool call/result pairs, and empty messages before
 * LLM-based compression. Mirrors `@context-chef/ai-sdk-middleware`'s
 * CompactConfig (AI SDK `pruneMessages` semantics).
 */
export interface CompactConfig {
  /**
   * Controls removal of `thinking` (reasoning) content from assistant messages.
   * - `'all'`: Remove reasoning from all messages.
   * - `'before-last-message'`: Keep reasoning only in the final message.
   * - `'none'` (default): Keep all reasoning.
   */
  reasoning?: 'all' | 'before-last-message' | 'none';
  /**
   * Controls removal of tool-call and tool-result message pairs.
   * - `'all'`: Remove all tool-call/result pairs.
   * - `'before-last-message'`: Keep tool pairs only in the last message.
   * - `'before-last-${N}-messages'`: Keep tool pairs referenced by the last N messages.
   * - `'none'` (default): Keep all tool pairs.
   * - Array form allows per-tool control: each entry applies its removal
   *   mode only to the tools named in `tools` (all tools when omitted).
   *
   * Window semantics follow AI SDK `pruneMessages`: "last N messages"
   * counts messages of the whole array (any role); tool calls/results
   * referenced from inside that window are kept everywhere.
   */
  toolCalls?:
    | 'all'
    | 'before-last-message'
    | `before-last-${number}-messages`
    | 'none'
    | Array<{
        type: 'all' | 'before-last-message' | `before-last-${number}-messages`;
        tools?: string[];
      }>;
  /**
   * Whether to retain messages with no content after pruning.
   * - `'remove'` (default): Exclude messages with no text content, no tool
   *   calls, and no attachments. `role: 'tool'` messages are never removed —
   *   an empty string is a valid tool result, and dropping it would orphan
   *   the assistant tool_call that references it.
   * - `'keep'`: Retain them.
   */
  emptyMessages?: 'keep' | 'remove';
}

/**
 * Dynamic state injection config.
 * State is converted to XML and injected into the prompt for maximum LLM attention.
 */
export interface DynamicStateConfig {
  /**
   * Returns the current state object. Auto-converted to XML via `objectToXml`.
   * Called on every model invocation (init and each agent iteration); the
   * previously injected block is replaced, never duplicated.
   */
  getState: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Where to inject the state.
   * - `'last_user'` (default): Appends to the last user message. Leverages Recency Bias.
   * - `'system'`: Adds as a standalone system prompt at the end.
   */
  placement?: 'system' | 'last_user';
}

export interface ContextChefOptions {
  /**
   * The model's context window size in tokens.
   *
   * Required when a compression option is configured (`compress`,
   * `onCompress`, `onBeforeCompress`) — `contextChefMiddleware` throws
   * otherwise. Optional (and unused) for truncate / compact / clear /
   * skill / dynamicState-only configurations, which involve no budget
   * check.
   */
  contextWindow?: number;
  /** Enable history compression. Omit for no compression. */
  compress?: CompressOptions;
  /** Enable tool result truncation. Omit for no truncation. */
  truncate?: TruncateOptions;
  /**
   * Placeholder-style clearing (core semantics):
   *
   * - `'tool-result'` targets replace matched tool results with
   *   `'[Old tool result content cleared]'` instead of deleting them —
   *   message structure and tool-call pairing stay intact, unlike
   *   `compact` (deletion-style). When tool results are targeted, an
   *   instruction explaining the placeholder is auto-appended to
   *   `systemPrompts` so the model doesn't read it as an error.
   * - `'thinking'` strips `thinking` (reasoning) content from assistant
   *   messages. Equivalent to `compact: { reasoning: 'all' }` except it
   *   runs AFTER compression instead of before.
   *
   * Runs AFTER compression, so the summarizer still sees full content.
   *
   * Note: with `{ target: 'tool-result', keepRecent: N }`, the clearing
   * boundary advances each turn, which invalidates the provider prefix
   * cache at the first newly-cleared message — inherent to the semantics.
   */
  clear?: ClearTarget[];
  /**
   * Mechanical compaction — zero LLM cost.
   * Prunes reasoning, tool call/result pairs, and empty messages before compression.
   */
  compact?: CompactConfig;
  /**
   * Dynamic state injection. State is converted to XML and placed
   * for maximum LLM attention (last_user or system position).
   */
  dynamicState?: DynamicStateConfig;
  /**
   * Inject the active skill's instructions as an additional system prompt
   * before the model call. Mirrors the `dynamicState` pattern.
   *
   * - Pass a `Skill` object for static activation.
   * - Pass a function returning `Skill | null | undefined` for dynamic
   *   activation (called on every request — return null/undefined to skip).
   * - Function may be async.
   *
   * Skill instructions are appended to `systemPrompts` AFTER any existing
   * user system prompts, matching `@context-chef/core` compile() ordering
   * (see SKILL_SPEC §6.3 — instructions sit between userSystemPrompt and
   * memoryMessages; in TanStack AI all `systemPrompts` collapse to system
   * messages prepended to the conversation, so appending here yields the
   * equivalent ordering). Injection is idempotent across agent iterations.
   *
   * Decoupled from tool restriction — `skill.allowedTools` is annotation
   * only; chef does NOT enforce it (Claude Code semantics, see SKILL_SPEC
   * §5.4). Wire it to the Pruner yourself if you want hard restriction.
   *
   * Skipped when the resolved skill is null/undefined or its instructions
   * are an empty string.
   */
  skill?: Skill | (() => Skill | null | undefined | Promise<Skill | null | undefined>);
  /** Optional tokenizer for precise per-message token counting. */
  tokenizer?: (messages: Message[]) => number;
  /**
   * Sink for degradation warnings (storage write failures, missing usage
   * data, misconfiguration, hook failures). Defaults to `console`.
   * Forwarded to the underlying Janitor and Offloader.
   */
  logger?: ChefLogger;
  /**
   * The overflow axis: an explicit `OverflowStrategy` in place of the policy
   * `compress` describes (`summarize()`, `anchored()`, `reset()`, `chain()`,
   * `background()`), and an `archive` that keeps the evicted span retrievable
   * behind the URI the summary cites.
   *
   * `overflow.strategy` REPLACES the `compress` tuning options; the runner
   * concerns (`contextWindow`, `tokenizer`, `compress.triggerRatio`,
   * `compress.usagePreference`, `onCompress`, `onBeforeCompress`) keep
   * applying whatever the strategy is. `contextWindow` is required either way.
   *
   * @example
   * overflow: { strategy: chain(summarize({ compressionModel }), reset()) }
   */
  overflow?: IntegrationOverflowOptions;
  /**
   * Cap on concurrently tracked conversations. Each `ctx.threadId` gets
   * its own Janitor so token-usage feeds and compression state never leak
   * across conversations sharing one middleware instance.
   * Least-recently-used conversations beyond the cap are dropped and
   * transparently recreated on next access. Must be a positive integer —
   * the pool throws a RangeError otherwise. Default: 256.
   */
  maxSessions?: number;
  /**
   * Hook called after compression occurs.
   *
   * `details.compressedMessages` is the exact slice (TanStack format) that
   * the summary replaced — the precise boundary for persisting the summary
   * as a marker in your own store. These are the post-transform messages
   * (after truncate/compact): match tool messages back to your records by
   * `toolCallId`; user/assistant text is not modified by those steps.
   */
  onCompress?: (
    summary: string,
    truncatedCount: number,
    details: { compressedMessages: ModelMessage[] },
  ) => void;
  /**
   * Called when token budget is exceeded, before LLM compression.
   * Return modified messages to replace history, or null/undefined to
   * let default compression handle it.
   */
  onBeforeCompress?: (
    history: Message[],
    tokenInfo: { currentTokens: number; limit: number },
  ) => Message[] | null | undefined | Promise<Message[] | null | undefined>;
  /**
   * Transform the messages and system prompts after compression, before
   * sending to the model. Use for custom prompt manipulation, RAG
   * injection, etc.
   *
   * Runs on EVERY `onConfig` firing — at init and at the start of every
   * agent iteration — and the transformed config carries over to the next
   * iteration, so the hook MUST be idempotent (check before appending, or
   * gate on `ctx.phase === 'init'`).
   */
  transformContext?: (
    messages: ModelMessage[],
    systemPrompts: SystemPrompt[],
    ctx: ChatMiddlewareContext,
  ) =>
    | { messages: ModelMessage[]; systemPrompts: SystemPrompt[] }
    | Promise<{ messages: ModelMessage[]; systemPrompts: SystemPrompt[] }>;
}
