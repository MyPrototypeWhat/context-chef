import { auditAnthropicCachePlacement } from '../../adapters/anthropicCacheAudit';
import type { AnthropicPayload } from '../../types';
import type { Phase } from '../context';

/**
 * Optional cache audit (Anthropic target only). Dedupe on the semantic issue
 * kind, NOT the position: as history grows the same misconfiguration drifts
 * through message indices, and a positional key would re-warn every compile
 * and grow the seen-set unboundedly. The kind space is fixed
 * (markers × placements), so the set is bounded too.
 */
export const auditPhase: Phase = {
  name: 'audit',
  async run(ctx, host) {
    if (!host.cacheAudit || !ctx.target.isAnthropicTarget) return;

    for (const issue of auditAnthropicCachePlacement(ctx.requirePayload() as AnthropicPayload)) {
      host.warnOnce(
        `cache-audit:${issue.dedupeKey}`,
        `[context-chef] cache audit — ${issue.location}: ${issue.message}`,
      );
    }
  },
};
