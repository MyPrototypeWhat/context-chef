import type { Message, Skill, VFSStorageAdapter } from '@context-chef/core';
import type { AnyTextAdapter, ModelMessage } from '@tanstack/ai';

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
   */
  storage?: VFSStorageAdapter;
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

export interface CompressOptions {
  /** A cheap TanStack AI adapter used for summarization (e.g. openaiText('gpt-4o-mini')). */
  adapter: AnyTextAdapter;
  /** Ratio of context window to preserve for recent messages. Default: 0.8 */
  preserveRatio?: number;
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
   *   at construction time with a console warning.
   */
  usagePreference?: 'max' | 'feedFirst' | 'tokenizerFirst';
}

/**
 * Mechanical compaction options — zero LLM cost.
 * Removes tool call/result pairs and empty messages before LLM-based compression.
 */
export interface CompactConfig {
  /**
   * Controls removal of tool-call and tool-result message pairs.
   * - `'all'`: Remove all tool-call/result pairs.
   * - `'before-last-message'`: Keep tool pairs only in the final assistant turn.
   * - `'before-last-${N}-messages'`: Keep tool pairs in the last N messages.
   * - `'none'` (default): Keep all tool pairs.
   */
  toolCalls?: 'all' | 'before-last-message' | `before-last-${number}-messages` | 'none';
  /**
   * Whether to retain messages with no content after pruning.
   * - `'remove'` (default): Exclude empty messages.
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
   * Called on every model invocation.
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
  /** The model's context window size in tokens. */
  contextWindow: number;
  /** Enable history compression. Omit for no compression. */
  compress?: CompressOptions;
  /** Enable tool result truncation. Omit for no truncation. */
  truncate?: TruncateOptions;
  /**
   * Mechanical compaction — zero LLM cost.
   * Prunes tool call/result pairs and empty messages before compression.
   */
  compact?: CompactConfig;
  /**
   * Dynamic state injection. State is converted to XML and placed
   * for maximum LLM attention (last_user or system position).
   */
  dynamicState?: DynamicStateConfig;
  /**
   * Inject the active skill's instructions as an additional system prompt
   * before the chat() call. Mirrors the `dynamicState` pattern.
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
   * equivalent ordering).
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
  /** Hook called after compression occurs. */
  onCompress?: (summary: string, truncatedCount: number) => void;
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
   * Transform the messages and system prompts after compression, before sending to the model.
   * Use for custom prompt manipulation, RAG injection, etc.
   */
  transformContext?: (
    messages: ModelMessage[],
    systemPrompts: string[],
  ) =>
    | { messages: ModelMessage[]; systemPrompts: string[] }
    | Promise<{ messages: ModelMessage[]; systemPrompts: string[] }>;
}
