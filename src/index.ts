import type { z } from 'zod';
import { getAdapter } from './adapters/adapterFactory';
import { type GovernanceOptions, Governor } from './modules/governor';
import { Memory } from './modules/memory';
import type { MemoryStore } from './modules/memory/memoryStore';
import { Janitor, type JanitorConfig, type JanitorSnapshot } from './modules/janitor';
import { Pointer, type ProcessOptions, type VFSConfig } from './modules/pointer';
import {
  type CompiledTools,
  Pruner,
  type PrunerConfig,
  type ResolvedToolCall,
  type ToolGroup,
} from './modules/pruner';
import { type DynamicStatePlacement, Stitcher } from './modules/stitcher';
import type {
  AnthropicPayload,
  CompileOptions,
  GeminiPayload,
  Message,
  OpenAIPayload,
  TargetPayload,
  ToolDefinition,
} from './types';
import { objectToXml } from './utils/xmlGenerator';

export { AdapterFactory, getAdapter, type ITargetAdapter } from './adapters/adapterFactory';
export { Governor } from './modules/governor';
export { Janitor, type JanitorConfig, type JanitorSnapshot } from './modules/janitor';
export { FileSystemAdapter, Pointer, type ProcessOptions, type VFSConfig, type VFSStorageAdapter } from './modules/pointer';
export { Pruner, type PrunerConfig } from './modules/pruner';
export { Stitcher, type StitchOptions } from './modules/stitcher';
export * from './prompts';
export { InMemoryStore } from './modules/memory/inMemoryStore';
export { Memory, type MemoryEntry } from './modules/memory';
export type { MemoryStore } from './modules/memory/memoryStore';
export { VFSMemoryStore } from './modules/memory/vfsMemoryStore';
export * from './types';
export { TokenUtils } from './utils/tokenUtils';
export { XmlGenerator } from './utils/xmlGenerator';

/**
 * Read-only snapshot of the current context, passed to the onBeforeCompile hook.
 */
export interface BeforeCompileContext {
  topLayer: readonly Message[];
  rollingHistory: readonly Message[];
  dynamicState: readonly Message[];
  rawDynamicXml: string;
}

/**
 * An immutable snapshot of ContextChef's full internal state.
 * Created by chef.snapshot() and consumed by chef.restore().
 */
export interface ChefSnapshot {
  readonly topLayer: Message[];
  readonly rollingHistory: Message[];
  readonly dynamicState: Message[];
  readonly dynamicStatePlacement: DynamicStatePlacement;
  readonly rawDynamicXml: string;
  readonly _janitor: JanitorSnapshot;
  readonly _memoryStore?: Record<string, string>;
  readonly label?: string;
  readonly createdAt: number;
}

export interface ChefConfig {
  vfs?: Partial<VFSConfig>;
  janitor?: JanitorConfig;
  pruner?: PrunerConfig;
  memoryStore?: MemoryStore;
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
   *     const snippets = await vectorDB.search(ctx.rawDynamicXml);
   *     return snippets.map(s => s.content).join('\n');
   *   },
   * });
   */
  onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>;
}

export type {
  GovernanceOptions,
  ToolGroup,
  CompiledTools,
  ResolvedToolCall,
  DynamicStatePlacement,
};

export class ContextChef {
  private stitcher: Stitcher;
  private pointer: Pointer;
  private janitor: Janitor;
  private governor: Governor;
  private pruner: Pruner;
  private _memory: Memory | null;
  private transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;
  private onBeforeCompile?: (context: BeforeCompileContext) => string | null | Promise<string | null>;

  private topLayer: Message[] = [];
  private rollingHistory: Message[] = [];
  private dynamicState: Message[] = [];
  private dynamicStatePlacement: DynamicStatePlacement = 'last_user';
  private rawDynamicXml: string = '';

  constructor(config: ChefConfig = {}) {
    this.stitcher = new Stitcher();
    this.pointer = new Pointer(config.vfs);
    this.janitor = new Janitor(config.janitor);
    this.governor = new Governor();
    this.pruner = new Pruner(config.pruner);
    this._memory = config.memoryStore ? new Memory(config.memoryStore) : null;
    this.transformContext = config.transformContext;
    this.onBeforeCompile = config.onBeforeCompile;
  }

  /**
   * Sets the static base of the context.
   * This layer is deeply frozen to ensure KV-Cache stability.
   */
  public setTopLayer(messages: Message[]): this {
    this.topLayer = [...messages];
    return this;
  }

  /**
   * Appends to or sets the rolling history.
   * Compression runs automatically on compile() via the Janitor.
   */
  public useRollingHistory(history: Message[]): this {
    this.rollingHistory = [...history];
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
    this.rawDynamicXml = xml;

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
   * Applies the Governor's rules.
   * If a specific `target` is provided during `compile()`, it will elegantly degrade prefill.
   */
  public withGovernance(options: GovernanceOptions): this {
    this.dynamicState = this.governor.applyGovernance(this.dynamicState, options);
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
   * The caller decides which field to pass (e.g. input_tokens, prompt_tokens, total_tokens).
   * On the next compile(), this value is used alongside the local estimate —
   * whichever is higher triggers compression.
   *
   * @example
   * const response = await openai.chat.completions.create({ ... });
   * chef.feedTokenUsage(response.usage.prompt_tokens);
   * const nextPayload = await chef.compile({ target: 'openai' });
   */
  public feedTokenUsage(tokenCount: number): this {
    this.janitor.feedTokenUsage(tokenCount);
    return this;
  }

  /**
   * Returns the Pruner instance for direct access to all tool management strategies.
   *
   * @example
   * // Flat mode
   * const { tools } = chef.tools().pruneByTask("read and analyze a file");
   *
   * // Namespace + Lazy Loading
   * const { tools, directoryXml } = chef.tools().compile();
   */
  public tools(): Pruner {
    return this.pruner;
  }

  /**
   * Returns the Memory instance for direct access to core memory operations.
   * Requires `memoryStore` to be configured in ChefConfig.
   *
   * @example
   * await chef.memory().set('project_rules', 'Always use strict TypeScript');
   * await chef.memory().extractAndApply(assistantResponse);
   */
  public memory(): Memory {
    if (!this._memory) {
      throw new Error('ContextChef: memory() requires a memoryStore in ChefConfig.');
    }
    return this._memory;
  }

  /**
   * Utility method to safely process large outputs via VFS before they hit history.
   * Throws an error if the configured VFS storage adapter is asynchronous.
   */
  public processLargeOutput(
    content: string,
    type: 'log' | 'doc' = 'log',
    options?: ProcessOptions,
  ): string {
    const result = this.pointer.process(content, type, options);
    return result.content;
  }

  /**
   * Async utility method to safely process large outputs via VFS.
   * Required when using an asynchronous VFS storage adapter (like a database).
   * Also safely supports synchronous adapters.
   */
  public async processLargeOutputAsync(
    content: string,
    type: 'log' | 'doc' = 'log',
    options?: ProcessOptions,
  ): Promise<string> {
    const result = await this.pointer.processAsync(content, type, options);
    return result.content;
  }

  private async _getMemoryMessages(): Promise<Message[]> {
    if (!this._memory) return [];
    const xml = await this._memory.toXml();
    if (!xml) return [];
    return [{ role: 'system', content: xml }];
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
   * Explicitly clears the rolling history and resets Janitor state.
   * Use when the developer knows it's time to "start fresh" — e.g., user requests a new topic,
   * or an Agent completes an independent sub-task phase.
   * This provides more direct control than waiting for Janitor's automatic token-based compression.
   */
  public clearRollingHistory(): this {
    this.rollingHistory = [];
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
      topLayer: this.topLayer.map((m) => ({ ...m })),
      rollingHistory: this.rollingHistory.map((m) => ({ ...m })),
      dynamicState: this.dynamicState.map((m) => ({ ...m })),
      dynamicStatePlacement: this.dynamicStatePlacement,
      rawDynamicXml: this.rawDynamicXml,
      _janitor: this.janitor.snapshotState(),
      _memoryStore: this._memory?.snapshot() ?? undefined,
      label,
      createdAt: Date.now(),
    };
  }

  /**
   * Restores ContextChef to a previously captured snapshot.
   * All state — including Janitor compression flags — is rolled back.
   */
  public restore(snapshot: ChefSnapshot): this {
    this.topLayer = snapshot.topLayer.map((m) => ({ ...m }));
    this.rollingHistory = snapshot.rollingHistory.map((m) => ({ ...m }));
    this.dynamicState = snapshot.dynamicState.map((m) => ({ ...m }));
    this.dynamicStatePlacement = snapshot.dynamicStatePlacement;
    this.rawDynamicXml = snapshot.rawDynamicXml;
    this.janitor.restoreState(snapshot._janitor);
    if (snapshot._memoryStore && this._memory) {
      this._memory.restore(snapshot._memoryStore);
    }
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
    // 1. Janitor: Compress history if needed
    const compressedHistory = await this.janitor.compress(this.rollingHistory);

    // 2. onBeforeCompile hook: inject external context (RAG, AST, MCP, etc.)
    let implicitContextXml = '';
    if (this.onBeforeCompile) {
      const injected = await this.onBeforeCompile({
        topLayer: this.topLayer,
        rollingHistory: compressedHistory,
        dynamicState: this.dynamicState,
        rawDynamicXml: this.rawDynamicXml,
      });
      if (injected) {
        implicitContextXml = `<implicit_context>\n${injected}\n</implicit_context>`;
      }
    }

    // 3. For system placement, append implicit_context directly to the dynamic state message
    //    (Stitcher only handles last_user injection)
    let dynamicState = this.dynamicState;
    if (implicitContextXml && this.dynamicStatePlacement === 'system' && dynamicState.length > 0) {
      dynamicState = dynamicState.map((msg) =>
        msg.content.includes('CURRENT TASK STATE')
          ? { ...msg, content: `${msg.content}\n${implicitContextXml}` }
          : msg,
      );
    }

    // 4. Core Memory injection (between topLayer and history)
    const memoryMessages = await this._getMemoryMessages();

    // 5. Sandwich assembly
    let messages = [...this.topLayer, ...memoryMessages, ...compressedHistory, ...dynamicState];

    // 6. Transform hook
    if (this.transformContext) {
      messages = await this.transformContext(messages);
    }

    // 7. Stitcher: Dynamic state injection (if last_user) + deterministic key ordering
    const stitchXml = [this.rawDynamicXml, implicitContextXml].filter(Boolean).join('\n');
    const rawPayload = this.stitcher.compile(messages, {
      dynamicStateXml: stitchXml || undefined,
      placement: this.dynamicStatePlacement,
    });

    const target = options?.target ?? 'openai';
    const adapter = getAdapter(target);
    const adapterPayload = adapter.compile([...rawPayload.messages]);

    const tools = this._getPrunerTools();
    return tools.length > 0 ? { ...adapterPayload, tools } : adapterPayload;
  }
}
