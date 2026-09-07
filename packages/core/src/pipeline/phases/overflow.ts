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
 *
 * A pending `chef.requestNewContext()` makes the runner apply the strategy
 * whatever the budget says. It does not override the two ways a compile can
 * decline to overflow at all — a server-managed target and a `before-overflow`
 * veto — because both are statements about who owns this window, not about
 * whether it is full. It is consumed either way, and the drop is REPORTED:
 * the model was told a new window was starting, and something has to say that
 * it did not.
 */
export const overflowPhase: Phase = {
  name: 'overflow',
  async run(ctx, host) {
    const before = ctx.history;
    // Read-and-clear: a `requestNewContext()` is answered by exactly one
    // compile — including one that ends up skipping overflow, because the
    // answer "not this time" is still an answer and re-asking is the caller's
    // call, not the pipeline's.
    const forced = host.takeForcedOverflow();
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

    if (forced && skipped) {
      const message = ctx.target.serverManaged
        ? '[context-chef] a requestNewContext() / new_context request was dropped: the compile ' +
          'target is server-managed, so the provider decides when this window ends. The request ' +
          'is consumed either way. Configure a client-side strategy (or drop new_context from ' +
          'the tool set) if the model is meant to be able to close the window.'
        : '[context-chef] a requestNewContext() / new_context request was dropped: a ' +
          'before-overflow handler vetoed this compile. The request is consumed either way — ' +
          'call requestNewContext() again once the handler is willing to let the window turn.';
      host.warnOnce(
        ctx.target.serverManaged ? 'forced-overflow-server-managed' : 'forced-overflow-vetoed',
        message,
      );
      await host.emit('pipeline:invariant', { phase: 'overflow', message }, ctx.signal);
    }

    let result: OverflowResult | null = null;
    if (!skipped) {
      result = await host.overflow(before, ctx.signal, forced);
      ctx.history = result.history;
    }
    // Read after the runner ran: a landed overflow closed the window this
    // compile started in, and the payload belongs to the one it opened.
    ctx.meta.windowId = ctx.window.current;
    await host.emit('compress:end', { compressed: ctx.history !== before }, ctx.signal);

    for (const handler of host.slots.get('after-overflow')) {
      await handler({ history: ctx.history, result });
    }
  },
};
