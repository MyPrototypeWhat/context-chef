import type {
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import type { Message, ToolCall } from '@context-chef/core';

/** Content types for each AI SDK message role */
type UserContent = Extract<LanguageModelV3Message, { role: 'user' }>['content'];
type AssistantContent = Extract<LanguageModelV3Message, { role: 'assistant' }>['content'];
type ToolContent = Extract<LanguageModelV3Message, { role: 'tool' }>['content'];

/**
 * Extended IR message with typed pass-through fields for lossless AI SDK round-trip.
 * Per-role content fields avoid union types, so no `as` casts are needed in `toAISDK`.
 */
export interface AISDKMessage extends Message {
  _userContent?: UserContent;
  _assistantContent?: AssistantContent;
  _toolContent?: ToolContent;
  _originalText?: string;
  _providerOptions?: SharedV3ProviderOptions;
  _toolName?: string;
}

/**
 * Converts an AI SDK V3 prompt to context-chef IR messages.
 *
 * Original AI SDK content is stored in per-role fields for lossless round-trip.
 * `_originalText` caches the extracted text so `toAISDK` can detect Janitor modifications.
 * `_providerOptions` preserves message-level provider options (e.g. Anthropic cache control).
 */
export function fromAISDK(prompt: LanguageModelV3Prompt): AISDKMessage[] {
  const messages: AISDKMessage[] = [];

  for (const msg of prompt) {
    if (msg.role === 'system') {
      messages.push({
        role: 'system',
        content: msg.content,
        ...(msg.providerOptions ? { _providerOptions: msg.providerOptions } : {}),
      });
      continue;
    }

    if (msg.role === 'user') {
      const text = msg.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      messages.push({
        role: 'user',
        content: text,
        _userContent: msg.content,
        _originalText: text,
        ...(msg.providerOptions ? { _providerOptions: msg.providerOptions } : {}),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const text: string[] = [];
      const toolCalls: ToolCall[] = [];
      let thinking: { thinking: string } | undefined;

      for (const part of msg.content) {
        if (part.type === 'text') text.push(part.text);
        else if (part.type === 'tool-call') {
          toolCalls.push({
            id: part.toolCallId,
            type: 'function',
            function: {
              name: part.toolName,
              arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
            },
          });
        } else if (part.type === 'reasoning') {
          thinking = { thinking: part.text };
        }
      }

      const joinedText = text.join('\n');
      const m: AISDKMessage = {
        role: 'assistant',
        content: joinedText,
        _assistantContent: msg.content,
        _originalText: joinedText,
        ...(msg.providerOptions ? { _providerOptions: msg.providerOptions } : {}),
      };
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
      if (thinking) m.thinking = thinking;
      messages.push(m);
      continue;
    }

    if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          const text = stringifyToolOutput(part.output);
          messages.push({
            role: 'tool',
            content: text,
            tool_call_id: part.toolCallId,
            _toolContent: [part],
            _originalText: text,
            _toolName: part.toolName,
          });
        }
      }
    }
  }

  return messages;
}

/**
 * Narrows a generic Message to AISDKMessage for typed access to pass-through fields.
 */
function asAISDK(msg: Message): AISDKMessage {
  return msg;
}

/**
 * Converts context-chef IR messages back to AI SDK V3 prompt format.
 *
 * Uses per-role original content when unmodified (detected via `_originalText`).
 * Falls back to constructing from IR fields when content was modified by Janitor
 * (e.g. compact() cleared tool results) or for new messages (e.g. compression summaries).
 */
export function toAISDK(messages: Message[]): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [];

  let i = 0;
  while (i < messages.length) {
    const msg = asAISDK(messages[i]);
    const contentModified = msg._originalText !== undefined && msg._originalText !== msg.content;

    if (msg.role === 'system') {
      prompt.push({
        role: 'system',
        content: msg.content,
        ...(msg._providerOptions ? { providerOptions: msg._providerOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'user') {
      prompt.push({
        role: 'user',
        content:
          !contentModified && msg._userContent
            ? msg._userContent
            : [{ type: 'text', text: msg.content }],
        ...(msg._providerOptions ? { providerOptions: msg._providerOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'assistant') {
      prompt.push({
        role: 'assistant',
        content:
          !contentModified && msg._assistantContent
            ? msg._assistantContent
            : [{ type: 'text', text: msg.content }],
        ...(msg._providerOptions ? { providerOptions: msg._providerOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'tool') {
      const toolResults: LanguageModelV3ToolResultPart[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const toolMsg = asAISDK(messages[i]);
        const toolModified =
          toolMsg._originalText !== undefined && toolMsg._originalText !== toolMsg.content;

        if (!toolModified && toolMsg._toolContent) {
          for (const part of toolMsg._toolContent) {
            if (part.type === 'tool-result') {
              toolResults.push(part);
            }
          }
        } else {
          toolResults.push({
            type: 'tool-result',
            toolCallId: toolMsg.tool_call_id ?? '',
            toolName: toolMsg._toolName ?? 'unknown',
            output: { type: 'text', value: toolMsg.content },
          });
        }
        i++;
      }
      prompt.push({ role: 'tool', content: toolResults });
      continue;
    }

    i++;
  }

  return prompt;
}

function stringifyToolOutput(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value);
    case 'content':
      return output.value
        .map((v) => (v.type === 'text' ? v.text : ''))
        .filter(Boolean)
        .join('\n');
    default:
      return JSON.stringify(output);
  }
}
