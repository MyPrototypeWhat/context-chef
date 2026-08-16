import {
  compactHistory as coreCompactHistory,
  planCompaction as corePlanCompaction,
  type PlanCompactionOptions,
  type SummarizeHistoryOptions,
  summarizeHistory,
} from '@context-chef/core';
import type { AnyTextAdapter, ModelMessage } from '@tanstack/ai';

import { fromTanStackAI, toTanStackAI } from './adapter';
import { createCompressionAdapter } from './middleware';

export type { PlanCompactionOptions } from '@context-chef/core';

/**
 * Options for {@link summarizeTanStackMessages} / {@link compactTanStackMessages}.
 * Currently a structural alias of core's `SummarizeHistoryOptions` — add
 * middleware-specific fields here if they ever diverge.
 */
export type SummarizeMessagesOptions = SummarizeHistoryOptions;

export interface CompactionPlanTanStackMessages {
  /** The old conversation slice to summarize. Empty when nothing is old enough. */
  toSummarize: ModelMessage[];
  /** The recent conversation turns to keep verbatim. */
  toKeep: ModelMessage[];
}

/**
 * Turn-safe split for durable compaction at the **TanStack ModelMessage**
 * altitude — the type `chat()` messages use. Converts to IR via
 * {@link fromTanStackAI}, splits on turn boundaries via core's
 * `planCompaction`, and converts each slice back via {@link toTanStackAI}.
 * Summarize `toSummarize`, then persist `[<summary>, ...toKeep]`.
 *
 * Unlike the AI SDK sibling (`planCompactionModelMessages`), the plan has no
 * `system` slice: TanStack AI's `ModelMessage` has no system role — standing
 * instructions live in `chat({ systemPrompts })` and never enter this split.
 *
 * `keepRecentTurns` counts **message-level turns, not agent-loop iterations**:
 * a turn is one user/assistant message, or an assistant with its tool-calls
 * plus all their tool results (kept together so a result is never orphaned).
 * A single tool-using iteration is often 2–3 turns, so size it for your
 * worst-case iteration — tool-dense loops need a larger value than a plain
 * chat.
 */
export function planCompactionTanStackMessages(
  messages: ModelMessage[],
  options: PlanCompactionOptions,
): CompactionPlanTanStackMessages {
  const plan = corePlanCompaction(fromTanStackAI(messages), options);
  return {
    toSummarize: toTanStackAI(plan.toSummarize),
    toKeep: toTanStackAI(plan.toKeep),
  };
}

/**
 * One-shot durable compaction at the **TanStack ModelMessage** altitude: plan
 * a turn-safe split, summarize the old slice with `adapter`, and return a new
 * `ModelMessage[]` ready to persist — `[<summary>, ...toKeep]`. Run it against
 * your own message store between chat() calls, then pass the result as the
 * next call's `messages`.
 *
 * `adapter` is any TanStack AI text adapter (e.g. `openaiText('gpt-4o-mini')`)
 * — its `chatStream` is called directly, bypassing middleware. Reuses core's
 * `compactHistory` + {@link createCompressionAdapter} (tool-role flattening).
 *
 * Returns the **input `messages` reference unchanged** when there is nothing
 * old enough to compact or the summarizer yields no text, so callers can skip
 * persistence on a no-op via `result === messages`. Throws only if the model
 * call throws.
 *
 * The summary is inserted as a `user` message (Claude Code style) wrapped
 * with the "continued conversation" framing, so when the kept tail also
 * begins with a user turn the result can hold two consecutive `user`
 * messages — a valid `ModelMessage[]` for TanStack AI adapters.
 *
 * IMPORTANT: if you drive compaction this way, do NOT also configure
 * `compress` on a `contextChefMiddleware` instance serving the same
 * conversation — that would compress twice. `truncate`, `clear`, `compact`,
 * and `dynamicState` remain safe to combine.
 */
export async function compactTanStackMessages(
  messages: ModelMessage[],
  adapter: AnyTextAdapter,
  options: PlanCompactionOptions & SummarizeMessagesOptions,
): Promise<ModelMessage[]> {
  const ir = fromTanStackAI(messages);
  const result = await coreCompactHistory(ir, createCompressionAdapter(adapter), options);
  // core returns the input IR reference on a no-op — preserve the original
  // `messages` reference so callers can skip persistence via `result === messages`.
  return result === ir ? messages : toTanStackAI(result);
}

/**
 * Summarize a `ModelMessage[]` slice into a single summary string, using the
 * SAME pipeline as the in-flight `compress` path: role-flattening via
 * {@link createCompressionAdapter} + core `summarizeHistory`. Returns the
 * extracted summary text — wrap it with `getCompactSummaryWrapper` from
 * `@context-chef/core` for the "continued conversation" framing. An empty
 * slice returns `''` without a model call; throws if the model call fails.
 *
 * For hosts that own their conversation store and persist compression
 * themselves (durable compaction) instead of relying on in-flight middleware
 * compression.
 */
export async function summarizeTanStackMessages(
  messages: ModelMessage[],
  adapter: AnyTextAdapter,
  opts: SummarizeMessagesOptions = {},
): Promise<string> {
  const ir = fromTanStackAI(messages);
  return summarizeHistory(ir, createCompressionAdapter(adapter), opts);
}
