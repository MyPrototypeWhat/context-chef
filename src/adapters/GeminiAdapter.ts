import type { Message, TargetPayload } from '../types';
import type { ITargetAdapter } from './ITargetAdapter';

export class GeminiAdapter implements ITargetAdapter {
  compile(messages: Message[]): TargetPayload {
    const formattedMessages = messages.map((msg) => {
      // Gemini uses a distinct parts/role schema
      const geminiRole = msg.role === 'assistant' ? 'model' : 'user';

      const part: { text: string } = { text: msg.content };

      // Optional logic for Gemini tool formats
      if (msg.tool_calls) {
        // handle tools
      }

      return {
        role: geminiRole,
        parts: [part],
      };
    });

    return { messages: formattedMessages };
  }
}
