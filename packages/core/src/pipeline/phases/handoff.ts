import { renderHandoffNotice } from '../../overflow/handoff';
import type { Phase } from '../context';

/**
 * Id of the internal announcement the notice rides on. Underscored so it
 * cannot collide with a caller's id — and it never reaches the announcement
 * map anyway, so `retractAnnouncement('__handoff__')` has nothing to remove.
 */
export const HANDOFF_ANNOUNCEMENT_ID = '__handoff__';

/**
 * The handoff budget: one notice before the window is cut.
 *
 * Runs immediately before `overflow`, against the same history that phase will
 * read, so the reading is the one the overflow decision is about to be made
 * on. Delivery goes through the announcement channel — the notice is a
 * statement of current system state, and that channel already knows where such
 * a statement belongs per target — but the announcement lives on the compile
 * context, so it is gone the moment the payload is built.
 *
 * Once per window, tracked by window id rather than by a counter: the point of
 * the notice is "the window you are in is about to end", and it stops being
 * news until a different window is about to end. A server-managed target gets
 * no notice at all — the provider decides when to compact, so the library
 * cannot honestly say how much headroom is left before it does.
 */
export const handoffPhase: Phase = {
  name: 'handoff',
  async run(ctx, host) {
    const handoff = host.handoff;
    if (!handoff || ctx.target.serverManaged) return;

    const windowId = ctx.window.current;
    if (host.handoffNoticedWindow() === windowId) return;

    const budget = host.readBudget(ctx.history);
    if (budget.remaining > handoff.budgetTokens) return;

    ctx.handoffNotice = {
      id: HANDOFF_ANNOUNCEMENT_ID,
      content: renderHandoffNotice(handoff.prompt, budget.remaining),
      channel: 'auto',
    };
    host.markHandoffNoticed(windowId);
  },
};
