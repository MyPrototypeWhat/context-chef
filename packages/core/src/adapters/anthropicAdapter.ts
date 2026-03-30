import type {
  ContentBlockParam as SDKContentBlockParam,
  MessageParam as SDKMessageParam,
  RedactedThinkingBlockParam as SDKRedactedThinkingBlockParam,
  TextBlockParam as SDKTextBlockParam,
  ThinkingBlockParam as SDKThinkingBlockParam,
  ToolResultBlockParam as SDKToolResultBlockParam,
  ToolUseBlockParam as SDKToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { AnthropicPayload, Message } from '../types';
import type { ITargetAdapter } from './targetAdapter';

export class AnthropicAdapter implements ITargetAdapter {
  compile(messages: Message[]): AnthropicPayload {
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
          // Prepend thinking blocks before tool_use blocks (Anthropic requirement)
          if (msg.thinking) {
            const thinkingBlock: SDKThinkingBlockParam = {
              type: 'thinking',
              thinking: msg.thinking.thinking,
              signature: msg.thinking.signature ?? '',
            };
            content.push(thinkingBlock);
          }
          if (msg.redacted_thinking) {
            const redactedBlock: SDKRedactedThinkingBlockParam = {
              type: 'redacted_thinking',
              data: msg.redacted_thinking.data,
            };
            content.push(redactedBlock);
          }
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
          // Prepend thinking blocks before text block
          if (msg.thinking) {
            const thinkingBlock: SDKThinkingBlockParam = {
              type: 'thinking',
              thinking: msg.thinking.thinking,
              signature: msg.thinking.signature ?? '',
            };
            content.push(thinkingBlock);
          }
          if (msg.redacted_thinking) {
            const redactedBlock: SDKRedactedThinkingBlockParam = {
              type: 'redacted_thinking',
              data: msg.redacted_thinking.data,
            };
            content.push(redactedBlock);
          }
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
    };
  }
}
