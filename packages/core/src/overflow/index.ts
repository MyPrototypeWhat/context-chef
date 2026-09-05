/**
 * Overflow: what leaves the context window when it fills up.
 *
 * A strategy is the policy (`summarize`, `anchored`, `server`, `reset`, plus
 * the `chain` / `background` combinators); the {@link Janitor} is the runner
 * that evaluates the budget, applies the strategy, archives what left, and
 * reports it. See `docs/architecture-v5.md` §4.
 */

export { type AnchoredOptions, anchored } from './anchored';
export { type BackgroundOverflowStrategy, background } from './background';
export { chain } from './chain';
export { type ResetOptions, reset } from './reset';
export { type OverflowAliasConfig, resolveOverflowStrategy } from './resolve';
export { isServerStrategy, type ServerOverflowStrategy, server } from './server';
export { type SplitMode, type SummarizeOptions, summarize } from './summarize';
export { renderSummaryMessage, type SummarizeHistoryOptions, summarizeHistory } from './summary';
export {
  buildToolNameMap,
  groupIntoTurns,
  partitionPinnedMessages,
  type Turn,
} from './turns';
export {
  type BudgetInfo,
  type CompressionArchiveConfig,
  createWindowId,
  type HandoffConfig,
  type OverflowInput,
  type OverflowResult,
  type OverflowRunner,
  type OverflowStrategy,
  type OverflowWindow,
} from './types';
