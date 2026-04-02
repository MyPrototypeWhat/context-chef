import type { z } from 'zod';
import { getAdapter } from './adapters/adapterFactory';
import { Assembler, type DynamicStatePlacement } from './modules/assembler';
import { Guardrail, type GuardrailOptions } from './modules/guardrail';
import { Janitor, type JanitorConfig, type JanitorSnapshot } from './modules/janitor';
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
import { Prompts } from './prompts';
import type {
  AnthropicPayload,
  CompileOptions,
  GeminiPayload,
  Message,
  OpenAIPayload,
  TargetPayload,
  ToolDefinition,
} from './types';
import { type EventHandler, TypedEventEmitter } from './utils/eventEmitter';
import { objectToXml } from './utils/xmlGenerator';

export { AdapterFactory, getAdapter, type ITargetAdapter } from './adapters/adapterFactory';
export { type AssembleOptions, Assembler } from './modules/assembler';
export { Guardrail } from './modules/guardrail';
export {
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
  type MemorySetOptions,
  type MemorySnapshot,
  type TTLValue,
} from './modules/memory';
export { InMemoryStore } from './modules/memory/inMemoryStore';
export type { MemoryStore, MemoryStoreEntry } from './modules/memory/memoryStore';
export { VFSMemoryStore } from './modules/memory/vfsMemoryStore';
export {
  FileSystemAdapter,
  Offloader,
  type OffloadOptions,
  type VFSConfig,
  type VFSStorageAdapter,
} from './modules/offloader';
export { Pruner, type PrunerConfig, type PrunerSnapshot } from './modules/pruner';
export * from './prompts';
export type { ClearTarget, CompactOptions } from './types';
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
  readonly label?: string;
  readonly createdAt: number;
}

export interface ChefConfig {
  vfs?: Partial<VFSConfig>;
  janitor?: JanitorConfig;
  pruner?: PrunerConfig;
  memory?: MemoryConfig;
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
   * @example
   * const chef = new ContextChef({
   *   onBeforeCompile: async (ctx) => {
   *     const snippets = await vectorDB.search(ctx.dynamicStateXml);
   *     return snippets.map(s => s.content).join('\n');
   *   },
   * });
   */
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>;
}

export type { GuardrailOptions, ToolGroup, CompiledTools, ResolvedToolCall, DynamicStatePlacement };

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
  private emitter = new TypedEventEmitter<ChefEvents>();

  private systemPrompt: Message[] = [];
  private history: Message[] = [];
  private dynamicState: Message[] = [];
  private dynamicStatePlacement: DynamicStatePlacement = 'last_user';
  private dynamicStateXml: string = '';

  constructor(config: ChefConfig = {}) {
    this.assembler = new Assembler();
    this.offloader = new Offloader(config.vfs);
    this.guardrail = new Guardrail();
    this.pruner = new Pruner(config.pruner);
    this.transformContext = config.transformContext;
    this.onBeforeCompile = config.onBeforeCompile;

    // Bridge Janitor's onCompress callback to the unified event system
    const janitorConfig = config.janitor ?? { contextWindow: Infinity };
    const userOnCompress = janitorConfig.onCompress;
    this.janitor = new Janitor({
      ...janitorConfig,
      onCompress: async (summary, truncatedCount) => {
        if (userOnCompress) await userOnCompress(summary, truncatedCount);
        await this.emitter.emit('compress', { summary, truncatedCount });
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
          await this.emitter.emit('memory:changed', event);
        },
        onMemoryExpired: async (entry) => {
          if (userOnExpired) await userOnExpired(entry);
          await this.emitter.emit('memory:expired', entry);
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
   * @example
   * chef.on('compress', ({ summary, truncatedCount }) => {
   *   console.log(`Compressed ${truncatedCount} messages`);
   * });
   *
   * chef.on('compile:done', ({ payload }) => {
   *   metrics.track('compile', { messageCount: payload.messages.length });
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
   * Returns the Memory instance for direct access to memory operations.
   * Requires `memory` to be configured in ChefConfig.
   *
   * @example
   * await chef.getMemory().createMemory('project_rules', 'Always use strict TypeScript');
   * await chef.getMemory().deleteMemory('outdated_rule');
   */
  public getMemory(): Memory {
    if (!this.memory) {
      throw new Error('ContextChef: getMemory() requires a memoryStore in ChefConfig.');
    }
    return this.memory;
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

  private async _getMemoryMessages(): Promise<Message[]> {
    if (!this.memory) return [];

    let content = Prompts.MEMORY_INSTRUCTION;

    const selected = await this.memory.getSelectedEntries();
    if (selected.length > 0) {
      const xml = await this.memory.toXml();
      const keys = selected.map((e) => e.key);
      content = `${content}\n\n${Prompts.getMemoryBlock(xml, keys, this.memory.allowedKeys)}`;
    }

    return [{ role: 'system', content }];
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
      label,
      createdAt: Date.now(),
    };
  }

  /**
   * Restores ContextChef to a previously captured snapshot.
   * All state — including Janitor compression flags — is rolled back.
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
    return this;
  }

  /**
   * Compiles the final deterministic payload ready for the LLM SDK.
   * Triggers Janitor compression if history exceeds configured token/message limits.
   * Leverages TargetAdapters to conform strictly to provider requirements.
   * Registered tools are automatically included in the returned payload.
   */
  public async compile(options: { target: 'openai' }): Promise<OpenAIPayload>;
  public async compile(options: { target: 'anthropic' }): Promise<AnthropicPayload>;
  public async compile(options: { target: 'gemini' }): Promise<GeminiPayload>;
  public async compile(options?: CompileOptions): Promise<TargetPayload>;
  public async compile(options?: CompileOptions): Promise<TargetPayload> {
    // 0. Emit compile:start
    await this.emitter.emit('compile:start', {
      systemPrompt: this.systemPrompt,
      history: this.history,
    });

    // 1. Janitor: Compress history if needed
    const compressedHistory = await this.janitor.compress(this.history);

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

    // 3. For system placement, append implicit_context directly to the dynamic state message
    //    (Assembler only handles last_user injection)
    let dynamicState = this.dynamicState;
    if (implicitContextXml && this.dynamicStatePlacement === 'system' && dynamicState.length > 0) {
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

    // 5. Core Memory injection (between systemPrompt and history)
    const memoryMessages = await this._getMemoryMessages();
    if (this.memory) {
      injectedMemoryKeys = (await this.memory.getSelectedEntries()).map((e) => e.key);
    }

    // 6. Sandwich assembly
    let messages = [...this.systemPrompt, ...memoryMessages, ...compressedHistory, ...dynamicState];

    // 7. Transform hook
    if (this.transformContext) {
      messages = await this.transformContext(messages);
    }

    // 8. Assembler: Dynamic state injection (if last_user) + deterministic key ordering
    const stitchXml = [this.dynamicStateXml, implicitContextXml].filter(Boolean).join('\n');
    const rawPayload = this.assembler.compile(messages, {
      dynamicStateXml: stitchXml || undefined,
      placement: this.dynamicStatePlacement,
    });

    const target = options?.target ?? 'openai';
    const adapter = getAdapter(target);
    const adapterPayload = adapter.compile([...rawPayload.messages]);

    const prunerTools = this._getPrunerTools();
    const memoryTools = this.memory ? await this.memory.getToolDefinitions() : [];
    const tools = [...prunerTools, ...memoryTools];
    const meta = { injectedMemoryKeys, memoryExpiredKeys };
    const payload: TargetPayload = { ...adapterPayload, meta };
    if (tools.length > 0) payload.tools = tools;

    // 9. Emit compile:done
    await this.emitter.emit('compile:done', { payload });

    return payload;
  }
}
