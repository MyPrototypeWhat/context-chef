export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  tags?: string[];
}

export interface PrunerConfig {
  /** Strategy to use when both allowlist and tags are provided. Defaults to 'union'. */
  strategy?: 'union' | 'intersection';
}

export interface PrunerResult {
  tools: ToolDefinition[];
  removed: string[];
  kept: number;
  total: number;
}

/**
 * Pruner — Tool Guard.
 *
 * Dynamically prunes the tool list injected into LLM context based on:
 * - An explicit allowlist of tool names
 * - Keyword/tag-based relevance scoring against a task description
 *
 * This prevents "tool hallucination" where an LLM calls tools that are
 * irrelevant or unavailable in the current execution phase.
 */
export class Pruner {
  private tools: ToolDefinition[] = [];
  private config: Required<PrunerConfig>;

  constructor(config: PrunerConfig = {}) {
    this.config = {
      strategy: config.strategy ?? 'union',
    };
  }

  /**
   * Registers the full set of available tools.
   * Call this once with your complete tool registry.
   */
  public registerTools(tools: ToolDefinition[]): this {
    this.tools = [...tools];
    return this;
  }

  /**
   * Prunes tools to only those matching the given allowlist of names.
   * Case-insensitive matching.
   */
  public allowOnly(names: string[]): PrunerResult {
    const normalized = new Set(names.map(n => n.toLowerCase()));
    return this._buildResult(
      this.tools.filter(t => normalized.has(t.name.toLowerCase()))
    );
  }

  /**
   * Prunes tools by relevance to a task description.
   * A tool is considered relevant if any of its tags appear (case-insensitively) in the task text,
   * OR if the task text contains the tool name itself.
   *
   * Tools with no tags are always kept (they are treated as universal utilities).
   */
  public pruneByTask(taskDescription: string): PrunerResult {
    const lowerTask = taskDescription.toLowerCase();
    const relevant = this.tools.filter(tool => {
      if (!tool.tags || tool.tags.length === 0) return true;
      const nameMatch = lowerTask.includes(tool.name.toLowerCase());
      const tagMatch = tool.tags.some(tag => lowerTask.includes(tag.toLowerCase()));
      return nameMatch || tagMatch;
    });
    return this._buildResult(relevant);
  }

  /**
   * Combines allowlist and task-based relevance filtering.
   *
   * strategy: 'union' (default) — keeps tools that match EITHER condition.
   * strategy: 'intersection' — keeps tools that match BOTH conditions.
   */
  public pruneByTaskAndAllowlist(taskDescription: string, allowlist: string[]): PrunerResult {
    const lowerTask = taskDescription.toLowerCase();
    const normalizedAllowlist = new Set(allowlist.map(n => n.toLowerCase()));

    const isRelevantByTask = (tool: ToolDefinition): boolean => {
      if (!tool.tags || tool.tags.length === 0) return true;
      const nameMatch = lowerTask.includes(tool.name.toLowerCase());
      const tagMatch = tool.tags.some(tag => lowerTask.includes(tag.toLowerCase()));
      return nameMatch || tagMatch;
    };

    const isInAllowlist = (tool: ToolDefinition): boolean =>
      normalizedAllowlist.has(tool.name.toLowerCase());

    const relevant = this.tools.filter(tool => {
      if (this.config.strategy === 'intersection') {
        return isRelevantByTask(tool) && isInAllowlist(tool);
      }
      return isRelevantByTask(tool) || isInAllowlist(tool);
    });

    return this._buildResult(relevant);
  }

  /**
   * Returns all registered tools without filtering.
   */
  public getAllTools(): ToolDefinition[] {
    return [...this.tools];
  }

  private _buildResult(kept: ToolDefinition[]): PrunerResult {
    const keptNames = new Set(kept.map(t => t.name));
    const removed = this.tools
      .filter(t => !keptNames.has(t.name))
      .map(t => t.name);

    return {
      tools: kept,
      removed,
      kept: kept.length,
      total: this.tools.length,
    };
  }
}
