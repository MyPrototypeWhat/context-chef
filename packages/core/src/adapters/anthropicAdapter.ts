import type {
  ContentBlockParam as SDKContentBlockParam,
  DocumentBlockParam as SDKDocumentBlockParam,
  ImageBlockParam as SDKImageBlockParam,
  MessageParam as SDKMessageParam,
  RedactedThinkingBlockParam as SDKRedactedThinkingBlockParam,
  TextBlockParam as SDKTextBlockParam,
  ThinkingBlockParam as SDKThinkingBlockParam,
  ToolResultBlockParam as SDKToolResultBlockParam,
  ToolUseBlockParam as SDKToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  AnthropicPayload,
  Attachment,
  HistoryMessage,
  Message,
  ParsedMessages,
  ToolCall,
} from '../types';
import type { ITargetAdapter } from './targetAdapter';

// ─── Input: Anthropic → IR ───

/**
 * Converts Anthropic Messages API messages to ContextChef IR.
 * Separates system messages from conversation history.
 *
 * @param messages - Anthropic chat messages (user/assistant with content blocks)
 * @param system - Optional top-level system text blocks
 *
 * @example
 * const { system, history } = fromAnthropic(anthropicMessages, anthropicSystem);
 * chef.setSystemPrompt(system).setHistory(history);
 */
export function fromAnthropic(
  messages: SDKMessageParam[],
  system?: SDKTextBlockParam[],
): ParsedMessages {
  const systemMsgs: Message[] = [];
  const history: HistoryMessage[] = [];

  // Top-level system blocks
  if (system) {
    for (const block of system) {
      systemMsgs.push({ role: 'system', content: block.text });
    }
  }

  for (const msg of messages) {
    // String content shorthand
    if (typeof msg.content === 'string') {
      history.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Complex content blocks
    const textParts: string[] = [];
    const attachments: Attachment[] = [];
    const toolCalls: ToolCall[] = [];
    let thinking: { thinking: string; signature?: string } | undefined;
    let redactedThinking: { data: string } | undefined;

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          break;
        case 'image': {
          const src = block.source;
          if (src.type === 'base64') {
            attachments.push({
              mediaType: src.media_type,
              data: src.data,
            });
          } else {
            // URLImageSource
            attachments.push({
              mediaType: 'image/*',
              data: src.url,
            });
          }
          break;
        }
        case 'document': {
          const docSrc = block.source;
          if (docSrc.type === 'base64') {
            attachments.push({
              mediaType: docSrc.media_type,
              data: docSrc.data,
            });
          } else if (docSrc.type === 'url') {
            attachments.push({
              mediaType: 'application/pdf',
              data: docSrc.url,
            });
          } else if (docSrc.type === 'text') {
            attachments.push({
              mediaType: docSrc.media_type,
              data: docSrc.data,
            });
          } else if (docSrc.type === 'content') {
            const nested = docSrc.content;
            if (Array.isArray(nested)) {
              for (const c of nested) {
                if (c.type === 'text' && c.text) textParts.push(c.text);
              }
            }
          }
          break;
        }
        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
          break;
        case 'tool_result':
          // Tool results in Anthropic live inside user messages as content blocks.
          // Flatten to separate IR tool messages.
          history.push({
            role: 'tool',
            content:
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                      .map((c) => c.text)
                      .join('\n')
                  : '',
            tool_call_id: block.tool_use_id,
          });
          break;
        case 'thinking':
          thinking = {
            thinking: block.thinking,
            signature: block.signature,
          };
          break;
        case 'redacted_thinking':
          redactedThinking = { data: block.data };
          break;
        default:
          // Unknown block types are silently skipped
          break;
      }
    }

    // Only push a message for the role if there's meaningful content
    if (
      textParts.length ||
      toolCalls.length ||
      attachments.length ||
      thinking ||
      redactedThinking
    ) {
      const ir: HistoryMessage = {
        role: msg.role,
        content: textParts.join('\n'),
      };
      if (attachments.length) ir.attachments = attachments;
      if (toolCalls.length) ir.tool_calls = toolCalls;
      if (thinking) ir.thinking = thinking;
      if (redactedThinking) ir.redacted_thinking = redactedThinking;
      history.push(ir);
    }
  }

  return { system: systemMsgs, history };
}

// ─── Output: IR → Anthropic ───

/** Converts IR attachments to Anthropic image/document content blocks. */
function attachmentsToBlocks(attachments: Attachment[]): SDKContentBlockParam[] {
  const blocks: SDKContentBlockParam[] = [];
  for (const att of attachments) {
    const isUrl = att.data.startsWith('http');
    if (att.mediaType.startsWith('image/')) {
      const block: SDKImageBlockParam = isUrl
        ? { type: 'image', source: { type: 'url', url: att.data } }
        : {
            type: 'image',
            source: {
              type: 'base64',
              media_type: att.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: att.data,
            },
          };
      blocks.push(block);
    } else {
      const block: SDKDocumentBlockParam = isUrl
        ? { type: 'document', source: { type: 'url', url: att.data } }
        : {
            type: 'document',
            source: {
              type: 'base64',
              media_type: att.mediaType as 'application/pdf',
              data: att.data,
            },
          };
      blocks.push(block);
    }
  }
  return blocks;
}

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
          const textBlock: SDKTextBlockParam = { type: 'text', text: msg.content || '' };
          content.push(textBlock);
          // Attachments after text, before tool_use blocks
          if (msg.attachments?.length) {
            content.push(...attachmentsToBlocks(msg.attachments));
          }
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
          // Attachments after text block
          if (msg.attachments?.length) {
            content.push(...attachmentsToBlocks(msg.attachments));
          }
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
