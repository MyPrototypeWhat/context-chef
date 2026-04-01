import type { TargetProvider } from '../types';
import { AnthropicAdapter } from './anthropicAdapter';
import { GeminiAdapter } from './geminiAdapter';
import { OpenAIAdapter } from './openAIAdapter';
import type { ITargetAdapter } from './targetAdapter';

export type { ITargetAdapter };

const adapterCache = new Map<TargetProvider, ITargetAdapter>();

export function getAdapter(target: TargetProvider): ITargetAdapter {
  const cached = adapterCache.get(target);
  if (cached) return cached;

  let adapter: ITargetAdapter;
  switch (target) {
    case 'openai':
      adapter = new OpenAIAdapter();
      break;
    case 'anthropic':
      adapter = new AnthropicAdapter();
      break;
    case 'gemini':
      adapter = new GeminiAdapter();
      break;
    default:
      throw new Error(`Unsupported target provider: ${target}`);
  }

  adapterCache.set(target, adapter);
  return adapter;
}

/** @deprecated Use getAdapter() instead */
export const AdapterFactory = { getAdapter };
