import type { Message, VFSStorageAdapter } from '@context-chef/core';
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
}

export interface CompressOptions {
  /** A cheap TanStack AI adapter used for summarization (e.g. openaiText('gpt-4o-mini')). */
  adapter: AnyTextAdapter;
  /** Ratio of context window to preserve for recent messages. Default: 0.8 */
  preserveRatio?: number;
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
