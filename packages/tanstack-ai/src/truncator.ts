import { Offloader } from '@context-chef/core';
import type { ModelMessage } from '@tanstack/ai';
import type { TruncateOptions } from './types';

/**
 * Truncates tool-result content within TanStack AI messages when it exceeds the configured threshold.
 * When a storage adapter is provided, original content is persisted and a URI is included in the output.
 */
export async function truncateToolResults(
  messages: ModelMessage[],
  options: TruncateOptions,
): Promise<ModelMessage[]> {
  const { threshold, headChars = 0, tailChars = 1000, storage } = options;

  const offloader = storage ? new Offloader({ threshold, adapter: storage }) : null;

  const result: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role !== 'tool') {
      result.push(msg);
      continue;
    }

    const text = extractToolText(msg.content);
    if (text.length <= threshold || headChars + tailChars >= text.length) {
      result.push(msg);
      continue;
    }

    // With storage: use Offloader to persist original and get a URI-annotated truncation
    if (offloader) {
      try {
        const vfsResult = await offloader.offloadAsync(text, {
          threshold,
          headChars,
          tailChars,
        });
        result.push({ ...msg, content: vfsResult.content });
        continue;
      } catch (error) {
        console.warn(
          `[context-chef] Storage adapter write failed for tool result (${msg.toolCallId}). ` +
            `Falling back to simple truncation. Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Fall through to simple truncation below
      }
    }

    // Without storage: simple truncation, original is discarded
    const head = text.slice(0, headChars);
    const tail = text.slice(text.length - tailChars);
    const totalLines = text.split('\n').length;

    const truncated = [
      head,
      `\n--- truncated (${totalLines} lines, ${text.length} chars total) ---\n`,
      tail,
    ]
      .filter(Boolean)
      .join('')
      .trim();

    result.push({ ...msg, content: truncated });
  }

  return result;
}

/** Extracts text from tool message content. */
function extractToolText(content: ModelMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  // ContentPart array — extract text parts
  return (content as Array<{ type: string; content?: string }>)
    .filter((p) => p.type === 'text')
    .map((p) => p.content ?? '')
    .filter(Boolean)
    .join('\n');
}
