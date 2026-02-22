import type { TargetProvider } from '../types';
import { AnthropicAdapter } from './AnthropicAdapter';
import { GeminiAdapter } from './GeminiAdapter';
import type { ITargetAdapter } from './ITargetAdapter';
import { OpenAIAdapter } from './OpenAIAdapter';

export type { ITargetAdapter };

export function getAdapter(target: TargetProvider): ITargetAdapter {
  switch (target) {
    case 'openai':
      return new OpenAIAdapter();
    case 'anthropic':
      return new AnthropicAdapter();
    case 'gemini':
      return new GeminiAdapter();
    default:
      throw new Error(`Unsupported target provider: ${target}`);
  }
}

/** @deprecated Use getAdapter() instead */
export const AdapterFactory = { getAdapter };
