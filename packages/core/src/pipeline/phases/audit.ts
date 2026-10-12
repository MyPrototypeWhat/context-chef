import { auditAnthropicCachePlacement } from '../../adapters/anthropicCacheAudit';
import type { AnthropicPayload } from '../../types';
import type { Phase } from '../context';

/**
 * Optional cache audit (Anthropic target only). Dedupe on the semantic issue
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
