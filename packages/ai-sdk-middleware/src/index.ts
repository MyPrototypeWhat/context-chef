import type { LanguageModelV3 } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';

import { createMiddleware } from './middleware';
import type { ContextChefOptions } from './types';

export { fromAISDK, toAISDK } from './adapter';
export { createMiddleware } from './middleware';
export type { CompressOptions, ContextChefOptions, TruncateOptions } from './types';

/**
 * Wraps an AI SDK language model with context-chef middleware for
 * transparent history compression, tool result truncation, and token budget management.
 *
 * @example
 * ```typescript
 * import { withContextChef } from '@context-chef/ai-sdk-middleware';
 * import { openai } from '@ai-sdk/openai';
 * import { generateText } from 'ai';
 *
 * const model = withContextChef(openai('gpt-4o'), {
 *   contextWindow: 128_000,
 *   compress: { model: openai('gpt-4o-mini') },
 *   truncate: { threshold: 5000, headChars: 500, tailChars: 1000 },
 * });
 *
 * // Use exactly like normal — zero other code changes
 * const result = await generateText({ model, messages, tools });
 * ```
 */
export function withContextChef(model: LanguageModelV3, options: ContextChefOptions): LanguageModelV3 {
  const middleware = createMiddleware(options);
  return wrapLanguageModel({ model, middleware });
}
