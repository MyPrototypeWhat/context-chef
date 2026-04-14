import type { ToolCall as CoreToolCall, Message } from '@context-chef/core';
import type { ContentPart, ModelMessage, ToolCall } from '@tanstack/ai';

/**
 * Extended IR message with pass-through fields for lossless TanStack AI round-trip.
 * `_originalContent` preserves multimodal content parts so unmodified messages
 * can be reconstructed without loss.
 * `_originalToolCalls` preserves providerMetadata on tool calls.
 */
export interface TanStackAIMessage extends Message {
  _originalContent?: ModelMessage['content'];
  _originalText?: string;
  _originalToolCalls?: ToolCall[];
}

/**
 * Converts TanStack AI ModelMessages to context-chef IR messages.
 *
 * Original content is stored in `_originalContent` for lossless round-trip.
 * `_originalText` caches extracted text so `toTanStackAI` can detect Janitor modifications.
 * `_originalToolCalls` preserves TanStack AI ToolCalls (including providerMetadata).
 */
export function fromTanStackAI(messages: ModelMessage[]): TanStackAIMessage[] {
  const result: TanStackAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractTextContent(msg.content);
      result.push({
        role: 'user',
        content: text,
        _originalContent: msg.content,
        _originalText: text,
        ...(msg.name ? { name: msg.name } : {}),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const text = extractTextContent(msg.content);
      const m: TanStackAIMessage = {
        role: 'assistant',
        content: text,
        _originalContent: msg.content,
        _originalText: text,
        ...(msg.name ? { name: msg.name } : {}),
      };
      if (msg.toolCalls?.length) {
        m.tool_calls = msg.toolCalls.map(convertToolCall);
        m._originalToolCalls = msg.toolCalls;
      }
      result.push(m);
      continue;
    }

    if (msg.role === 'tool') {
      const text = extractTextContent(msg.content);
      result.push({
        role: 'tool',
        content: text,
        tool_call_id: msg.toolCallId ?? '',
        _originalContent: msg.content,
        _originalText: text,
      });
    }
  }

  return result;
}

/**
 * Converts context-chef IR messages back to TanStack AI ModelMessages.
 *
 * Uses original content when unmodified (detected via `_originalText`).
 * Uses original tool calls when unmodified (detected via ID comparison).
 * Falls back to constructing from IR fields when modified by Janitor.
 */
export function toTanStackAI(messages: Message[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    const ext = msg as TanStackAIMessage;
    const contentModified = ext._originalText !== undefined && ext._originalText !== msg.content;

    if (msg.role === 'system') {
      // Defensive: TanStack AI ModelMessage has no 'system' role.
      // Converts to user message if system-role messages are injected
      // via onBeforeCompress or direct toTanStackAI calls.
      result.push({
        role: 'user' as const,
        content: msg.content,
      });
      continue;
    }

    if (msg.role === 'user') {
      result.push({
        role: 'user' as const,
        content:
          !contentModified && ext._originalContent !== undefined
            ? ext._originalContent
            : msg.content,
        ...(msg.name ? { name: msg.name } : {}),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const m: ModelMessage = {
        role: 'assistant' as const,
        content:
          !contentModified && ext._originalContent !== undefined
            ? ext._originalContent
            : msg.content,
        ...(msg.name ? { name: msg.name } : {}),
      };
      if (msg.tool_calls?.length) {
        // toolCallsUnmodified checks originals is defined, safe to cast
        m.toolCalls = toolCallsUnmodified(msg.tool_calls, ext._originalToolCalls)
          ? (ext._originalToolCalls as ToolCall[])
          : msg.tool_calls.map(
              (tc): ToolCall => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                },
              }),
            );
      }
      result.push(m);
      continue;
    }

    if (msg.role === 'tool') {
      result.push({
        role: 'tool' as const,
        content:
          !contentModified && ext._originalContent !== undefined
            ? ext._originalContent
            : msg.content,
        toolCallId: msg.tool_call_id ?? '',
      });
    }
  }

  return result;
}

/** Checks if IR tool_calls match the originals (same length and IDs). */
function toolCallsUnmodified(irCalls: CoreToolCall[], originals?: ToolCall[]): boolean {
  if (!originals || originals.length !== irCalls.length) return false;
  return irCalls.every((tc, i) => tc.id === originals[i].id);
}

/** Converts a TanStack AI ToolCall to core IR ToolCall. */
function convertToolCall(tc: ToolCall): CoreToolCall {
  return {
    id: tc.id,
    type: 'function',
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments,
    },
  };
}

/** Extracts text from ModelMessage content (string, null, or ContentPart[]). */
function extractTextContent(content: ModelMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return (content as ContentPart[])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { type: 'text'; content: string }).content)
    .join('\n');
}
