/**
 * `reset()` — drop the window and start over.
 */

import { renderSummaryMessage } from './summary';
import {
  type OverflowInput,
  type OverflowResult,
  type OverflowStrategy,
  unchanged,
  type WindowLineage,
} from './types';

/**
 * The stub that stands in for the evicted conversation.
 *
 * The ids name the window that was just reset and the one before it — the
 * runner opens the next window only once this result lands, so at the moment
 * the notice is written the newest id in existence is the one being closed.
 * That is also the id the archive entry belongs to, which is what makes the
 * pair worth printing: it ties the stub to the span it stands for.
 */
function defaultNotice(window: WindowLineage): string {
  const lineage = window.previous
    ? `window ${window.current}; previous ${window.previous}`
    : `window ${window.current}`;
  return `Context window reset (${lineage}). Earlier conversation was archived.`;
}

export interface ResetOptions {
  /**
   * Text of the stub summary left behind, before the continuation wrapper.
   * Used verbatim, in place of the default window-lineage notice. It goes
   * through the same wrapper as a real summary, so the runner's archive
   * citation lands on it exactly like it lands on `summarize()`.
   */
  notice?: string;
}

/**
 * Keeps the pinned messages and evicts everything else — no model call, no
 * summary of the content, just a notice that the window was reset.
 *
 * The cheapest possible overflow, and lossy unless `overflow.archive` is
 * configured: with an archive the evicted span stays retrievable through the
 * URI cited in the notice; without one it is gone. That combination is
 * documented, not enforced — no combination of user choices is rejected.
 *
 * Most useful as the escalation step of a {@link chain}, where it takes over
 * when summarization keeps failing.
 */
export function reset(options: ResetOptions = {}): OverflowStrategy {
  return {
    name: 'reset',
    async apply(input: OverflowInput): Promise<OverflowResult> {
      const pinnedSet = new Set(input.pinned);
      const evicted = input.history.filter((m) => !pinnedSet.has(m));
      if (evicted.length === 0) {
        return unchanged(input, 'reset', 'history holds nothing but pinned messages');
      }
      const notice = options.notice ?? defaultNotice(input.window);
      // input.pinned is already turn-scoped and in original order.
      const kept = input.pinned.filter((m) => input.history.includes(m));
      return {
        history: [renderSummaryMessage(notice), ...kept],
        evicted,
        // Nothing was compressed around the pinned messages — the notice
        // stands for exactly what left.
        span: evicted,
        summary: notice,
        meta: { strategy: 'reset', windowId: input.window.current, changed: true },
      };
    },
  };
}
