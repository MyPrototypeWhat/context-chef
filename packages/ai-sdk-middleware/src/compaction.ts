import {
  compactHistory as coreCompactHistory,
  planCompaction as corePlanCompaction,
  type PlanCompactionOptions,
} from '@context-chef/core';
import type { LanguageModel, ModelMessage } from 'ai';

import { createCompressionAdapter, type SummarizeMessagesOptions } from './middleware';
import { fromModelMessages, toModelMessages } from './modelMessageAdapter';

export type { PlanCompactionOptions } from '@context-chef/core';

export interface CompactionPlanModelMessages {
  /** System messages, preserved verbatim — standing instructions are never summarized. */
  system: ModelMessage[];
  /** The old conversation slice to summarize (system excluded). Empty when nothing is old enough. */
  toSummarize: ModelMessage[];
  /** The recent conversation turns to keep verbatim. */
  toKeep: ModelMessage[];
}

/**
 * Turn-safe split for durable compaction at the **ModelMessage** altitude — the
 * type `prepareStep`/`generateText` hand you. Converts to IR via
 * {@link fromModelMessages}, splits on turn boundaries via core's
 * `planCompaction`, and converts each slice back via {@link toModelMessages}.
 * Summarize `toSummarize`, then persist `[...system, <summary>, ...toKeep]`.
 *
 * `keepRecentTurns` counts **message-level turns, not `ToolLoopAgent` steps**: a
 * turn is one user/assistant message, or an assistant with its tool-calls plus
 * all their tool results (kept together so a result is never orphaned). System
 * messages are always preserved and never counted. A single tool-using step is
 * often 2–3 turns, so size it for your worst-case step — tool-dense loops need a
 * larger value than a plain chat.
 */
export function planCompactionModelMessages(
  messages: ModelMessage[],
  options: PlanCompactionOptions,
): CompactionPlanModelMessages {
  const plan = corePlanCompaction(fromModelMessages(messages), options);
  return {
    system: toModelMessages(plan.system),
    toSummarize: toModelMessages(plan.toSummarize),
    toKeep: toModelMessages(plan.toKeep),
  };
}

/**
 * One-shot durable compaction at the **ModelMessage** altitude: plan a turn-safe
 * split, summarize the old slice, and return a new `ModelMessage[]` ready to
 * persist — `[...system, <summary>, ...toKeep]`. Use it in your own own-the-store
 * loop, or inside a `ToolLoopAgent` `prepareStep` (`return { messages: await
 * compactModelMessages(messages, model, opts) }`).
 *
 * `model` is `ai`'s `LanguageModel` (string id | V4) — exactly what
 * `prepareStep`/`generateText` give you. Reuses core's `compactHistory` +
 * `createCompressionAdapter` (tool-role flattening); no model is called directly.
 *
 * Returns the **input `messages` reference unchanged** when there is nothing old
 * enough to compact or the summarizer yields no text, so callers can skip
 * persistence on a no-op via `result === messages`. Throws only if the model call
 * throws.
 *
 * `keepRecentTurns` counts **message-level turns, not `ToolLoopAgent` steps** — a
 * turn is one user/assistant message, or an assistant with its tool-calls plus
 * all their tool results (so a result is never orphaned); system messages are
 * always preserved and never counted. A single tool-using step is often 2–3
 * turns, so size it for your worst-case step (tool-dense loops need more than a
 * plain chat).
 *
 * The summary is inserted as a `user` message (Claude Code style), so when the
 * kept tail also begins with a user turn the result can hold two consecutive
 * `user` messages. That is a valid `ModelMessage[]` — the AI SDK provider layer
 * normalizes it (Anthropic merges same-role, OpenAI accepts it) — but if you feed
 * the output to a non-AI-SDK consumer that requires strict alternation, account
 * for it.
 */
export async function compactModelMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  options: PlanCompactionOptions & SummarizeMessagesOptions,
): Promise<ModelMessage[]> {
  const ir = fromModelMessages(messages);
  const result = await coreCompactHistory(ir, createCompressionAdapter(model), options);
  // core returns the input IR reference on a no-op — preserve the original
  // `messages` reference so callers can skip persistence via `result === messages`.
  return result === ir ? messages : toModelMessages(result);
}
