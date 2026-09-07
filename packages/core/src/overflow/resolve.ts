/**
 * Building the default strategy out of the 4.x `janitor.*` options.
 */

import type { Message } from '../types';
import { anchored } from './anchored';
import { background } from './background';
import { type SummarizeOptions, summarize } from './summarize';
import type { OverflowStrategy } from './types';

/**
 * The deprecated `JanitorConfig` fields that used to describe the overflow
 * policy. Every one of them is an option of a built-in strategy now; this is
 * the mapping that keeps them working.
 */
export interface OverflowAliasConfig extends SummarizeOptions {
  /** `'incremental-anchored'` → {@link anchored}, anything else → {@link summarize}. */
  compressionMode?: 'rewrite' | 'incremental-anchored';
  /** `'background'` → wrapped in {@link background}. */
  compressionScheduling?: 'blocking' | 'background';
  /** Only read to pick the split rule — the runner owns the tokenizer itself. */
  tokenizer?: (messages: Message[]) => number;
}

/**
 * Builds the strategy described by the legacy `janitor.*` options.
 *
 * Used whenever no explicit `overflow.strategy` is configured, so the default
 * path and the composed path run the exact same code.
 */
export function resolveOverflowStrategy(config: OverflowAliasConfig = {}): OverflowStrategy {
  const options: SummarizeOptions = {
    compressionModel: config.compressionModel,
    compressionGuidelines: config.compressionGuidelines,
    customCompressionInstructions: config.customCompressionInstructions,
    minShrinkRatio: config.minShrinkRatio,
    validateCompression: config.validateCompression,
    preserveRatio: config.preserveRatio,
    preserveRecentMessages: config.preserveRecentMessages,
    toolResultStubThreshold: config.toolResultStubThreshold,
    // The tokenizer path can price each turn, so it spends a token budget on
    // the preserved tail; the feedTokenUsage path has no per-turn costs to
    // read and counts turns instead.
    split: config.tokenizer ? 'ratio' : 'recent-turns',
  };

  const base =
    config.compressionMode === 'incremental-anchored' ? anchored(options) : summarize(options);
  return config.compressionScheduling === 'background' ? background(base) : base;
}
