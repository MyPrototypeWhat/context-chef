import type { Phase } from '../context';

/**
 * Single-read memory artifacts — sweep expired entries, apply the selector
 * exactly once, and derive injection XML + tool definitions from the same
 * store read (`Memory.compileArtifacts`), then advance the turn counter and
 * shape the sandwich parts:
 * - `memoryMessages`: system message(s) that always sit at the top
 * - `memoryTailDataXml`: volatile <memory> block to inject at the user tail
 *   (empty unless memoryPlacement === 'before_history_tail')
 *
 * `compileArtifacts()` awaits per-entry `onMemoryExpired` hooks, so handler
 * latency adds up before the orchestrator's next abort check. Caveat: the turn
 * counter has already advanced; aborting here means TTL state diverges from
 * payload state. Documented in `CompileOptions.signal`.
 */
export const memoryPhase: Phase = {
  name: 'memory',
  async run(ctx, host) {
    if (!host.memory) return;

    const artifacts = await host.memory.compileArtifacts();
    host.memory.advanceTurn();
    ctx.meta.memoryExpiredKeys = artifacts.expiredKeys;
    ctx.meta.injectedMemoryKeys = artifacts.selected.map((e) => e.key);
    ctx.memoryTools = artifacts.toolDefinitions;

    const parts = host.shapeMemoryParts(artifacts.dataXml, ctx.meta.injectedMemoryKeys);
    ctx.memoryMessages = parts.topMessages;
    ctx.memoryTailDataXml = parts.tailDataXml;
  },
};
