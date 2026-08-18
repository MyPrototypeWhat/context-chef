import type { AnthropicPayload } from '../types';

/** One problem found by {@link auditAnthropicCachePlacement}. */
export interface CacheAuditIssue {
  /** Where the volatile content sits, e.g. "system[1]" or "messages[3]". */
  location: string;
  /** Human-readable explanation with the suggested fix. */
  message: string;
}

/**
 * Markers of content that changes across compiles. Each maps to the module
 * that emits it, so the audit message can point at the right knob.
 */
const VOLATILE_MARKERS: Array<{ marker: string; source: string; fix: string }> = [
  {
    marker: 'You recall the following',
    source: 'memory data block',
    fix: "set memory config `memoryPlacement: 'before_history_tail'` so memory changes stop rewriting the cached prefix",
  },
  {
    marker: '<dynamic_state>',
    source: 'dynamic state',
    fix: "use the default `setDynamicState(..., { placement: 'last_user' })` instead of 'system'",
  },
  {
    marker: '<implicit_context>',
    source: 'onBeforeCompile injection',
    fix: "keep dynamic state placement 'last_user' so implicit context rides the tail injection",
  },
  {
    marker: '<EPHEMERAL_MESSAGE>',
    source: 'guardrail enforce-XML',
    fix: "set `withGuardrails({ ..., placement: 'last_user' })` so guardrail changes stop rewriting the cached prefix",
  },
];

/** Structural view of one position in the Anthropic prompt prefix. */
interface PrefixSegment {
  location: string;
  text: string;
  hasBreakpoint: boolean;
}

function collectSegments(payload: AnthropicPayload): PrefixSegment[] {
  const segments: PrefixSegment[] = [];

  for (let i = 0; i < (payload.system?.length ?? 0); i++) {
    const block = payload.system?.[i] as { text?: string; cache_control?: unknown } | undefined;
    segments.push({
      location: `system[${i}]`,
      text: typeof block?.text === 'string' ? block.text : '',
      hasBreakpoint: Boolean(block?.cache_control),
    });
  }

  for (let i = 0; i < payload.messages.length; i++) {
    const msg = payload.messages[i] as { content?: unknown };
    let text = '';
    let hasBreakpoint = false;
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const raw of msg.content) {
        const block = raw as { text?: string; content?: unknown; cache_control?: unknown };
        if (typeof block.text === 'string') text += `\n${block.text}`;
        else if (typeof block.content === 'string') text += `\n${block.content}`;
        if (block.cache_control) hasBreakpoint = true;
      }
    }
    segments.push({ location: `messages[${i}]`, text, hasBreakpoint });
  }

  return segments;
}

/**
 * Audits a compiled Anthropic payload for volatile content sitting INSIDE the
 * cached prompt prefix.
 *
 * Model: Anthropic hashes the prefix in order `tools → system → messages`; a
 * `cache_control` breakpoint at position P caches everything before and
 * including P. Volatile content (memory data, dynamic state, implicit
 * context, guardrail instructions — anything ContextChef re-generates per
 * compile) placed at or before the LAST breakpoint invalidates that cache
 * every time it changes.
 *
 * Scope: **Anthropic only** — it is the one provider with explicit,
 * client-visible breakpoints, so the check is fully deterministic (a pure
 * structural property of the payload; zero heuristics, zero false positives).
 * OpenAI's automatic prefix cache and Gemini's implicit cache have no marks
 * to audit against, so no equivalent is offered for them.
 *
 * Returns an empty array when the placement is cache-safe (including when no
 * breakpoints exist at all — with nothing marked, nothing can be broken).
 *
 * @example
 * const payload = await chef.compile({ target: 'anthropic' });
 * for (const issue of auditAnthropicCachePlacement(payload)) {
 *   console.warn(`[cache] ${issue.location}: ${issue.message}`);
 * }
 */
export function auditAnthropicCachePlacement(payload: AnthropicPayload): CacheAuditIssue[] {
  const segments = collectSegments(payload);

  let lastBreakpoint = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].hasBreakpoint) lastBreakpoint = i;
  }
  if (lastBreakpoint === -1) return []; // nothing cached, nothing to break

  const issues: CacheAuditIssue[] = [];
  for (let i = 0; i <= lastBreakpoint; i++) {
    for (const { marker, source, fix } of VOLATILE_MARKERS) {
      if (segments[i].text.includes(marker)) {
        issues.push({
          location: segments[i].location,
          message:
            `volatile ${source} sits inside the cached prefix (a cache_control breakpoint ` +
            `exists at or after this position) — every change to it invalidates the cache. Fix: ${fix}.`,
        });
      }
    }
  }
  return issues;
}
