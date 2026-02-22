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
   * A custom tokenizer function. If not provided, a fast heuristic estimator is used.
   * You can plug in `js-tiktoken` or Anthropic's tokenizer here for exact calculations.
   */
  tokenizer?: (text: string) => number;

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
  constructor(private config: JanitorConfig = {}) {}

  /**
   * Get the token count using either the provided custom tokenizer or the fast heuristic.
   */
  private getTokenCount(messages: Message[]): number {
    if (this.config.tokenizer) {
      // Serialize to string so the custom tokenizer can parse it
      return this.config.tokenizer(JSON.stringify(messages));
    }
    return TokenUtils.estimateObject(messages);
  }

  /**
   * Compresses the rolling history based on configured token budgets (or legacy message counts).
   */
  public async compress(history: Message[]): Promise<Message[]> {
    if (history.length === 0) return history;

    // 1. Token-based compression (Recommended)
    if (this.config.maxHistoryTokens) {
      const totalTokens = this.getTokenCount(history);

      if (totalTokens <= this.config.maxHistoryTokens) {
        return history;
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

      return this.executeCompression(history, splitIndex);
    }

    // 2. Message count-based compression (Legacy fallback)
    const limit = this.config.maxHistoryLimit;
    if (limit && history.length > limit) {
      const preserveCount = this.config.preserveRecentCount ?? Math.floor(limit * 0.7);
      const splitIndex = Math.max(0, history.length - preserveCount);
      return this.executeCompression(history, splitIndex);
    }

    // No limits reached
    return history;
  }

  private async executeCompression(history: Message[], splitIndex: number): Promise<Message[]> {
    if (splitIndex <= 0) return history;

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

    return [summaryMessage, ...toKeep];
  }
}
