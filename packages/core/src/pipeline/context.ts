import type { Announcement, ChefConfig, ChefEvents, SkillPlacement } from '../chef';
import type { Assembler, DynamicStatePlacement } from '../modules/assembler';
import type { Guardrail, GuardrailOptions } from '../modules/guardrail';
import type { Memory } from '../modules/memory';
import type { BudgetInfo, HandoffConfig, OverflowResult, WindowLineage } from '../overflow/types';
import type {
  CompileMeta,
  CompileOptions,
  ITargetAdapter,
  Message,
  TargetPayload,
  ToolDefinition,
} from '../types';
import type { SlotRegistry } from './slots';

/**
 * Ordered stages of `ContextChef.compile()`. The orchestrator runs them in
 * exactly this order; each stage reads and writes the {@link CompileContext}.
 */
export type PhaseName =
  | 'start'
  | 'transform-tool-results'
  | 'handoff'
  | 'overflow'
  | 'inject'
  | 'memory'
  | 'skill'
  | 'assemble'
  | 'tail'
  | 'adapt'
  | 'audit'
  | 'done';

/** One stage of the compile pipeline. */
export interface Phase {
  readonly name: PhaseName;
  run(ctx: CompileContext, host: PipelineHost): Promise<void>;
}

/** The compile target after resolution, shared by every phase that adapts to it. */
export interface ResolvedTarget {
  adapter: ITargetAdapter;
  /** The Anthropic target — the one provider with server-side context management and cache breakpoints. */
  isAnthropicTarget: boolean;
  /** `contextManagement.strategy: 'server'` AND a target that implements it. */
  serverManaged: boolean;
}

/**
 * @internal
 *
 * Mutable state of a single `compile()` pass. Replaces the closure variables
 * `_compileInner` used to thread between its numbered steps: every phase reads
 * what earlier phases wrote and writes what later phases read.
 *
 * `history`, `messages` and the other arrays are REPLACED, never mutated in
 * place — `history` starts as the chef's own array reference.
 */
export class CompileContext {
  readonly options: CompileOptions;
  readonly signal?: AbortSignal;
  /**
   * The runner's live window lineage — the same object the Janitor advances,
   * so `current` read late in the pipeline is the window this payload belongs
   * to, not the one the compile started in.
   */
  readonly window: WindowLineage;

  /** Working history: chef history → transformed tool results → post-overflow. */
  history: Message[];
  /** `<implicit_context>` block built from `before-assemble` injections. */
  implicitContextXml = '';
  /** Dynamic state messages, with implicit context folded in under `'system'` placement. */
  dynamicState: Message[] = [];

  memoryMessages: Message[] = [];
  memoryTailDataXml = '';
  memoryTools: ToolDefinition[] = [];

  skillMessages: Message[] = [];
  skillTailXml = '';

  guardrailMessages: Message[] = [];
  guardrailTailXml = '';

  /** System layers of the sandwich: user system prompt + skill + memory. */
  systemLayers: Message[] = [];
  /** The sandwich after `assemble`; the final message array after `tail`. */
  messages: Message[] = [];
  /** Tail stitch parts, in the fixed order the tail phase composes them. */
  tailParts: string[] = [];

  /**
   * The handoff notice for THIS compile, rendered by the `handoff` phase and
   * delivered by `tail` through the announcement channel. It lives on the
   * compile rather than on the chef so it cannot outlive the payload it was
   * written for: no leakage into `getAnnouncements()`, into a snapshot, or
   * into the next compile.
   */
  handoffNotice?: Announcement;

  payload?: TargetPayload;
  readonly meta: CompileMeta;

  private _target?: ResolvedTarget;

  constructor(init: {
    options: CompileOptions;
    signal?: AbortSignal;
    history: Message[];
    window: WindowLineage;
  }) {
    this.options = init.options;
    this.signal = init.signal;
    this.history = init.history;
    this.window = init.window;
    // Key order is part of the compile output (`payload.meta`), so both memory
    // fields are created up front even though the memory phase fills them.
    this.meta = { injectedMemoryKeys: [], memoryExpiredKeys: [] };
  }

  /** Resolved by the `start` phase; reading it earlier is a phase-order bug. */
  get target(): ResolvedTarget {
    if (!this._target) {
      throw new Error(
        '[context-chef] compile pipeline: target read before the start phase resolved it',
      );
    }
    return this._target;
  }

  set target(target: ResolvedTarget) {
    this._target = target;
  }

  /** The payload built by the `adapt` phase. */
  requirePayload(): TargetPayload {
    if (!this.payload) {
      throw new Error('[context-chef] compile pipeline: the adapt phase produced no payload');
    }
    return this.payload;
  }
}

/**
 * @internal
 *
 * The slice of `ContextChef` the phases are allowed to touch. Implemented by a
 * closure object the chef builds once at construction, so phases get exactly
 * this surface and the chef's fields stay `private`.
 */
export interface PipelineHost {
  readonly systemPrompt: Message[];
  readonly history: Message[];
  readonly dynamicState: Message[];
  readonly dynamicStateXml: string;
  readonly dynamicStatePlacement: DynamicStatePlacement;

  readonly defaultTarget?: ChefConfig['defaultTarget'];
  readonly contextManagement?: ChefConfig['contextManagement'];
  readonly transformToolResult?: ChefConfig['transformToolResult'];
  readonly toolTransformCache: WeakMap<Message, { source: string; transformed: Message }>;

  readonly cacheAudit: boolean;
  readonly pipelineChecks: boolean;

  readonly slots: SlotRegistry;
  readonly assembler: Assembler;
  readonly guardrail: Guardrail;
  readonly guardrailOptions?: GuardrailOptions;
  readonly memory: Memory | null;
  readonly skill: { name?: string; instructions: string; placement: SkillPlacement };

  emit<K extends keyof ChefEvents>(
    event: K,
    payload: ChefEvents[K],
    signal?: AbortSignal,
  ): Promise<void>;
  /** The runner's window lineage, live (see {@link CompileContext.window}). */
  readonly window: WindowLineage;
  /** The validated handoff budget, when one is configured. */
  readonly handoff?: Required<HandoffConfig>;

  /**
   * One overflow pass through the Janitor runner (client-side overflow).
   * `force` applies the strategy whatever the budget says.
   */
  overflow(history: Message[], signal?: AbortSignal, force?: boolean): Promise<OverflowResult>;
  /** The runner's budget reading for the `before-overflow` slot. Consumes nothing. */
  readBudget(history: Message[]): BudgetInfo;
  /**
   * Reads and clears the pending `requestNewContext()` flag. Read-and-clear
   * because the request belongs to exactly one compile, whatever that compile
   * then does with it.
   */
  takeForcedOverflow(): boolean;
  /** The window the handoff notice was last issued for, if any. */
  handoffNoticedWindow(): string | undefined;
  /** Records that the handoff notice has been issued for `windowId`. */
  markHandoffNoticed(windowId: string): void;
  shapeMemoryParts(
    dataXml: string,
    injectedMemoryKeys: string[],
  ): { topMessages: Message[]; tailDataXml: string };
  /**
   * Standing announcements split by channel, with `extra` (the handoff notice)
   * appended for this compile only.
   */
  resolveAnnouncementChannels(
    isAnthropicTarget: boolean,
    extra?: readonly Announcement[],
  ): { systemXml: string; tailXml: string };
  prunerTools(): ToolDefinition[];
  /** Logs `message` the first time `kind` is seen on this chef instance. */
  warnOnce(kind: string, message: string): void;
  /** Whether `kind` has already been warned — lets a phase skip the scan that produces the message. */
  hasWarned(kind: string): boolean;
  /** `pipelineChecks` violation: warn + `pipeline:invariant` event. Never throws. */
  reportInvariant(phase: PhaseName, message: string, signal?: AbortSignal): Promise<void>;
}
