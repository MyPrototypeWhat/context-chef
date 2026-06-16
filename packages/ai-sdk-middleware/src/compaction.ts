import type { LanguageModelV3, LanguageModelV3Prompt } from '@ai-sdk/provider';
import {
  compactHistory as coreCompactHistory,
  planCompaction as corePlanCompaction,
  type PlanCompactionOptions,
} from '@context-chef/core';

import { fromAISDK, toAISDK } from './adapter';
import { createCompressionAdapter, type SummarizeMessagesOptions } from './middleware';

export type { PlanCompactionOptions } from '@context-chef/core';

export interface CompactionPlan {
  /** System messages, preserved verbatim — standing instructions are never summarized. */
  system: LanguageModelV3Prompt;
  /**
   * The old conversation slice to summarize (system excluded). Feed this to
   * `summarizeMessages`. Empty when there is nothing old enough to compact.
   */
  toSummarize: LanguageModelV3Prompt;
  /** The recent conversation turns to keep verbatim. */
  toKeep: LanguageModelV3Prompt;
}

/**
 * Splits an AI SDK prompt into `{ system, toSummarize, toKeep }` on **turn
 * boundaries**, for durable (caller-owned) compaction.
 *
 * Unlike the in-flight middleware `compress` — which only rewrites the outgoing
 * request and is discarded each call — this is a pure, synchronous split you run
 * against your *own* message store. Summarize `toSummarize`, then persist
 * `[...system, <summary>, ...toKeep]` back to your store so the history actually
 * shrinks. See {@link compactHistory} for the one-shot version.
 *
 * The AI-SDK-typed wrapper around core's provider-agnostic `planCompaction`:
 * converts the prompt to IR via {@link fromAISDK}, splits on turn boundaries
 * (assistant + its tool results stay together), and converts each slice back via
 * {@link toAISDK}.
 */
export function planCompaction(
  prompt: LanguageModelV3Prompt,
  options: PlanCompactionOptions,
): CompactionPlan {
  const plan = corePlanCompaction(fromAISDK(prompt), options);
  return {
    system: toAISDK(plan.system),
    toSummarize: toAISDK(plan.toSummarize),
    toKeep: toAISDK(plan.toKeep),
  };
}

/**
 * One-shot durable compaction: plan a turn-safe split, summarize the old slice,
 * and return a new prompt ready to persist — `[...system, <summary>, ...toKeep]`.
 *
 * This is the recommended way to keep a long conversation lean when you own the
 * message store (a long agent loop, or a chat past the budget). Run it between
 * model calls and replace your stored messages with the result; the summary is
 * a real `user` message wrapped with the "continued conversation" framing.
 *
 * Returns the prompt **unchanged** (same reference) when there is nothing old
 * enough to compact (no more turns than `keepRecentTurns`) or when the summarizer
 * yields no text — so it is safe to call unconditionally, and callers can skip
 * persistence on a no-op via `result === prompt`. Throws only if the model call
 * throws.
 *
 * The AI-SDK-typed wrapper around core's `compactHistory`: it binds `model` into
 * a compression callback via {@link createCompressionAdapter} (core never calls a
 * model directly). Do NOT also configure middleware `compress` (with a `model`)
 * on the same path — that compresses twice. Use this OR in-flight `compress`,
 * not both.
 *
 * @example
 * ```ts
 * // In your loop / between turns, when you own `messages`:
 * messages = await compactHistory(messages, summarizerModel, {
 *   keepRecentTurns: 4,
 *   toolResultStubThreshold: 5000,
 * });
 * ```
 */
export async function compactHistory(
  prompt: LanguageModelV3Prompt,
  model: LanguageModelV3,
  options: PlanCompactionOptions & SummarizeMessagesOptions,
): Promise<LanguageModelV3Prompt> {
  const ir = fromAISDK(prompt);
  const result = await coreCompactHistory(ir, createCompressionAdapter(model), options);
  // core returns the input IR reference on a no-op — preserve the original
  // prompt reference so callers can skip persistence via `result === prompt`.
  return result === ir ? prompt : toAISDK(result);
}
