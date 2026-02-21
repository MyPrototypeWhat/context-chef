import { Message, CompileOptions, TargetPayload } from './types';
import { Stitcher } from './modules/Stitcher';
import { Pointer, VFSConfig, ProcessOptions } from './modules/Pointer';
import { Janitor, JanitorConfig } from './modules/Janitor';
import { Governor, GovernanceOptions } from './modules/Governor';
import { Pruner, PrunerConfig, ToolDefinition } from './modules/Pruner';
import { AdapterFactory } from './adapters/AdapterFactory';
import { XmlGenerator } from './utils/XmlGenerator';
import { z } from 'zod';

export * from './prompts';

export interface ChefConfig {
  vfs?: Partial<VFSConfig>;
  janitor?: JanitorConfig;
  pruner?: PrunerConfig;
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;
}

export { GovernanceOptions, ToolDefinition };

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
  public useRollingHistory(history: Message[], options?: { windowSize?: string, strategy?: string }): this {
    this.rollingHistory = [...history];
    // TODO: integrate Janitor compression logic here
    return this;
  }

  /**
   * Strongly typed dynamic state injection.
   * Converts the structured state into XML tags which are highly optimized for LLM comprehension.
   */
  public setDynamicState<T>(schema: z.ZodType<T>, state: T): this {
    // Validate state at runtime
    const parsedState = schema.parse(state);
    
    // Generate an XML representation
    const xml = XmlGenerator.objectToXml(parsedState, 'dynamic_state');

    this.dynamicState = [
      {
        role: 'system',
        content: `CURRENT TASK STATE:\n${xml}`
      }
    ];
    
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
   * Registers the full tool registry with the Pruner.
   * The Pruner will use this list as the source of truth for all filtering operations.
   */
  public registerTools(tools: ToolDefinition[]): this {
    this.pruner.registerTools(tools);
    return this;
  }

  /**
   * Returns the Pruner instance for direct access to pruning strategies.
   * Use this to get a filtered tool list for your LLM SDK call.
   *
   * @example
   * const { tools } = chef.tools().pruneByTask("read and analyze a file");
   */
  public tools(): Pruner {
    return this.pruner;
  }

  /**
   * Utility method to safely process large outputs via VFS before they hit history.
   */
  public processLargeOutput(content: string, type: 'log' | 'doc' = 'log', options?: ProcessOptions): string {
    const result = this.pointer.process(content, type, options);
    return result.content;
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
        throw new Error("transformContext is async. Use compileAsync() instead.");
      }
      messages = transformed;
    }

    const rawPayload = this.stitcher.compile(messages);
    
    const target = options?.target || 'openai';
    const adapter = AdapterFactory.getAdapter(target);
    
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

    // 4. Stitcher: Deterministic compilation
    const rawPayload = this.stitcher.compile(messages);
    
    const target = options?.target || 'openai';
    const adapter = AdapterFactory.getAdapter(target);
    
    return adapter.compile([...rawPayload.messages]);
  }
}
