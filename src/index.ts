import type { z } from 'zod';
import { getAdapter } from './adapters/AdapterFactory';
import { GovernanceOptions, Governor } from './modules/Governor';
import { Janitor, type JanitorConfig } from './modules/Janitor';
import { Pointer, type ProcessOptions, type VFSConfig } from './modules/Pointer';
import {
  CompiledTools,
  Pruner,
  type PrunerConfig,
  ResolvedToolCall,
  ToolDefinition,
  ToolGroup,
} from './modules/Pruner';
import { DynamicStatePlacement, Stitcher, type StitchOptions } from './modules/Stitcher';
import type { CompileOptions, Message, TargetPayload } from './types';
import { objectToXml } from './utils/XmlGenerator';

export { AdapterFactory, getAdapter, ITargetAdapter } from './adapters/AdapterFactory';
export { Governor } from './modules/Governor';
export { Janitor, JanitorConfig } from './modules/Janitor';
export { Pointer, ProcessOptions, VFSConfig } from './modules/Pointer';
export { Pruner, PrunerConfig } from './modules/Pruner';
export { Stitcher, StitchOptions } from './modules/Stitcher';
export * from './prompts';
export * from './types';
export { TokenUtils } from './utils/TokenUtils';
export { XmlGenerator } from './utils/XmlGenerator';

export interface ChefConfig {
  vfs?: Partial<VFSConfig>;
  janitor?: JanitorConfig;
  pruner?: PrunerConfig;
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;
}

export {
  GovernanceOptions,
  ToolDefinition,
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
  private transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;

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
    this.transformContext = config.transformContext;
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
   * In a real implementation, this would trigger the Janitor if threshold is reached.
   */
  public useRollingHistory(
    history: Message[],
    _options?: { windowSize?: string; strategy?: string },
  ): this {
    this.rollingHistory = [...history];
    // TODO: integrate Janitor compression logic here
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
   * Utility method to safely process large outputs via VFS before they hit history.
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
   * Build the StitchOptions that tell the Stitcher how to handle dynamic state placement.
   */
  private getStitchOptions(): StitchOptions {
    return {
      dynamicStateXml: this.rawDynamicXml || undefined,
      placement: this.dynamicStatePlacement,
    };
  }

  /**
   * Compiles the final deterministic payload ready for the LLM SDK.
   * Leverages TargetAdapters to conform strictly to provider requirements.
   */
  public compile(options?: CompileOptions): TargetPayload {
    let messages = [...this.topLayer, ...this.rollingHistory, ...this.dynamicState];

    // Sync transform hook execution (if provided and synchronous)
    if (this.transformContext) {
      const transformed = this.transformContext(messages);
      if (transformed instanceof Promise) {
        throw new Error('transformContext is async. Use compileAsync() instead.');
      }
      messages = transformed;
    }

    // Stitcher: Dynamic state injection (if last_user) + deterministic key ordering
    const rawPayload = this.stitcher.compile(messages, this.getStitchOptions());

    const target = options?.target || 'openai';
    const adapter = getAdapter(target);

    return adapter.compile([...rawPayload.messages]);
  }

  /**
   * Async compilation for the final deterministic payload.
   */
  public async compileAsync(options?: CompileOptions): Promise<TargetPayload> {
    // 1. Janitor: Compress history if needed
    const compressedHistory = await this.janitor.compress(this.rollingHistory);

    // 2. Sandwich assembly
    let messages = [...this.topLayer, ...compressedHistory, ...this.dynamicState];

    // 3. Transform hook
    if (this.transformContext) {
      messages = await this.transformContext(messages);
    }

    // 4. Stitcher: Dynamic state injection (if last_user) + deterministic key ordering
    const rawPayload = this.stitcher.compile(messages, this.getStitchOptions());

    const target = options?.target || 'openai';
    const adapter = getAdapter(target);

    return adapter.compile([...rawPayload.messages]);
  }
}
