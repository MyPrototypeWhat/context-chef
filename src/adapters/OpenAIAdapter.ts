import { Prompts } from '../prompts';
import type { Message, TargetPayload } from '../types';
import type { ITargetAdapter } from './ITargetAdapter';

export class OpenAIAdapter implements ITargetAdapter {
  compile(messages: Message[]): TargetPayload {
    // We deeply clone the messages to prevent reference mutations leaking back to the core
    const formattedMessages = messages.map((msg) => {
      const { _cache_breakpoint, ...cleanMsg } = msg;
      return JSON.parse(JSON.stringify(cleanMsg));
    });

    if (formattedMessages.length > 0) {
      const lastMsg = formattedMessages[formattedMessages.length - 1];
      if (
        lastMsg.role === 'assistant' &&
        (!lastMsg.tool_calls || lastMsg.tool_calls.length === 0)
      ) {
        // Pop the assistant message out of the array
        const popped = formattedMessages.pop();
        const prefillContent = popped?.content;

        // Find the last user or system message and create a NEW copy with the appended note
        if (prefillContent !== undefined) {
          for (let i = formattedMessages.length - 1; i >= 0; i--) {
            if (formattedMessages[i].role === 'user' || formattedMessages[i].role === 'system') {
              formattedMessages[i] = {
                ...formattedMessages[i],
                content: `${formattedMessages[i].content}\n\n${Prompts.getPrefillEnforcement(prefillContent)}`,
              };
              break;
            }
          }
        }
      }
    }

    return { messages: formattedMessages };
  }
}
