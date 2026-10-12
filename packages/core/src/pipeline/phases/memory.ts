import { type MemoryEntry, renderMemoryEntry } from '../../modules/memory';
import { memoryEvents } from '../../prefix';
import type { Phase, PipelineHost, PrefixCompile } from '../context';

/**
 * Single-read memory artifacts — sweep expired entries, apply the selector
 * exactly once, and derive injection XML + tool definitions from the same
 * store read (`Memory.compileArtifacts`), then advance the turn counter and
 * shape the sandwich parts:
 * - `memoryMessages`: system message(s) that always sit at the top
 * - `memoryTailDataXml`: volatile <memory> block to inject at the user tail
 *   (empty unless memoryPlacement === 'before_history_tail')
 *
 * Under `appendOnly` the data at the tail is an event instead
 * (`memoryEvents`): a snapshot when the window starts, then a delta of what
 * the model was not told. The instruction stays the static top message.
 *
 * `compileArtifacts()` awaits per-entry `onMemoryExpired` hooks, so handler
 * latency adds up before the orchestrator's next abort check. Caveat: the turn
 * counter has already advanced; aborting here means TTL state diverges from
 * payload state. Documented in `CompileOptions.signal`.
 */
export const memoryPhase: Phase = {
  name: 'memory',
  async run(ctx, host) {
    const memory = host.memory;
    if (!memory) return;

    const artifacts = await memory.compileArtifacts();
    memory.advanceTurn();
    ctx.meta.memoryExpiredKeys = artifacts.expiredKeys;
    ctx.meta.injectedMemoryKeys = artifacts.selected.map((e) => e.key);
    ctx.memoryTools = artifacts.toolDefinitions;

    const parts = host.shapeMemoryParts(artifacts.dataXml, ctx.meta.injectedMemoryKeys);
    ctx.memoryMessages = parts.topMessages;
    if (ctx.prefix && memory.placement === 'before_history_tail') {
      const pushed = memoryEventsFor(ctx.prefix, host, {
        live: artifacts.live,
        selected: artifacts.selected,
        snapshot: parts.tailDataXml,
      });
      ctx.memoryEvents = pushed.events;
      ctx.meta.injectedMemoryKeys = pushed.keys;
    } else {
      ctx.memoryTailDataXml = parts.tailDataXml;
    }
  },
};

/**
 * `appendOnly`: the snapshot or delta this compile appends, and the keys it
 * speaks for. The model's own writes count as told until an event states
 * their keys again, or until a checkpoint may have dropped the turns that
 * made them: every one reported by now does — `system` and `tools`, which
 * keep the turns, are only found once the payload exists.
 */
function memoryEventsFor(
  prefix: PrefixCompile,
  host: PipelineHost,
  read: { live: MemoryEntry[]; selected: MemoryEntry[]; snapshot: string },
) {
  if (prefix.breaks.length > 0) host.forgetModelMemoryWrites();
  const written = new Map<string, string | null>();
  for (const [key, entry] of host.modelMemoryWrites) {
    written.set(key, entry && renderMemoryEntry(entry));
  }
  const selected = read.selected.map((entry) => ({
    key: entry.key,
    xml: renderMemoryEntry(entry),
  }));

  const pushed = memoryEvents(
    prefix.ledger.appended('memory'),
    { selected, live: new Set(read.live.map((entry) => entry.key)), written },
    {
      header: host.vocabulary.memoryBlockHeader,
      snapshot: read.snapshot,
      delta: host.vocabulary.memoryDelta,
    },
  );
  host.forgetModelMemoryWrites(pushed.keys);
  return pushed;
}
