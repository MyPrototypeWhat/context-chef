import { Prompts } from '../prompts';
import type {
  Attachment,
  CompileMeta,
  HistoryMessage,
  Message,
  ParsedMessages,
  ToolCall,
  ToolDefinition,
} from '../types';
import { ensureValidHistory } from '../utils/ensureValidHistory';
import { extractMediaType } from './openAIAdapter';

// ─── Wire shapes (OpenAI Responses API input items) ───

/** User-authored text part. */
export interface OpenAIResponsesInputTextPart {
  type: 'input_text';
  text: string;
}

/** Assistant-authored text part. */
export interface OpenAIResponsesOutputTextPart {
  type: 'output_text';
  text: string;
}

/** Image part — `image_url` is an http(s) URL or a data: URL. */
export interface OpenAIResponsesInputImagePart {
  type: 'input_image';
  image_url: string;
}

/** File part — either inline `file_data` (data: URL) or a remote `file_url`. */
export interface OpenAIResponsesInputFilePart {
  type: 'input_file';
  file_data?: string;
  file_url?: string;
  filename?: string;
}

export type OpenAIResponsesContentPart =
  | OpenAIResponsesInputTextPart
  | OpenAIResponsesOutputTextPart
  | OpenAIResponsesInputImagePart
  | OpenAIResponsesInputFilePart;

/** Conversation message item. `type` may be omitted on input when `role` is present. */
export interface OpenAIResponsesMessageItem {
  type?: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | OpenAIResponsesContentPart[];
}

/** Tool invocation item. Correlated with its output via `call_id`. */
export interface OpenAIResponsesFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  /** JSON string */
  arguments: string;
  id?: string;
  status?: string;
}

/** Tool result item. Correlated with its call via `call_id`. */
export interface OpenAIResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string | OpenAIResponsesContentPart[];
  id?: string;
  status?: string;
}

/**
 * Reasoning item. `encrypted_content` is an opaque blob that must be echoed
 * byte-identically in multi-turn (`store: false`) conversations. The index
 * signature lets unknown future fields survive the IR round-trip verbatim.
 */
export interface OpenAIResponsesReasoningItem {
  type: 'reasoning';
  id: string;
  summary: Array<{ type: 'summary_text'; text: string }>;
  content?: Array<{ type: 'reasoning_text'; text: string }>;
  encrypted_content?: string;
  [key: string]: unknown;
}

export type OpenAIResponsesInputItem =
  | OpenAIResponsesMessageItem
  | OpenAIResponsesFunctionCallItem
  | OpenAIResponsesFunctionCallOutputItem
  | OpenAIResponsesReasoningItem;

/**
 * Payload shape for the OpenAI Responses API (`client.responses.create`).
 * Note the wire field is `input` (items), not `messages` — spread
 * `instructions` and `input` into the SDK call.
 */
export interface OpenAIResponsesPayload {
  /** System prompt messages joined with blank lines. */
  instructions?: string;
  input: OpenAIResponsesInputItem[];
  tools?: ToolDefinition[];
  meta?: CompileMeta;
}

/**
 * IR passthrough field on assistant messages carrying Responses reasoning
 * items (including `encrypted_content`) verbatim across the round-trip.
 */
const REASONING_KEY = '_openai_reasoning';

// ─── Input: OpenAI Responses → IR ───

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Flattens message content (string or parts) to text + IR attachments. */
function flattenContent(content: unknown): { text: string; attachments: Attachment[] } {
  if (typeof content === 'string') return { text: content, attachments: [] };

  const textParts: string[] = [];
  const attachments: Attachment[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (
        (part.type === 'input_text' || part.type === 'output_text') &&
        typeof part.text === 'string'
      ) {
        textParts.push(part.text);
      } else if (part.type === 'input_image' && typeof part.image_url === 'string') {
        attachments.push({
          mediaType: extractMediaType(part.image_url, 'image/*'),
          data: part.image_url,
        });
      } else if (part.type === 'input_file') {
        const data =
          typeof part.file_data === 'string'
            ? part.file_data
            : typeof part.file_url === 'string'
              ? part.file_url
              : '';
        const att: Attachment = {
          mediaType: extractMediaType(data, 'application/octet-stream'),
          data,
        };
        if (typeof part.filename === 'string') att.filename = part.filename;
        attachments.push(att);
      }
    }
  }
  return { text: textParts.join('\n'), attachments };
}

/** Flattens a function_call_output `output` field (string or parts) to text. */
function flattenOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .filter(isRecord)
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

/**
 * Converts OpenAI Responses API input items to ContextChef IR.
 *
 * - `message` items map to IR user/assistant messages; `system` / `developer`
 *   roles (and the top-level `instructions` param) become system messages.
 * - `function_call` items join the current assistant turn's `tool_calls`;
 *   `function_call_output` items become IR tool messages placed right after
 *   the assistant message that carries the matching call — correlation is by
 *   `call_id`, so out-of-order outputs are re-joined deterministically.
 * - `reasoning` items are attached verbatim (incl. `encrypted_content`) as
 *   `_openai_reasoning` on the FOLLOWING assistant message, or a standalone
 *   assistant stub when trailing. `OpenAIResponsesAdapter` re-emits them
 *   byte-identically.
 *
 * Boundary sanitization: history is run through {@link ensureValidHistory}
 * to fix orphan tool results, missing tool results, and ensure the first
 * non-system message is a user message. This is a system boundary — IR
 * downstream of `setHistory` is trusted to satisfy invariants.
 *
 * @param items - Responses API input items (or a stored response's `output`)
 * @param instructions - Optional top-level `instructions` string
 *
 * @example
 * const { system, history } = fromOpenAIResponses(previousResponse.output, instructions);
 * chef.setSystemPrompt(system).setHistory(history);
 */
export function fromOpenAIResponses(items: unknown[], instructions?: string): ParsedMessages {
  const system: Message[] = [];
  if (instructions) system.push({ role: 'system', content: instructions });

  const history: HistoryMessage[] = [];
  const outputs = new Map<string, string>();
  let pendingReasoning: OpenAIResponsesReasoningItem[] = [];
  // Assistant message of the current model turn — function_call items merge
  // into it until the turn closes (a tool output or user message arrives).
  let openAssistant: HistoryMessage | null = null;

  const attachReasoning = (msg: HistoryMessage): void => {
    if (pendingReasoning.length) {
      msg[REASONING_KEY] = pendingReasoning;
      pendingReasoning = [];
    }
  };

  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const type =
      typeof raw.type === 'string' ? raw.type : raw.role !== undefined ? 'message' : undefined;

    if (type === 'reasoning') {
      pendingReasoning.push(raw as OpenAIResponsesReasoningItem);
      continue;
    }

    if (type === 'function_call') {
      const call: ToolCall = {
        id: typeof raw.call_id === 'string' ? raw.call_id : '',
        type: 'function',
        function: {
          name: typeof raw.name === 'string' ? raw.name : '',
          arguments: typeof raw.arguments === 'string' ? raw.arguments : '{}',
        },
      };
      // Pending reasoning marks a new turn: the call following it belongs to
      // that turn, never to the previously open assistant message.
      if (openAssistant && pendingReasoning.length === 0) {
        openAssistant.tool_calls = [...(openAssistant.tool_calls ?? []), call];
      } else {
        const msg: HistoryMessage = { role: 'assistant', content: '', tool_calls: [call] };
        attachReasoning(msg);
        history.push(msg);
        openAssistant = msg;
      }
      continue;
    }

    if (type === 'function_call_output') {
      if (typeof raw.call_id === 'string') {
        outputs.set(raw.call_id, flattenOutput(raw.output));
      }
      // An output closes the turn — a later function_call starts a new one.
      openAssistant = null;
      continue;
    }

    if (type === 'message') {
      const { text, attachments } = flattenContent(raw.content);
      if (raw.role === 'system' || raw.role === 'developer') {
        // Leading system/developer items are the prompt's system layer. A
        // `system` item appearing MID-STREAM is positional channel output —
        // announcements re-rendered every compile until retracted. Folding
        // it into the top-level system layer would bake volatile text into
        // the cacheable prefix and defeat retraction, so it is skipped:
        // ownership stays with the chef state that injected it. `developer`
        // items are exempt from the skip — chef only ever emits
        // `role: 'system'` for positional output, while a mid-stream
        // developer item is a hand-written durable steering instruction.
        if (raw.role === 'system' && history.length > 0) {
          openAssistant = null;
          continue;
        }
        system.push({ role: 'system', content: text });
        openAssistant = null;
        continue;
      }
      if (raw.role === 'assistant') {
        const msg: HistoryMessage = { role: 'assistant', content: text };
        if (attachments.length) msg.attachments = attachments;
        attachReasoning(msg);
        history.push(msg);
        openAssistant = msg;
        continue;
      }
      const msg: HistoryMessage = { role: 'user', content: text };
      if (attachments.length) msg.attachments = attachments;
      history.push(msg);
      openAssistant = null;
    }
    // Unknown item types are silently skipped
  }

  // Trailing reasoning with no following assistant item → standalone stub so
  // the encrypted blob survives the round-trip.
  if (pendingReasoning.length) {
    const stub: HistoryMessage = { role: 'assistant', content: '' };
    attachReasoning(stub);
    history.push(stub);
  }

  // Join collected outputs to their calls: emit tool messages right after the
  // assistant message carrying the matching tool_calls, in call order.
  // Orphan outputs (no matching call) are dropped, mirroring
  // ensureValidHistory's orphan tool-result policy.
  const joined: HistoryMessage[] = [];
  for (const msg of history) {
    joined.push(msg);
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const output = outputs.get(tc.id);
        if (output !== undefined) {
          joined.push({ role: 'tool', content: output, tool_call_id: tc.id });
          outputs.delete(tc.id);
        }
      }
    }
  }

  // Sanitize at boundary: enforce IR invariants before handing to caller.
  // Cast is safe — ensureValidHistory only inserts user/tool messages, never system.
  return { system, history: ensureValidHistory(joined) as HistoryMessage[] };
}

// ─── Output: IR → OpenAI Responses ───

/** Converts an IR attachment to an input_image / input_file content part. */
function attachmentToPart(att: Attachment): OpenAIResponsesContentPart {
  const isUrl = att.data.startsWith('http');
  const isDataUrl = att.data.startsWith('data:');
  if (att.mediaType.startsWith('image/')) {
    return {
      type: 'input_image',
      image_url: isUrl || isDataUrl ? att.data : `data:${att.mediaType};base64,${att.data}`,
    };
  }
  const part: OpenAIResponsesInputFilePart = { type: 'input_file' };
  if (isUrl) {
    part.file_url = att.data;
  } else {
    part.file_data = isDataUrl ? att.data : `data:${att.mediaType};base64,${att.data}`;
  }
  if (att.filename) part.filename = att.filename;
  return part;
}

/** Reads the `_openai_reasoning` passthrough off an assistant message. */
function readReasoningPassthrough(msg: Message): OpenAIResponsesReasoningItem[] | undefined {
  const value = msg[REASONING_KEY];
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.filter(isRecord) as OpenAIResponsesReasoningItem[];
}

/**
 * Target adapter for the OpenAI Responses API.
 *
 * - system messages → joined `instructions` string, except `_positional` ones,
 *   which stay in `input` as inline system items
 * - user/assistant text → `message` items with `input_text` / `output_text` parts
 * - assistant `tool_calls` → `function_call` items (`call_id` = ToolCall.id)
 * - tool messages → `function_call_output` items
 * - user attachments → `input_image` / `input_file` parts
 * - `_openai_reasoning` passthrough → reasoning items re-emitted verbatim
 *   BEFORE the assistant message that carries them (preserving
 *   `encrypted_content` byte-identically)
 * - Anthropic-style `thinking` / `redacted_thinking` and internal fields
 *   (`_cache_breakpoint`) are dropped — the Responses API has no slot for them
 * - a trailing plain assistant message (prefill) is degraded to an ephemeral
 *   enforcement instruction on the last user item (or the instructions),
 *   mirroring the Chat Completions adapter
 *
 * Registered as the `'openai-responses'` builtin target. The payload uses the
 * Responses wire field `input` (not `messages`), so `chef.compile({ target:
 * 'openai-responses' })` returns it through the generic `TargetPayload` type —
 * cast to {@link OpenAIResponsesPayload} until the typed overload lands.
 */
export class OpenAIResponsesAdapter {
  compile(messages: Message[]): OpenAIResponsesPayload {
    const instructionParts: string[] = [];
    const input: OpenAIResponsesInputItem[] = [];

    // Prefill degradation: the Responses API has no assistant-prefill slot —
    // a trailing plain assistant message (ContextChef's guardrail prefill
    // convention) would be emitted as a COMPLETED output_text item, silently
    // neutering the prefill. Mirror the Chat Completions adapter: pop it and
    // enforce the prefix via an ephemeral instruction on the last user item
    // (or the instructions when no user item exists). Trailing assistant
    // messages carrying tool_calls or reasoning passthrough are real turns
    // and stay untouched.
    let prefill: string | undefined;
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && !last.tool_calls?.length && !readReasoningPassthrough(last)) {
      prefill = last.content;
      messages = messages.slice(0, -1);
    }
    // Parts array of the most recently emitted user message item — the
    // prefill enforcement injection target.
    let lastUserParts: OpenAIResponsesContentPart[] | undefined;

    for (const msg of messages) {
      if (msg.role === 'system') {
        if (msg._positional) {
          // `instructions` is this API's top-level system slot, so honoring the
          // flag means emitting an inline system item at this position instead.
          input.push({
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: msg.content }],
          });
        } else {
          instructionParts.push(msg.content);
        }
        continue;
      }

      if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id ?? '',
          output: msg.content,
        });
        continue;
      }

      if (msg.role === 'assistant') {
        const reasoning = readReasoningPassthrough(msg);
        if (reasoning) {
          // Immutable passthrough, emitted BY REFERENCE: reasoning items
          // (often multi-KB encrypted_content blobs) are never mutated by
          // ContextChef or this adapter, and deep-cloning them on every
          // compile is measurably expensive. Byte-identity round-trip tests
          // pin the contract.
          input.push(...reasoning);
        }
        // Skip an empty message item when the turn is represented by its
        // function_call / reasoning items alone (keeps round-trips exact).
        if (msg.content || !(msg.tool_calls?.length || reasoning)) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: msg.content }],
          });
        }
        for (const tc of msg.tool_calls ?? []) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
        continue;
      }

      // user message
      const parts: OpenAIResponsesContentPart[] = [];
      if (msg.content || !msg.attachments?.length) {
        parts.push({ type: 'input_text', text: msg.content });
      }
      for (const att of msg.attachments ?? []) {
        parts.push(attachmentToPart(att));
      }
      input.push({ type: 'message', role: 'user', content: parts });
      lastUserParts = parts;
    }

    if (prefill !== undefined) {
      const enforcement = Prompts.getPrefillEnforcement(prefill);
      if (lastUserParts) {
        // Append to the item's last input_text part; a media-only user item
        // gets a fresh text part instead.
        let appended = false;
        for (let j = lastUserParts.length - 1; j >= 0 && !appended; j--) {
          const part = lastUserParts[j];
          if (part.type === 'input_text') {
            part.text = `${part.text}\n\n${enforcement}`;
            appended = true;
          }
        }
        if (!appended) lastUserParts.push({ type: 'input_text', text: enforcement });
      } else {
        instructionParts.push(enforcement);
      }
    }

    const payload: OpenAIResponsesPayload = { input };
    if (instructionParts.length) payload.instructions = instructionParts.join('\n\n');
    return payload;
  }
}
