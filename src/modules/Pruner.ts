// ─── Core Types ───

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  tags?: string[];
}

export interface ToolGroup {
  name: string;
  description: string;
  tools: ToolDefinition[];
}

export interface PrunerConfig {
  /** Strategy for combined allowlist+task filtering. Defaults to 'union'. */
  strategy?: 'union' | 'intersection';
}

export interface PrunerResult {
  tools: ToolDefinition[];
  removed: string[];
  kept: number;
  total: number;
}

/** The result of resolving a namespace tool call back to a concrete tool. */
export interface ResolvedToolCall {
  group: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** The result of compile(): tools array for LLM + directory XML for system prompt. */
export interface CompiledTools {
  /** Tool definitions to pass to the LLM SDK's `tools` parameter. */
  tools: ToolDefinition[];
  /** XML directory of lazy-loadable toolkits, to inject into system prompt. */
  directoryXml: string;
}

// ─── Internal Constants ───

const LOAD_TOOLKIT_NAME = 'load_toolkit';

// ─── Pruner ───

/**
 * Pruner — Tool Guard with Namespace + Lazy Loading.
 *
 * Two-layer architecture for tool management:
 * - Layer 1 (Namespaces): Stable category tools that route to concrete sub-tools.
 *   These never change across turns, preserving KV-Cache stability.
 * - Layer 2 (Lazy Toolkits): On-demand tool loading via a `load_toolkit` virtual tool.
 *   The LLM sees a lightweight directory and requests full schemas when needed.
 *
 * Also supports flat tool registration and filtering (legacy/simple mode).
 */
export class Pruner {
  private flatTools: ToolDefinition[] = [];
  private namespaces: ToolGroup[] = [];
  private lazyToolkits: ToolGroup[] = [];
  private config: Required<PrunerConfig>;

  constructor(config: PrunerConfig = {}) {
    this.config = {
      strategy: config.strategy ?? 'union',
    };
  }

  // ─── Flat Mode (Legacy) ───

  public registerTools(tools: ToolDefinition[]): this {
    this.flatTools = [...tools];
    return this;
  }

  public allowOnly(names: string[]): PrunerResult {
    const normalized = new Set(names.map((n) => n.toLowerCase()));
    return this._buildResult(this.flatTools.filter((t) => normalized.has(t.name.toLowerCase())));
  }

  public pruneByTask(taskDescription: string): PrunerResult {
    const lowerTask = taskDescription.toLowerCase();
    const relevant = this.flatTools.filter((tool) => {
      if (!tool.tags || tool.tags.length === 0) return true;
      const nameMatch = lowerTask.includes(tool.name.toLowerCase());
      const tagMatch = tool.tags.some((tag) => lowerTask.includes(tag.toLowerCase()));
      return nameMatch || tagMatch;
    });
    return this._buildResult(relevant);
  }

  public pruneByTaskAndAllowlist(taskDescription: string, allowlist: string[]): PrunerResult {
    const lowerTask = taskDescription.toLowerCase();
    const normalizedAllowlist = new Set(allowlist.map((n) => n.toLowerCase()));

    const isRelevantByTask = (tool: ToolDefinition): boolean => {
      if (!tool.tags || tool.tags.length === 0) return true;
      return (
        lowerTask.includes(tool.name.toLowerCase()) ||
        tool.tags.some((tag) => lowerTask.includes(tag.toLowerCase()))
      );
    };
    const isInAllowlist = (tool: ToolDefinition): boolean =>
      normalizedAllowlist.has(tool.name.toLowerCase());

    const relevant = this.flatTools.filter((tool) => {
      if (this.config.strategy === 'intersection') {
        return isRelevantByTask(tool) && isInAllowlist(tool);
      }
      return isRelevantByTask(tool) || isInAllowlist(tool);
    });
    return this._buildResult(relevant);
  }

  public getAllTools(): ToolDefinition[] {
    return [...this.flatTools];
  }

  // ─── Layer 1: Namespaces ───

  /**
   * Registers tool groups as stable namespace tools (Layer 1).
   * Each group becomes a single tool with an `action` enum and `args` object.
   */
  public registerNamespaces(groups: ToolGroup[]): this {
    this.namespaces = groups.map((g) => ({ ...g, tools: [...g.tools] }));
    return this;
  }

  // ─── Layer 2: Lazy Loading Toolkits ───

  /**
   * Registers toolkits for on-demand lazy loading (Layer 2).
   * These appear as a lightweight directory in the system prompt.
   * The LLM can request full schemas via the `load_toolkit` virtual tool.
   */
  public registerToolkits(toolkits: ToolGroup[]): this {
    this.lazyToolkits = toolkits.map((g) => ({ ...g, tools: [...g.tools] }));
    return this;
  }

  // ─── Compilation ───

  /**
   * Compiles the final tools array and directory XML for an LLM request.
   *
   * Output contains:
   * - Namespace tools (one per group, with action enum + sub-tool docs in description)
   * - `load_toolkit` virtual tool (if lazy toolkits are registered)
   * - directoryXml: lightweight XML listing of available lazy toolkits
   */
  public compile(): CompiledTools {
    const tools: ToolDefinition[] = [];

    // Layer 1: Namespace tools
    for (const ns of this.namespaces) {
      tools.push(this._compileNamespaceTool(ns));
    }

    // Layer 2: load_toolkit virtual tool (only if toolkits exist)
    if (this.lazyToolkits.length > 0) {
      tools.push(this._buildLoaderTool());
    }

    const directoryXml = this._buildDirectoryXml();

    return { tools, directoryXml };
  }

  /**
   * Generates the toolkit directory XML for injection into the system prompt.
   */
  public getDirectoryXml(): string {
    return this._buildDirectoryXml();
  }

  // ─── Runtime Resolution Helpers ───

  /**
   * Checks if a tool call is a `load_toolkit` request.
   */
  public isToolkitLoader(toolCall: { name: string }): boolean {
    return toolCall.name === LOAD_TOOLKIT_NAME;
  }

  /**
   * Checks if a tool call targets a namespace tool.
   */
  public isNamespaceCall(toolCall: { name: string }): boolean {
    return this.namespaces.some((ns) => ns.name === toolCall.name);
  }

  /**
   * Extracts the full tool definitions for a lazy toolkit.
   * Returns the real ToolDefinition[] to inject into the next LLM request's tools array.
   */
  public extractToolkit(toolkitName: string): ToolDefinition[] {
    const kit = this.lazyToolkits.find((k) => k.name.toLowerCase() === toolkitName.toLowerCase());
    if (!kit) {
      throw new Error(
        `Unknown toolkit: "${toolkitName}". Available: ${this.lazyToolkits.map((k) => k.name).join(', ')}`,
      );
    }
    return [...kit.tools];
  }

  /**
   * Resolves a namespace tool call to the concrete sub-tool name and args.
   *
   * @example
   * const resolved = pruner.resolveNamespace({
   *   name: 'file_ops',
   *   arguments: '{"action":"read_file","args":{"path":"auth.ts"}}'
   * });
   * // → { group: 'file_ops', toolName: 'read_file', args: { path: 'auth.ts' } }
   */
  public resolveNamespace(toolCall: {
    name: string;
    arguments: string | Record<string, unknown>;
  }): ResolvedToolCall {
    const ns = this.namespaces.find((n) => n.name === toolCall.name);
    if (!ns) {
      throw new Error(
        `"${toolCall.name}" is not a registered namespace. Available: ${this.namespaces.map((n) => n.name).join(', ')}`,
      );
    }

    const parsed =
      typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : toolCall.arguments;

    const action = parsed.action as string;
    const args = (parsed.args ?? {}) as Record<string, unknown>;

    const matchedTool = ns.tools.find((t) => t.name === action);
    if (!matchedTool) {
      throw new Error(
        `Unknown action "${action}" in namespace "${ns.name}". Available: ${ns.tools.map((t) => t.name).join(', ')}`,
      );
    }

    return { group: ns.name, toolName: matchedTool.name, args };
  }

  // ─── Internal Builders ───

  /**
   * Compiles a ToolGroup into a single namespace ToolDefinition.
   * Sub-tool schemas are serialized into the description for LLM reference.
   */
  private _compileNamespaceTool(group: ToolGroup): ToolDefinition {
    const actionEnum = group.tools.map((t) => t.name);
    const subToolDocs = group.tools
      .map((t) => {
        let doc = `- ${t.name}: ${t.description}`;
        if (t.parameters) {
          const params = Object.entries(t.parameters)
            .map(([k, v]) => {
              const info = v as Record<string, unknown>;
              return `    - ${k} (${info.type ?? 'any'})${info.description ? `: ${info.description}` : ''}`;
            })
            .join('\n');
          if (params) doc += `\n${params}`;
        }
        return doc;
      })
      .join('\n');

    return {
      name: group.name,
      description: `${group.description}\n\nAvailable actions:\n${subToolDocs}`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: actionEnum,
            description: 'The specific tool to invoke within this group.',
          },
          args: {
            type: 'object',
            description: 'Arguments for the selected action. See action descriptions above.',
          },
        },
        required: ['action', 'args'],
      },
    };
  }

  /**
   * Builds the `load_toolkit` virtual tool definition.
   */
  private _buildLoaderTool(): ToolDefinition {
    const kitNames = this.lazyToolkits.map((k) => k.name);
    return {
      name: LOAD_TOOLKIT_NAME,
      description:
        'Load a toolkit to access its specialized tools. ' +
        'Call this when you need tools not available in the current namespace groups. ' +
        'Check the <available_toolkits> directory in your system prompt for options.',
      parameters: {
        type: 'object',
        properties: {
          toolkit_name: {
            type: 'string',
            enum: kitNames,
            description: 'The name of the toolkit to load.',
          },
        },
        required: ['toolkit_name'],
      },
    };
  }

  /**
   * Builds the lightweight XML directory of lazy toolkits.
   */
  private _buildDirectoryXml(): string {
    if (this.lazyToolkits.length === 0) return '';

    const items = this.lazyToolkits.map((kit) => {
      const toolNames = kit.tools.map((t) => t.name).join(', ');
      return `  <toolkit name="${kit.name}" tools="${toolNames}">${kit.description}</toolkit>`;
    });

    return `<available_toolkits>\n${items.join('\n')}\n</available_toolkits>`;
  }

  private _buildResult(kept: ToolDefinition[]): PrunerResult {
    const keptNames = new Set(kept.map((t) => t.name));
    const removed = this.flatTools.filter((t) => !keptNames.has(t.name)).map((t) => t.name);

    return {
      tools: kept,
      removed,
      kept: kept.length,
      total: this.flatTools.length,
    };
  }
}
