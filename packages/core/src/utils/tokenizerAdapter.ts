import type { Message } from '../types';

/**
 * Wrap a plain-text `encode` function (gpt-tokenizer, js-tiktoken, or anything
 * that returns an array-like of tokens) into the `(messages: Message[]) => number`
 * shape that `JanitorConfig.tokenizer` expects.
 *
 * The value of this helper is encoding the "which fields count" convention once:
 *
 * - `content`
 * - `thinking.thinking` (extended-thinking text)
 * - `redacted_thinking.data` (opaque blob — echoed back verbatim, so it costs tokens)
 * - every `tool_calls[]` entry's `function.name` and `function.arguments`
 * - plus `perMessageOverhead` (default 4) tokens per message for role/framing
 *
 * Tool-call arguments MUST be counted: in coding-agent histories the bulk of a
 * turn's span often lives in write/edit tool arguments (whole file bodies ride
 * in `function.arguments` as JSON), so skipping them undercounts exactly the
 * turns that dominate the window and defeats compression triggering.
 *
 * Limitation: `attachments` are skipped — base64 payloads do not tokenize as
 * text, and providers bill media by their own formulas (image tiles, document
 * pages), so running a text encoder over the blob would produce a number that
 * is wrong in both directions. Feed provider-reported usage via
 * `feedTokenUsage()` when attachment-heavy histories need precision.
 *
 * Counts are approximate across providers (a cl100k/o200k count applied to a
 * Claude or Gemini conversation drifts a few percent). That is safe in
 * practice: Janitor triggers at `contextWindow * triggerRatio` (default 0.7),
 * so the ~30% headroom absorbs cross-tokenizer drift comfortably.
 *
 * @example
 * ```ts
 * import { encode } from 'gpt-tokenizer';
 * import { createTokenizerAdapter, Janitor } from '@context-chef/core';
 *
 * const janitor = new Janitor({
 *   contextWindow: 200_000,
 *   tokenizer: createTokenizerAdapter(encode),
 * });
 * ```
 *
 * @param encode - Text-to-tokens function; only `.length` of the result is read.
 * @param options.perMessageOverhead - Tokens charged per message for role and
 *   framing metadata. Default 4 (the long-standing ChatML convention).
 */
export function createTokenizerAdapter(
  encode: (text: string) => ArrayLike<unknown>,
  options?: { perMessageOverhead?: number },
): (messages: Message[]) => number {
  const overhead = options?.perMessageOverhead ?? 4;

  return (messages: Message[]): number => {
    let total = 0;
    for (const message of messages) {
      total += overhead;
      if (message.content) total += encode(message.content).length;
      if (message.thinking?.thinking) total += encode(message.thinking.thinking).length;
      if (message.redacted_thinking?.data) total += encode(message.redacted_thinking.data).length;
      if (message.tool_calls) {
        for (const call of message.tool_calls) {
          total += encode(call.function.name).length;
          total += encode(call.function.arguments).length;
        }
      }
    }
    return total;
  };
}
