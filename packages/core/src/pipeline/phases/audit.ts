import { auditAnthropicCachePlacement } from '../../adapters/anthropicCacheAudit';
import type { PrefixLedger } from '../../prefix';
import { isPrefill } from '../../prefix/events';
import type { AnthropicPayload, Message } from '../../types';
import { checkSentPrefix, type PrefixComparable, type SentPayload } from '../checks';
import type { CompileContext, Phase, PipelineHost } from '../context';
import { withoutStrippedThinking } from './prefix';

/**
 * By ledger, as it was last committed: a ledger restored from a snapshot, or
 * a new one, has sent nothing this check has seen.
 */
const committed = new WeakMap<PrefixLedger, SentPayload>();

/** Where the prefill `messages` end with starts: their length when there is none. */
function prefillStart(messages: readonly Message[]): number {
  let start = messages.length;
  while (start > 0 && isPrefill(messages[start - 1])) start--;
  return start;
}

/** Just past the last reply ahead of a trailing prefill: 0 when nothing was answered. */
function pastLastReply(messages: readonly Message[]): number {
  for (let i = prefillStart(messages); i > 0; i--) {
    if (messages[i - 1].role === 'assistant') return i;
  }
  return 0;
}

const sentItems = (payload: PrefixComparable): readonly unknown[] =>
  payload.input ?? payload.messages ?? [];

/**
 * `appendOnly` with `pipelineChecks`: the cross-turn invariant (spec §8.1).
 * This compile's payload must still send what the last committed one sent —
 * all of it once a reply answered that request, up to its last reply until
 * then — unless it reported a checkpoint. A violation is reported, never
 * enforced: R6, a slot handler can rewrite anything. Then this payload is
 * staged as the one the next compile compares with, kept once committed.
 */
async function checkAcrossTurns(ctx: CompileContext, host: PipelineHost): Promise<void> {
  const prefix = ctx.prefix;
  if (!prefix || !host.pipelineChecks) return;

  const payload = ctx.requirePayload() as PrefixComparable;
  const prev = committed.get(prefix.ledger);
  if (prev && prefix.breaks.length === 0) {
    const answered = pastLastReply(prefix.history) > prev.hostLength;
    for (const violation of checkSentPrefix(prev, payload, answered)) {
      await host.reportInvariant('audit', violation, ctx.signal);
    }
  }

  // The messages `adapt` rendered: a leading part counts as many items as it renders to.
  const messages = ctx.messages;
  const items = (count: number): number => {
    if (count >= messages.length) return sentItems(payload).length;
    if (count === 0) return 0;
    const part = ctx.target.adapter.compile(withoutStrippedThinking(ctx, messages.slice(0, count)));
    return sentItems(part as PrefixComparable).length;
  };
  let leadingSystem = 0;
  while (leadingSystem < messages.length && messages[leadingSystem].role === 'system') {
    leadingSystem++;
  }
  prefix.sentForCheck = {
    // A copy as on the wire: the host may edit the payload it is handed.
    payload: JSON.parse(
      JSON.stringify({
        system: payload.system,
        systemInstruction: payload.systemInstruction,
        instructions: payload.instructions,
        tools: payload.tools,
        messages: payload.messages,
        input: payload.input,
      }),
    ),
    hostLength: prefix.history.length,
    replied: items(Math.max(pastLastReply(messages), leadingSystem)),
    asked: items(prefillStart(messages)),
  };
}

/**
 * `appendOnly` with `pipelineChecks`, once the ledger committed this compile:
 * its payload is the one the next compile is compared with.
 */
export function keepSentForCheck(ctx: CompileContext): void {
  const prefix = ctx.prefix;
  const sent = prefix?.sentForCheck;
  if (prefix && sent) committed.set(prefix.ledger, sent);
}

/**
 * The cross-turn check (`appendOnly` with `pipelineChecks`), then the
 * optional cache audit (Anthropic target only). Dedupe on the semantic issue
 * kind, NOT the position: as history grows the same misconfiguration drifts
 * through message indices, and a positional key would re-warn every compile
 * and grow the seen-set unboundedly. The kind space is fixed
 * (markers × placements), so the set is bounded too. Under `appendOnly` the
 * events in `messages` stay where they were sent, so only the system prompt
 * is audited.
 */
export const auditPhase: Phase = {
  name: 'audit',
  async run(ctx, host) {
    await checkAcrossTurns(ctx, host);
    if (!host.cacheAudit || !ctx.target.isAnthropicTarget) return;

    const payload = ctx.requirePayload() as AnthropicPayload;
    const issues = auditAnthropicCachePlacement(payload, { appendOnly: ctx.prefix !== undefined });
    for (const issue of issues) {
      host.warnOnce(
        `cache-audit:${issue.dedupeKey}`,
        `[context-chef] cache audit — ${issue.location}: ${issue.message}`,
      );
    }
  },
};
