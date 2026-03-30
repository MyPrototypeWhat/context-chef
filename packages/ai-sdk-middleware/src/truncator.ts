import type {
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
} from '@ai-sdk/provider';
import { Offloader } from '@context-chef/core';
import type { TruncateOptions } from './types';

/**
 * Truncates tool-result content within an AI SDK prompt when it exceeds the configured threshold.
 * When a storage adapter is provided, original content is persisted and a URI is included in the output.
 */
export async function truncateToolResults(
  prompt: LanguageModelV3Prompt,
  options: TruncateOptions,
): Promise<LanguageModelV3Prompt> {
  const { threshold, headChars = 0, tailChars = 1000, storage } = options;

  const offloader = storage
    ? new Offloader({ threshold, adapter: storage, storageDir: '' })
    : null;

  const result: LanguageModelV3Prompt = [];

  for (const msg of prompt) {
    if (msg.role !== 'tool') {
      result.push(msg);
      continue;
    }

    const newContent: typeof msg.content = [];

    for (const part of msg.content) {
      if (part.type !== 'tool-result') {
        newContent.push(part);
        continue;
      }

      const text = extractText(part.output);
      if (text.length <= threshold || headChars + tailChars >= text.length) {
        newContent.push(part);
        continue;
      }

      // With storage: use Offloader to persist original and get a URI-annotated truncation
      if (offloader) {
        try {
          const vfsResult = await offloader.offloadAsync(text, { threshold, headChars, tailChars });
          newContent.push({
            ...part,
            output: { type: 'text', value: vfsResult.content } satisfies LanguageModelV3ToolResultOutput,
          } satisfies LanguageModelV3ToolResultPart);
          continue;
        } catch (error) {
          console.warn(
            `[context-chef] Storage adapter write failed for tool result (${part.toolCallId}). ` +
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

      newContent.push({
        ...part,
        output: { type: 'text', value: truncated } satisfies LanguageModelV3ToolResultOutput,
      } satisfies LanguageModelV3ToolResultPart);
    }

    result.push({ ...msg, content: newContent });
  }

  return result;
}

function extractText(output: LanguageModelV3ToolResultOutput): string {
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
      return '';
  }
}
