import type { ChefConfig, ChefEvents, SkillPlacement } from '../chef';
import type { Assembler, DynamicStatePlacement } from '../modules/assembler';
import type { Guardrail, GuardrailOptions } from '../modules/guardrail';
import type { Memory } from '../modules/memory';
import type {
  CompileMeta,
  CompileOptions,
  ITargetAdapter,
  Message,
  TargetPayload,
  ToolDefinition,
} from '../types';
import type { BudgetInfo, SlotRegistry } from './slots';

/**
 * Ordered stages of `ContextChef.compile()`. The orchestrator runs them in
 * exactly this order; each stage reads and writes the {@link CompileContext}.
 */
export type PhaseName =
  | 'start'
  | 'transform-tool-results'
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

/** Opaque, sortable-enough id for one context window. */
export function createWindowId(): string {
  return `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Window lineage stub. Phase 3 turns this into the full `WindowLineage`
 * (`previous` + a fresh id per overflow); Phase 1 allocates one id per chef
 * instance so slot handlers and `OverflowResult.meta` already have a stable
 * key to hang on to.
 */
export interface CompileWindow {
  readonly first: string;
  current: string;
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
  readonly window: CompileWindow;

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

  payload?: TargetPayload;
  readonly meta: CompileMeta;

  private _target?: ResolvedTarget;

  constructor(init: {
    options: CompileOptions;
    signal?: AbortSignal;
    history: Message[];
    window: CompileWindow;
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
  /** Janitor compression (client-side overflow). */
  compress(history: Message[]): Promise<Message[]>;
  /** Best-effort budget reading for the `before-overflow` slot. */
  estimateBudget(history: Message[]): BudgetInfo;
  shapeMemoryParts(
    dataXml: string,
    injectedMemoryKeys: string[],
  ): { topMessages: Message[]; tailDataXml: string };
  resolveAnnouncementChannels(isAnthropicTarget: boolean): { systemXml: string; tailXml: string };
  prunerTools(): ToolDefinition[];
  /** Logs `message` the first time `kind` is seen on this chef instance. */
  warnOnce(kind: string, message: string): void;
  /** Whether `kind` has already been warned — lets a phase skip the scan that produces the message. */
  hasWarned(kind: string): boolean;
  /** `pipelineChecks` violation: warn + `pipeline:invariant` event. Never throws. */
  reportInvariant(phase: PhaseName, message: string, signal?: AbortSignal): Promise<void>;
}
