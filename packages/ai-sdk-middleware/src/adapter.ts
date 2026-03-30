import type {
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import type { Message, ToolCall } from '@context-chef/core';

/**
 * Converts an AI SDK V3 prompt to context-chef IR messages.
 *
 * Original AI SDK content is stored in `_originalContent` for lossless round-trip.
 * `_originalText` caches the extracted text so `toAISDK` can detect Janitor modifications.
 * `_providerOptions` preserves message-level provider options (e.g. Anthropic cache control).
 */
export function fromAISDK(prompt: LanguageModelV3Prompt): Message[] {
  const messages: Message[] = [];

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
        _originalContent: msg.content,
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
      const m: Message = {
        role: 'assistant',
        content: joinedText,
        _originalContent: msg.content,
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
            _originalContent: [part],
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
 * Converts context-chef IR messages back to AI SDK V3 prompt format.
 *
 * Uses `_originalContent` when content is unmodified (detected via `_originalText`).
 * Falls back to constructing from IR fields when content was modified by Janitor
 * (e.g. compact() cleared tool results) or for new messages (e.g. compression summaries).
 */
export function toAISDK(messages: Message[]): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const providerOptions = msg._providerOptions as SharedV3ProviderOptions | undefined;
    const contentModified = msg._originalText !== undefined && msg._originalText !== msg.content;

    if (msg.role === 'system') {
      prompt.push({
        role: 'system',
        content: msg.content,
        ...(providerOptions ? { providerOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'user') {
      const content =
        !contentModified && Array.isArray(msg._originalContent)
          ? (msg._originalContent as any)
          : [{ type: 'text' as const, text: msg.content }];
      prompt.push({
        role: 'user',
        content,
        ...(providerOptions ? { providerOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'assistant') {
      const content =
        !contentModified && Array.isArray(msg._originalContent)
          ? (msg._originalContent as any)
          : [{ type: 'text' as const, text: msg.content }];
      prompt.push({
        role: 'assistant',
        content,
        ...(providerOptions ? { providerOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'tool') {
      const toolResults: LanguageModelV3ToolResultPart[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const toolMsg = messages[i];
        const toolModified =
          toolMsg._originalText !== undefined && toolMsg._originalText !== toolMsg.content;

        if (!toolModified && toolMsg._originalContent) {
          toolResults.push(...(toolMsg._originalContent as LanguageModelV3ToolResultPart[]));
        } else {
          toolResults.push({
            type: 'tool-result',
            toolCallId: toolMsg.tool_call_id ?? '',
            toolName: (toolMsg._toolName as string) ?? 'unknown',
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
        .map((v: { type: string; text?: string }) => (v.type === 'text' ? (v.text ?? '') : ''))
        .filter(Boolean)
        .join('\n');
    default:
      return JSON.stringify(output);
  }
}
