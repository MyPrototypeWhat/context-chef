import type { z } from 'zod';
import { adapterRegistry } from './adapters/adapterRegistry';
import { Assembler, type DynamicStatePlacement } from './modules/assembler';
import { Guardrail, type GuardrailOptions } from './modules/guardrail';
import {
  type CompressionDetails,
  Janitor,
  type JanitorConfig,
  type JanitorSnapshot,
} from './modules/janitor';
import {
  Memory,
  type MemoryChangeEvent,
  type MemoryConfig,
  type MemoryEntry,
  type MemorySnapshot,
} from './modules/memory';
import { Offloader, type OffloadOptions, type VFSConfig } from './modules/offloader';
import {
  type CompiledTools,
  Pruner,
  type PrunerConfig,
  type PrunerSnapshot,
  type ResolvedToolCall,
  type ToolGroup,
} from './modules/pruner';
import type { Skill } from './modules/skill';
import { Prompts } from './prompts';
import type {
  AnthropicPayload,
  ChefLogger,
  CompileMeta,
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

export {
  AdapterFactory,
  AdapterRegistry,
  adapterRegistry,
  getAdapter,
  type ITargetAdapter,
} from './adapters/adapterFactory';
export { fromAnthropic } from './adapters/anthropicAdapter';
export { fromGemini } from './adapters/geminiAdapter';
export { fromOpenAI } from './adapters/openAIAdapter';
export { Assembler } from './modules/assembler';
export { Guardrail } from './modules/guardrail';
export {
  type CompressionDetails,
  groupIntoTurns,
  Janitor,
  type JanitorConfig,
  type JanitorSnapshot,
  type Turn,
} from './modules/janitor';
export {
  Memory,
  type MemoryChangeEvent,
  type MemoryConfig,
  type MemoryEntry,
  type MemoryPlacement,
  type MemorySetOptions,
  type MemorySnapshot,
  type TTLValue,
} from './modules/memory';
export { InMemoryStore } from './modules/memory/inMemoryStore';
export type { MemoryStore, MemoryStoreEntry } from './modules/memory/memoryStore';
export { VFSMemoryStore } from './modules/memory/vfsMemoryStore';
export {
  type CleanupOptions,
  FileSystemAdapter,
  Offloader,
  type OffloadOptions,
  VFSCleanupNotSupportedError,
  type VFSCleanupResult,
  type VFSConfig,
  type VFSEntryMeta,
  type VFSEvictionReason,
  type VFSStorageAdapter,
} from './modules/offloader';
export { Pruner, type PrunerConfig, type PrunerSnapshot } from './modules/pruner';
export {
  type FormatSkillListingOptions,
  formatSkillListing,
  type LoadSkillsDirsOptions,
  loadSkill,
  loadSkillsDir,
  loadSkillsDirs,
  type RenderSkillOptions,
  renderSkill,
  type Skill,
  type SkillLoadResult,
} from './modules/skill';
export * from './prompts';
export type { ChefLogger, ClearTarget, CompactOptions } from './types';
export * from './types';
export { ensureValidHistory } from './utils/ensureValidHistory';
export { type EventHandler, TypedEventEmitter } from './utils/eventEmitter';
export { TokenUtils } from './utils/tokenUtils';
export { XmlGenerator } from './utils/xmlGenerator';

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
 * An immutable snapshot of ContextChef's full internal state.
 * Created by chef.snapshot() and consumed by chef.restore().
 */
/**
 * Result of {@link ContextChef.checkToolCall}. Discriminated by `allowed`:
 * `reason` is mandatory exactly when the call was rejected, so consumers cannot
 * accidentally read it on an allowed call (or omit it on a rejection).
 */
export type ToolCallCheckResult = { allowed: true } | { allowed: false; reason: string };

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
  readonly label?: string;
  readonly createdAt: number;
}

export interface ChefConfig {
  vfs?: Partial<VFSConfig>;
  janitor?: JanitorConfig;
  /**
   * Sink for degradation warnings across all modules. Defaults to `console`.
   * A module-level `logger` in `vfs` / `janitor` config wins over this one.
   */
  logger?: ChefLogger;
  pruner?: PrunerConfig;
  memory?: MemoryConfig;
  /**
   * Lifecycle hook applied to the message array right before it's handed to the
   * Assembler. Use this to apply broad transformations like filtering, reordering,
   * or injecting messages programmatically. Runs after Janitor compression and
   * Memory injection.
   *
   * Contract: must not throw or reject. Errors propagate out of compile() — there
   * is no fallback path. Wrap your logic in try/catch and return the original
   * messages on failure.
   */
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;
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
 * - `onBudgetExceeded` in JanitorConfig
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
  compress: {
    summary: Message;
    truncatedCount: number;
    details: CompressionDetails;
  };
  'memory:changed': MemoryChangeEvent;
  'memory:expired': MemoryEntry;
}

export class ContextChef {
  private assembler: Assembler;
  private offloader: Offloader;
  private janitor: Janitor;
  private guardrail: Guardrail;
  private pruner: Pruner;
  private memory: Memory | null;
  private transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;
  private onBeforeCompile?: (
    context: BeforeCompileContext,
  ) => string | null | Promise<string | null>;
  private defaultTarget?: TargetProvider | ITargetAdapter;
  private emitter = new TypedEventEmitter<ChefEvents>();

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

  constructor(config: ChefConfig = {}) {
    this.assembler = new Assembler();
    this.offloader = new Offloader({ logger: config.logger, ...config.vfs });
    this.guardrail = new Guardrail();
    this.pruner = new Pruner(config.pruner);
    this.transformContext = config.transformContext;
    this.onBeforeCompile = config.onBeforeCompile;
    this.defaultTarget = config.defaultTarget;

    // Bridge Janitor's onCompress callback to the unified event system
    const janitorConfig = config.janitor ?? { contextWindow: Infinity };
    const userOnCompress = janitorConfig.onCompress;
    this.janitor = new Janitor({
      logger: config.logger,
      ...janitorConfig,
      onCompress: async (summary, truncatedCount, details) => {
        if (userOnCompress) await userOnCompress(summary, truncatedCount, details);
        await this.emitter.emit(
          'compress',
          { summary, truncatedCount, details },
          this._currentSignal,
        );
      },
    });

    // Bridge Memory's notification callbacks to the unified event system
    if (config.memory) {
      const userOnChanged = config.memory.onMemoryChanged;
      const userOnExpired = config.memory.onMemoryExpired;
      this.memory = new Memory({
        ...config.memory,
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
   * Applies the Guardrail's rules.
   * If a specific `target` is provided during `compile()`, it will elegantly degrade prefill.
   */
  public withGuardrails(options: GuardrailOptions): this {
    this.dynamicState = this.guardrail.apply(this.dynamicState, options);
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
      return {
        allowed: false,
        reason: `Tool "${toolCall.name}" is currently blocked.`,
      };
    }
    return { allowed: true };
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
   * message. Pruner state is NOT touched (Skill ⊥ Pruner).
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
   * Offload large content to VFS, returning a truncated string with a pointer URI.
   * Throws an error if the configured VFS storage adapter is asynchronous.
   */
  public offload(content: string, options?: OffloadOptions): string {
    const result = this.offloader.offload(content, options);
    return result.content;
  }

  /**
   * Async version of offload(). Required when using an asynchronous VFS storage adapter.
   */
  public async offloadAsync(content: string, options?: OffloadOptions): Promise<string> {
    const result = await this.offloader.offloadAsync(content, options);
    return result.content;
  }

  /**
   * Builds the per-turn memory artifacts that {@link compile} injects into the sandwich.
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
   * Consolidates what was previously two `getSelectedEntries()` round-trips
   * (one for the XML, one for `injectedMemoryKeys`) into a single read.
   */
  private async _buildMemorySandwichParts(): Promise<{
    topMessages: Message[];
    tailDataXml: string;
    injectedMemoryKeys: string[];
  }> {
    if (!this.memory) {
      return { topMessages: [], tailDataXml: '', injectedMemoryKeys: [] };
    }

    const selected = await this.memory.getSelectedEntries();
    const injectedMemoryKeys = selected.map((e) => e.key);

    let dataBlock = '';
    if (selected.length > 0) {
      const xml = await this.memory.toXml();
      dataBlock = Prompts.getMemoryBlock(xml, injectedMemoryKeys, this.memory.allowedKeys);
    }

    if (this.memory.placement === 'after_system') {
      const content = dataBlock
        ? `${Prompts.MEMORY_INSTRUCTION}\n\n${dataBlock}`
        : Prompts.MEMORY_INSTRUCTION;
      return {
        topMessages: [{ role: 'system', content }],
        tailDataXml: '',
        injectedMemoryKeys,
      };
    }

    // 'before_history_tail': instruction at top, volatile data at tail
    return {
      topMessages: [{ role: 'system', content: Prompts.MEMORY_INSTRUCTION }],
      tailDataXml: dataBlock,
      injectedMemoryKeys,
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
   * Explicitly clears the conversation history and resets Janitor state.
   * Use when the developer knows it's time to "start fresh" — e.g., user requests a new topic,
   * or an Agent completes an independent sub-task phase.
   * This provides more direct control than waiting for Janitor's automatic token-based compression.
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
    const signal = options?.signal;
    // Stash signal so event-bridge closures (Janitor.onCompress, Memory.onMemoryChanged,
    // Memory.onMemoryExpired) can forward it to handlers. Cleared in finally.
    this._currentSignal = signal;
    try {
      // 0. Emit compile:start (unconditional — observers may want to log even
      //    aborted compiles. throwIfAborted runs immediately after so the
      //    expensive Janitor phase is skipped on a pre-aborted signal.)
      await this.emitter.emit(
        'compile:start',
        {
          systemPrompt: this.systemPrompt,
          history: this.history,
        },
        signal,
      );
      signal?.throwIfAborted();

      // 1. Janitor: Compress history if needed
      const compressedHistory = await this.janitor.compress(this.history);
      signal?.throwIfAborted();

      // 2. onBeforeCompile hook: inject external context (RAG, AST, MCP, etc.)
      let implicitContextXml = '';
      if (this.onBeforeCompile) {
        const injected = await this.onBeforeCompile({
          systemPrompt: this.systemPrompt,
          history: compressedHistory,
          dynamicState: this.dynamicState,
          dynamicStateXml: this.dynamicStateXml,
        });
        if (injected) {
          implicitContextXml = `<implicit_context>\n${injected}\n</implicit_context>`;
        }
      }
      signal?.throwIfAborted();

      // 3. For system placement, append implicit_context directly to the dynamic state message
      //    (Assembler only handles last_user injection)
      let dynamicState = this.dynamicState;
      if (
        implicitContextXml &&
        this.dynamicStatePlacement === 'system' &&
        dynamicState.length > 0
      ) {
        dynamicState = dynamicState.map((msg) =>
          msg.content.includes('CURRENT TASK STATE')
            ? { ...msg, content: `${msg.content}\n${implicitContextXml}` }
            : msg,
        );
      }

      // 4. Memory: sweep expired entries, then advance turn counter
      let memoryExpiredKeys: string[] = [];
      let injectedMemoryKeys: string[] = [];
      if (this.memory) {
        memoryExpiredKeys = await this.memory.sweepExpired();
        this.memory.advanceTurn();
      }
      // sweepExpired() awaits per-entry onMemoryExpired hooks, so handler
      // latency adds up before the next throwIfAborted at step 7. Caveat:
      // turn counter has already advanced; aborting here means TTL state
      // diverges from payload state. Documented in CompileOptions.signal.
      signal?.throwIfAborted();

      // 5. Memory: build sandwich parts (top instruction + optional tail data)
      //    `_buildMemorySandwichParts` consolidates the previously-duplicated
      //    `getSelectedEntries()` calls into a single read and returns:
      //      - `topMessages`: system message(s) that always sit at the top
      //      - `tailDataXml`: volatile <memory> block to inject at user tail
      //                       (empty unless memoryPlacement === 'before_history_tail')
      //      - `injectedMemoryKeys`: meta for the compile() return payload
      const memoryParts = await this._buildMemorySandwichParts();
      const memoryMessages = memoryParts.topMessages;
      const memoryTailDataXml = memoryParts.tailDataXml;
      injectedMemoryKeys = memoryParts.injectedMemoryKeys;

      // 5b. Skill instructions slot — single dedicated system message between
      //     userSystemPrompt and memoryMessages. NOT appended to user system
      //     so the cache breakpoint stays clean and LLM attribution is direct.
      const skillMessages: Message[] =
        this._skillInstructions.length > 0
          ? [{ role: 'system', content: this._skillInstructions }]
          : [];

      // 6. Sandwich assembly
      let messages = [
        ...this.systemPrompt,
        ...skillMessages,
        ...memoryMessages,
        ...compressedHistory,
        ...dynamicState,
      ];

      // 7. Transform hook
      if (this.transformContext) {
        messages = await this.transformContext(messages);
      }
      signal?.throwIfAborted();

      // 8. Assembler: tail injection (volatile content closest to LLM generation
      //    point) + deterministic key ordering. The stitch is composed in a fixed
      //    inner order — memory data, dynamic state, implicit context, anchor —
      //    so callers reading the final user message can rely on the layout.
      const tailParts: string[] = [];
      if (memoryTailDataXml) {
        tailParts.push(memoryTailDataXml);
      }
      if (this.dynamicStatePlacement === 'last_user') {
        let dynamicTailAdded = false;
        if (this.dynamicStateXml) {
          tailParts.push(this.dynamicStateXml);
          dynamicTailAdded = true;
        }
        if (implicitContextXml) {
          tailParts.push(implicitContextXml);
          dynamicTailAdded = true;
        }
        // The anchor refers specifically to dynamic state / implicit context.
        // Memory data already self-introduces via `Prompts.MEMORY_BLOCK_HEADER`
        // ("You recall the following from previous conversations:"), so a second
        // anchor for memory-only tail injections is redundant and reads as noise
        // to the model. If `MEMORY_BLOCK_HEADER` is ever changed or removed in
        // `prompts.ts`, this suppression rule needs to be re-evaluated.
        if (dynamicTailAdded) {
          tailParts.push('Above is the current system state. Use it to guide your next action.');
        }
      }
      const tailXml = tailParts.join('\n\n');
      const rawPayload = this.assembler.compile(messages, {
        tailXml: tailXml || undefined,
      });

      const target = options?.target ?? this.defaultTarget ?? 'openai';
      const adapter = typeof target === 'string' ? adapterRegistry.get(target) : target;
      const adapterPayload = adapter.compile([...rawPayload.messages]);

      const prunerTools = this._getPrunerTools();
      const memoryTools = this.memory ? await this.memory.getToolDefinitions() : [];
      const tools = [...prunerTools, ...memoryTools];
      const meta: CompileMeta = { injectedMemoryKeys, memoryExpiredKeys };
      if (this._activeSkill) meta.activeSkillName = this._activeSkill.name;
      const payload: TargetPayload = { ...adapterPayload, meta };
      if (tools.length > 0) payload.tools = tools;

      // 9. Emit compile:done
      await this.emitter.emit('compile:done', { payload }, signal);

      return payload;
    } finally {
      this._currentSignal = undefined;
    }
  }
}
