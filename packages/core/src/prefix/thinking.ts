import type { Message } from '../types';
import type { PrefixLedger } from './ledger';

/** An Anthropic `thinking` or `redacted_thinking` content block. */
export const isThinkingBlock = (block: unknown): boolean => {
  const type = (block as { type?: unknown } | null)?.type;
  return type === 'thinking' || type === 'redacted_thinking';
};

/** The thinking blocks a message is sent with: its original Anthropic blocks when it carries them. */
export function thinkingBlocks(message: Message): number {
  const blocks = message._anthropic_origin?.blocks;
  if (blocks) return blocks.filter(isThinkingBlock).length;
  return (message.thinking ? 1 : 0) + (message.redacted_thinking ? 1 : 0);
}

/**
 * How a message's thinking is known in any copy of the message: its
 * signature, and a redacted block's data. The phases since `prefix` work on
 * copies, and a strategy may copy what it keeps.
 */
export function thinkingKeys(message: Message): string[] {
  const keys: string[] = [];
  if (message.thinking?.signature) keys.push(`signature:${message.thinking.signature}`);
  if (message.redacted_thinking) keys.push(`redacted:${message.redacted_thinking.data}`);
  return keys;
}

/**
 * The messages whose thinking unsigned checkpoints invalidated: host messages
 * in a stripped range, and every message of an unsigned head. Nothing in such
 * a head was signed over what comes before it now — a pinned message put
 * back after the summary, or a copy a strategy kept of a later turn. A signed
 * head vouches for its compaction block alone: anything else in it is what
 * it kept of an unsigned head before it, sent without its thinking since.
 */
export function invalidatedMessages(history: readonly Message[], ledger: PrefixLedger): Message[] {
  const stripped = ledger.stripped.flatMap(([from, until]) => history.slice(from, until));
  const head = ledger.head;
  if (!head) return stripped;
  const carried = head.signed
    ? head.replacement.filter((message) => message._anthropic_compaction === undefined)
    : head.replacement;
  return [...stripped, ...carried];
}

/** The thinking `ledger` has invalidated over `history`, by key: what is never sent again. */
export function invalidatedThinking(
  history: readonly Message[],
  ledger: PrefixLedger,
): Set<string> {
  return new Set(invalidatedMessages(history, ledger).flatMap(thinkingKeys));
}

/** Thinking blocks of the messages whose thinking is invalidated now and was not `before`. */
export function newlyStrippedThinking(
  history: readonly Message[],
  ledger: PrefixLedger,
  before: ReadonlySet<string>,
): number {
  const counted = new Set(before);
  let count = 0;
  for (const message of invalidatedMessages(history, ledger)) {
    const keys = thinkingKeys(message).filter((key) => !counted.has(key));
    if (keys.length === 0) continue;
    for (const key of keys) counted.add(key);
    count += thinkingBlocks(message);
  }
  return count;
}
