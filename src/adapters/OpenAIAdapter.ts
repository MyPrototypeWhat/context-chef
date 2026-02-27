import type { ChatCompletionMessageParam as SDKMessageParam } from 'openai/resources/chat/completions/completions';
import { Prompts } from '../prompts';
import type { Message, OpenAIPayload } from '../types';
import type { ITargetAdapter } from './iTargetAdapter';

export class OpenAIAdapter implements ITargetAdapter {
  compile(messages: Message[]): OpenAIPayload {
    const formattedMessages: SDKMessageParam[] = messages.map((msg) => {
      // Strip internal fields and thinking (Chat Completions does not accept reasoning input)
      const { _cache_breakpoint, thinking, redacted_thinking, ...cleanMsg } = msg;
      return JSON.parse(JSON.stringify(cleanMsg));
    });

    if (formattedMessages.length > 0) {
      const lastMsg = formattedMessages[formattedMessages.length - 1];
      if (
        lastMsg.role === 'assistant' &&
        (!('tool_calls' in lastMsg) || !lastMsg.tool_calls || lastMsg.tool_calls.length === 0)
      ) {
        const popped = formattedMessages.pop();
        const prefillContent = popped && 'content' in popped ? popped.content : undefined;

        if (prefillContent !== undefined && typeof prefillContent === 'string') {
          for (let i = formattedMessages.length - 1; i >= 0; i--) {
            const m = formattedMessages[i];
            if (m.role === 'user' || m.role === 'system') {
              const currentContent = 'content' in m ? m.content : '';
              formattedMessages[i] = {
                ...m,
                content: `${currentContent}\n\n${Prompts.getPrefillEnforcement(prefillContent)}`,
              } as SDKMessageParam;
              break;
            }
          }
        }
      }
    }

    return { messages: formattedMessages };
  }
}
