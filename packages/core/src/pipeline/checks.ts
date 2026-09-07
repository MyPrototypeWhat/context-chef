import { Assembler } from '../modules/assembler';
import type { Message } from '../types';

/**
 * Dev-mode invariant checks (`ChefConfig.pipelineChecks`). Each function
 * returns human-readable violations; the caller warns and emits
 * `pipeline:invariant` for each. Nothing here ever throws or mutates —
 * a broken invariant is reported, never enforced (see the "mechanism, not
 * policy" rule in docs/architecture-v5.md).
 */

/** Identity first, structural equality second — a handler may legitimately clone. */
function findEquivalent(message: Message, pool: Message[], poolRefs: Set<Message>): boolean {
  if (poolRefs.has(message)) return true;
  const serialized = Assembler.stringifyPayload(message);
  return pool.some((candidate) => Assembler.stringifyPayload(candidate) === serialized);
}

function collectToolPairIds(messages: Message[]): { calls: Set<string>; results: Set<string> } {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) calls.add(call.id);
    }
    if (message.role === 'tool' && message.tool_call_id) results.add(message.tool_call_id);
  }
  return { calls, results };
}

/**
 * `after-assemble` handlers may filter, reorder and rewrite freely — but
 * dropping a pinned message or half of a tool pair produces a payload the
 * provider rejects (or, worse, silently accepts minus a constraint the caller
 * pinned on purpose).
 */
export function checkAssembleInvariants(before: Message[], after: Message[]): string[] {
  const violations: string[] = [];
  const afterRefs = new Set(after);

  const missingPinned = before.filter((m) => m.pinned && !findEquivalent(m, after, afterRefs));
  if (missingPinned.length > 0) {
    violations.push(
      `${missingPinned.length} pinned message(s) were dropped by an 'after-assemble' handler ` +
        `(first: role='${missingPinned[0].role}', content starts "${missingPinned[0].content.slice(0, 60)}")`,
    );
  }

  const pre = collectToolPairIds(before);
  const post = collectToolPairIds(after);
  const broken: string[] = [];
  for (const id of pre.calls) {
    if (!pre.results.has(id)) continue; // incomplete before the hook — not the hook's doing
    if (!post.calls.has(id) || !post.results.has(id)) broken.push(id);
  }
  if (broken.length > 0) {
    violations.push(
      `tool_call/tool_result pairs were split by an 'after-assemble' handler: ${broken.join(', ')}`,
    );
  }

  return violations;
}

/**
 * The tail stitch is appended at the conversational tail; everything before
 * that index must survive byte-identical or the cacheable prefix (and every
 * cache breakpoint downstream) is invalidated. Key ordering is normalized
 * away — the Assembler re-orders keys deterministically on every message.
 */
export function checkTailInvariants(
  before: Message[],
  after: Message[],
  insertionIndex: number,
): string[] {
  const violations: string[] = [];
  for (let i = 0; i < insertionIndex; i++) {
    const original = before[i];
    const produced = after[i];
    if (
      !produced ||
      Assembler.stringifyPayload(original) !== Assembler.stringifyPayload(produced)
    ) {
      violations.push(
        `message ${i} changed before the tail insertion point (index ${insertionIndex}) — ` +
          'everything ahead of the stitch must stay byte-identical',
      );
      break;
    }
  }
  return violations;
}

/**
 * First index the tail stitch can touch — mirrors the Assembler's placement
 * rules: the last user/tool message (merged into or inserted after), or, with
 * no conversational tail at all, the slot before any trailing assistant
 * prefill.
 */
export function tailInsertionIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' || messages[i].role === 'tool') return i;
  }
  let insertAt = messages.length;
  while (insertAt > 0 && messages[insertAt - 1].role === 'assistant') insertAt--;
  return insertAt;
}
