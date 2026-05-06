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
  const policy = buildPolicyMap(options.perTool);
  // TanStack's UIMessage → ModelMessage path constructs tool messages with only
  // `role / content / toolCallId` (no `name`). Resolve the tool name by
  // tracking each preceding assistant turn's toolCalls so `perTool` works for
  // standard chat() consumers, not just for callers who set `msg.name` by hand.
  const toolCallIdToName = new Map<string, string>();

  const result: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCallIdToName.set(tc.id, tc.function.name);
      }
    }

    if (msg.role !== 'tool') {
      result.push(msg);
      continue;
    }

    const toolName =
      msg.name ?? (msg.toolCallId ? toolCallIdToName.get(msg.toolCallId) : undefined);
    const toolPolicy = toolName ? policy.get(toolName) : undefined;
    if (toolPolicy?.preserve) {
      // Preserve = full bypass: no truncation, no storage write.
      result.push(msg);
      continue;
    }

    const effThreshold = toolPolicy?.threshold ?? threshold;
    const effHeadChars = toolPolicy?.headChars ?? headChars;
    const effTailChars = toolPolicy?.tailChars ?? tailChars;

    const text = extractToolText(msg.content);
    if (text.length <= effThreshold || effHeadChars + effTailChars >= text.length) {
      result.push(msg);
      continue;
    }

    // With storage: use Offloader to persist original and get a URI-annotated truncation
    if (offloader) {
      try {
        const vfsResult = await offloader.offloadAsync(text, {
          threshold: effThreshold,
          headChars: effHeadChars,
          tailChars: effTailChars,
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
    const head = text.slice(0, effHeadChars);
    const tail = text.slice(text.length - effTailChars);
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

type ToolPolicy =
  | { preserve: true }
  | {
      preserve?: false;
      threshold?: number;
      headChars?: number;
      tailChars?: number;
    };

/**
 * Normalises `perTool` into a name → policy lookup.
 * Bare strings become `{ preserve: true }`; objects keep their partial overrides.
 * Last entry wins on duplicate names.
 */
function buildPolicyMap(perTool: TruncateOptions['perTool']): Map<string, ToolPolicy> {
  const map = new Map<string, ToolPolicy>();
  if (!perTool) return map;
  for (const entry of perTool) {
    if (typeof entry === 'string') {
      map.set(entry, { preserve: true });
    } else {
      map.set(entry.name, {
        threshold: entry.threshold,
        headChars: entry.headChars,
        tailChars: entry.tailChars,
      });
    }
  }
  return map;
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
