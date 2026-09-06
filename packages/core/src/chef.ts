import type { z } from 'zod';
import { Assembler, type DynamicStatePlacement } from './modules/assembler';
import { Guardrail, type GuardrailOptions } from './modules/guardrail';
import {
  type CompressionDetails,
  Janitor,
  type JanitorConfig,
  type JanitorSnapshot,
  NO_COMPRESSION_MODEL_WARNING,
} from './modules/janitor';
import {
  Memory,
  type MemoryChangeEvent,
  type MemoryConfig,
  type MemoryEntry,
  type MemorySnapshot,
} from './modules/memory';
import { Offloader, type OffloadOptions, type VFSConfig } from './modules/offloader';
import { type ResolveRecallOptions, renderRecalledContent } from './modules/offloader/recallTool';
import {
  type CompiledTools,
  Pruner,
  type PrunerConfig,
  type PrunerSnapshot,
  type ResolvedToolCall,
  type ToolGroup,
} from './modules/pruner';
import type { Skill } from './modules/skill';
import {
  type CompressionArchiveConfig,
  getNewContextToolDefinition,
  type HandoffConfig,
  isServerStrategy,
  type OverflowStrategy,
  resolveOverflowStrategy,
  server,
  validateHandoffConfig,
} from './overflow';
import {
  ABORT_AFTER_PHASE,
  COMPILE_PHASES,
  CompileContext,
  type PhaseName,
  type PipelineHost,
  type SlotHandlers,
  type SlotName,
  SlotRegistry,
} from './pipeline';
import { escapeXmlAttribute } from './pipeline/xml';
import { Store } from './store/store';
import type { StorageBackend } from './store/types';
import { getContextToolDefinition } from './tools/contextTool';
import {
  type ContextToolCall,
  type ContextToolHost,
  dispatchContextTool,
  isContextToolName,
} from './tools/dispatch';
import {
  type ContextToolPolicy,
  type ContextToolPolicyConfig,
  resolveContextToolPolicy,
} from './tools/policy';
import type {
  AnthropicPayload,
  ChefLogger,
  CompileOptions,
  GeminiPayload,
  ITargetAdapter,
  Message,
  OpenAIPayload,
  TargetPayload,
  TargetProvider,
  ToolDefinition,
} from './types';
import { type EventHandler, TypedEventEmitter } from './utils/eventEmitter';
import { objectToXml } from './utils/xmlGenerator';
import { resolveVocabulary, type Vocabulary } from './vocabulary';

/**
 * Delivery channel for an announcement (see {@link ContextChef.announce}).
 *
 * - `'system'` — one `_positional` system message at the conversational tail.
 * - `'user_tail'` — folded into the tail stitch of the last user message.
 * - `'auto'` — resolved per compile target: `'system'` on the Anthropic target,
 *   `'user_tail'` everywhere else.
 */
export type AnnouncementChannel = 'auto' | 'system' | 'user_tail';

/** A standing capability announcement, as returned by {@link ContextChef.getAnnouncements}. */
export interface Announcement {
  readonly id: string;
  readonly content: string;
  readonly channel: AnnouncementChannel;
}

/**
 * Where the active skill's instructions are delivered.
 *
 * - `'after_system'` (default): a dedicated `role: 'system'` message right
 *   after the user system prompt. The instructions live in the cacheable
 *   prefix, but every activation / switch / deactivation rewrites that prefix
 *   and costs one full cache invalidation.
 * - `'tail'`: the instructions become the first element of the tail stitch,
 *   wrapped in `<skill_instructions skill="NAME">`. The cacheable prefix is
 *   never touched — the right trade for agents that switch modes frequently —
 *   at the cost of re-sending the instruction tokens in the uncacheable tail
 *   on every single request.
 */
export type SkillPlacement = 'after_system' | 'tail';

/**
 * Read-only snapshot of the current context, passed to the onBeforeCompile hook.
 */
export interface BeforeCompileContext {
  systemPrompt: readonly Message[];
  history: readonly Message[];
  dynamicState: readonly Message[];
  dynamicStateXml: string;
}

/**
 * Result of {@link ContextChef.checkToolCall}. Discriminated by `allowed`:
 * `reason` is mandatory exactly when the call was rejected, so consumers cannot
 * accidentally read it on an allowed call (or omit it on a rejection).
 */
export type ToolCallCheckResult = { allowed: true } | { allowed: false; reason: string };

/**
 * An immutable snapshot of ContextChef's full internal state.
 * Created by chef.snapshot() and consumed by chef.restore().
 */
export interface ChefSnapshot {
  readonly systemPrompt: Message[];
  readonly history: Message[];
  readonly dynamicState: Message[];
  readonly dynamicStatePlacement: DynamicStatePlacement;
  readonly dynamicStateXml: string;
  readonly modules: {
    readonly janitor: JanitorSnapshot;
    readonly memory: MemorySnapshot | null;
    readonly pruner: PrunerSnapshot;
  };
  /**
   * Name of the active skill at snapshot time.
   * On restore: re-resolved against the current skill registry. Skills are NOT
   * persisted in the snapshot — `registerSkills` must be called again before
   * `restore` if name-based re-activation is required.
   */
  readonly activeSkillName?: string;
  /**
   * Verbatim instructions of the active skill at snapshot time.
   * Persisted so the message-sandwich injection survives `restore()` even when
   * the skill registry is empty (e.g., a fresh `ContextChef` restoring an
   * older snapshot).
   */
  readonly skillInstructions?: string;
  /** Guardrail options active at snapshot time (withGuardrails). */
  readonly guardrailOptions?: GuardrailOptions;
  /**
   * Standing announcements at snapshot time, in insertion order. Optional for
   * backward compatibility: restoring a pre-announcement snapshot yields an
   * empty announcement set.
   */
  readonly announcements?: Announcement[];
  /**
   * The window the handoff notice had already been issued for at snapshot
   * time. The window lineage itself round-trips through the Janitor snapshot,
   * so without this the restored session is on a window it has already
   * noticed with the flag cleared, and repeats the notice every turn.
   */
  readonly handoffNoticedWindow?: string;
  readonly label?: string;
  readonly createdAt: number;
}

/**
 * Which library-owned tool set `compile()` puts in `payload.tools`.
 *
 * - `'legacy'` (default in 4.x): the Memory module's `create_memory` /
 *   `modify_memory`. `recall_context` and `new_context` stay opt-in — register
 *   them yourself.
 * - `'unified'`: one `context` tool covering every namespace, plus
 *   `new_context` when `overflow.handoff` is configured. The legacy memory
 *   tools are not emitted; the two sets never co-exist in one payload.
 *
 * The mode also picks the session's {@link Vocabulary}: under `'unified'`
 * every string the model reads — the memory instruction and memory block, the
 * offload truncation marker, the summary wrapper, the default handoff
 * notice — is written in `context://` addressing and names the `context` tool,
 * so the prompt never mentions a tool the payload does not carry.
 *
 * Tool names are dispatch keys in your agent loop, so the default cannot flip
 * in a minor release. It becomes `'unified'` in 5.0.
 */
export type ToolsMode = 'legacy' | 'unified';

/**
 * {@link MemoryConfig} with `store` optional: at the chef level a shared
 * {@link ChefConfig.store} can supply it instead.
 */
export type ChefMemoryConfig = Omit<MemoryConfig, 'store'> & { store?: MemoryConfig['store'] };

export interface ChefConfig {
  vfs?: Partial<VFSConfig>;
  janitor?: JanitorConfig;
  /**
   * Sink for degradation warnings across all modules. Defaults to `console`.
   * A module-level `logger` in `vfs` / `janitor` config wins over this one.
   */
  logger?: ChefLogger;
  pruner?: PrunerConfig;
  memory?: ChefMemoryConfig;
  /**
   * One storage substrate for every namespace: `memory` (Memory), `vfs` and
   * `archive` (Offloader + overflow), `notes` (the model's own scratch space).
   * Pass a {@link StorageBackend} — `InMemoryBackend`, `FileSystemBackend`, or
   * your own — or a pre-built {@link Store} when you want per-namespace
   * eviction or URI schemes.
   *
   * It fills in what nothing else specifies: an explicit `memory.store` wins
   * for memory, and an explicit `vfs.store` / `vfs.adapter` / `vfs.storageDir`
   * wins for the VFS. With neither set, today's defaults apply unchanged.
   *
   * @example
   * const backend = new InMemoryBackend();
   * new ContextChef({ store: backend, memory: {}, tools: 'unified' });
   */
  store?: StorageBackend | Store;
  /**
   * Which library-owned tools `compile()` emits. Defaults to `'legacy'` —
   * see {@link ToolsMode}.
   */
  tools?: ToolsMode;
  /**
   * Access policy for the unified `context` tool. Reading is always allowed;
   * `writable` lists the namespaces the model may change. Defaults to
   * `['memory', 'notes']`.
   *
   * Enforced when a call is dispatched, never in the store: the same store may
   * be written freely from your own code.
   */
  contextTool?: ContextToolPolicyConfig;
  /**
   * Where the active skill's instructions land. Defaults to `'after_system'`,
   * which is bit-for-bit compatible with pre-hot-plug behavior.
   *
   * `'after_system'` puts the instructions in the cacheable prefix — cheap to
   * re-send, but each activation or mode switch invalidates the whole cached
   * prefix. `'tail'` puts them at the head of the tail stitch instead: the
   * prefix survives every switch untouched, and in exchange the instruction
   * tokens are re-sent uncached on every request. Pick `'tail'` when the agent
   * switches skills often relative to how long each skill stays active.
   */
  skillPlacement?: SkillPlacement;
  /**
   * Lifecycle hook applied to the message array right before it's handed to the
   * Assembler. Use this to apply broad transformations like filtering, reordering,
   * or injecting messages programmatically. Runs after Janitor compression and
   * Memory injection.
   *
   * Contract: must not throw or reject. Errors propagate out of compile() — there
   * is no fallback path. Wrap your logic in try/catch and return the original
   * messages on failure.
   *
   * @deprecated Register on the `after-assemble` slot instead —
   * `chef.use('after-assemble', fn)`. This field is registered on that same
   * slot at construction (ahead of any later `use()` call) and keeps working
   * unchanged; it is removed in 5.0.
   */
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;
  /**
   * Uniform tool-result transform, applied to every `role: 'tool'` message at
   * the START of compile() — BEFORE compression, so the compression model and
   * every later stage see the transformed content. Use for auto-offloading
   * large results, PII redaction, or error-format normalization without
   * writing per-tool if/else chains in the agent loop.
   *
   * `info.toolName` is resolved from the preceding assistant turn's
   * `tool_calls` via `tool_call_id` (null when unresolvable).
   *
   * Contract: must not throw or reject. Errors propagate out of compile() —
   * return the original content on failure. Non-mutating: the stored history
   * is never modified.
   *
   * @example
   * transformToolResult: async (content, { toolName }) =>
   *   content.length > 5000 ? await chef.offloadAsync(content) : content,
   */
  transformToolResult?: (
    content: string,
    info: { toolName: string | null; toolCallId: string | null },
  ) => string | Promise<string>;
  /**
   * Lifecycle hook invoked before each compile(), after Janitor compression.
   * Use this to inject externally-retrieved context (RAG results, AST snippets, MCP queries, etc.)
   * without modifying the core message array directly.
   *
   * Return a string to inject as `<implicit_context>` alongside the dynamic state,
   * or null/undefined to skip injection. The returned content is placed at the same position
   * as dynamic state (last_user or system), preserving KV-Cache stability.
   *
   * Contract: must not throw or reject. Errors propagate out of compile() — return
   * null on failure to skip injection rather than throwing.
   *
   * @example
   * const chef = new ContextChef({
   *   onBeforeCompile: async (ctx) => {
   *     const snippets = await vectorDB.search(ctx.dynamicStateXml);
   *     return snippets.map(s => s.content).join('\n');
   *   },
   * });
   *
   * @deprecated Register on the `before-assemble` slot instead —
   * `chef.use('before-assemble', async (ctx) => ctx.inject(await retrieve(ctx)))`.
   * This field is registered on that same slot at construction (ahead of any
   * later `use()` call) and keeps working unchanged; it is removed in 5.0.
   */
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>;
  /**
   * Default adapter target used when `compile()` is called without an explicit
   * `target` option. Accepts a registered name (built-in or user-registered via
   * `adapterRegistry.register()`) or an `ITargetAdapter` instance.
   *
   * Resolution order in `compile()`:
   *   `options.target` → `defaultTarget` → `'openai'` (final fallback)
   */
  defaultTarget?: TargetProvider | ITargetAdapter;

  /**
   * When true, every compile targeting Anthropic runs
   * `auditAnthropicCachePlacement` on the produced payload and logs each
   * distinct issue ONCE per chef instance — volatile content (memory data,
   * dynamic state, guardrail instructions) sitting inside the cached prefix
   * silently invalidates prompt caching on every change. Anthropic-only:
   * it is the one provider with explicit breakpoints to audit against.
   * Zero cost on other targets. Default false.
   */
  cacheAudit?: boolean;
  /**
   * Dev-mode pipeline invariants. When true, `compile()` verifies after every
   * `after-assemble` handler that pinned messages survived and tool
   * call/result pairs are still paired, and after the tail phase that nothing
   * ahead of the tail insertion point changed.
   *
   * Violations are REPORTED, never enforced: each one goes to
   * `ChefConfig.logger` (or `console`) and to the `pipeline:invariant` event.
   * `compile()` never throws because of a check. Costs a snapshot + a
   * serialization pass per compile, so keep it off in production. Default false.
   */
  pipelineChecks?: boolean;
  /**
   * Where history compression happens:
   *
   * - `'client'` (default): ContextChef's Janitor compresses locally (today's
   *   behavior on every provider).
   * - `'server'`: compression is DELEGATED to the provider's server-side
   *   context management. The Janitor's LLM compression is skipped entirely
   *   (mechanical `compact()` and every other module still work), and on the
   *   Anthropic target the payload carries `context_management` + the
   *   matching `betas` headers. Compaction blocks returned by the API round-
   *   trip through `fromAnthropic` → history → compile verbatim (pinned).
   *
   * Rationale: providers now run compaction server-side (Anthropic
   * `compact_20260112`, OpenAI `/responses/compact`) — one model call fewer
   * and exact token accounting. What stays client-side is everything servers
   * don't do: tool pruning, skills, memory, VFS, dynamic state.
   */
  contextManagement?: {
    /**
     * @deprecated Use `overflow.strategy` — `'server'` is
     * `server(config, { fallback })`, `'client'` is the default. This field
     * builds exactly that and keeps working; it is removed in 5.0.
     */
    strategy: 'client' | 'server';
    /**
     * Provider-shaped edits config passed through verbatim, e.g. Anthropic
     * `{ edits: [{ type: 'compact_20260112', trigger: {...} }] }`. When
     * omitted under `'server'`, a default single `compact_20260112` edit is
     * emitted (server-side default trigger).
     *
     * @deprecated The first argument of `server()`.
     */
    server?: unknown;
  };
  /**
   * The overflow axis: what leaves the context window when it fills up, and
   * where it goes.
   *
   * `strategy` is the policy — `summarize()` (the default), `anchored()`,
   * `server()`, `reset()`, composed with `chain()` / `background()`, or your
   * own object. It REPLACES the deprecated `janitor.compression*` and
   * `contextManagement` fields, which describe the same thing in the old
   * vocabulary; setting both logs a warning and the strategy wins.
   *
   * `archive` is strategy-agnostic: whatever a strategy evicts is stored, and
   * the URI is cited in the summary that replaced it, so exact details stay
   * retrievable (pair with `getRecallToolDefinition()` + `chef.resolveRecall()`).
   * Pass `'vfs'` to store spans in this chef's VFS.
   *
   * @example
   * new ContextChef({
   *   janitor: { contextWindow: 128_000, tokenizer },
   *   overflow: {
   *     strategy: chain(summarize({ compressionModel }), reset()),
   *     archive: 'vfs',
   *   },
   * });
   */
  overflow?: {
    strategy?: OverflowStrategy;
    archive?: 'vfs' | CompressionArchiveConfig;
    /**
     * Tokens reserved above the compression trigger for a handoff notice: when
     * the headroom drops into that band, one compile carries a notice in its
     * tail telling the model its window is about to be cut, so state worth
     * keeping can be written to memory/notes while the conversation is still
     * there to write from. Once per window. Validated at construction.
     */
    handoff?: HandoffConfig;
  };
}

export type { CompiledTools, DynamicStatePlacement, GuardrailOptions, ResolvedToolCall, ToolGroup };

/**
 * Unified event map for ContextChef lifecycle notifications.
 *
 * Observation events (pure notification, do not affect control flow):
 * - `compile:start`  — emitted at the very start of compile()
 * - `compile:done`   — emitted after compile() produces the final payload
 * - `compress`       — emitted after Janitor compresses history
 * - `memory:changed` — emitted after any memory mutation (set, delete, expire)
 * - `memory:expired` — emitted when a memory entry expires during compile()
 *
 * Intercept hooks (can modify data / veto operations) remain as config callbacks:
 * - `onBeforeCompress` in JanitorConfig
 * - `onMemoryUpdate` in MemoryConfig
 * - `onBeforeCompile` / `transformContext` in ChefConfig
 */
export interface ChefEvents {
  'compile:start': {
    systemPrompt: readonly Message[];
    history: readonly Message[];
  };
  'compile:done': {
    payload: TargetPayload;
  };
  /** Budget exceeded — compression is about to run (before summarization). */
  'compress:start': {
    historyLength: number;
    currentTokens: number;
    limit: number;
  };
  /** Compression phase finished. `compressed: false` = budget was fine or the result was rejected. */
  'compress:end': {
    compressed: boolean;
  };
  compress: {
    summary: Message;
    truncatedCount: number;
    details: CompressionDetails;
  };
  /** Content was offloaded to the VFS (via chef.offload/offloadAsync or the compression archive). */
  'offload:created': {
    uri: string;
  };
  /** checkToolCall() rejected a tool call against the Pruner blocklist. */
  'pruner:tool-blocked': {
    name: string;
  };
  /**
   * A pipeline invariant was violated: a `ChefConfig.pipelineChecks` finding
   * (a slot handler dropped a pinned message, split a tool pair, or rewrote
   * content ahead of the tail insertion point), or a request the pipeline
   * could not honour — a `requestNewContext()` dropped because the target is
   * server-managed or a `before-overflow` handler vetoed the compile, which is
   * reported whatever `pipelineChecks` says. Reported only; compile()
   * continues.
   */
  'pipeline:invariant': {
    phase: PhaseName;
    message: string;
  };
  'memory:changed': MemoryChangeEvent;
  'memory:expired': MemoryEntry;
}

/**
 * Whether any deprecated overflow alias is set — the fields an explicit
 * `overflow.strategy` supersedes. `janitor.archive` is deliberately absent:
 * it maps to `overflow.archive`, which applies to every strategy.
 */
function usesOverflowAliases(config: ChefConfig, janitor: JanitorConfig): boolean {
  return Boolean(
    config.contextManagement?.strategy === 'server' ||
      janitor.compressionMode ||
      janitor.compressionScheduling ||
      janitor.compressionModel ||
      janitor.compressionGuidelines ||
      janitor.customCompressionInstructions ||
      janitor.minShrinkRatio !== undefined ||
      janitor.validateCompression ||
      janitor.preserveRatio !== undefined ||
      janitor.preserveRecentMessages !== undefined ||
      janitor.toolResultStubThreshold !== undefined,
  );
}

/**
 * The `contextManagement` block the pipeline reads, derived from the strategy
 * that was actually installed. The strategy is the single source of truth for
 * how overflow is handled, so it also decides whether the target is
 * server-managed — whichever of the three spellings configured it
 * (`overflow.strategy`, `janitor.strategy`, `contextManagement.strategy`).
 */
function resolveContextManagement(
  config: ChefConfig,
  strategy: OverflowStrategy,
): ChefConfig['contextManagement'] {
  if (isServerStrategy(strategy)) return { strategy: 'server', server: strategy.config };
  // An explicit strategy that is not `server()` says the client owns overflow,
  // whatever a leftover `contextManagement` block next to it says.
  return (config.overflow?.strategy ?? config.janitor?.strategy)
    ? undefined
    : config.contextManagement;
}

export class ContextChef {
  private assembler: Assembler;
  private offloader: Offloader;
  private janitor: Janitor;
  private guardrail: Guardrail;
  private pruner: Pruner;
  private memory: Memory | null;
  private transformToolResult?: ChefConfig['transformToolResult'];
  private defaultTarget?: TargetProvider | ITargetAdapter;
  private contextManagement?: ChefConfig['contextManagement'];
  private logger?: ChefLogger;
  private cacheAudit = false;
  private pipelineChecks = false;
  /**
   * Diagnostics already warned on this instance, keyed by kind (never by
   * position: as history grows the same misconfiguration drifts through
   * message indices, and a positional key would re-warn every compile and
   * grow the set unboundedly). The kind space is fixed, so the set is bounded.
   */
  private _warnedOnce = new Set<string>();
  /** Slot handlers, including the ones the legacy config hooks register. */
  private readonly _slots = new SlotRegistry();
  /** The validated handoff budget, or undefined when none is configured. */
  private readonly _handoff?: Required<HandoffConfig>;
  /**
   * The window the handoff notice has already been issued for. Compared by id
   * rather than counted, so the "once" resets exactly when the window the
   * notice talked about is gone.
   */
  private _handoffNoticedWindow?: string;
  /** A pending {@link requestNewContext}, consumed by the next compile. */
  private _forceOverflow = false;
  /** The shared context store from `ChefConfig.store`, if one was passed. */
  private readonly _store?: Store;
  private readonly _toolsMode: ToolsMode;
  /**
   * The model-facing wording of this session, resolved once from
   * {@link _toolsMode} and handed to every module that renders: memory
   * shaping, the Offloader's truncation marker, the Janitor's summary
   * wrapper, and the handoff notice.
   */
  private readonly _vocabulary: Vocabulary;
  private readonly _contextToolPolicy: ContextToolPolicy;
  /**
   * The `tools: 'unified'` definitions, built once. Frozen and
   * reference-stable, so `payload.tools` stays deep-equal across compiles.
   */
  private readonly _unifiedTools: readonly ToolDefinition[];
  /** The dispatcher's view of this chef, built once (see {@link ContextToolHost}). */
  private readonly _contextToolHost: ContextToolHost;
  /** The pipeline's view of this chef, built once (see {@link PipelineHost}). */
  private readonly _host: PipelineHost;
  /**
   * Serializes compile() calls on this instance (Snapshot + Serialize model):
   * concurrent callers queue instead of interleaving the mutable state a
   * compile pass holds across await points.
   */
  private _compileChain: Promise<unknown> = Promise.resolve();
  /** True while _compileInner runs — lets re-entrant compile() calls (from
   *  hooks/event handlers) bypass the queue instead of deadlocking on it. */
  private _compiling = false;
  /**
   * Per-source-message cache for transformToolResult, keyed by the ORIGINAL
   * history message. Keeps transformed message objects stable across
   * compiles (same source content → same output object), which (a) avoids
   * re-running the transform over old tool results on every compile and
   * (b) preserves object identity for identity-sensitive consumers like the
   * Janitor's background-compression staleness check.
   */
  private _toolTransformCache = new WeakMap<Message, { source: string; transformed: Message }>();
  /** Guardrail options stored by withGuardrails(); applied during compile(). */
  private _guardrailOptions?: GuardrailOptions;
  private emitter: TypedEventEmitter<ChefEvents>;

  /**
   * Cancellation signal for the in-flight compile() call. Set in compile()
   * entry, cleared in finally. Exposed only to event-bridge closures (Janitor
   * onCompress, Memory onMemoryChanged / onMemoryExpired) so events fired
   * during compile() receive the caller's AbortSignal even though those bridges
   * are constructed once at chef creation time. Null outside compile().
   */
  private _currentSignal?: AbortSignal;

  private systemPrompt: Message[] = [];
  private history: Message[] = [];
  private dynamicState: Message[] = [];
  private dynamicStatePlacement: DynamicStatePlacement = 'last_user';
  private dynamicStateXml: string = '';

  // Skill state. Independent of Pruner — activateSkill() does NOT call any Pruner method.
  private _registeredSkills: Skill[] = [];
  private _activeSkill: Skill | undefined;
  private _skillInstructions: string = '';
  private skillPlacement: SkillPlacement = 'after_system';

  /**
   * Standing announcements, keyed by id. A Map because rendering order is the
   * insertion order and re-setting an existing key keeps its position, which
   * is exactly the upsert semantics announce() promises.
   */
  private _announcements = new Map<string, Announcement>();

  constructor(config: ChefConfig = {}) {
    this.emitter = new TypedEventEmitter<ChefEvents>(config.logger);
    this.assembler = new Assembler();
    this._store = config.store ? Store.from(config.store) : undefined;
    // The tools mode picks the vocabulary, and the vocabulary is what every
    // module below renders in — so both are settled before anything is built.
    this._toolsMode = config.tools ?? 'legacy';
    this._vocabulary = resolveVocabulary(this._toolsMode);
    this.offloader = new Offloader({
      ...this._resolveVfsConfig(config),
      vocabulary: this._vocabulary,
    });
    this.guardrail = new Guardrail();
    this.pruner = new Pruner(config.pruner);
    this.transformToolResult = config.transformToolResult;
    this.defaultTarget = config.defaultTarget;
    this.logger = config.logger;
    this.cacheAudit = config.cacheAudit ?? false;
    this.pipelineChecks = config.pipelineChecks ?? false;
    this.skillPlacement = config.skillPlacement ?? 'after_system';
    this._contextToolPolicy = resolveContextToolPolicy(config.contextTool);
    // Before anything is wired: a handoff budget that cannot work is a config
    // error, and it should surface at the line that wrote it. An unset prompt
    // takes the vocabulary's notice rather than the legacy constant.
    this._handoff = config.overflow?.handoff
      ? validateHandoffConfig(
          config.overflow.handoff.prompt === undefined
            ? { ...config.overflow.handoff, prompt: this._vocabulary.handoffNotice }
            : config.overflow.handoff,
        )
      : undefined;

    // Legacy lifecycle hooks are slot registrations — one code path, no second
    // idiom. Registering here puts them ahead of anything the caller adds
    // later with use(), which is the order they used to run in.
    if (config.onBeforeCompile) {
      const hook = config.onBeforeCompile;
      this._slots.use('before-assemble', async (context) => {
        const injected = await hook(context);
        if (injected) context.inject(injected);
      });
    }
    if (config.transformContext) {
      this._slots.use('after-assemble', config.transformContext);
    }

    if (config.contextManagement?.strategy === 'server' && config.janitor?.compressionModel) {
      (config.logger ?? console).warn(
        "[context-chef] contextManagement.strategy 'server' is configured together with a " +
          'janitor.compressionModel. Server-side compaction wins — the client-side compression ' +
          "model will never run. Remove one of the two (or switch strategy to 'client').",
      );
    }

    // Bridge Janitor's onCompress callback to the unified event system
    const janitorConfig = config.janitor ?? { contextWindow: Infinity };
    const userOnCompress = janitorConfig.onCompress;
    const userOnBeforeCompress = janitorConfig.onBeforeCompress;
    const strategy = this._resolveOverflowStrategy(config, janitorConfig);
    // `server()` as the overflow strategy says the same thing to the pipeline
    // as `contextManagement: { strategy: 'server' }`: the start phase resolves
    // the server-managed target from it, the adapt phase reads the edits
    // config out of it. One source, whichever way it was configured — read off
    // the resolved strategy so `janitor.strategy` is not a third opinion.
    this.contextManagement = resolveContextManagement(config, strategy);
    // The Janitor's own version of this diagnostic can never fire for a
    // chef-built runner — it is always handed a resolved strategy — so the
    // call is made here, against the config the user actually wrote.
    if (
      !janitorConfig.tokenizer &&
      !janitorConfig.compressionModel &&
      !config.overflow?.strategy &&
      !janitorConfig.strategy
    ) {
      this._warnOnce('no-compression-model', NO_COMPRESSION_MODEL_WARNING);
    }
    // The 'vfs' archive shorthand stores evicted spans in this chef's VFS.
    // Substituted here because only the facade holds the Offloader.
    const configuredArchive = config.overflow?.archive ?? janitorConfig.archive;
    const archive =
      configuredArchive === 'vfs'
        ? {
            store: async (serialized: string): Promise<string> => {
              // threshold 0 forces storage regardless of size; head/tail 0
              // because only the URI is used (no inline preview needed).
              const result = await this.offloader.offloadAsync(serialized, {
                threshold: 0,
                headChars: 0,
                tailChars: 0,
              });
              if (!result.isOffloaded || !result.uri) {
                throw new Error('VFS archive store failed: content was not offloaded');
              }
              await this.emitter.emit('offload:created', { uri: result.uri }, this._currentSignal);
              return result.uri;
            },
          }
        : configuredArchive;
    this.janitor = new Janitor({
      logger: config.logger,
      ...janitorConfig,
      vocabulary: this._vocabulary,
      archive,
      strategy,
      onCompress: async (summary, truncatedCount, details) => {
        if (userOnCompress) await userOnCompress(summary, truncatedCount, details);
        await this.emitter.emit(
          'compress',
          { summary, truncatedCount, details },
          this._currentSignal,
        );
      },
      onBeforeCompress: async (history, tokenInfo) => {
        await this.emitter.emit(
          'compress:start',
          {
            historyLength: history.length,
            currentTokens: tokenInfo.currentTokens,
            limit: tokenInfo.limit,
          },
          this._currentSignal,
        );
        return userOnBeforeCompress ? userOnBeforeCompress(history, tokenInfo) : null;
      },
    });

    // Bridge Memory's notification callbacks to the unified event system
    if (config.memory) {
      const userOnChanged = config.memory.onMemoryChanged;
      const userOnExpired = config.memory.onMemoryExpired;
      const memoryStore = config.memory.store ?? this._store;
      if (!memoryStore) {
        throw new Error(
          '[context-chef] memory is configured without a store. Pass `memory: { store }`, ' +
            'or a shared `store` on ChefConfig for memory, the VFS and the archive to share.',
        );
      }
      this.memory = new Memory({
        ...config.memory,
        store: memoryStore,
        onMemoryChanged: async (event) => {
          if (userOnChanged) await userOnChanged(event);
          await this.emitter.emit('memory:changed', event, this._currentSignal);
        },
        onMemoryExpired: async (entry) => {
          if (userOnExpired) await userOnExpired(entry);
          await this.emitter.emit('memory:expired', entry, this._currentSignal);
        },
      });
    } else {
      this.memory = null;
    }

    // `new_context` only makes sense when something is watching the budget for
    // the model; the handoff notice is that something.
    this._unifiedTools = Object.freeze(
      this._handoff
        ? [getContextToolDefinition(), getNewContextToolDefinition()]
        : [getContextToolDefinition()],
    );
    this._contextToolHost = this._createContextToolHost();
    this._host = this._createPipelineHost();
  }

  /**
   * The VFS config the Offloader is built from. An explicit `vfs.store`,
   * `vfs.adapter` or `vfs.storageDir` is a deliberate choice of storage for
   * offloaded content and wins; otherwise a shared `ChefConfig.store` backs
   * the `vfs` (and, in 4.x, archive) namespace too.
   */
  private _resolveVfsConfig(config: ChefConfig): Partial<VFSConfig> {
    const vfs: Partial<VFSConfig> = { logger: config.logger, ...config.vfs };
    const explicit = config.vfs?.store ?? config.vfs?.adapter ?? config.vfs?.storageDir;
    if (this._store && !explicit) vfs.store = this._store;
    return vfs;
  }

  /**
   * The installed overflow policy.
   *
   * `overflow.strategy` wins outright: the deprecated `janitor.compression*`
   * and `contextManagement` fields describe a strategy in the old vocabulary,
   * and two descriptions of one thing would silently disagree. With none of
   * them set this is `summarize()` built from the janitor options — the 4.x
   * default, unchanged.
   */
  private _resolveOverflowStrategy(
    config: ChefConfig,
    janitorConfig: JanitorConfig,
  ): OverflowStrategy {
    const explicit = config.overflow?.strategy ?? janitorConfig.strategy;
    if (explicit) {
      if (usesOverflowAliases(config, janitorConfig)) {
        this._warnOnce(
          'overflow-alias-conflict',
          '[context-chef] overflow.strategy is configured together with the deprecated ' +
            'janitor.compression* / contextManagement options. The strategy wins — those ' +
            'options are ignored. Move them into the strategy factory (summarize({ ... })).',
        );
      }
      return explicit;
    }

    const client = resolveOverflowStrategy(janitorConfig);
    // Strategy 'server' keeps its v4 meaning: the provider compacts where it
    // can, the client-side policy runs everywhere else.
    return config.contextManagement?.strategy === 'server'
      ? server(config.contextManagement.server, { fallback: client })
      : client;
  }

  /** Logs `message` the first time `kind` is seen on this instance. */
  private _warnOnce(kind: string, message: string): void {
    if (this._warnedOnce.has(kind)) return;
    this._warnedOnce.add(kind);
    (this.logger ?? console).warn(message);
  }

  /**
   * The dispatcher's view of this chef. Same shape as {@link _createPipelineHost}:
   * live accessors over private fields, one stable object.
   */
  private _createContextToolHost(): ContextToolHost {
    const chef = this;
    return {
      get memory() {
        return chef.memory;
      },
      get offloader() {
        return chef.offloader;
      },
      get store() {
        return chef.getStore();
      },
      get policy() {
        return chef._contextToolPolicy;
      },
      requestNewContext() {
        chef.requestNewContext();
      },
    };
  }

  /**
   * The pipeline's view of this chef: every accessor reads live state, so the
   * phases work against current values while the fields above stay `private`.
   * Built once — the object identity is stable for the chef's lifetime.
   */
  private _createPipelineHost(): PipelineHost {
    // `this` inside the object literal's methods and getters is the literal,
    // not the chef — the alias is what gives them access to the instance.
    const chef = this;
    return {
      get systemPrompt() {
        return chef.systemPrompt;
      },
      get history() {
        return chef.history;
      },
      get dynamicState() {
        return chef.dynamicState;
      },
      get dynamicStateXml() {
        return chef.dynamicStateXml;
      },
      get dynamicStatePlacement() {
        return chef.dynamicStatePlacement;
      },
      get defaultTarget() {
        return chef.defaultTarget;
      },
      get contextManagement() {
        return chef.contextManagement;
      },
      get transformToolResult() {
        return chef.transformToolResult;
      },
      get toolTransformCache() {
        return chef._toolTransformCache;
      },
      get cacheAudit() {
        return chef.cacheAudit;
      },
      get pipelineChecks() {
        return chef.pipelineChecks;
      },
      get slots() {
        return chef._slots;
      },
      get assembler() {
        return chef.assembler;
      },
      get guardrail() {
        return chef.guardrail;
      },
      get guardrailOptions() {
        return chef._guardrailOptions;
      },
      get memory() {
        return chef.memory;
      },
      get skill() {
        return {
          name: chef._activeSkill?.name,
          instructions: chef._skillInstructions,
          placement: chef.skillPlacement,
        };
      },
      emit(event, payload, signal) {
        return chef.emitter.emit(event, payload, signal);
      },
      get window() {
        return chef.janitor.window;
      },
      get handoff() {
        return chef._handoff;
      },
      overflow(history, signal, force) {
        return chef.janitor.overflow(history, { signal, force });
      },
      readBudget(history) {
        return chef.janitor.readBudget(history);
      },
      takeForcedOverflow() {
        const forced = chef._forceOverflow;
        chef._forceOverflow = false;
        return forced;
      },
      handoffNoticedWindow() {
        return chef._handoffNoticedWindow;
      },
      markHandoffNoticed(windowId) {
        chef._handoffNoticedWindow = windowId;
      },
      shapeMemoryParts(dataXml, injectedMemoryKeys) {
        return chef._shapeMemorySandwichParts(dataXml, injectedMemoryKeys);
      },
      resolveAnnouncementChannels(isAnthropicTarget, extra) {
        return chef._resolveAnnouncementChannels(isAnthropicTarget, extra);
      },
      prunerTools() {
        return chef._getPrunerTools();
      },
      get toolsMode() {
        return chef._toolsMode;
      },
      contextTools() {
        // Fresh array, same frozen definition objects — the caller may reorder
        // its copy without the payload's identity drifting between compiles.
        return [...chef._unifiedTools];
      },
      warnOnce(kind, message) {
        chef._warnOnce(kind, message);
      },
      hasWarned(kind) {
        return chef._warnedOnce.has(kind);
      },
      async reportInvariant(phase, message, signal) {
        (chef.logger ?? console).warn(`[context-chef] pipeline invariant (${phase}): ${message}`);
        await chef.emitter.emit('pipeline:invariant', { phase, message }, signal);
      },
    };
  }

  // ─── Event System ──────────────────────────────────────────────────────

  /**
   * Subscribe to a lifecycle event.
   *
   * Handlers receive an optional `AbortSignal` as the second argument when the
   * event was triggered by a `compile({ signal })` call. Long-running async work
   * inside a handler should forward this signal to honor cooperative cancellation
   * (fetch, DB clients, Anthropic SDK all accept `signal`). Memory events fired
   * outside of compile() (from direct `memory().set()` / `delete()`) get
   * `signal: undefined`.
   *
   * @example
   * chef.on('compress', ({ summary, truncatedCount }) => {
   *   console.log(`Compressed ${truncatedCount} messages`);
   * });
   *
   * chef.on('compile:done', async ({ payload }, signal) => {
   *   await db.write(payload, { signal });
   * });
   */
  public on<K extends keyof ChefEvents>(event: K, handler: EventHandler<ChefEvents[K]>): this {
    this.emitter.on(event, handler);
    return this;
  }

  /**
   * Unsubscribe from a lifecycle event.
   */
  public off<K extends keyof ChefEvents>(event: K, handler: EventHandler<ChefEvents[K]>): this {
    this.emitter.off(event, handler);
    return this;
  }

  // ─── Pipeline Slots ────────────────────────────────────────────────────

  /**
   * Registers a handler on a compile-pipeline slot. Slots are the composition
   * surface events cannot cover: unlike `on()`, a slot handler participates in
   * the compile — it can inject context, transform the assembled messages, or
   * skip the overflow phase.
   *
   * Handlers run in registration order and are awaited one after another. The
   * legacy config hooks (`onBeforeCompile`, `transformContext`) are registered
   * on this same registry at construction, so they always run first.
   *
   * Errors are NOT isolated (unlike event handlers): a throwing slot handler
   * fails the compile. Wrap your logic in try/catch if that is not what you
   * want.
   *
   * @example
   * chef.use('before-assemble', async (ctx) => {
   *   ctx.inject(await vectorDB.search(ctx.dynamicStateXml));
   * });
   * chef.use('after-adapt', (payload) => metrics.record(payload));
   */
  public use<S extends SlotName>(slot: S, handler: SlotHandlers[S]): this {
    this._slots.use(slot, handler);
    return this;
  }

  /**
   * Removes one registration of `handler` from `slot`. Registering the same
   * function twice requires two `unuse` calls.
   */
  public unuse<S extends SlotName>(slot: S, handler: SlotHandlers[S]): this {
    this._slots.unuse(slot, handler);
    return this;
  }

  /**
   * Sets the static system prompt layer.
   * This layer is deeply frozen to ensure KV-Cache stability.
   */
  public setSystemPrompt(messages: Message[]): this {
    this.systemPrompt = [...messages];
    return this;
  }

  /**
   * Sets the conversation history.
   * Compression runs automatically on compile() via the Janitor.
   */
  public setHistory(history: Message[]): this {
    this.history = [...history];
    return this;
  }

  /**
   * Strongly typed dynamic state injection.
   * Converts the structured state into XML tags which are highly optimized for LLM comprehension.
   *
   * @param placement
   *   - `'last_user'` (default, recommended): Injects the state into the last user message
   *     in the conversation. This leverages the LLM's Recency Bias for maximum attention,
   *     preventing "Lost in the Middle" state drift in long conversations.
   *   - `'system'`: Injects as a standalone system message at the bottom of the sandwich.
   *     Suitable for short conversations or global configuration that doesn't need recency boost.
   */
  public setDynamicState<T>(
    schema: z.ZodType<T>,
    state: T,
    options?: { placement?: DynamicStatePlacement },
  ): this {
    const parsedState = schema.parse(state);
    const xml = objectToXml(parsedState, 'dynamic_state');

    this.dynamicStatePlacement = options?.placement ?? 'last_user';
    this.dynamicStateXml = xml;

    if (this.dynamicStatePlacement === 'system') {
      this.dynamicState = [{ role: 'system', content: `CURRENT TASK STATE:\n${xml}` }];
    } else {
      // For 'last_user', we don't create a standalone message here.
      // The injection happens during compile() when we have the full message array.
      this.dynamicState = [];
    }

    return this;
  }

  /**
   * Sets the Guardrail rules for subsequent compile() calls.
   * If a specific `target` is provided during `compile()`, it will elegantly degrade prefill.
   *
   * Replace semantics: each call REPLACES the previous options (no
   * accumulation); pass `null` to clear. Application is deferred to
   * `compile()`, so call order relative to `setDynamicState` no longer
   * matters (pre-4.0, calling `setDynamicState` after `withGuardrails`
   * silently discarded the guardrail). The enforce-XML instruction and
   * prefill land at the very end of the sandwich, closest to generation.
   */
  public withGuardrails(options: GuardrailOptions | null): this {
    this._guardrailOptions = options ? structuredClone(options) : undefined;
    return this;
  }

  /**
   * Registers flat tools with the Pruner (legacy/simple mode).
   */
  public registerTools(tools: ToolDefinition[]): this {
    this.pruner.registerTools(tools);
    return this;
  }

  /**
   * Registers tool groups as stable namespace tools (Layer 1).
   * Each group becomes a single tool with an action enum.
   * The tool list never changes across turns — KV-Cache stable.
   */
  public registerNamespaces(groups: ToolGroup[]): this {
    this.pruner.registerNamespaces(groups);
    return this;
  }

  /**
   * Registers toolkits for on-demand lazy loading (Layer 2).
   * These appear as a lightweight directory in the system prompt.
   * The LLM requests full schemas via `load_toolkit` when needed.
   */
  public registerToolkits(toolkits: ToolGroup[]): this {
    this.pruner.registerToolkits(toolkits);
    return this;
  }

  /**
   * Feeds an externally-reported token count into the Janitor.
   * Call this after each LLM response with the token usage reported by the API.
   * On the next compile(), if this value exceeds contextWindow, compression is triggered.
   *
   * @example
   * const response = await openai.chat.completions.create({ ... });
   * chef.reportTokenUsage(response.usage.prompt_tokens);
   */
  public reportTokenUsage(tokenCount: number): this {
    this.janitor.feedTokenUsage(tokenCount);
    return this;
  }

  /**
   * Returns the Pruner instance for direct access to all tool management strategies.
   *
   * @example
   * // Flat mode
   * const { tools } = chef.getPruner().pruneByTask("read and analyze a file");
   *
   * // Namespace + Lazy Loading
   * const { tools, directoryXml } = chef.getPruner().compile();
   */
  public getPruner(): Pruner {
    return this.pruner;
  }

  /**
   * Dispatch-time gate against the Pruner's blocklist.
   *
   * Call this for every tool call returned by the LLM before invoking the tool.
   * Returns `{ allowed: true }` when the tool is not blocked, otherwise
   * `{ allowed: false, reason }` where `reason` is a structured rejection string
   * that can be surfaced back to the LLM as a tool error message.
   *
   * Does not modify any state and does not consult Skill annotations — the blocklist
   * is the single source of truth (see Pruner.setBlockedTools).
   *
   * @example
   * for (const call of response.tool_calls) {
   *   const check = chef.checkToolCall(call);
   *   if (!check.allowed) {
   *     history.push({ role: 'tool', tool_call_id: call.id, content: check.reason });
   *     continue;
   *   }
   *   // ... dispatch
   * }
   */
  public checkToolCall(toolCall: { name: string }): ToolCallCheckResult {
    // Defensive guard: SDK adapters and malformed LLM output occasionally
    // produce tool-call shapes whose `name` violates the type signature.
    // Refuse rather than silently letting them past the gate.
    if (typeof toolCall?.name !== 'string' || toolCall.name === '') {
      return {
        allowed: false,
        reason: 'Tool call rejected: missing or empty tool name.',
      };
    }
    const blocked = this.pruner.getBlockedTools();
    if (blocked.includes(toolCall.name)) {
      // Fire-and-forget observation event (checkToolCall is sync by contract).
      void this.emitter.emit('pruner:tool-blocked', { name: toolCall.name }, this._currentSignal);
      return {
        allowed: false,
        reason: `Tool "${toolCall.name}" is currently blocked.`,
      };
    }
    return { allowed: true };
  }

  // ─── Library-owned tools ───────────────────────────────────────────────

  /**
   * Whether `name` is a tool this chef dispatches: `context`, `new_context`,
   * and the legacy `create_memory` / `modify_memory` / `recall_context`.
   *
   * Independent of `ChefConfig.tools` — the mode decides what `compile()`
   * EMITS, not what `handleTool` understands. A migration that emits `context`
   * while the model still occasionally reaches for a legacy name works, and so
   * does the reverse.
   *
   * @example
   * for (const call of response.tool_calls) {
   *   if (chef.ownsTool(call.function.name)) {
   *     const content = await chef.handleTool({
   *       name: call.function.name,
   *       arguments: call.function.arguments,
   *     });
   *     history.push({ role: 'tool', tool_call_id: call.id, content });
   *     continue;
   *   }
   *   // ... your own tools
   * }
   */
  public ownsTool(name: string): boolean {
    return typeof name === 'string' && isContextToolName(name);
  }

  /**
   * Runs one library-owned tool call and returns the text to hand back as the
   * tool result. `arguments` may be the JSON string the OpenAI and Anthropic
   * SDKs produce or an already-parsed object (Anthropic `input`, Gemini
   * `args`) — both are accepted.
   *
   * Model-facing mistakes never throw: an unknown path, a missing argument, a
   * write to a read-only namespace and a veto from `onMemoryUpdate` all come
   * back as `Error: …` text the model can read and correct. Only a tool name
   * this chef does not own throws — guard with {@link ownsTool}.
   */
  public handleTool(call: ContextToolCall): Promise<string> {
    if (!this.ownsTool(call?.name)) {
      throw new Error(
        `[context-chef] chef.handleTool('${call?.name}') — this chef does not own that tool. ` +
          'Guard the call with chef.ownsTool(name) and dispatch the rest yourself.',
      );
    }
    return dispatchContextTool(this._contextToolHost, call);
  }

  // ─── Skill API ─────────────────────────────────────────────────────────
  //
  // Skill is fully decoupled from Pruner. None of these methods touch
  // `this.pruner` — they only manage the active-skill instructions slot
  // and the optional name-based registry.

  /**
   * Register a set of skills the chef can later activate by name. Replaces any
   * previously registered set. Stores defensive copies so caller mutations do
   * not bleed in.
   */
  public registerSkills(skills: Skill[]): this {
    this._registeredSkills = skills.map((s) => structuredClone(s));
    return this;
  }

  /**
   * Returns a defensive copy of the registered skill list.
   */
  public getRegisteredSkills(): Skill[] {
    return this._registeredSkills.map((s) => structuredClone(s));
  }

  /**
   * Activate a skill as a standing "mode" instruction (the system-slot delivery).
   * For progressive disclosure of many skills, append rendered skills as messages
   * host-side instead — see docs/skill-recipes.md.
   *
   * Pass:
   *   - a Skill object   → activated directly (does not need to be registered)
   *   - a string         → resolved by name from `registerSkills`; throws if not found
   *   - null             → clears the active skill and instructions slot
   *
   * On activation the skill's `instructions` are placed into the message
   * sandwich on the next `compile()` as a dedicated `{ role: 'system' }`
   * message — or, under `ChefConfig.skillPlacement: 'tail'`, at the head of
   * the tail stitch instead. Pruner state is NOT touched (Skill ⊥ Pruner).
   */
  public activateSkill(skill: Skill | string | null): this {
    if (skill === null) {
      this._activeSkill = undefined;
      this._skillInstructions = '';
      return this;
    }

    let resolved: Skill;
    if (typeof skill === 'string') {
      const found = this._registeredSkills.find((s) => s.name === skill);
      if (!found) {
        const available = this._registeredSkills.map((s) => s.name).join(', ') || '(none)';
        throw new Error(
          `ContextChef.activateSkill: no skill named "${skill}" is registered. Available: ${available}.`,
        );
      }
      resolved = found;
    } else {
      resolved = skill;
    }

    this._activeSkill = structuredClone(resolved);
    this._skillInstructions = resolved.instructions ?? '';
    return this;
  }

  /**
   * Returns the currently-active skill, or undefined if none is active.
   * Returns a defensive copy.
   */
  public getActiveSkill(): Skill | undefined {
    return this._activeSkill ? structuredClone(this._activeSkill) : undefined;
  }

  // ─── Announcements ─────────────────────────────────────────────────────

  /**
   * Announce a mid-session capability change (tools or skills added, withdrawn,
   * re-scoped) to the model.
   *
   * An announcement is a statement of CURRENT state, not a one-shot event: it
   * is re-rendered into EVERY compile until {@link retractAnnouncement} removes
   * it. That is the point — ContextChef's injections never persist into the
   * caller's history, so a retracted announcement disappears completely from
   * subsequent payloads instead of lingering as an obsolete turn the model
   * keeps re-reading.
   *
   * Upsert by `id`: re-announcing the same id replaces the content and channel
   * while keeping the original insertion position, so the rendered block stays
   * stable as announcements are updated.
   *
   * Wording: state facts, do not command. "Tools newly available: read_file,
   * grep" and "web_search has been withdrawn; calls to it will be rejected"
   * read as system state; "You must now use read_file" reads as an instruction
   * competing with the system prompt.
   *
   * Detecting the delta is userland policy, not chef mechanism:
   *
   * @example
   * const added = next.filter((t) => !prev.has(t));
   * const removed = [...prev].filter((t) => !next.includes(t));
   * if (added.length) chef.announce('tools:added', `Tools newly available: ${added.join(', ')}`);
   * else chef.retractAnnouncement('tools:added');
   * if (removed.length) {
   *   chef.announce('tools:removed', `Withdrawn; calls will be rejected: ${removed.join(', ')}`);
   * }
   */
  public announce(id: string, content: string, options?: { channel?: AnnouncementChannel }): this {
    // Map.set on an existing key overwrites in place, keeping insertion order.
    this._announcements.set(id, { id, content, channel: options?.channel ?? 'auto' });
    return this;
  }

  /**
   * Removes a standing announcement. Returns true when one was removed.
   * The next compile() carries no trace of it.
   */
  public retractAnnouncement(id: string): boolean {
    return this._announcements.delete(id);
  }

  /** Current standing announcements, in insertion order. */
  public getAnnouncements(): ReadonlyArray<Announcement> {
    return [...this._announcements.values()].map((a) => ({ ...a }));
  }

  /**
   * Wraps announcements in the shared `<announcements>` block. Returns '' for
   * an empty list so callers can treat the result as a presence check.
   */
  private _renderAnnouncements(list: Announcement[]): string {
    if (list.length === 0) return '';
    const items = list.map(
      (a) => `<announcement id="${escapeXmlAttribute(a.id)}">\n${a.content}\n</announcement>`,
    );
    return `<announcements>\n${items.join('\n\n')}\n</announcements>`;
  }

  /**
   * Splits standing announcements by their effective channel for one compile.
   *
   * `'auto'` routes by TARGET only — chef does not know the model id. The
   * Anthropic target gets `'system'` because mid-conversation system messages
   * leave the cached prefix intact and carry operator precedence; every other
   * target gets `'user_tail'`. Anthropic models WITHOUT mid-conversation system
   * support (Sonnet 5) must therefore pass `channel: 'user_tail'` explicitly —
   * mechanism, not policy.
   */
  private _resolveAnnouncementChannels(
    isAnthropicTarget: boolean,
    extra: readonly Announcement[] = [],
  ): {
    systemXml: string;
    tailXml: string;
  } {
    // `extra` is this compile's own (the handoff notice) — rendered last, and
    // never part of the standing set.
    const all = [...this._announcements.values(), ...extra];
    const autoChannel: Exclude<AnnouncementChannel, 'auto'> = isAnthropicTarget
      ? 'system'
      : 'user_tail';
    const resolved = all.map((a) => (a.channel === 'auto' ? autoChannel : a.channel));
    return {
      systemXml: this._renderAnnouncements(all.filter((_, i) => resolved[i] === 'system')),
      tailXml: this._renderAnnouncements(all.filter((_, i) => resolved[i] === 'user_tail')),
    };
  }

  /**
   * Returns the Memory instance for direct access to memory operations.
   * Requires `memory` to be configured in ChefConfig.
   *
   * @example
   * await chef.getMemory().createMemory('project_rules', 'Always use strict TypeScript');
   * await chef.getMemory().deleteMemory('outdated_rule');
   */
  public getMemory(): Memory {
    if (!this.memory) {
      throw new Error(
        'ContextChef.getMemory() called but no memory config was provided. ' +
          'Pass `memory: { store: ... }` to the ContextChef constructor — ' +
          'see the Memory section in the README for store options ' +
          '(InMemoryStore, VFSMemoryStore, or your own MemoryStore implementation).',
      );
    }
    return this.memory;
  }

  /**
   * Returns the underlying Offloader for advanced operations like cleanup() and reconcile().
   *
   * @example
   * await chef.getOffloader().cleanupAsync();   // sweep expired/over-cap entries
   * await chef.getOffloader().reconcileAsync(); // adopt orphan files after restart
   */
  public getOffloader(): Offloader {
    return this.offloader;
  }

  /**
   * The context store every namespace is addressed through — the shared
   * `ChefConfig.store` when one was passed, otherwise the Offloader's own.
   *
   * This is where the `context` tool reads and writes `notes/` and anything
   * else outside `memory/`; use it to seed notes before a run, or to inspect
   * what the model wrote after one.
   *
   * @example
   * await chef.getStore().namespace('notes').put('plan.md', '# Plan\n');
   */
  public getStore(): Store {
    return this._store ?? this.offloader.store;
  }

  /**
   * Offload large content to VFS, returning a truncated string with a pointer URI.
   * Throws an error if the configured VFS storage adapter is asynchronous.
   */
  public offload(content: string, options?: OffloadOptions): string {
    const result = this.offloader.offload(content, options);
    if (result.isOffloaded && result.uri) {
      void this.emitter.emit('offload:created', { uri: result.uri }, this._currentSignal);
    }
    return result.content;
  }

  /**
   * Async version of offload(). Required when using an asynchronous VFS storage adapter.
   */
  public async offloadAsync(content: string, options?: OffloadOptions): Promise<string> {
    const result = await this.offloader.offloadAsync(content, options);
    if (result.isOffloaded && result.uri) {
      await this.emitter.emit('offload:created', { uri: result.uri }, this._currentSignal);
    }
    return result.content;
  }

  /**
   * Resolves a `context://` URI back to its full stored content — offloaded
   * tool output or an archived compressed span (see `JanitorConfig.archive`).
   * Returns null when the URI is unknown. Pair with
   * {@link getRecallToolDefinition} to let the model request retrieval.
   *
   * `format: 'text'` renders an archived span as a readable transcript instead
   * of the `{ version, messages }` JSON the archive stores — worth the swap
   * when the result goes straight back to the model as a tool result. Any
   * other payload (an offloaded tool output, a caller-written archive entry)
   * is returned unchanged in both modes. Defaults to `'raw'`.
   */
  public async resolveRecall(uri: string, options?: ResolveRecallOptions): Promise<string | null> {
    const stored = await this.offloader.resolveAsync(uri);
    if (stored === null || (options?.format ?? 'raw') === 'raw') return stored;
    return renderRecalledContent(stored);
  }

  /**
   * Shapes the per-turn memory artifacts that {@link compile} injects into the
   * sandwich, from a single-read {@link Memory.compileArtifacts} result.
   *
   * Behavior depends on {@link MemoryConfig.memoryPlacement}:
   * - `'after_system'` (default): the stable instruction and the volatile
   *   `<memory>` data are folded into a single `role: 'system'` message at the
   *   top of the sandwich. `tailDataXml` is empty. Bit-for-bit compatible with
   *   pre-3.5 behavior.
   * - `'before_history_tail'`: the instruction stays as a `role: 'system'`
   *   message at the top; the data block is returned via `tailDataXml` for the
   *   Assembler to append to the last user message. The volatile text never
   *   enters the top-level system parameter on Anthropic/Gemini, so cache
   *   breakpoints earlier in the message stream survive memory mutations.
   *
   * The wording of both parts comes from the session's {@link Vocabulary}:
   * under `tools: 'unified'` memory is one namespace of the context store, so
   * the instruction describes the store and the block addresses its keys as
   * `context://memory/<key>`.
   */
  private _shapeMemorySandwichParts(
    dataXml: string,
    injectedMemoryKeys: string[],
  ): { topMessages: Message[]; tailDataXml: string } {
    if (!this.memory) return { topMessages: [], tailDataXml: '' };

    // The key guidance lists the SELECTED (visible) keys only. A selector is
    // the caller's visibility policy: enumerating every live key here would
    // defeat its token control (hundreds of key names per compile) and —
    // under 'after_system' — rewrite the top system block on mutations the
    // selector deliberately never injects, re-introducing the cache
    // invalidation this placement exists to avoid. Keys a selector hides
    // stay modifiable anyway: the dispatcher validates at call time.
    const instruction = this._vocabulary.memoryInstruction;
    const dataBlock = dataXml
      ? this._vocabulary.memoryBlock(dataXml, injectedMemoryKeys, this.memory.allowedKeys)
      : '';

    if (this.memory.placement === 'after_system') {
      const content = dataBlock ? `${instruction}\n\n${dataBlock}` : instruction;
      return { topMessages: [{ role: 'system', content }], tailDataXml: '' };
    }

    // 'before_history_tail': instruction at top, volatile data at tail
    return {
      topMessages: [{ role: 'system', content: instruction }],
      tailDataXml: dataBlock,
    };
  }

  /**
   * Returns tools from the Pruner if any are registered.
   * Namespace/lazy mode takes priority over flat mode.
   */
  private _getPrunerTools(): ToolDefinition[] {
    const { tools } = this.pruner.compile();
    if (tools.length > 0) return tools;
    return this.pruner.getAllTools();
  }

  /**
   * Requests a new context window: the next `compile()` applies the overflow
   * strategy whatever the budget says, instead of waiting for the trigger.
   *
   * This is the model-facing side of the overflow axis — dispatch a
   * `new_context` tool call (see `getNewContextToolDefinition()`) here when
   * the model decides a chunk of work is finished and its details no longer
   * need to be in front of it.
   *
   * What "new window" means is whatever the installed strategy does:
   * `summarize()` leaves a summary, `reset()` leaves a stub, `archive` keeps
   * the span retrievable either way. Unlike {@link clearHistory} this does not
   * discard the conversation behind the library's back — the strategy is still
   * the one deciding what survives, and a `before-overflow` handler can still
   * veto it.
   *
   * The request is consumed by one compile, whether or not the window actually
   * changed (a strategy may decline; the circuit breaker may be open). Call it
   * again if it must be retried.
   */
  public requestNewContext(): this {
    this._forceOverflow = true;
    return this;
  }

  /**
   * Explicitly clears the conversation history and resets Janitor state.
   * Use when the developer knows it's time to "start fresh" — e.g., user requests a new topic,
   * or an Agent completes an independent sub-task phase.
   * This provides more direct control than waiting for Janitor's automatic token-based compression.
   *
   * Announcements survive: they describe the CURRENT capability set, which a
   * fresh conversation still needs. Retract them explicitly via
   * {@link retractAnnouncement} when the capability change no longer holds.
   */
  public clearHistory(): this {
    this.history = [];
    this.janitor.reset();
    return this;
  }

  /**
   * Captures an immutable snapshot of the current context state.
   * Use before risky operations (tool calls, branching) to enable rollback.
   *
   * @example
   * const snap = chef.snapshot('before tool execution');
   * // ... risky operations ...
   * chef.restore(snap); // roll back if needed
   */
  public snapshot(label?: string): ChefSnapshot {
    return {
      systemPrompt: structuredClone(this.systemPrompt),
      history: structuredClone(this.history),
      dynamicState: structuredClone(this.dynamicState),
      dynamicStatePlacement: this.dynamicStatePlacement,
      dynamicStateXml: this.dynamicStateXml,
      modules: {
        janitor: this.janitor.snapshotState(),
        memory: this.memory?.snapshot() ?? null,
        pruner: this.pruner.snapshotState(),
      },
      activeSkillName: this._activeSkill?.name,
      // Persist verbatim only when a skill is actually active. Guards against
      // the `'' || undefined` trap that would silently drop an active skill
      // whose instructions happen to be empty.
      skillInstructions: this._activeSkill ? this._skillInstructions : undefined,
      guardrailOptions: this._guardrailOptions
        ? structuredClone(this._guardrailOptions)
        : undefined,
      announcements: [...this._announcements.values()].map((a) => ({ ...a })),
      handoffNoticedWindow: this._handoffNoticedWindow,
      label,
      createdAt: Date.now(),
    };
  }

  /**
   * Restores ContextChef to a previously captured snapshot.
   * All state — including Janitor compression flags — is rolled back.
   *
   * Skills are NOT persisted in the snapshot itself, so the active skill is
   * re-resolved against the current registry by name. When the snapshot
   * carries `skillInstructions` they are restored verbatim, ensuring the
   * compile()-time instructions slot survives even when the registry is
   * empty (e.g., a fresh chef restoring an old snapshot).
   */
  public restore(snapshot: ChefSnapshot): this {
    this.systemPrompt = structuredClone(snapshot.systemPrompt);
    this.history = structuredClone(snapshot.history);
    this.dynamicState = structuredClone(snapshot.dynamicState);
    this.dynamicStatePlacement = snapshot.dynamicStatePlacement;
    this.dynamicStateXml = snapshot.dynamicStateXml;
    this._guardrailOptions = snapshot.guardrailOptions
      ? structuredClone(snapshot.guardrailOptions)
      : undefined;
    // Pre-announcement snapshots have no `announcements` field — restoring one
    // clears the set rather than leaving the previous chef's announcements live.
    this._announcements = new Map(
      (Array.isArray(snapshot.announcements) ? snapshot.announcements : []).map((a) => [
        a.id,
        { ...a },
      ]),
    );
    // Restored together with the lineage the flag is compared against: a
    // snapshot from before this field simply had not noticed anything yet.
    this._handoffNoticedWindow = snapshot.handoffNoticedWindow;
    this.janitor.restoreState(snapshot.modules.janitor);
    if (snapshot.modules.memory && this.memory) {
      this.memory.restore(snapshot.modules.memory);
    }
    this.pruner.restoreState(snapshot.modules.pruner);

    // Skill restoration. Two slots (`_activeSkill` and `_skillInstructions`)
    // must always agree on which instructions are live, so they are written
    // together from the same source:
    //   1. Registry hit → both come from the registry (authoritative; matches
    //      whatever the developer just registered, even if the snapshot's
    //      persisted instructions are stale).
    //   2. Registry miss but persisted instructions exist → synthesize a
    //      degenerate stub so the message-sandwich injection survives.
    //   3. Otherwise → no active skill.
    const name = snapshot.activeSkillName ?? undefined;
    const persistedInstructions = snapshot.skillInstructions ?? undefined;
    if (name) {
      const fromRegistry = this._registeredSkills.find((s) => s.name === name);
      if (fromRegistry) {
        this._activeSkill = structuredClone(fromRegistry);
        this._skillInstructions = fromRegistry.instructions;
      } else if (persistedInstructions !== undefined) {
        this._activeSkill = { name, description: '', instructions: persistedInstructions };
        this._skillInstructions = persistedInstructions;
      } else {
        this._activeSkill = undefined;
        this._skillInstructions = '';
      }
    } else {
      this._activeSkill = undefined;
      this._skillInstructions = '';
    }
    return this;
  }

  /**
   * Compiles the final deterministic payload ready for the LLM SDK.
   * Triggers Janitor compression if history exceeds configured token/message limits.
   * Leverages TargetAdapters to conform strictly to provider requirements.
   * Registered tools are automatically included in the returned payload.
   *
   * Target resolution order:
   *   1. `options.target` — per-call override (string name or `ITargetAdapter` instance)
   *   2. `ChefConfig.defaultTarget` — instance-wide default set at construction
   *   3. `'openai'` — final built-in fallback (kept for backward compatibility)
   *
   * **Concurrency model: per-instance.** A chef is single-threaded by design —
   * it holds mutable state across `await` points (`_currentSignal`, memory turn
   * counter, janitor circuit breaker, skill fields, history references), so
   * two `compile()` calls running concurrently on the same instance corrupt
   * each other. Canonical pattern is one chef per concurrent caller (e.g. per
   * HTTP request); see the "Concurrency Model" section in README. To share a
   * chef across calls, serialize them with chained `await`.
   */
  public async compile(options: { target: 'openai'; signal?: AbortSignal }): Promise<OpenAIPayload>;
  public async compile(options: {
    target: 'anthropic';
    signal?: AbortSignal;
  }): Promise<AnthropicPayload>;
  public async compile(options: { target: 'gemini'; signal?: AbortSignal }): Promise<GeminiPayload>;
  public async compile(options: {
    target: ITargetAdapter;
    signal?: AbortSignal;
  }): Promise<TargetPayload>;
  public async compile(options: { target: string; signal?: AbortSignal }): Promise<TargetPayload>;
  public async compile(options?: CompileOptions): Promise<TargetPayload>;
  public async compile(options?: CompileOptions): Promise<TargetPayload> {
    // Re-entrancy: a hook or event handler running INSIDE a compile may call
    // compile() again (e.g. compiling a sub-payload). Queueing that inner
    // call behind the outer unfinished one would deadlock — run it inline
    // instead; it executes within the lock the outer call already holds.
    if (this._compiling) {
      return this._compileInner(options);
    }
    // Snapshot + Serialize: queue behind any in-flight compile on this
    // instance (a failed predecessor does not poison the chain).
    const run = () => this._compileInner(options);
    const result = this._compileChain.then(run, run);
    this._compileChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async _compileInner(options?: CompileOptions): Promise<TargetPayload> {
    const signal = options?.signal;
    // Stash signal so event-bridge closures (Janitor.onCompress, Memory.onMemoryChanged,
    // Memory.onMemoryExpired) can forward it to handlers. The PREVIOUS value
    // is restored in finally rather than cleared: a re-entrant inner compile
    // must not leave the remainder of the outer compile signal-less (for the
    // outermost call the previous value is undefined, so restore == clear).
    const prevSignal = this._currentSignal;
    this._currentSignal = signal;
    // Only the OUTERMOST call clears the flag: a re-entrant inner compile
    // (hook calling compile() — the bypass in compile()) must leave it set,
    // or a second inner call after the first would queue and deadlock.
    // Without any reset (the pre-4.1 bug), every compile after the first
    // took the bypass and the Snapshot + Serialize queue was dead.
    //
    // Known limit of the boolean: while the outermost compile is awaiting, a
    // genuinely CONCURRENT external compile() call also sees the flag and
    // runs inline instead of queueing. The queue is defensive hardening —
    // the canonical concurrency model remains one chef per concurrent caller
    // (see the Concurrency section in the README).
    const isOutermostCompile = !this._compiling;
    this._compiling = true;
    try {
      const ctx = new CompileContext({
        options: options ?? {},
        signal,
        history: this.history,
        // The runner's lineage, by reference: an overflow inside this compile
        // moves it, and the phases after `overflow` must see where it moved to.
        window: this.janitor.window,
      });
      for (const phase of COMPILE_PHASES) {
        await phase.run(ctx, this._host);
        // Abort points are per-phase rather than uniform: these are the
        // boundaries that follow an await which can take arbitrarily long
        // (compression model, memory store, user hooks). `start` and
        // `transform-tool-results` check inside the phase instead.
        if (ABORT_AFTER_PHASE.has(phase.name)) signal?.throwIfAborted();
      }
      return ctx.requirePayload();
    } finally {
      this._currentSignal = prevSignal;
      if (isOutermostCompile) this._compiling = false;
    }
  }
}
