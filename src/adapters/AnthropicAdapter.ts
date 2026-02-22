import type { Message, TargetPayload } from '../types';
import type { ITargetAdapter } from './ITargetAdapter';
import type {
  MessageParam as SDKMessageParam,
  TextBlockParam as SDKTextBlockParam,
  ToolUseBlockParam as SDKToolUseBlockParam,
  ToolResultBlockParam as SDKToolResultBlockParam,
  ContentBlockParam as SDKContentBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';

export class AnthropicAdapter implements ITargetAdapter {
  compile(messages: Message[]): TargetPayload {
    const systemMessages: SDKTextBlockParam[] = [];
    const chatMessages: SDKMessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const sysObj: SDKTextBlockParam = { type: 'text', text: msg.content };
        if (msg._cache_breakpoint) {
          sysObj.cache_control = { type: 'ephemeral' };
        }
        systemMessages.push(sysObj);
      } else {
        const role: 'user' | 'assistant' =
          msg.role === 'tool' ? 'user' : (msg.role as 'user' | 'assistant');
        const content: SDKContentBlockParam[] = [];

        if (msg.role === 'tool') {
          const block: SDKToolResultBlockParam = {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id ?? '',
            content: msg.content,
          };
          content.push(block);
        } else if (msg.tool_calls) {
          content.push({ type: 'text', text: msg.content || '' } as SDKTextBlockParam);
          for (const tc of msg.tool_calls) {
            const block: SDKToolUseBlockParam = {
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            };
            content.push(block);
          }
        } else {
          const block: SDKTextBlockParam = { type: 'text', text: msg.content };
          if (msg._cache_breakpoint) {
            block.cache_control = { type: 'ephemeral' };
          }
          content.push(block);
        }

        chatMessages.push({ role, content });
      }
    }

    return {
      system: systemMessages.length > 0 ? systemMessages : undefined,
      messages: chatMessages,
    } as unknown as TargetPayload;
  }
}
