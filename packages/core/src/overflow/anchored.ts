/**
 * `anchored()` — incremental summarization against a persistent document.
 */

import { AnchorDocument, type SummarizeOptions, SummarizingStrategy } from './summarize';
import type { OverflowStrategy } from './types';

export type AnchoredOptions = SummarizeOptions;

/**
 * Like {@link summarize}, but the strategy maintains a persistent "anchor
 * document": each compression summarizes ONLY the newly evicted span and
 * merges it into the anchor, instead of regenerating the whole summary from
 * scratch every time.
 *
 * Avoids the drift and loss of repeated whole-summary rewrites and keeps the
 * summary prefix stable for caching. The anchor is part of the strategy's
 * state: it survives `Janitor.snapshotState()` / `restoreState()`, clears on
 * `Janitor.reset()`, and is never written by a background job that was
 * discarded as stale.
 *
 * The shrink guard compares anchor GROWTH rather than absolute size — the
 * anchor is cumulative, so comparing it against only the newly evicted span
 * would inevitably trip the circuit breaker in healthy long sessions.
 */
export function anchored(options: AnchoredOptions = {}): OverflowStrategy {
  return new SummarizingStrategy('anchored', options, new AnchorDocument());
}

/**
 * Reads the anchor document out of a strategy snapshot, for the Janitor's
 * `JanitorSnapshot.anchorDoc` compatibility field.
 *
 * @internal
 */
export function readAnchorDoc(state: unknown): string | null {
  const anchorDoc = (state as { anchorDoc?: unknown } | undefined)?.anchorDoc;
  return typeof anchorDoc === 'string' ? anchorDoc : null;
}
