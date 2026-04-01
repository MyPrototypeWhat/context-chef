import type { Message } from '../types';

const PLACEHOLDER_TOOL_RESULT = '[Tool result missing]';
const PLACEHOLDER_ORPHAN_REMOVED = '[Conversation continues]';

/**
 * Sanitizes a message history to satisfy LLM API invariants.
 *
 * Fixes three classes of problems:
 *
 * 1. **Orphan tool results** — a `role: 'tool'` message whose `tool_call_id`
 *    has no matching `tool_calls` entry in a preceding assistant message.
 *    These are removed (or replaced with a placeholder if removal would
 *    leave the history empty).
 *
 * 2. **Missing tool results** — an assistant message has `tool_calls` but
 *    no subsequent `role: 'tool'` message with a matching `tool_call_id`.
 *    A synthetic error tool result is injected.
 *
 * 3. **First message must be user** — if the first non-system message is
 *    not `role: 'user'`, a synthetic user placeholder is prepended.
 *
 * This function does NOT modify the input array. It returns a new array.
 */
export function ensureValidHistory(history: Message[]): Message[] {
  if (history.length === 0) return [];

  let result = [...history];

  // ── Step 1: Fix orphan tool results ──
  result = fixOrphanToolResults(result);

  // ── Step 2: Fix missing tool results ──
  result = fixMissingToolResults(result);

  // ── Step 3: Ensure first non-system message is user ──
  result = ensureFirstMessageIsUser(result);

  return result;
}

/**
 * Remove tool messages whose tool_call_id has no matching assistant tool_calls.
 */
function fixOrphanToolResults(messages: Message[]): Message[] {
  const result: Message[] = [];
  const knownToolCallIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Track tool_call ids as we encounter assistant messages
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        knownToolCallIds.add(tc.id);
      }
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      if (!knownToolCallIds.has(msg.tool_call_id)) {
        // Orphan — skip it
        continue;
      }
    }

    result.push(msg);
  }

  // If we removed everything, keep a placeholder
  if (result.length === 0 && messages.length > 0) {
    return [{ role: 'user', content: PLACEHOLDER_ORPHAN_REMOVED }];
  }

  return result;
}

/**
 * For each assistant with tool_calls, ensure every tool_call_id has a matching
 * tool result in the subsequent messages (before the next assistant or user message).
 */
function fixMissingToolResults(messages: Message[]): Message[] {
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    result.push(msg);

    if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) {
      continue;
    }

    // Collect expected tool_call_ids
    const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));

    // Scan forward for matching tool results
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next.role === 'tool' && next.tool_call_id) {
        expectedIds.delete(next.tool_call_id);
      }
      // Stop scanning at the next assistant or user message
      if (next.role === 'assistant' || next.role === 'user') {
        break;
      }
    }

    // Inject synthetic tool results for any missing ids
    for (const missingId of expectedIds) {
      result.push({
        role: 'tool',
        tool_call_id: missingId,
        content: PLACEHOLDER_TOOL_RESULT,
      });
    }
  }

  return result;
}

/**
 * Ensure the first non-system message is role: 'user'.
 */
function ensureFirstMessageIsUser(messages: Message[]): Message[] {
  const firstNonSystemIdx = messages.findIndex((m) => m.role !== 'system');

  if (firstNonSystemIdx === -1) {
    // All system messages — nothing to fix
    return messages;
  }

  if (messages[firstNonSystemIdx].role === 'user') {
    return messages;
  }

  // Insert a synthetic user message before the first non-system message
  const result = [...messages];
  result.splice(firstNonSystemIdx, 0, {
    role: 'user',
    content: PLACEHOLDER_ORPHAN_REMOVED,
  });
  return result;
}
