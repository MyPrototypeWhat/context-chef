import type {
  ChatCompletionMessageFunctionToolCall as SDKFunctionToolCall,
  ChatCompletionMessageParam as SDKMessageParam,
} from 'openai/resources/chat/completions/completions';
import { Prompts } from '../prompts';
import type {
  Attachment,
  ChefLogger,
  HistoryMessage,
  Message,
  OpenAIPayload,
  ParsedMessages,
} from '../types';
import { ensureValidHistory } from '../utils/ensureValidHistory';
import type { ITargetAdapter } from './targetAdapter';

// ─── Input: OpenAI → IR ───

/**
 * Extracts MIME type from a data URI (e.g. "data:image/png;base64,...").
 * Returns `fallback` for plain URLs and other non-data strings.
 * Shared with the OpenAI Responses adapter — single source of truth.
 */
export function extractMediaType(url: string, fallback: string): string {
  const match = url.match(/^data:([^;,]+)/);
  return match ? match[1] : fallback;
}

/**
 * Converts OpenAI Chat Completions messages to ContextChef IR.
 * Separates system messages from conversation history.
 *
 * Boundary sanitization: history is run through {@link ensureValidHistory}
 * to fix orphan tool results, missing tool results, and ensure the first
 * non-system message is a user message. This is a system boundary — IR
 * downstream of `setHistory` is trusted to satisfy invariants.
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
      // Leading system messages are the prompt's system layer. A system
      // message appearing MID-STREAM (after any conversation message) is
      // positional channel output — announcements re-rendered every compile
      // until retracted. Folding it into the system layer would bake
      // volatile text into the cacheable prefix and defeat
      // retractAnnouncement(), so it is skipped: ownership stays with the
      // chef state that injected it. Same contract as fromAnthropic /
      // fromOpenAIResponses.
      if (history.length > 0) continue;
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
              mediaType: extractMediaType(part.image_url.url, 'image/*'),
              data: part.image_url.url,
            });
          } else if (part.type === 'file') {
            attachments.push({
              mediaType: extractMediaType(part.file.file_data ?? '', 'image/*'),
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

  // Sanitize at boundary: enforce IR invariants before handing to caller.
  // Cast is safe — ensureValidHistory only inserts user/tool messages, never system.
  return { system, history: ensureValidHistory(history) as HistoryMessage[] };
}

// ─── Output: IR → OpenAI ───

/**
 * Deep-clones plain message data, dropping `undefined`-valued properties.
 * Equivalent to a `JSON.parse(JSON.stringify(...))` round-trip for this data
 * domain (plain objects/arrays/primitives) without serializing — the string
 * detour is measurably expensive for messages carrying base64 attachments.
 *
 * Matches JSON semantics for `toJSON`-bearing values (a Date lands as its
 * ISO string, not `{}`). Assumes acyclic data: a circular reference
 * overflows the stack, where the old round-trip threw a TypeError.
 */
function cloneWithoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(cloneWithoutUndefined) as T;
  }
  if (value !== null && typeof value === 'object') {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === 'function') {
      return cloneWithoutUndefined(toJSON.call(value)) as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = cloneWithoutUndefined(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Header for an Anthropic server-side compaction summary degraded to plain
 * text. Chat Completions has no compaction block, and the Anthropic API drops
 * everything before that block — silently stripping it on a provider switch
 * would lose the entire compacted history.
 */
const COMPACTION_SUMMARY_HEADER = '[Summary of earlier conversation (compacted server-side)]';

export interface OpenAIAdapterOptions {
  /**
   * When true, Anthropic-style `thinking` on assistant messages is converted
   * to a `<thinking>...</thinking>` text prefix instead of being dropped, so
   * reasoning survives cross-provider replay. `redacted_thinking` is NEVER
   * textified (it is an opaque encrypted blob) — it is dropped with a
   * one-time warning. Default: false (drop thinking, pre-4.0 behavior).
   */
  preserveThinkingAsText?: boolean;
  /** Sink for degradation warnings. Defaults to `console`. */
  logger?: ChefLogger;
}

export class OpenAIAdapter implements ITargetAdapter {
  private _redactedWarned = false;

  constructor(private readonly options: OpenAIAdapterOptions = {}) {}

  compile(messages: Message[]): OpenAIPayload {
    const formattedMessages: SDKMessageParam[] = messages.map((msg) => {
      // Strip internal/passthrough fields and thinking (Chat Completions does
      // not accept reasoning input, and IR-internal fields must never reach
      // the wire).
      const {
        _cache_breakpoint,
        // Chat Completions keeps system messages inline, so positional is the
        // only behavior here — the flag itself must not reach the wire.
        _positional,
        thinking,
        redacted_thinking,
        attachments,
        pinned: _pinned,
        _anthropic_compaction,
        _gemini_thought_signature,
        _openai_reasoning,
        ...cleanMsg
      } = msg;

      // Drop IR-only tool-call fields (Gemini thoughtSignature) — only
      // { id, type, function } may reach the Chat Completions wire.
      if (cleanMsg.tool_calls?.length) {
        cleanMsg.tool_calls = cleanMsg.tool_calls.map(({ id, type, function: fn }) => ({
          id,
          type,
          function: fn,
        }));
      }

      if (msg.role === 'assistant' && this.options.preserveThinkingAsText) {
        if (thinking?.thinking) {
          cleanMsg.content = `<thinking>\n${thinking.thinking}\n</thinking>\n\n${cleanMsg.content ?? ''}`;
        }
        if (redacted_thinking && !this._redactedWarned) {
          this._redactedWarned = true;
          (this.options.logger ?? console).warn(
            '[context-chef] redacted_thinking is an opaque encrypted blob and cannot be ' +
              'preserved as text — dropped on the OpenAI target (warned once).',
          );
        }
      }

      // Degrade an Anthropic server-side compaction to a marked summary block
      // prepended to the message text (it summarizes everything before it, so
      // it must come first — ahead of any textified thinking).
      if (typeof _anthropic_compaction === 'string') {
        cleanMsg.content = `${COMPACTION_SUMMARY_HEADER}\n${_anthropic_compaction}\n\n${cleanMsg.content ?? ''}`;
      }

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
        return cloneWithoutUndefined({
          ...cleanMsg,
          content: contentParts,
        }) as unknown as SDKMessageParam;
      }

      return cloneWithoutUndefined(cleanMsg) as SDKMessageParam;
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
