import type { Message, TargetPayload } from '../types';
import type { ITargetAdapter } from './ITargetAdapter';

interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicChatContentBlock {
  type: 'text' | 'tool_result' | 'tool_use';
  text?: string;
  tool_use_id?: string;
  content?: string;
  id?: string;
  name?: string;
  input?: unknown;
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicChatMessage {
  role: string;
  content: AnthropicChatContentBlock[];
}

export class AnthropicAdapter implements ITargetAdapter {
  compile(messages: Message[]): TargetPayload {
    // Anthropic API separates `system` messages from `messages` array
    const systemMessages: AnthropicSystemBlock[] = [];
    const chatMessages: AnthropicChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const sysObj: AnthropicSystemBlock = { type: 'text', text: msg.content };
        // Anthropic Prompt Caching: Add ephemeral cache_control to marked breakpoints
        if (msg._cache_breakpoint) {
          sysObj.cache_control = { type: 'ephemeral' };
        }
        systemMessages.push(sysObj);
      } else {
        const chatObj: AnthropicChatMessage = {
          role: msg.role === 'tool' ? 'user' : msg.role, // Anthropic handles tools slightly differently
          content: [],
        };

        // Handle tool calls / tool results specific mapping for Anthropic...
        if (msg.role === 'tool') {
          chatObj.content.push({
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          });
        } else if (msg.tool_calls) {
          // Map tool calls
          chatObj.content.push({ type: 'text', text: msg.content || '' });
          for (const tc of msg.tool_calls) {
            chatObj.content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            });
          }
        } else {
          chatObj.content.push({ type: 'text', text: msg.content });
          if (msg._cache_breakpoint) {
            // You can also put cache_control on regular messages
            (
              chatObj.content[chatObj.content.length - 1] as AnthropicChatContentBlock
            ).cache_control = {
              type: 'ephemeral',
            };
          }
        }

        chatMessages.push(chatObj);
      }
    }

    return {
      // We attach system here for easy destructuring by the user SDK
      system: systemMessages.length > 0 ? systemMessages : undefined,
      messages: chatMessages,
    } as TargetPayload;
  }
}
