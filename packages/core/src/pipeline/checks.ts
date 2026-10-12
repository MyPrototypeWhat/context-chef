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

/** The parts of any target payload that decide what the model has already seen. */
export interface PrefixComparable {
  /** Anthropic top-level system blocks. */
  system?: unknown;
  /** Gemini system instruction. */
  systemInstruction?: unknown;
  /** OpenAI Responses system prompt. */
  instructions?: unknown;
  tools?: unknown;
  /** Chat-style targets (OpenAI, Anthropic, Gemini). */
  messages?: readonly unknown[];
  /** OpenAI Responses input items. */
  input?: readonly unknown[];
}

export interface PrefixContinuity {
  ok: boolean;
  /** The first place `next` stops repeating `prev`: `'system'`, `'tools'`, `'messages[3]'`, … */
  firstDivergence?: { path: string; before: unknown; after: unknown };
}

const PREFIX_HEAD_FIELDS = ['system', 'systemInstruction', 'instructions', 'tools'] as const;

/** Key order and cache breakpoints don't change what the model saw. */
export function sameContent(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown) =>
    JSON.stringify(Assembler.orderKeysDeterministically(value), (key, v) =>
      key === 'cache_control' ? undefined : v,
    );
  return canonical(a) === canonical(b);
}

/**
 * Whether the payload sent on one turn is still the prefix of the payload for
 * the next: the system prompt and tools unchanged, and every earlier message
 * repeated as it was, with new ones only appended. Claude Fable 5.1 / Opus 5.5
 * / Sonnet 5.5 / Haiku 5.5 sign each thinking block over everything before it,
 * so a turn that fails this check fails theirs when it replays thinking. The
 * payload's `meta`, and request fields outside the prompt, are not compared.
 */
export function checkPrefixContinuity(
  prev: PrefixComparable,
  next: PrefixComparable,
): PrefixContinuity {
  for (const field of PREFIX_HEAD_FIELDS) {
    if (!sameContent(prev[field], next[field])) {
      return {
        ok: false,
        firstDivergence: { path: field, before: prev[field], after: next[field] },
      };
    }
  }

  const field = prev.input !== undefined || next.input !== undefined ? 'input' : 'messages';
  const before = prev[field] ?? [];
  const after = next[field] ?? [];
  for (let i = 0; i < before.length; i++) {
    if (!sameContent(before[i], after[i])) {
      return {
        ok: false,
        firstDivergence: { path: `${field}[${i}]`, before: before[i], after: after[i] },
      };
    }
  }
  return { ok: true };
}
