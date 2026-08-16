import { adapterRegistry } from './adapterRegistry';
import { AnthropicAdapter } from './anthropicAdapter';
import { GeminiAdapter } from './geminiAdapter';
import { OpenAIAdapter } from './openAIAdapter';
import { OpenAIResponsesAdapter } from './openAIResponsesAdapter';
import type { ITargetAdapter } from './targetAdapter';

/**
 * Side-effect module: registers built-in adapters under the `'builtin'`
 * sourceId on first import. Imported by `adapterFactory.ts` so the
 * registry is populated as soon as anything from this package is loaded.
 *
 * Built-ins can be replaced (`adapterRegistry.register('openai', myFork)`)
 * but typically should not be unregistered.
 */
adapterRegistry.register('openai', new OpenAIAdapter(), 'builtin');
adapterRegistry.register('anthropic', new AnthropicAdapter(), 'builtin');
adapterRegistry.register('gemini', new GeminiAdapter(), 'builtin');
// OpenAIResponsesPayload uses the Responses wire field `input` (not
// `messages`), so it does not yet satisfy the legacy TargetPayload shape.
// The cast is runtime-safe — the registry only forwards messages into
// compile(). Typed compile() overloads for 'openai-responses' land with the
// v4 TargetPayload widening in the main line.
adapterRegistry.register(
  'openai-responses',
  new OpenAIResponsesAdapter() as unknown as ITargetAdapter,
  'builtin',
);
