import { Prompts } from '../../prompts';
import type { CompactOptions, Message } from '../../types';
import { TokenUtils } from '../../utils/tokenUtils';

const DEFAULT_PRESERVE_RATIO = 0.8;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 1;

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
   * Defaults to DEFAULT_PRESERVE_RATIO (keep 70% of contextWindow worth of recent messages).
   */
  preserveRatio?: number;

  /**
   * [FeedTokenUsage path only] Number of recent messages to keep when compressing.
   * All other messages are compressed into a summary.
   * Defaults to 1.
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
   * Hook triggered when the token budget is exceeded, BEFORE automatic compression.
   * Return a modified Message[] to replace the history before compression proceeds,
   * or return null/undefined to let the default compression handle it.
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
   * - Tokenizer path: precise splitIndex based on per-message token counts.
   * - FeedTokenUsage path: full compression, keeping only the last N messages.
   */
  public async compress(history: Message[]): Promise<Message[]> {
    const evaluation = this.evaluateBudget(history);
    if (evaluation === null) return history;

    let { splitIndex } = evaluation;
    const { currentTokens } = evaluation;

    // Fire onBudgetExceeded hook — developer gets a chance to intervene
    if (this.config.onBudgetExceeded) {
      const modified = await this.config.onBudgetExceeded(history, {
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
   * // Inside onBudgetExceeded hook
   * onBudgetExceeded: (history) => {
   *   return janitor.compact(history, { clear: ['tool-result'] });
   * }
   *
   * // Proactive compaction in agent loop
   * history = janitor.compact(history, { clear: ['tool-result', 'thinking'] });
   */
  public compact(history: Message[], options: CompactOptions): Message[] {
    const targets = new Set(options.clear);
    return history.map((msg) => {
      let result = msg;

      if (targets.has('tool-result') && msg.role === 'tool') {
        result = { ...result, content: '[Tool result cleared]' };
      }

      if (targets.has('thinking') && msg.role === 'assistant') {
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
   */
  private evaluateBudget(history: Message[]): { splitIndex: number; currentTokens: number } | null {
    if (history.length === 0) return null;

    // E10: Skip check once after a successful compression to avoid cascading re-compression.
    if (this._suppressNextCompression) {
      this._suppressNextCompression = false;
      return null;
    }

    // ─── Tokenizer path: precise per-message calculation ───
    if (this.config.tokenizer) {
      const currentTokens = this.config.tokenizer(history);
      // Also consider external usage if fed (take the higher value for safety)
      const effectiveTokens = Math.max(currentTokens, this._externalTokenUsage ?? 0);
      this._externalTokenUsage = null;

      if (effectiveTokens <= this.config.contextWindow) {
        return null;
      }

      const preserveTarget = Math.floor(
        this.config.contextWindow * (this.config.preserveRatio ?? DEFAULT_PRESERVE_RATIO),
      );

      let accumulatedTokens = 0;
      let splitIndex = history.length;

      for (let i = history.length - 1; i >= 0; i--) {
        const msgTokens = this.config.tokenizer([history[i]]);
        if (accumulatedTokens + msgTokens > preserveTarget) {
          break;
        }
        accumulatedTokens += msgTokens;
        splitIndex = i;
      }

      // Keep at least 1 message if a single message exceeds the preserve budget.
      if (splitIndex === history.length && history.length > 0) {
        splitIndex = history.length - 1;
      }

      return splitIndex > 0 ? { splitIndex, currentTokens: effectiveTokens } : null;
    }

    // ─── FeedTokenUsage path: simple total comparison, full compression ───
    const currentTokens = this._externalTokenUsage ?? TokenUtils.estimateObject(history);
    this._externalTokenUsage = null;

    if (currentTokens <= this.config.contextWindow) {
      return null;
    }

    // Keep the last N messages, compress everything else
    const keepCount = Math.min(
      this.config.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES,
      history.length,
    );
    const splitIndex = history.length - keepCount;

    return splitIndex > 0 ? { splitIndex, currentTokens } : null;
  }

  private async executeCompression(history: Message[], splitIndex: number): Promise<Message[]> {
    const toCompress = history.slice(0, splitIndex);
    const toKeep = history.slice(splitIndex);

    if (!this.config.compressionModel) {
      // No compression model — just discard old messages and keep recent ones.
      if (this.config.onCompress) {
        await this.config.onCompress(
          { role: 'system', content: Prompts.getFallbackCompressionSummary(toCompress.length) },
          toCompress.length,
        );
      }
      this._suppressNextCompression = true;
      return toKeep;
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
      role: 'system',
      content: summaryText,
    };

    if (this.config.onCompress) {
      await this.config.onCompress(summaryMessage, toCompress.length);
    }

    // E10: Suppress the immediate next compression check.
    this._suppressNextCompression = true;

    return [summaryMessage, ...toKeep];
  }
}
