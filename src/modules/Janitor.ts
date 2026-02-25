import { Prompts } from '../prompts';
import type { Message } from '../types';
import { TokenUtils } from '../utils/TokenUtils';

export interface JanitorConfig {
  /**
   * (Legacy) The maximum number of messages to keep in history before triggering compression.
   */
  maxHistoryLimit?: number;

  /**
   * (Legacy) The number of recent messages to preserve during compression.
   */
  preserveRecentCount?: number;

  /**
   * [Recommended] The maximum token budget for the rolling history.
   * If the history exceeds this, compression is triggered.
   */
  maxHistoryTokens?: number;

  /**
   * [Recommended] The token budget to preserve for recent history when compressing.
   * E.g., if maxHistoryTokens is 20,000, you might preserve the recent 10,000 tokens.
   */
  preserveRecentTokens?: number;

  /**
   * A custom tokenizer function that receives the Message[] array directly.
   * If not provided, a fast heuristic estimator is used.
   * You can plug in `js-tiktoken` or Anthropic's tokenizer here for exact calculations.
   *
   * @example
   * tokenizer: (messages) => messages.reduce((sum, m) => sum + encode(m.content).length, 0)
   */
  tokenizer?: (messages: Message[]) => number;

  /**
   * Async hook to call a low-cost LLM (e.g. gpt-4o-mini) to summarize the truncated messages.
   * If not provided, a simple placeholder message is used.
   */
  compressionModel?: (messagesToCompress: Message[]) => Promise<string>;

  /**
   * Hook triggered ONLY when compression actually happens.
   * Useful for UI loaders ("Compressing memory..."), logging, or saving the compressed state back to a DB.
   */
  onCompress?: (summaryMessage: Message, truncatedCount: number) => void | Promise<void>;
}

export class Janitor {
  /** Externally reported token count from the last API response (E9). */
  private _externalTokenUsage: number | null = null;
  /** Suppresses the next compression check after a successful compression (E10). */
  private _suppressNextCompression = false;

  constructor(private config: JanitorConfig = {}) {}

  /**
   * Feeds an externally-reported token count (e.g. from the LLM API response) into the Janitor.
   * This value takes priority over the local heuristic estimate when both are available.
   * The caller decides which field to pass (input_tokens, prompt_tokens, total_tokens, etc.).
   * The value is consumed on the next compress() call and then cleared.
   */
  public feedTokenUsage(tokenCount: number): void {
    this._externalTokenUsage = tokenCount;
  }

  /**
   * Get the token count using either the provided custom tokenizer or the fast heuristic.
   */
  private getTokenCount(messages: Message[]): number {
    if (this.config.tokenizer) {
      return this.config.tokenizer(messages);
    }
    return TokenUtils.estimateObject(messages);
  }

  /**
   * Compresses the rolling history based on configured token budgets (or legacy message counts).
   */
  public async compress(history: Message[]): Promise<Message[]> {
    const splitIndex = this.evaluateBudget(history);
    if (splitIndex === null) return history;
    return this.executeCompression(history, splitIndex);
  }

  /**
   * Evaluates token/message budgets and returns the split index for compression,
   * or null if no compression is needed.
   */
  private evaluateBudget(history: Message[]): number | null {
    if (history.length === 0) return null;

    // E10: Skip check once after a successful compression to avoid cascading re-compression
    // before the external token count refreshes.
    if (this._suppressNextCompression) {
      this._suppressNextCompression = false;
      return null;
    }

    // 1. Token-based compression (Recommended)
    if (this.config.maxHistoryTokens) {
      const localEstimate = this.getTokenCount(history);
      // E9: Use the max of external API-reported count and local estimate as the effective total.
      const totalTokens = Math.max(localEstimate, this._externalTokenUsage ?? 0);
      this._externalTokenUsage = null; // Consume and clear after use

      if (totalTokens <= this.config.maxHistoryTokens) {
        return null;
      }

      const preserveTarget =
        this.config.preserveRecentTokens ?? Math.floor(this.config.maxHistoryTokens * 0.7);

      let accumulatedTokens = 0;
      let splitIndex = history.length;

      // Traverse backwards to find how many messages we can keep within the preserve budget
      for (let i = history.length - 1; i >= 0; i--) {
        const msgTokens = this.getTokenCount([history[i]]);
        if (accumulatedTokens + msgTokens > preserveTarget) {
          break; // We've hit the budget limit for recent messages
        }
        accumulatedTokens += msgTokens;
        splitIndex = i;
      }

      // If a single message is larger than the preserve budget, splitIndex might equal history.length.
      // We must keep at least 1 message if possible to avoid infinite loops, unless it's impossible.
      if (splitIndex === history.length && history.length > 0) {
        splitIndex = history.length - 1;
      }

      return splitIndex > 0 ? splitIndex : null;
    }

    // 2. Message count-based compression (Legacy fallback)
    const limit = this.config.maxHistoryLimit;
    if (limit && history.length > limit) {
      const preserveCount = this.config.preserveRecentCount ?? Math.floor(limit * 0.7);
      const splitIndex = Math.max(0, history.length - preserveCount);
      return splitIndex > 0 ? splitIndex : null;
    }

    // No limits reached
    return null;
  }

  private async executeCompression(history: Message[], splitIndex: number): Promise<Message[]> {
    const toCompress = history.slice(0, splitIndex);
    const toKeep = history.slice(splitIndex);

    let summaryText = Prompts.getFallbackCompressionSummary(toCompress.length);

    if (this.config.compressionModel) {
      try {
        const compressionMessages: Message[] = [
          ...toCompress,
          { role: 'user', content: Prompts.CONTEXT_COMPACTION_INSTRUCTION },
        ];
        const summary = await this.config.compressionModel(compressionMessages);
        summaryText = summary;
      } catch (error) {
        summaryText += `\n(Compression failed: ${error})`;
      }
    }

    const summaryMessage: Message = {
      role: 'system',
      content: summaryText,
    };

    if (this.config.onCompress) {
      await this.config.onCompress(summaryMessage, toCompress.length);
    }

    // E10: Suppress the immediate next compression check to prevent cascading re-compression.
    this._suppressNextCompression = true;

    return [summaryMessage, ...toKeep];
  }

}
