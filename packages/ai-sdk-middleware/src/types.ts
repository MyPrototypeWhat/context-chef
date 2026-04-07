import type { LanguageModelV3, LanguageModelV3Prompt } from '@ai-sdk/provider';
import type { Message, VFSStorageAdapter } from '@context-chef/core';

export interface TruncateOptions {
  /** Character count threshold to trigger truncation. */
  threshold: number;
  /** Characters to preserve from the start. Default: 0 */
  headChars?: number;
  /** Characters to preserve from the end. Default: 1000 */
  tailChars?: number;
  /**
   * Storage adapter for persisting original content before truncation.
   * Can be a FileSystemAdapter, database adapter, or any custom implementation.
   * When provided, truncated output includes a `context://vfs/` URI for retrieval.
   * When omitted, original content is discarded after truncation.
   */
  storage?: VFSStorageAdapter;
}

export interface CompressOptions {
  /** A cheap model used for summarization (e.g. openai('gpt-4o-mini')). */
  model: LanguageModelV3;
  /** Ratio of context window to preserve for recent messages. Default: 0.8 */
  preserveRatio?: number;
}

/**
 * Mechanical compaction options — zero LLM cost.
 * Delegates to AI SDK's `pruneMessages` before IR conversion.
 * Runs before LLM-based compression to reduce token usage at no cost.
 */
export interface CompactConfig {
  /**
   * Controls removal of reasoning content from assistant messages.
   * - `'all'`: Remove reasoning from all messages.
   * - `'before-last-message'`: Keep reasoning only in the final message.
   * - `'none'` (default): Keep all reasoning.
   */
  reasoning?: 'all' | 'before-last-message' | 'none';
  /**
   * Controls removal of tool-call, tool-result, and tool-approval chunks.
   * - `'all'`: Remove all tool-related chunks.
   * - `'before-last-message'`: Keep tool chunks only in the final message.
   * - `'before-last-${N}-messages'`: Keep tool chunks in the last N messages.
   * - `'none'`: Keep all tool chunks.
   * - Array form allows per-tool control.
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
   * - `'last_user'` (default): Appends to the last user message. Leverages Recency Bias
   *   for maximum attention, preventing "Lost in the Middle" drift in long conversations.
   * - `'system'`: Adds as a standalone system message at the end.
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
   * Mechanical compaction via AI SDK's `pruneMessages`.
   * Prunes reasoning, tool calls, and empty messages at zero LLM cost.
   *
   * See CompactConfig for details.
   */
  compact?: CompactConfig;
  /**
   * Dynamic state injection. State is converted to XML and placed
   * for maximum LLM attention (last_user or system position).
   */
  dynamicState?: DynamicStateConfig;
  /** Optional tokenizer for precise per-message token counting. */
  tokenizer?: (messages: unknown[]) => number;
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
   * @deprecated Use `onBeforeCompress` instead. Will be removed in the next major version.
   */
  onBudgetExceeded?: (
    history: Message[],
    tokenInfo: { currentTokens: number; limit: number },
  ) => Message[] | null | undefined | Promise<Message[] | null | undefined>;
  /**
   * Transform the AI SDK prompt after compression, before sending to the model.
   * Use for custom prompt manipulation, RAG injection, etc.
   */
  transformContext?: (
    prompt: LanguageModelV3Prompt,
  ) => LanguageModelV3Prompt | Promise<LanguageModelV3Prompt>;
}
