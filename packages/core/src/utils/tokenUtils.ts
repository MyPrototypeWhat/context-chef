import type { Message } from '../types';

/**
 * A fast, zero-dependency token estimator.
 * While exact token counting requires model-specific tokenizers (like `tiktoken` or Anthropic's tokenizer),
 * loading WASM/heavy dictionaries in a lightweight library is often overkill.
 *
 * This heuristic provides a safe, conservative estimate:
 * - English / Code / ASCII: ~ 4 characters per token
 * - CJK (Chinese, Japanese, Korean): ~ 1 to 1.5 tokens per character depending on the model
 */
export function estimate(text: string): number {
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
 * `_anthropic_origin` holds a verbatim copy of content the message's own
 * fields already carry; serializing it would count that content twice.
 */
function skipDuplicateContent(key: string, value: unknown): unknown {
  return key === '_anthropic_origin' ? undefined : value;
}

/**
 * Estimates tokens for an array of messages or a single object by serializing it.
 */
export function estimateObject(obj: unknown): number {
  if (typeof obj === 'string') {
    return estimate(obj);
  }
  return estimate(JSON.stringify(obj, skipDuplicateContent));
}

/**
 * What one attachment counts for in {@link estimateMessages}: about an image
 * at the size Anthropic scales images down to. Providers bill media by their
 * own formulas (image tiles, document pages), and the base64 counted as text
 * would overstate an image hundreds of times.
 */
export const ATTACHMENT_TOKENS = 1_600;

/**
 * {@link estimateObject} over messages, with each attachment at a flat
 * {@link ATTACHMENT_TOKENS} instead of its data.
 */
export function estimateMessages(messages: readonly Message[]): number {
  let attachments = 0;
  const text = JSON.stringify(messages, (key, value) => {
    if (key !== 'attachments') return skipDuplicateContent(key, value);
    attachments += Array.isArray(value) ? value.length : 0;
    return undefined;
  });
  return estimate(text) + attachments * ATTACHMENT_TOKENS;
}
