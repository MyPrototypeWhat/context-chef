import { adapterRegistry } from './adapterRegistry';
import { AnthropicAdapter } from './anthropicAdapter';
import { GeminiAdapter } from './geminiAdapter';
import { OpenAIAdapter } from './openAIAdapter';

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
