import type { OverflowResult } from '../../overflow/types';
import type { Phase } from '../context';

/**
 * Budget check + the installed overflow strategy.
 *
 * The Janitor runner owns everything inside: evaluating the budget, applying
 * the strategy, archiving what left the window, reporting it. This phase is
 * the boundary — it fires the slots around that call and decides whether it
 * runs at all.
 *
 * When the target is server-managed (Anthropic + a `server()` strategy, in
 * either its explicit or its `contextManagement` spelling) the provider
 * compacts — client-side overflow is skipped entirely (mechanical `compact()`
 * and every other module remain available). Non-server-managed targets fall
 * back to the strategy's own client-side policy.
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
      const budget = host.readBudget(before);
      for (const handler of beforeHandlers) {
        if ((await handler({ history: before, budget })) === false) skipped = true;
      }
    }

    let result: OverflowResult | null = null;
    if (!skipped) {
      result = await host.overflow(before, ctx.window, ctx.signal);
      ctx.history = result.history;
    }
    await host.emit('compress:end', { compressed: ctx.history !== before }, ctx.signal);

    for (const handler of host.slots.get('after-overflow')) {
      await handler({ history: ctx.history, result });
    }
  },
};
