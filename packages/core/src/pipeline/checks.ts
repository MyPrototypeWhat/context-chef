import { Assembler } from '../modules/assembler';
import { sameOnWire } from '../prefix';
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
    if (!sameOnWire(prev[field], next[field])) {
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
    if (!sameOnWire(before[i], after[i])) {
      return {
        ok: false,
        firstDivergence: { path: `${field}[${i}]`, before: before[i], after: after[i] },
      };
    }
  }
  return { ok: true };
}

/** A payload a committed `appendOnly` compile sent, as the next compile is compared with it. */
export interface SentPayload {
  /** What it sent the model: the `PrefixComparable` fields, as plain data. */
  readonly payload: PrefixComparable;
  /** Leading messages (Responses: input items) up to and including its last reply. */
  readonly replied: number;
  /** Leading messages without the prefill it ended with, if any: what a reply to it continues. */
  readonly asked: number;
  /** The host history it was compiled over. */
  readonly hostLength: number;
}

/** `payload` with only its first `count` messages (or input items). */
function leading(payload: PrefixComparable, count: number): PrefixComparable {
  return {
    ...payload,
    ...(payload.messages ? { messages: payload.messages.slice(0, count) } : {}),
    ...(payload.input ? { input: payload.input.slice(0, count) } : {}),
  };
}

/** Every thinking signature `payload` sends, on any target: what the provider verifies. */
function thinkingSignatures(payload: PrefixComparable): Set<string> {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Record<string, unknown>;
    const signature =
      node.type === 'thinking'
        ? node.signature
        : node.type === 'redacted_thinking'
          ? node.data
          : node.type === 'reasoning'
            ? node.encrypted_content
            : node.thoughtSignature;
    if (typeof signature === 'string') found.add(signature);
    for (const child of Object.values(node)) visit(child);
  };
  visit(payload.messages ?? payload.input);
  return found;
}

/**
 * `appendOnly`'s promise across turns, for a compile that reported no
 * checkpoint: it still sends what `prev`, the payload committed before it,
 * sent, and only appends. Once a reply answered `prev` — `answered`, read off
 * the host history — that holds for all of it but a trailing prefill, which
 * the reply replaced. Until then, only up to its last reply: what follows is
 * the request nobody answered, whose events may be said again on a retry or
 * move behind a user turn the host appended. No thinking signature `prev`
 * sent may be missing either.
 */
export function checkSentPrefix(
  prev: SentPayload,
  next: PrefixComparable,
  answered: boolean,
): string[] {
  const violations: string[] = [];
  const continuity = checkPrefixContinuity(
    leading(prev.payload, answered ? prev.asked : prev.replied),
    next,
  );
  if (continuity.firstDivergence) {
    violations.push(
      `appendOnly: this payload stops repeating the one sent before it at ` +
        `${continuity.firstDivergence.path}, and this compile reported no checkpoint — ` +
        'something the ledger does not see (a slot handler, a hook that edited the history ' +
        'in place, the target adapter) rewrote what was already sent',
    );
  }
  const sent = thinkingSignatures(next);
  const missing = [...thinkingSignatures(prev.payload)].filter((s) => !sent.has(s));
  if (missing.length > 0) {
    violations.push(
      `appendOnly: ${missing.length} thinking signature(s) sent before are no longer sent ` +
        `(first: ${missing[0]}), and this compile reported no checkpoint`,
    );
  }
  return violations;
}
