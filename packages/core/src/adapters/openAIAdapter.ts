import type {
  ChatCompletionMessageFunctionToolCall as SDKFunctionToolCall,
  ChatCompletionMessageParam as SDKMessageParam,
} from 'openai/resources/chat/completions/completions';
import { Prompts } from '../prompts';
import type { Attachment, HistoryMessage, Message, OpenAIPayload, ParsedMessages } from '../types';
import type { ITargetAdapter } from './targetAdapter';

// ─── Input: OpenAI → IR ───

/**
 * Extracts MIME type from a data URI (e.g. "data:image/png;base64,...").
 * Returns 'image/*' as fallback for plain URLs.
 */
function extractMediaType(url: string): string {
  const match = url.match(/^data:([^;,]+)/);
  return match ? match[1] : 'image/*';
}

/**
 * Converts OpenAI Chat Completions messages to ContextChef IR.
 * Separates system messages from conversation history.
 *
 * @example
 * const { system, history } = fromOpenAI(openaiMessages);
 * chef.setSystemPrompt(system).setHistory(history);
 */
export function fromOpenAI(messages: SDKMessageParam[]): ParsedMessages {
  const system: Message[] = [];
  const history: HistoryMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n')
            : '';
      system.push({ role: 'system', content });
      continue;
    }

    if (msg.role === 'tool') {
      history.push({
        role: 'tool',
        content:
          typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((p) => p.type === 'text')
                  .map((p) => p.text)
                  .join('\n')
              : '',
        tool_call_id: msg.tool_call_id,
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const ir: HistoryMessage = {
        role: 'assistant',
        content: typeof msg.content === 'string' ? msg.content : '',
      };
      if (msg.tool_calls?.length) {
        ir.tool_calls = msg.tool_calls
          .filter((tc): tc is SDKFunctionToolCall => tc.type === 'function')
          .map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }));
      }
      history.push(ir);
      continue;
    }

    // user message
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        history.push({ role: 'user', content: msg.content });
        continue;
      }

      // Array content: extract text and media
      if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const attachments: Attachment[] = [];

        for (const part of msg.content) {
          if (part.type === 'text') {
            textParts.push(part.text);
          } else if (part.type === 'image_url') {
            attachments.push({
              mediaType: extractMediaType(part.image_url.url),
              data: part.image_url.url,
            });
          } else if (part.type === 'file') {
            attachments.push({
              mediaType: extractMediaType(part.file.file_data ?? ''),
              data: part.file.file_data ?? part.file.file_id ?? '',
              filename: part.file.filename,
            });
          }
        }

        const ir: HistoryMessage = {
          role: 'user',
          content: textParts.join('\n'),
        };
        if (attachments.length) ir.attachments = attachments;
        history.push(ir);
        continue;
      }

      // Fallback
      history.push({ role: 'user', content: '' });
    }
  }

  return { system, history };
}

// ─── Output: IR → OpenAI ───

export class OpenAIAdapter implements ITargetAdapter {
  compile(messages: Message[]): OpenAIPayload {
    const formattedMessages: SDKMessageParam[] = messages.map((msg) => {
      // Strip internal fields and thinking (Chat Completions does not accept reasoning input)
      const { _cache_breakpoint, thinking, redacted_thinking, attachments, ...cleanMsg } = msg;

      // Convert attachments to OpenAI content parts for user messages
      if (attachments?.length && (msg.role === 'user' || msg.role === 'system')) {
        const contentParts: Array<Record<string, unknown>> = [];
        if (cleanMsg.content) {
          contentParts.push({ type: 'text', text: cleanMsg.content });
        }
        for (const att of attachments) {
          if (att.mediaType.startsWith('image/')) {
            contentParts.push({ type: 'image_url', image_url: { url: att.data } });
          } else {
            contentParts.push({
              type: 'file',
              file: {
                ...(att.data.startsWith('http') ? {} : { file_data: att.data }),
                ...(att.filename ? { filename: att.filename } : {}),
              },
            });
          }
        }
        return JSON.parse(JSON.stringify({ ...cleanMsg, content: contentParts }));
      }

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
            if (m.role === 'user') {
              const currentContent = typeof m.content === 'string' ? m.content : '';
              const injected: SDKMessageParam = {
                ...m,
                content: `${currentContent}\n\n${Prompts.getPrefillEnforcement(prefillContent)}`,
              };
              formattedMessages[i] = injected;
              break;
            }
            if (m.role === 'system') {
              const currentContent = typeof m.content === 'string' ? m.content : '';
              const injected: SDKMessageParam = {
                ...m,
                content: `${currentContent}\n\n${Prompts.getPrefillEnforcement(prefillContent)}`,
              };
              formattedMessages[i] = injected;
              break;
            }
          }
        }
      }
    }

    return { messages: formattedMessages };
  }
}
