/**
 * The compile pipeline: `ContextChef.compile()` as a fixed, ordered list of
 * named phases plus the slots they fire at the boundaries.
 *
 * Phases are internal (their contract is `docs/architecture-v5.md` §3); slots
 * are the public composition surface — see `ContextChef.use` / `unuse`.
 */

export {
  CompileContext,
  type Phase,
  type PhaseName,
  type PipelineHost,
  type ResolvedTarget,
} from './context';
export { adaptPhase } from './phases/adapt';
export { assemblePhase } from './phases/assemble';
export { auditPhase } from './phases/audit';
export { donePhase } from './phases/done';
export { HANDOFF_ANNOUNCEMENT_ID, handoffPhase } from './phases/handoff';
export { injectPhase } from './phases/inject';
export { memoryPhase } from './phases/memory';
export { overflowPhase } from './phases/overflow';
export { skillPhase } from './phases/skill';
export { startPhase } from './phases/start';
export { tailPhase } from './phases/tail';
export { transformToolResultsPhase } from './phases/transformToolResults';
export {
  type BeforeAssembleContext,
  type BudgetInfo,
  type OverflowResult,
  type SlotHandlers,
  type SlotName,
  SlotRegistry,
} from './slots';

import type { Phase, PhaseName } from './context';
import { adaptPhase } from './phases/adapt';
import { assemblePhase } from './phases/assemble';
import { auditPhase } from './phases/audit';
import { donePhase } from './phases/done';
import { handoffPhase } from './phases/handoff';
import { injectPhase } from './phases/inject';
import { memoryPhase } from './phases/memory';
import { overflowPhase } from './phases/overflow';
import { skillPhase } from './phases/skill';
import { startPhase } from './phases/start';
import { tailPhase } from './phases/tail';
import { transformToolResultsPhase } from './phases/transformToolResults';

/** The compile pipeline, in execution order. */
export const COMPILE_PHASES: readonly Phase[] = [
  startPhase,
  transformToolResultsPhase,
  handoffPhase,
  overflowPhase,
  injectPhase,
  memoryPhase,
  skillPhase,
  assemblePhase,
  tailPhase,
  adaptPhase,
  auditPhase,
  donePhase,
];

/**
 * Phases after which the orchestrator honours `compile({ signal })`. These are
 * the boundaries that existed before the pipeline refactor — every one of them
 * follows an await that can take arbitrarily long (compression model, memory
 * store, user hooks). `start` and `transform-tool-results` check inside the
 * phase instead, where the original code did; `handoff` awaits nothing at all
 * (a budget reading and a string), with `overflow`'s check right behind it.
 */
export const ABORT_AFTER_PHASE: ReadonlySet<PhaseName> = new Set<PhaseName>([
  'overflow',
  'inject',
  'memory',
  'assemble',
]);
