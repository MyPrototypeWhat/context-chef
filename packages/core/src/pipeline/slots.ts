import type { BeforeCompileContext } from '../chef';
import type { Message, TargetPayload } from '../types';

/**
 * Token budget as seen by the `before-overflow` slot.
 *
 * `current` is the pipeline's own reading (the configured Janitor tokenizer
 * when there is one, the built-in heuristic otherwise) — the Janitor's
 * internal evaluation is stateful and is NOT re-run here. Treat these numbers
 * as an observation, not as the exact figure the overflow decision uses.
 */
export interface BudgetInfo {
  /** Raw context window in tokens (`janitor.contextWindow`). */
  limit: number;
  /** Estimated tokens the current history occupies. */
  current: number;
  /** Effective trigger threshold: `limit * triggerRatio`. */
  trigger: number;
  /** Headroom before the trigger. Negative once history is over budget. */
  remaining: number;
}

/**
 * Outcome of the overflow phase, handed to `after-overflow` handlers.
 *
 * Phase 1 fills this from the Janitor's before/after history; Phase 2 replaces
 * the source with an `OverflowStrategy` result and moves the type to
 * `src/overflow/`. `null` means the phase did not run at all (server-managed
 * target, or a `before-overflow` handler skipped it).
 */
export interface OverflowResult {
  /** The new in-window history. */
  history: Message[];
  /** Messages that left the window (identity comparison against the input). */
  evicted: Message[];
  /** Rendered summary text, when the overflow produced one. */
  summary?: string;
  meta: {
    strategy: string;
    windowId: string;
    changed: boolean;
    reason?: string;
  };
}

/** Context handed to `before-assemble` handlers. */
export interface BeforeAssembleContext extends BeforeCompileContext {
  /**
   * Adds a block to the `<implicit_context>` injection for this compile.
   * Multiple calls (and multiple handlers) accumulate in registration order,
   * separated by a blank line; empty strings are ignored.
   */
  inject(text: string): void;
}

/**
 * Composition points the compile pipeline fires at phase boundaries.
 * Handlers run in registration order and are awaited sequentially.
 *
 * Handler errors are NOT isolated: they propagate out of `compile()`, exactly
 * like the legacy config hooks these slots generalize. Wrap your own logic in
 * try/catch if a failure should be survivable.
 */
export interface SlotHandlers {
  /** Runs before the overflow phase. Returning `false` skips overflow for this compile. */
  'before-overflow': (ctx: {
    history: readonly Message[];
    budget: BudgetInfo;
    // biome-ignore lint/suspicious/noConfusingVoidType: `void | false` is the veto contract — a handler returns nothing, or false to skip overflow.
  }) => void | false | Promise<void | false>;
  /** Runs after the overflow phase. `result` is null when the phase was skipped. */
  'after-overflow': (ctx: {
    history: Message[];
    result: OverflowResult | null;
  }) => void | Promise<void>;
  /** Runs before the sandwich is assembled; may inject implicit context. */
  'before-assemble': (ctx: BeforeAssembleContext) => void | Promise<void>;
  /** Transforms the assembled sandwich. Handlers chain: each receives the previous result. */
  'after-assemble': (messages: Message[]) => Message[] | Promise<Message[]>;
  /** Observes the final message array right before the target adapter runs. */
  'before-adapt': (messages: readonly Message[]) => void | Promise<void>;
  /** Observes the compiled payload, before `compile:done`. */
  'after-adapt': (payload: TargetPayload) => void | Promise<void>;
}

export type SlotName = keyof SlotHandlers;

/**
 * Registration order is the execution order, so handlers live in arrays rather
 * than a Set: the same function may be registered more than once (each
 * registration runs), and `unuse` removes one registration at a time.
 */
export class SlotRegistry {
  private readonly handlers = new Map<SlotName, unknown[]>();

  use<S extends SlotName>(slot: S, handler: SlotHandlers[S]): void {
    const list = this.handlers.get(slot);
    if (list) list.push(handler);
    else this.handlers.set(slot, [handler]);
  }

  /** Removes the first registration of `handler` on `slot`. Returns true when one was removed. */
  unuse<S extends SlotName>(slot: S, handler: SlotHandlers[S]): boolean {
    const list = this.handlers.get(slot);
    if (!list) return false;
    const index = list.indexOf(handler);
    if (index === -1) return false;
    list.splice(index, 1);
    return true;
  }

  /**
   * Handlers for a slot, in registration order. A snapshot, so a handler that
   * unregisters itself (or registers another) mid-run does not disturb the
   * iteration it is part of. Empty array when none are registered.
   */
  get<S extends SlotName>(slot: S): SlotHandlers[S][] {
    const list = this.handlers.get(slot);
    return list ? ([...list] as SlotHandlers[S][]) : [];
  }
}
