import type { Message } from '../../types';
import type { Phase } from '../context';
import type { OverflowResult } from '../slots';

/**
 * Describes what the Janitor did, in the shape Phase 2's `OverflowStrategy`
 * will produce natively. `evicted` and `summary` are derived by identity: the
 * Janitor returns `[summary, ...pinned, ...kept]`, so everything from the
 * input that is absent from the output left the window, and a lone new message
 * is the summary it wrote.
 */
function describeOverflow(before: Message[], after: Message[], windowId: string): OverflowResult {
  const afterRefs = new Set(after);
  const evicted = before.filter((m) => !afterRefs.has(m));
  const beforeRefs = new Set(before);
  const added = after.filter((m) => !beforeRefs.has(m));
  return {
    history: after,
    evicted,
    summary: added.length === 1 ? added[0].content : undefined,
    meta: { strategy: 'janitor', windowId, changed: after !== before },
  };
}

/**
 * Budget check + history compression.
 *
 * When the target is server-managed (Anthropic + strategy 'server') the
 * provider compacts — client compression is skipped (mechanical `compact()`
 * and every other module remain available). Non-server-managed targets keep
 * client-side compression even under strategy 'server'.
 */
export const overflowPhase: Phase = {
  name: 'overflow',
  async run(ctx, host) {
    const before = ctx.history;
    let skipped = ctx.target.serverManaged;

    const beforeHandlers = host.slots.get('before-overflow');
    if (beforeHandlers.length > 0) {
      // Budget is read only when someone is listening — the tokenizer path
      // walks the whole history.
      const budget = host.estimateBudget(before);
      for (const handler of beforeHandlers) {
        if ((await handler({ history: before, budget })) === false) skipped = true;
      }
    }

    ctx.history = skipped ? before : await host.compress(before);
    await host.emit('compress:end', { compressed: ctx.history !== before }, ctx.signal);

    const afterHandlers = host.slots.get('after-overflow');
    if (afterHandlers.length > 0) {
      const result = skipped ? null : describeOverflow(before, ctx.history, ctx.window.current);
      for (const handler of afterHandlers) {
        await handler({ history: ctx.history, result });
      }
    }
  },
};
