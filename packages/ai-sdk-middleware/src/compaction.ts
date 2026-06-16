import type {
  LanguageModelV3,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
} from '@ai-sdk/provider';
import { groupIntoTurns, Prompts } from '@context-chef/core';

import { fromAISDK, toAISDK } from './adapter';
import { type SummarizeMessagesOptions, summarizeMessages } from './middleware';

export interface PlanCompactionOptions {
  /**
   * Number of recent atomic turns to keep verbatim. Everything older goes to
   * `toSummarize`. A "turn" is a single user/assistant message, or an assistant
   * with tool_calls plus all its subsequent tool results — so the split never
   * lands inside a turn and never orphans a tool result.
   *
   * `0` summarizes the entire conversation; a value ≥ the turn count keeps
   * everything (nothing to summarize).
   */
  keepRecentTurns: number;
}

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
 * Boundaries are computed exactly like the Janitor: messages are grouped into
 * atomic turns (assistant + its tool results stay together), so the cut never
 * splits a turn, never orphans a tool result, and never lands inside a
 * multi-block assistant message.
 */
export function planCompaction(
  prompt: LanguageModelV3Prompt,
  options: PlanCompactionOptions,
): CompactionPlan {
  const keep = Math.max(0, Math.floor(options.keepRecentTurns));

  // fromAISDK also runs ensureValidHistory, so the conversation is well-formed
  // (no orphan tool results) before we group it into turns.
  const allIR = fromAISDK(prompt);
  const system = allIR.filter((m) => m.role === 'system');
  const conversation = allIR.filter((m) => m.role !== 'system');

  const turns = groupIntoTurns(conversation);
  const splitTurn = Math.max(0, turns.length - keep);
  // splitTurn === turns.length only when keep is 0 → summarize everything.
  const splitIndex = splitTurn < turns.length ? turns[splitTurn].startIndex : conversation.length;

  return {
    system: toAISDK(system),
    toSummarize: toAISDK(conversation.slice(0, splitIndex)),
    toKeep: toAISDK(conversation.slice(splitIndex)),
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
 * Returns the prompt **unchanged** when there is nothing old enough to compact
 * (fewer turns than `keepRecentTurns`) or when the summarizer yields no text —
 * so it is safe to call unconditionally. Throws only if the model call throws.
 *
 * Do NOT also configure middleware `compress` (with a `model`) on the same path
 * — that compresses twice. Use this OR in-flight `compress`, not both.
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
  const { keepRecentTurns, ...summarizeOptions } = options;
  const plan = planCompaction(prompt, { keepRecentTurns });

  // Nothing old enough to compact — return the original prompt untouched.
  if (plan.toSummarize.length === 0) return prompt;

  const summary = await summarizeMessages(plan.toSummarize, model, summarizeOptions);
  // Summarizer produced nothing usable — leave history intact rather than
  // dropping the old turns behind an empty marker.
  if (!summary.trim()) return prompt;

  const summaryMessage: LanguageModelV3Message = {
    role: 'user',
    content: [{ type: 'text', text: Prompts.getCompactSummaryWrapper(summary) }],
  };

  return [...plan.system, summaryMessage, ...plan.toKeep];
}
