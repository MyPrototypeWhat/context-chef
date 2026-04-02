import { Prompts } from '../../prompts';
import type { CompactOptions, Message } from '../../types';
import { TokenUtils } from '../../utils/tokenUtils';

const DEFAULT_PRESERVE_RATIO = 0.8;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 1;

// ─── Turn-based grouping ───

export interface Turn {
  startIndex: number;
  endIndex: number; // exclusive
}

/**
 * Groups a flat message array into atomic "turns."
 *
 * Grouping rules:
 * - user message → single-message turn
 * - system message → single-message turn
 * - assistant (no tool_calls) → single-message turn
 * - assistant (with tool_calls) + all subsequent tool results → one atomic turn
 *
 * Splitting on turn boundaries guarantees tool pair integrity and
 * eliminates the need for post-hoc adjustSplitIndex corrections.
 */
export function groupIntoTurns(history: Message[]): Turn[] {
  const turns: Turn[] = [];
  let i = 0;

  while (i < history.length) {
    const msg = history[i];

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Atomic turn: assistant + all subsequent tool results
      const start = i;
      i++;
      while (i < history.length && history[i].role === 'tool') {
        i++;
      }
      turns.push({ startIndex: start, endIndex: i });
    } else {
      // Single-message turn: user, system, or plain assistant
      turns.push({ startIndex: i, endIndex: i + 1 });
      i++;
    }
  }

  return turns;
}

export interface JanitorConfig {
  /**
   * The model's context window size (in tokens).
   * Compression is triggered when token usage exceeds this value.
   */
  contextWindow: number;

  /**
   * Optional tokenizer for precise per-message token counting.
   * When provided, enables the "tokenizer path": precise splitIndex calculation
   * that preserves recent messages based on preserveRatio.
   *
   * When NOT provided, the "feedTokenUsage path" is used: compression is triggered
   * by feedTokenUsage() and compresses all messages except the last `preserveRecentMessages`.
   *
   * IMPORTANT: This function is called with both the full history AND individual messages
   * (for per-message cost calculation), so it must handle arbitrary Message[] inputs.
   *
   * @example
   * tokenizer: (msgs) => msgs.reduce((sum, m) => sum + encode(JSON.stringify(m)).length, 0)
   */
  tokenizer?: (messages: Message[]) => number;

  /**
   * [Tokenizer path only] The ratio of contextWindow to preserve for recent messages.
   * Defaults to DEFAULT_PRESERVE_RATIO (keep 80% of contextWindow worth of recent messages).
   */
  preserveRatio?: number;

  /**
   * [FeedTokenUsage path only] Number of recent turns to keep when compressing.
   * A "turn" is an atomic unit: a single message, or an assistant with tool_calls
   * plus all its subsequent tool results. Defaults to 1.
   */
  preserveRecentMessages?: number;

  /**
   * Async hook to call a low-cost LLM (e.g. gpt-4o-mini) to summarize the truncated messages.
   * If not provided, a simple placeholder message is used.
   */
  compressionModel?: (messagesToCompress: Message[]) => Promise<string>;

  /**
   * Hook triggered ONLY when compression actually happens.
   * Useful for UI loaders ("Compressing memory..."), logging, or saving the compressed state.
   */
  onCompress?: (summaryMessage: Message, truncatedCount: number) => void | Promise<void>;

  /**
   * Hook triggered when the token budget is exceeded, BEFORE LLM compression.
   * Return a modified Message[] to replace the history before compression proceeds,
   * or return null/undefined to let the default compression handle it.
   */
  onBeforeCompress?: (
    history: Message[],
    tokenInfo: { currentTokens: number; limit: number },
  ) => Message[] | null | undefined | Promise<Message[] | null | undefined>;

  /**
   * @deprecated Use `onBeforeCompress` instead. Will be removed in the next major version.
   */
  onBudgetExceeded?: (
    history: Message[],
    tokenInfo: { currentTokens: number; limit: number },
  ) => Message[] | null | undefined | Promise<Message[] | null | undefined>;
}

export interface JanitorSnapshot {
  externalTokenUsage: number | null;
  suppressNextCompression: boolean;
}

export class Janitor {
  /** Externally reported token count from the last API response. */
  private _externalTokenUsage: number | null = null;
  /** Suppresses the next compression check after a successful compression (E10). */
  private _suppressNextCompression = false;

  constructor(private config: JanitorConfig) {
    // Warn if feedTokenUsage path is likely used without a compressionModel
    if (!config.tokenizer && !config.compressionModel) {
      console.warn(
        '[Janitor] Warning: No tokenizer and no compressionModel configured. ' +
          'In the feedTokenUsage path, compression without a compressionModel will discard old messages ' +
          'with only a placeholder summary. Consider providing a compressionModel for meaningful context preservation.',
      );
    }
  }

  public snapshotState(): JanitorSnapshot {
    return {
      externalTokenUsage: this._externalTokenUsage,
      suppressNextCompression: this._suppressNextCompression,
    };
  }

  public restoreState(state: JanitorSnapshot): void {
    this._externalTokenUsage = state.externalTokenUsage;
    this._suppressNextCompression = state.suppressNextCompression;
  }

  /**
   * Resets the Janitor's internal state.
   * Called when rolling history is explicitly cleared by the developer.
   */
  public reset(): void {
    this._externalTokenUsage = null;
    this._suppressNextCompression = false;
  }

  /**
   * Feeds an externally-reported token count (e.g. from the LLM API response).
   * Used in the feedTokenUsage path: when this value exceeds contextWindow,
   * compression is triggered on the next compress() call.
   * The value is consumed after use.
   */
  public feedTokenUsage(tokenCount: number): void {
    this._externalTokenUsage = tokenCount;
  }

  /**
   * Compresses the rolling history when token budget is exceeded.
   *
   * Two paths:
   * - Tokenizer path: precise splitIndex based on per-turn token costs.
   * - FeedTokenUsage path: full compression, keeping only the last N turns.
   */
  public async compress(history: Message[]): Promise<Message[]> {
    const evaluation = this.evaluateBudget(history);
    if (evaluation === null) return history;

    let { splitIndex } = evaluation;
    const { currentTokens } = evaluation;

    // Fire onBeforeCompress hook — developer gets a chance to intervene
    const hook = this.config.onBeforeCompress ?? this.config.onBudgetExceeded;
    if (hook) {
      const modified = await hook(history, {
        currentTokens,
        limit: this.config.contextWindow,
      });

      if (modified != null) {
        // Re-evaluate with the developer-modified history
        const reEval = this.evaluateBudget(modified);
        if (reEval === null) return modified;
        history = modified;
        splitIndex = reEval.splitIndex;
      }
    }

    return this.executeCompression(history, splitIndex);
  }

  /**
   * Mechanically strips content from history based on the specified clear targets.
   * Pure function — no LLM call, no side effects, no state mutation.
   *
   * @example
   * // Clear all tool results and thinking
   * history = janitor.compact(history, { clear: ['tool-result', 'thinking'] });
   *
   * // Keep the 5 most recent tool results, clear the rest
   * history = janitor.compact(history, { clear: [{ target: 'tool-result', keepRecent: 5 }] });
   */
  public compact(history: Message[], options: CompactOptions): Message[] {
    // Parse targets: separate simple strings from object configs
    let clearToolResult = false;
    let toolResultKeepRecent: number | undefined;
    let clearThinking = false;

    for (const target of options.clear) {
      if (target === 'tool-result') {
        clearToolResult = true;
      } else if (target === 'thinking') {
        clearThinking = true;
      } else if (typeof target === 'object' && target.target === 'tool-result') {
        clearToolResult = true;
        toolResultKeepRecent = target.keepRecent;
      }
    }

    // Build the set of tool message indices to skip (keepRecent)
    let toolResultSkipSet: Set<number> | undefined;
    if (clearToolResult && toolResultKeepRecent !== undefined) {
      const keepCount = Math.max(1, toolResultKeepRecent);
      // Collect indices of all tool messages (in order)
      const toolIndices: number[] = [];
      for (let i = 0; i < history.length; i++) {
        if (history[i].role === 'tool') {
          toolIndices.push(i);
        }
      }
      // The last keepCount tool messages are preserved
      const preserveIndices = toolIndices.slice(-keepCount);
      toolResultSkipSet = new Set(preserveIndices);
    }

    return history.map((msg, idx) => {
      let result = msg;

      if (clearToolResult && msg.role === 'tool') {
        // Skip (preserve) if this index is in the keepRecent set
        if (!toolResultSkipSet || !toolResultSkipSet.has(idx)) {
          result = { ...result, content: '[Old tool result content cleared]' };
        }
      }

      if (clearThinking && msg.role === 'assistant') {
        if (msg.thinking || msg.redacted_thinking) {
          const { thinking, redacted_thinking, ...rest } = result;
          result = rest as Message;
        }
      }

      return result;
    });
  }

  /**
   * Evaluates token budgets and returns the split index for compression,
   * or null if no compression is needed.
   *
   * Uses turn-based grouping: messages are grouped into atomic turns
   * (assistant+tool_calls+tool_results as one unit), and splits only happen
   * on turn boundaries. This guarantees tool pair integrity and valid
   * message alternation without post-hoc corrections.
   */
  private evaluateBudget(history: Message[]): { splitIndex: number; currentTokens: number } | null {
    if (history.length === 0) return null;

    // E10: Skip check once after a successful compression to avoid cascading re-compression.
    if (this._suppressNextCompression) {
      this._suppressNextCompression = false;
      return null;
    }

    const turns = groupIntoTurns(history);

    // ─── Tokenizer path: precise per-message calculation ───
    if (this.config.tokenizer) {
      const currentTokens = this.config.tokenizer(history);
      const effectiveTokens = Math.max(currentTokens, this._externalTokenUsage ?? 0);
      this._externalTokenUsage = null;

      if (effectiveTokens <= this.config.contextWindow) {
        return null;
      }

      const preserveTarget = Math.floor(
        this.config.contextWindow * (this.config.preserveRatio ?? DEFAULT_PRESERVE_RATIO),
      );

      // Iterate turns from the tail, accumulating token costs per turn
      let accumulatedTokens = 0;
      let splitTurn = turns.length;

      for (let t = turns.length - 1; t >= 0; t--) {
        const turnMessages = history.slice(turns[t].startIndex, turns[t].endIndex);
        const turnTokens = this.config.tokenizer(turnMessages);
        if (accumulatedTokens + turnTokens > preserveTarget) {
          break;
        }
        accumulatedTokens += turnTokens;
        splitTurn = t;
      }

      // Keep at least 1 turn if a single turn exceeds the preserve budget
      if (splitTurn === turns.length && turns.length > 0) {
        splitTurn = turns.length - 1;
      }

      if (splitTurn <= 0) return null;

      const splitIndex = turns[splitTurn].startIndex;
      return { splitIndex, currentTokens: effectiveTokens };
    }

    // ─── FeedTokenUsage path: simple total comparison, keep last N turns ───
    const currentTokens = this._externalTokenUsage ?? TokenUtils.estimateObject(history);
    this._externalTokenUsage = null;

    if (currentTokens <= this.config.contextWindow) {
      return null;
    }

    // Keep the last N turns (not messages), compress everything else
    const keepCount = Math.min(
      this.config.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES,
      turns.length,
    );
    const splitTurn = turns.length - keepCount;

    if (splitTurn <= 0) return null;

    const splitIndex = turns[splitTurn].startIndex;
    return { splitIndex, currentTokens };
  }

  private async executeCompression(history: Message[], splitIndex: number): Promise<Message[]> {
    const toCompress = history.slice(0, splitIndex);
    const toKeep = history.slice(splitIndex);

    if (!this.config.compressionModel) {
      if (this.config.onCompress) {
        await this.config.onCompress(
          { role: 'system', content: Prompts.getFallbackCompressionSummary(toCompress.length) },
          toCompress.length,
        );
      }
      this._suppressNextCompression = true;
      return [...toKeep];
    }

    if (toCompress.length === 0) {
      return history;
    }

    let summaryText: string;
    try {
      const compressionMessages: Message[] = [
        ...toCompress,
        { role: 'user', content: Prompts.CONTEXT_COMPACTION_INSTRUCTION },
      ];
      summaryText = await this.config.compressionModel(compressionMessages);
    } catch (error) {
      summaryText =
        Prompts.getFallbackCompressionSummary(toCompress.length) +
        `\n(Compression failed: ${error})`;
    }

    const summaryMessage: Message = {
      role: 'user',
      content: Prompts.getCompactSummaryWrapper(summaryText),
    };

    if (this.config.onCompress) {
      await this.config.onCompress(summaryMessage, toCompress.length);
    }

    // E10: Suppress the immediate next compression check.
    this._suppressNextCompression = true;

    return [summaryMessage, ...toKeep];
  }
}
