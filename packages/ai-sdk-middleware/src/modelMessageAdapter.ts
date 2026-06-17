import type { LanguageModelV3ToolResultOutput } from '@ai-sdk/provider';
import {
  type Attachment,
  ensureValidHistory,
  type Message,
  type ToolCall,
} from '@context-chef/core';
import type { ModelMessage } from 'ai';

import { stringifyToolOutput } from './adapter';

// NOTE: This adapter intentionally parallels src/adapter.ts (the V3 adapter). The
// user/assistant/file extraction logic is duplicated by design; keep the two in
// sync. The deltas here are deliberate: string-shorthand content, ImagePart, and
// approval parts — none of which exist at the V3 (LanguageModelV3Prompt) altitude.

// Content/part types derived from ModelMessage — no part-type imports needed
// (provider-utils does not export them all stably). Same trick as adapter.ts.
type UserContent = Extract<ModelMessage, { role: 'user' }>['content'];
type AssistantContent = Extract<ModelMessage, { role: 'assistant' }>['content'];
type ToolContent = Extract<ModelMessage, { role: 'tool' }>['content'];
type ProviderOptions = Extract<ModelMessage, { role: 'system' }>['providerOptions'];

/**
 * IR message carrying the original ModelMessage content for lossless round-trip.
 * Parallel to AISDKMessage (the V3 adapter's carrier) but typed to the
 * application-layer ModelMessage shapes, and on distinct `_mm*` fields so the two
 * adapters can never read each other's pass-through by accident.
 */
export interface ModelMessageIR extends Message {
  _mmUserContent?: UserContent;
  _mmAssistantContent?: AssistantContent;
  _mmToolContent?: ToolContent;
  _mmOriginalText?: string;
  _mmProviderOptions?: ProviderOptions;
  _mmToolName?: string;
}

/**
 * Converts AI SDK `ModelMessage[]` (the application/SDK altitude — what
 * `generateText`/`prepareStep` use) into context-chef IR.
 *
 * `content` may be a plain `string` (the SDK shorthand); it is preserved on the
 * `_mm*Content` pass-through so an unmodified message round-trips byte-exact
 * (string stays string). Boundary-sanitized via `ensureValidHistory`.
 *
 * Tool messages: one IR `role:'tool'` message per `tool-result` part (so
 * `groupIntoTurns`/orphan detection works per result). `tool-approval-response`
 * parts have no IR home; they are appended in order to the adjacent result's
 * pass-through so coalescing in `toModelMessages` restores them. A tool message
 * with no tool-result at all is dropped by sanitization (not a real durable
 * input).
 */
export function fromModelMessages(messages: ModelMessage[]): ModelMessageIR[] {
  const ir: ModelMessageIR[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      ir.push({
        role: 'system',
        content: msg.content,
        ...(msg.providerOptions ? { _mmProviderOptions: msg.providerOptions } : {}),
      });
      continue;
    }

    if (msg.role === 'user') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('\n');

      const attachments: Attachment[] = [];
      if (typeof msg.content !== 'string') {
        for (const part of msg.content) {
          if (part.type === 'file') {
            attachments.push({
              mediaType: part.mediaType,
              data: typeof part.data === 'string' ? part.data : '',
              ...(part.filename ? { filename: part.filename } : {}),
            });
          } else if (part.type === 'image') {
            attachments.push({
              mediaType: part.mediaType ?? 'image/*',
              data: typeof part.image === 'string' ? part.image : '',
            });
          }
        }
      }

      const m: ModelMessageIR = {
        role: 'user',
        content: text,
        _mmUserContent: msg.content,
        _mmOriginalText: text,
        ...(msg.providerOptions ? { _mmProviderOptions: msg.providerOptions } : {}),
      };
      if (attachments.length) m.attachments = attachments;
      ir.push(m);
      continue;
    }

    if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];
      const attachments: Attachment[] = [];
      let thinking: { thinking: string } | undefined;

      if (typeof msg.content === 'string') {
        textParts.push(msg.content);
      } else {
        for (const part of msg.content) {
          if (part.type === 'text') {
            textParts.push(part.text);
          } else if (part.type === 'tool-call') {
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
          } else if (part.type === 'file') {
            attachments.push({
              mediaType: part.mediaType,
              data: typeof part.data === 'string' ? part.data : '',
              ...(part.filename ? { filename: part.filename } : {}),
            });
          }
          // tool-approval-request parts ride through _mmAssistantContent verbatim (no IR projection).
        }
      }

      const joined = textParts.join('\n');
      const m: ModelMessageIR = {
        role: 'assistant',
        content: joined,
        _mmAssistantContent: msg.content,
        _mmOriginalText: joined,
        ...(msg.providerOptions ? { _mmProviderOptions: msg.providerOptions } : {}),
      };
      if (toolCalls.length) m.tool_calls = toolCalls;
      if (thinking) m.thinking = thinking;
      if (attachments.length) m.attachments = attachments;
      ir.push(m);
      continue;
    }

    if (msg.role === 'tool') {
      let anchor: ModelMessageIR | undefined;
      const pending: ToolContent = [];
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          // ModelMessage's ToolResultOutput is a structural superset of V3's (extra content[] members); stringifyToolOutput only reads .type/.value, so the cast is safe and matches the V3 adapter's projection.
          const text = stringifyToolOutput(part.output as LanguageModelV3ToolResultOutput);
          anchor = {
            role: 'tool',
            content: text,
            tool_call_id: part.toolCallId,
            _mmToolContent: [...pending, part],
            _mmOriginalText: text,
            _mmToolName: part.toolName,
          };
          pending.length = 0;
          ir.push(anchor);
        } else if (anchor?._mmToolContent) {
          anchor._mmToolContent.push(part);
        } else {
          // Approval part seen before any tool-result: buffer it to prepend to
          // the next result. If no result ever follows (a tool message with zero
          // results), these are dropped — an unreachable shape for real input,
          // since ensureValidHistory sanitizes resultless tool messages away.
          pending.push(part);
        }
      }
    }
  }

  return ensureValidHistory(ir) as ModelMessageIR[];
}

function asMM(msg: Message): ModelMessageIR {
  return msg;
}

/**
 * Converts context-chef IR back to AI SDK `ModelMessage[]`.
 *
 * Unmodified messages emit their original content verbatim (via `_mm*` fields),
 * so string content stays a string and reasoning/approval parts round-trip
 * byte-exact. Janitor-modified messages and synthetic messages (e.g. a
 * compression summary, which has no pass-through) are rebuilt from IR fields.
 * For a modified tool message this rebuild emits only a single `tool-result`
 * from the IR text — any co-located `tool-approval-response` parts are
 * intentionally dropped, since a modified/cleared result is being collapsed
 * anyway.
 */
export function toModelMessages(messages: Message[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = asMM(messages[i]);
    const modified = msg._mmOriginalText !== undefined && msg._mmOriginalText !== msg.content;

    if (msg.role === 'system') {
      out.push({
        role: 'system',
        content: msg.content,
        ...(msg._mmProviderOptions ? { providerOptions: msg._mmProviderOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'user') {
      out.push({
        role: 'user',
        content:
          !modified && msg._mmUserContent !== undefined
            ? msg._mmUserContent
            : [{ type: 'text', text: msg.content }],
        ...(msg._mmProviderOptions ? { providerOptions: msg._mmProviderOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'assistant') {
      out.push({
        role: 'assistant',
        content:
          !modified && msg._mmAssistantContent !== undefined
            ? msg._mmAssistantContent
            : [{ type: 'text', text: msg.content }],
        ...(msg._mmProviderOptions ? { providerOptions: msg._mmProviderOptions } : {}),
      });
      i++;
      continue;
    }

    if (msg.role === 'tool') {
      const content: ToolContent = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const t = asMM(messages[i]);
        const tModified = t._mmOriginalText !== undefined && t._mmOriginalText !== t.content;
        if (!tModified && t._mmToolContent) {
          content.push(...t._mmToolContent);
        } else {
          content.push({
            type: 'tool-result',
            toolCallId: t.tool_call_id ?? '',
            toolName: t._mmToolName ?? t.name ?? 'unknown',
            output: { type: 'text', value: t.content },
          });
        }
        i++;
      }
      out.push({ role: 'tool', content });
      continue;
    }

    i++;
  }

  return out;
}
