/**
 * Turn boundaries and pinning — the structural rules every overflow strategy
 * splits on. A "turn" is the atomic unit of a conversation: cutting anywhere
 * else orphans a tool result or splits a tool_use/tool_result pair.
 */

import type { Message } from '../types';

export interface Turn {
  startIndex: number;
  endIndex: number; // exclusive
}

/**
 * Groups a flat message array into atomic "turns."
 *
 * Grouping rules:
 * - user message → single-message turn
 * - system message → single-message turn
 * - assistant (no tool_calls) → single-message turn
 * - assistant (with tool_calls) + all subsequent tool results → one atomic turn
 *
 * Splitting on turn boundaries guarantees tool pair integrity and
 * eliminates the need for post-hoc adjustSplitIndex corrections.
 */
export function groupIntoTurns(history: Message[]): Turn[] {
  const turns: Turn[] = [];
  let i = 0;

  while (i < history.length) {
    const msg = history[i];

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Atomic turn: assistant + all subsequent tool results
      const start = i;
      i++;
      while (i < history.length && history[i].role === 'tool') {
        i++;
      }
      turns.push({ startIndex: start, endIndex: i });
    } else {
      // Single-message turn: user, system, or plain assistant
      turns.push({ startIndex: i, endIndex: i + 1 });
      i++;
    }
  }

  return turns;
}

// ─── Constraint pinning ───

/**
 * Returns the set of message indices protected by pinning, turn-scoped:
 * pinning any message of an atomic turn protects every message of that turn,
 * so an assistant+tool_calls unit and its tool results stay coherent.
 */
export function collectPinnedTurnIndices(history: Message[]): Set<number> {
  const pinned = new Set<number>();
  // Fast path: no pinned messages at all (the common case) — skip grouping.
  if (!history.some((m) => m.pinned)) return pinned;
  for (const turn of groupIntoTurns(history)) {
    let hasPinned = false;
    for (let i = turn.startIndex; i < turn.endIndex; i++) {
      if (history[i].pinned) {
        hasPinned = true;
        break;
      }
    }
    if (hasPinned) {
      for (let i = turn.startIndex; i < turn.endIndex; i++) pinned.add(i);
    }
  }
  return pinned;
}

/**
 * Content-equivalence check for the background-compression staleness test.
 * Object identity alone is too brittle — pipeline stages (transformToolResult,
 * compact) may recreate message objects without changing their meaning, and a
 * recreated-but-identical boundary must not discard a finished job.
 */
export function messagesEquivalent(a: Message | undefined, b: Message | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.role === b.role && a.content === b.content && a.tool_call_id === b.tool_call_id;
}

/** Extracts the pinned (turn-scoped) messages of a slice, in original order. */
export function extractPinnedMessages(messages: Message[]): Message[] {
  const indices = collectPinnedTurnIndices(messages);
  if (indices.size === 0) return [];
  return messages.filter((_, i) => indices.has(i));
}

/**
 * Splits a slice into its pinned (turn-scoped) messages and the rest, both in
 * original order. Used by durable compaction to move pinned turns out of the
 * summarize range so they survive verbatim.
 */
export function partitionPinnedMessages(messages: Message[]): {
  pinned: Message[];
  rest: Message[];
} {
  const indices = collectPinnedTurnIndices(messages);
  if (indices.size === 0) return { pinned: [], rest: messages };
  const pinned: Message[] = [];
  const rest: Message[] = [];
  messages.forEach((m, i) => {
    (indices.has(i) ? pinned : rest).push(m);
  });
  return { pinned, rest };
}

/**
 * Builds a map from `tool_call_id` → tool name by walking the messages and
 * collecting the names declared on every assistant turn's `tool_calls`.
 * The same map covers all tool messages because tool_call ids are unique
 * per invocation.
 */
export function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        map.set(tc.id, tc.function.name);
      }
    }
  }
  return map;
}
