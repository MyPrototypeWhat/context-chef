import { buildToolNameMap } from '../../modules/janitor';
import type { Phase } from '../context';

/**
 * Uniform tool-result rewrite BEFORE overflow, so the summarizer and all later
 * stages see transformed content.
 *
 * Cached per source message: unchanged tool results reuse the SAME transformed
 * object across compiles (no re-transform, stable identity for the Janitor's
 * background staleness check).
 */
export const transformToolResultsPhase: Phase = {
  name: 'transform-tool-results',
  async run(ctx, host) {
    const transform = host.transformToolResult;
    if (!transform) return;

    const nameById = buildToolNameMap(ctx.history);
    ctx.history = await Promise.all(
      ctx.history.map(async (m) => {
        if (m.role !== 'tool') return m;
        const cached = host.toolTransformCache.get(m);
        if (cached && cached.source === m.content) return cached.transformed;
        const content = await transform(m.content, {
          toolName: (m.tool_call_id && nameById.get(m.tool_call_id)) || null,
          toolCallId: m.tool_call_id ?? null,
        });
        const transformed = content === m.content ? m : { ...m, content };
        host.toolTransformCache.set(m, { source: m.content, transformed });
        return transformed;
      }),
    );
    ctx.signal?.throwIfAborted();
  },
};
