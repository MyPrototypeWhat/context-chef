/**
 * A fast, zero-dependency token estimator.
 * While exact token counting requires model-specific tokenizers (like `tiktoken` or Anthropic's tokenizer),
 * loading WASM/heavy dictionaries in a lightweight library is often overkill.
 * 
 * This heuristic provides a safe, conservative estimate:
 * - English / Code / ASCII: ~ 4 characters per token
 * - CJK (Chinese, Japanese, Korean): ~ 1 to 1.5 tokens per character depending on the model
 */
export class TokenUtils {
  /**
   * Fast heuristic estimation of token count for a given text.
   * Overestimates slightly to be safe for context limits.
   */
  public static estimate(text: string): number {
    if (!text) return 0;

    // Match CJK characters (Chinese, Japanese, Korean)
    const cjkRegex = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g;
    const cjkMatch = text.match(cjkRegex);
    const cjkCount = cjkMatch ? cjkMatch.length : 0;
    
    const otherCount = text.length - cjkCount;
    
    // Conservative weights: 
    // - CJK: ~1.5 tokens per character (Claude/OpenAI average)
    // - Other: ~0.3 tokens per character (~3.3 chars per token)
    return Math.ceil(cjkCount * 1.5 + otherCount * 0.3);
  }

  /**
   * Estimates tokens for an array of messages or a single object by serializing it.
   */
  public static estimateObject(obj: any): number {
    if (typeof obj === 'string') {
      return this.estimate(obj);
    }
    return this.estimate(JSON.stringify(obj));
  }
}
