import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { VFSStorageAdapter } from '@context-chef/core';

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

export interface ContextChefOptions {
  /** The model's context window size in tokens. */
  contextWindow: number;
  /** Enable history compression. Omit for no compression. */
  compress?: CompressOptions;
  /** Enable tool result truncation. Omit for no truncation. */
  truncate?: TruncateOptions;
  /** Optional tokenizer for precise per-message token counting. */
  tokenizer?: (messages: unknown[]) => number;
  /** Hook called after compression occurs. */
  onCompress?: (summary: string, truncatedCount: number) => void;
}
