import {
  type Attachment,
  type ToolCall as CoreToolCall,
  ensureValidHistory,
  type Message,
} from '@context-chef/core';
import type { ContentPart, ModelMessage, ToolCall } from '@tanstack/ai';

/**
 * Extended IR message with pass-through fields for lossless TanStack AI round-trip.
 *
 * `_original` holds the source ModelMessage by reference; `toTanStackAI`
 * re-emits its fields verbatim for every aspect (content / tool calls /
 * thinking) the pipeline did not modify, so multimodal parts, tool-call
 * `metadata`, `id`, and `createdAt` survive untouched. Modification is
 * detected per aspect by re-deriving the projection from `_original` and
 * comparing it against the IR field.
 */
export interface TanStackAIMessage extends Message {
  _original?: ModelMessage;
}

/**
 * Converts TanStack AI ModelMessages (0.44 shape) to context-chef IR messages.
 *
 * Projections:
 * - `content` — text parts joined with `\n` (string content passes through;
 *   `null` becomes `''`). Original content round-trips via `_original`.
 * - `toolCalls` → IR `tool_calls` (id/type/function only; `metadata` rides
 *   on `_original` and is restored when the calls are unmodified).
 * - `thinking: Array<{content, signature?}>` → IR `thinking` as a single
 *   `{ thinking, signature }`: contents joined with `\n`, signature taken
 *   from the FIRST element. This projection is lossy in isolation, but the
 *   full array round-trips losslessly via `_original` whenever the message's
 *   thinking is not modified or cleared by the pipeline.
 * - Media content parts (image/audio/video/document) → IR `attachments`
 *   presence signal (`mediaType` from `source.mimeType` or a `type/*`
 *   fallback, `data` from `source.value`). Read by Janitor to steer the
 *   compression prompt; the real parts round-trip via `_original`.
 *
 * Note: TanStack AI 0.44 has no `system` role in `ModelMessage` — system
 * prompts travel separately via `config.systemPrompts` and never pass
 * through this adapter.
 *
 * Boundary sanitization: the result is run through {@link ensureValidHistory}
 * to fix orphan tool results, missing tool results, and ensure the first
 * message is a user message. This is a system boundary — IR downstream is
 * trusted to satisfy invariants.
 */
export function fromTanStackAI(messages: ModelMessage[]): TanStackAIMessage[] {
  const result: TanStackAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const m: TanStackAIMessage = {
        role: 'user',
        content: extractTextContent(msg.content),
        _original: msg,
        ...(msg.name ? { name: msg.name } : {}),
      };
      const attachments = extractAttachments(msg.content);
      if (attachments.length) m.attachments = attachments;
      result.push(m);
      continue;
    }

    if (msg.role === 'assistant') {
      const m: TanStackAIMessage = {
        role: 'assistant',
        content: extractTextContent(msg.content),
        _original: msg,
        ...(msg.name ? { name: msg.name } : {}),
      };
      if (msg.toolCalls?.length) {
        m.tool_calls = msg.toolCalls.map(convertToolCall);
      }
      if (msg.thinking?.length) {
        m.thinking = {
          thinking: joinThinking(msg.thinking),
          ...(msg.thinking[0]?.signature ? { signature: msg.thinking[0].signature } : {}),
        };
      }
      const attachments = extractAttachments(msg.content);
      if (attachments.length) m.attachments = attachments;
      result.push(m);
      continue;
    }

    if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        content: extractTextContent(msg.content),
        tool_call_id: msg.toolCallId ?? '',
        _original: msg,
        ...(msg.name ? { name: msg.name } : {}),
      });
    }
  }

  // Sanitize at boundary: enforce IR invariants before handing to caller.
  // Cast is safe — ensureValidHistory only inserts plain user/tool messages
  // without pass-through fields; toTanStackAI falls back to constructing
  // from IR fields for any message lacking them.
  return ensureValidHistory(result) as TanStackAIMessage[];
}

/**
 * Converts context-chef IR messages back to TanStack AI ModelMessages.
 *
 * Per-aspect reconstruction: each aspect (content, tool calls, thinking)
 * uses the original field verbatim when the IR projection is unmodified,
 * and is rebuilt from IR fields when the pipeline changed it:
 *
 * - Modified content → IR text replaces the original content wholesale
 *   (multimodal parts of a rewritten message are dropped by design).
 * - Modified tool calls (id set changed) → rebuilt without `metadata`.
 * - Cleared thinking (IR `thinking` absent while the original had it) →
 *   the `thinking` field is omitted. Modified thinking text → rebuilt as a
 *   single-element array carrying the IR signature (if any).
 *
 * IR `role: 'system'` messages (possible via `onBeforeCompress` or direct
 * calls — never produced by `fromTanStackAI`) are converted to `user`
 * messages, since TanStack AI's ModelMessage has no system role.
 */
export function toTanStackAI(messages: Message[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    const original = (msg as TanStackAIMessage)._original;
    // Re-emit the original content (multimodal parts included) while it still
    // projects to exactly the IR text; a pipeline rewrite falls back to the IR.
    const content =
      original !== undefined && extractTextContent(original.content) === msg.content
        ? original.content
        : msg.content;

    if (msg.role === 'system') {
      // Defensive: TanStack AI ModelMessage has no 'system' role.
      result.push({ role: 'user' as const, content: msg.content });
      continue;
    }

    if (msg.role === 'user') {
      result.push({
        ...(original ? passthroughFields(original) : {}),
        role: 'user' as const,
        content,
        ...(msg.name ? { name: msg.name } : {}),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const m: ModelMessage = {
        ...(original ? passthroughFields(original) : {}),
        role: 'assistant' as const,
        content,
        ...(msg.name ? { name: msg.name } : {}),
      };
      if (msg.tool_calls?.length) {
        m.toolCalls = toolCallsUnmodified(msg.tool_calls, original?.toolCalls)
          ? (original?.toolCalls as ToolCall[])
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
      if (msg.thinking?.thinking) {
        const originalThinking = original?.thinking?.length ? original.thinking : undefined;
        m.thinking =
          originalThinking && joinThinking(originalThinking) === msg.thinking.thinking
            ? originalThinking
            : [
                {
                  content: msg.thinking.thinking,
                  ...(msg.thinking.signature ? { signature: msg.thinking.signature } : {}),
                },
              ];
      }
      result.push(m);
      continue;
    }

    if (msg.role === 'tool') {
      result.push({
        ...(original ? passthroughFields(original) : {}),
        role: 'tool' as const,
        content,
        toolCallId: msg.tool_call_id ?? '',
        ...(msg.name ? { name: msg.name } : {}),
      });
    }
  }

  return result;
}

/** Message-level fields carried over verbatim from the original ModelMessage. */
function passthroughFields(original: ModelMessage): Partial<ModelMessage> {
  return {
    ...(original.id !== undefined ? { id: original.id } : {}),
    ...(original.createdAt !== undefined ? { createdAt: original.createdAt } : {}),
  };
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

/** Joins a ModelMessage thinking array into the IR single-string projection. */
function joinThinking(thinking: NonNullable<ModelMessage['thinking']>): string {
  return thinking.map((t) => t.content).join('\n');
}

/** Extracts text from ModelMessage content (string, null, or ContentPart[]). */
function extractTextContent(content: ModelMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.content)
    .join('\n');
}

/** MIME-type fallbacks when a media part's source carries no mimeType. */
const MEDIA_TYPE_FALLBACK: Record<string, string> = {
  image: 'image/*',
  audio: 'audio/*',
  video: 'video/*',
  document: 'application/octet-stream',
};

/**
 * Projects media content parts into IR attachments. `data` carries the
 * source value (base64 for `data` sources, the URL for `url` sources) —
 * read by Janitor only as a presence/metadata signal; the real parts
 * round-trip via `_original`.
 */
function extractAttachments(content: ModelMessage['content']): Attachment[] {
  if (content == null || typeof content === 'string') return [];
  const attachments: Attachment[] = [];
  for (const part of content) {
    if (part.type === 'text') continue;
    attachments.push({
      mediaType:
        part.source.mimeType ?? MEDIA_TYPE_FALLBACK[part.type] ?? 'application/octet-stream',
      data: part.source.value,
    });
  }
  return attachments;
}
