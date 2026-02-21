import { TargetProvider } from '../types';
import { ITargetAdapter } from './ITargetAdapter';
import { OpenAIAdapter } from './OpenAIAdapter';
import { AnthropicAdapter } from './AnthropicAdapter';
import { GeminiAdapter } from './GeminiAdapter';

export type { ITargetAdapter };

export class AdapterFactory {
  static getAdapter(target: TargetProvider): ITargetAdapter {
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
}
