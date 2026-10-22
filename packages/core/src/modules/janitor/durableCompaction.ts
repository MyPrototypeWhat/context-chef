import { openingPlaceholder, summaryHead } from '../../overflow/summary';
import { Prompts } from '../../prompts';
import type { Message } from '../../types';
import { ensureValidHistory } from '../../utils/ensureValidHistory';
import {
  groupIntoTurns,
  partitionPinnedMessages,
  type SummarizeHistoryOptions,
  summarizeHistory,
} from '.';

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
  system: Message[];
  /**
   * The old conversation slice to summarize (system excluded). Feed this to
   * `summarizeHistory`. Empty when there is nothing old enough to compact.
   */
  toSummarize: Message[];
  /**
   * The conversation to keep verbatim: the pinned turns of the old slice,
   * then the recent turns. A compaction block it starts with goes before the
   * summary (see {@link planCompaction}).
   */
  toKeep: Message[];
}

/**
 * Splits an IR history into `{ system, toSummarize, toKeep }` on **turn
 * boundaries**, for durable (caller-owned) compaction.
 *
 * This is the provider-agnostic engine behind the AI SDK middleware's
 * `planCompaction`. Run it against your own message store, summarize
 * `toSummarize`, then persist `[...system, <summary>, ...toKeep]` so the history
 * actually shrinks — except when `toKeep` starts with a compaction message
 * (`_anthropic_compaction`, the block an Anthropic compaction returned): that
 * message goes before the summary, `[...system, block, <summary>, ...rest]`,
 * since the API rejects a request with anything ahead of the block. The
 * placeholder user turn `fromAnthropic` puts before such a block opens
 * `toSummarize`; keep it ahead of the block, so text targets still open with
 * a user turn. See {@link compactHistory} for the one-shot version, which
 * does both for you.
 *
 * **Input contract:** `history` is a flat `Message[]` with any system messages
 * **inline** (`role: 'system'`). This matches `fromAISDK` output. The direct
 * adapters (`fromAnthropic` / `fromOpenAI` / `fromGemini`) return
 * `{ system, history }` with system already extracted — those callers must
 * reassemble `planCompaction([...system, ...history], …)` themselves.
 *
 * Boundaries come from {@link groupIntoTurns} (assistant + its tool results stay
 * together), so the cut never splits a turn, never orphans a tool result, and
 * never lands inside a multi-block assistant message.
 */
export function planCompaction(history: Message[], options: PlanCompactionOptions): CompactionPlan {
  const keep = Math.max(0, Math.floor(options.keepRecentTurns));

  // ensureValidHistory guarantees a well-formed conversation (no orphan tool
  // results) before we group it into turns.
  const all = ensureValidHistory(history);
  const system = all.filter((m) => m.role === 'system');
  const conversation = all.filter((m) => m.role !== 'system');

  const turns = groupIntoTurns(conversation);
  const splitTurn = Math.max(0, turns.length - keep);
  // splitTurn === turns.length only when keep is 0 → summarize everything.
  const splitIndex = splitTurn < turns.length ? turns[splitTurn].startIndex : conversation.length;

  // Pinned contract: pinned (turn-scoped) messages inside the old span are
  // MOVED to the front of `toKeep` instead of being summarized away — every
  // consumer persisting `[...system, <summary>, ...toKeep]` preserves them
  // verbatim with no extra handling (this includes auto-pinned Anthropic
  // compaction blocks).
  const { pinned, rest } = partitionPinnedMessages(conversation.slice(0, splitIndex));

  return {
    system,
    toSummarize: rest,
    toKeep: [...pinned, ...conversation.slice(splitIndex)],
  };
}

/**
 * One-shot durable compaction: plan a turn-safe split, summarize the old slice,
 * and return a new history ready to persist — `[...system, <summary>, ...toKeep]`,
 * with a compaction block `toKeep` starts with ahead of the summary, and the
 * placeholder user turn ahead of the block (`ensureValidHistory` opens such a
 * history with one, and a text target needs it first): `[...system,
 * placeholder, block, <summary>, ...rest]`. A history that opens with a block
 * and no placeholder gains one. A split that leaves nothing but the
 * placeholder to summarize compacts nothing.
 *
 * The recommended way to keep a long conversation lean when you own the message
 * store. Run it between model calls and replace your stored messages with the
 * result; the summary is a real `user` message wrapped with the "continued
 * conversation" framing via {@link Prompts.getCompactSummaryWrapper}.
 *
 * `compress` is the model callback (same one {@link summarizeHistory} takes) —
 * core never calls a model directly, so the host injects the binding. It MUST
 * map `tool` roles and assistant tool-calls to plain user/assistant text. With
 * ai-sdk-middleware, use its `compactHistory(prompt, model, options)` wrapper.
 *
 * Returns the input `history` **reference unchanged** when there is nothing old
 * enough to compact (no more turns than `keepRecentTurns`) or when the summarizer
 * yields no text — so it is safe to call unconditionally, and callers can skip
 * persistence on a no-op via `result === history`. Throws only if `compress`
 * throws.
 */
export async function compactHistory(
  history: Message[],
  compress: (messages: Message[]) => Promise<string>,
  options: PlanCompactionOptions & SummarizeHistoryOptions,
): Promise<Message[]> {
  const { keepRecentTurns, ...summarizeOptions } = options;
  const plan = planCompaction(history, { keepRecentTurns });
  // The opening placeholder before a compaction block toKeep starts with stays with it.
  const opening = openingPlaceholder([...plan.toSummarize.slice(0, 1), ...plan.toKeep.slice(0, 1)]);
  const toSummarize = opening ? plan.toSummarize.slice(1) : plan.toSummarize;

  // Nothing old enough to compact — return the original reference untouched.
  if (toSummarize.length === 0) return history;

  const summary = await summarizeHistory(toSummarize, compress, summarizeOptions);
  // Summarizer produced nothing usable — leave history intact rather than
  // dropping the old turns behind an empty marker.
  if (!summary.trim()) return history;

  const summaryMessage: Message = {
    role: 'user',
    content: Prompts.getCompactSummaryWrapper(summary),
  };

  return [
    ...plan.system,
    ...summaryHead(summaryMessage, opening ? [opening, ...plan.toKeep] : plan.toKeep),
  ];
}
