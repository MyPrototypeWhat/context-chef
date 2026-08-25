import type {
  Content as SDKContent,
  FunctionCallPart as SDKFunctionCallPart,
  FunctionResponsePart as SDKFunctionResponsePart,
  Part as SDKPart,
  TextPart as SDKTextPart,
} from '@google/generative-ai';
import { Prompts } from '../prompts';
import type {
  Attachment,
  ChefLogger,
  GeminiPayload,
  HistoryMessage,
  Message,
  ParsedMessages,
} from '../types';
import { ensureValidHistory } from '../utils/ensureValidHistory';
import type { ITargetAdapter } from './targetAdapter';

// Re-export Gemini-specific types for consumers who want strong typing without importing the SDK
export type GeminiTextPart = SDKTextPart;
export type GeminiFunctionCallPart = SDKFunctionCallPart;
export type GeminiFunctionResponsePart = SDKFunctionResponsePart;
export type GeminiPart = SDKPart;
export type GeminiContent = SDKContent;

// ─── Input: Gemini → IR ───

/**
 * Converts Gemini generateContent messages to ContextChef IR.
 * Separates system instruction from conversation history.
 *
 * Boundary sanitization: history is run through {@link ensureValidHistory}
 * to fix orphan tool results, missing tool results, and ensure the first
 * non-system message is a user message. This is a system boundary — IR
 * downstream of `setHistory` is trusted to satisfy invariants.
 *
 * @param contents - Gemini content array (user/model messages with parts)
 * @param systemInstruction - Optional top-level system instruction
 *
 * @example
 * const { system, history } = fromGemini(geminiContents, systemInstruction);
 * chef.setSystemPrompt(system).setHistory(history);
 */
export function fromGemini(
  contents: SDKContent[],
  systemInstruction?: { parts: SDKTextPart[] },
): ParsedMessages {
  const system: Message[] = [];
  const history: HistoryMessage[] = [];

  // Gemini has no native tool call IDs. Synthesize `gemini-fc-<name>-<n>` with
  // a per-name counter spanning the whole conversation so repeat calls stay
  // unique, and correlate each functionResponse to the oldest unconsumed call
  // of the same name (FIFO) — responses normally arrive in a later content
  // entry, so the correlation state must outlive a single message.
  // FIFO assumes same-name responses arrive in call order (Gemini emits them
  // in order); out-of-order same-name responses would swap attributions — an
  // inherent limit of name-only correlation.
  const callCounters = new Map<string, number>();
  const pendingCallIds = new Map<string, string[]>();

  if (systemInstruction) {
    for (const part of systemInstruction.parts) {
      system.push({ role: 'system', content: part.text });
    }
  }

  for (const content of contents) {
    const role: 'user' | 'assistant' = content.role === 'model' ? 'assistant' : 'user';
    const textParts: string[] = [];
    const attachments: Attachment[] = [];
    const toolCalls: {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
      thoughtSignature?: string;
    }[] = [];
    let textSignature: string | undefined;

    // Gemini 3 thought signatures ride on parts (first functionCall of each
    // step, sometimes a text part) and MUST be echoed verbatim in later
    // requests — a missing signature on a current-turn function call is a
    // 400. The SDK part types may not declare the field; read it structurally.
    const partSignature = (part: SDKPart): string | undefined =>
      (part as { thoughtSignature?: string }).thoughtSignature;

    for (const part of content.parts) {
      if ('text' in part && part.text != null) {
        textParts.push(part.text);
        const sig = partSignature(part);
        if (sig) textSignature = sig;
      } else if ('inlineData' in part && part.inlineData) {
        attachments.push({
          mediaType: part.inlineData.mimeType,
          data: part.inlineData.data,
        });
      } else if ('fileData' in part && part.fileData) {
        attachments.push({
          mediaType: part.fileData.mimeType,
          data: part.fileData.fileUri,
        });
      } else if ('functionCall' in part && part.functionCall) {
        const name = part.functionCall.name;
        const seq = callCounters.get(name) ?? 0;
        callCounters.set(name, seq + 1);
        const id = `gemini-fc-${name}-${seq}`;
        const pending = pendingCallIds.get(name);
        if (pending) pending.push(id);
        else pendingCallIds.set(name, [id]);
        const call: (typeof toolCalls)[number] = {
          id,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        };
        const sig = partSignature(part);
        if (sig) call.thoughtSignature = sig;
        toolCalls.push(call);
      } else if ('functionResponse' in part && part.functionResponse) {
        const name = part.functionResponse.name;
        // Orphan responses (no unconsumed call of this name) fall back to `-0`
        // and are cleaned up by ensureValidHistory below.
        history.push({
          role: 'tool',
          content: JSON.stringify(part.functionResponse.response),
          name,
          tool_call_id: pendingCallIds.get(name)?.shift() ?? `gemini-fc-${name}-0`,
        });
      }
    }

    // Only push if there's meaningful content (skip if only functionResponses were extracted)
    if (textParts.length || toolCalls.length || attachments.length) {
      const ir: HistoryMessage = { role, content: textParts.join('\n') };
      if (attachments.length) ir.attachments = attachments;
      if (toolCalls.length) ir.tool_calls = toolCalls;
      // Text-part thought signature: message-level passthrough (text parts are
      // joined in IR, so a single signature per message is retained).
      if (textSignature) ir._gemini_thought_signature = textSignature;
      history.push(ir);
    }
  }

  // Sanitize at boundary: enforce IR invariants before handing to caller.
  // Cast is safe — ensureValidHistory only inserts user/tool messages, never system.
  return { system, history: ensureValidHistory(history) as HistoryMessage[] };
}

// ─── Output: IR → Gemini ───

/**
 * Header for an Anthropic server-side compaction summary degraded to plain
 * text. Gemini has no compaction block, and the Anthropic API drops
 * everything before that block — silently stripping it on a provider switch
 * would lose the entire compacted history.
 */
const COMPACTION_SUMMARY_HEADER = '[Summary of earlier conversation (compacted server-side)]';

/**
 * Adapts ContextChef IR to Google Gemini's generateContent format.
 *
 * Key differences from OpenAI/Anthropic:
 * - System messages go into a top-level `systemInstruction` field, not in `contents` —
 *   except `_positional` ones, which degrade to a `user` content entry.
 * - Roles are `user` and `model` (not `assistant`).
 * - Tool calls use `functionCall` parts with `name` + `args`.
 * - Tool results use `functionResponse` parts with `name` + `response`, sent as `role: "user"`.
 * - `_cache_breakpoint` is silently ignored (Gemini uses a separate CachedContent API).
 * - Prefill degradation follows the same pattern as OpenAI (Gemini doesn't support trailing model messages).
 */
export interface GeminiAdapterOptions {
  /**
   * When true, Anthropic-style `thinking` on assistant messages is converted
   * to a `<thinking>...</thinking>` text prefix instead of being dropped, so
   * reasoning survives cross-provider replay. `redacted_thinking` is NEVER
   * textified (opaque encrypted blob) — dropped with a one-time warning.
   * Default: false (drop thinking, pre-4.0 behavior).
   */
  preserveThinkingAsText?: boolean;
  /** Sink for degradation warnings. Defaults to `console`. */
  logger?: ChefLogger;
}

export class GeminiAdapter implements ITargetAdapter {
  private _redactedWarned = false;

  constructor(private readonly options: GeminiAdapterOptions = {}) {}

  compile(messages: Message[]): GeminiPayload {
    const systemParts: SDKTextPart[] = [];
    const contents: SDKContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const textPart: SDKTextPart = { text: msg.content };
        if (msg._positional) {
          // Gemini `contents` has no system role — degrade to a user entry
          // carrying the text verbatim, merged with adjacent user content by
          // _mergeConsecutiveSameRole below.
          contents.push({ role: 'user', parts: [textPart] });
        } else {
          systemParts.push(textPart);
        }
        continue;
      }

      if (msg.role === 'tool') {
        let parsedResponse: object;
        try {
          // JSON.parse returns `any`; the typed variable coerces without a cast.
          parsedResponse = JSON.parse(msg.content);
        } catch {
          parsedResponse = { result: msg.content };
        }
        const part: SDKFunctionResponsePart = {
          functionResponse: {
            name: msg.name ?? msg.tool_call_id ?? 'unknown',
            response: parsedResponse,
          },
        };
        contents.push({ role: 'user', parts: [part] });
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: SDKPart[] = [];

        // thinking / redacted_thinking have no Gemini request equivalent —
        // discarded unless preserveThinkingAsText converts thinking to a text
        // prefix. thought:true is an output-only field in Gemini responses;
        // multi-turn thinking is maintained via thoughtSignature on parts.
        let content = msg.content;
        if (this.options.preserveThinkingAsText) {
          if (msg.thinking?.thinking) {
            content = `<thinking>\n${msg.thinking.thinking}\n</thinking>\n\n${content ?? ''}`;
          }
          if (msg.redacted_thinking && !this._redactedWarned) {
            this._redactedWarned = true;
            (this.options.logger ?? console).warn(
              '[context-chef] redacted_thinking is an opaque encrypted blob and cannot be ' +
                'preserved as text — dropped on the Gemini target (warned once).',
            );
          }
        }

        // Degrade an Anthropic server-side compaction to a marked summary
        // block prepended to the message text (it summarizes everything before
        // it, so it must come first — ahead of any textified thinking).
        if (typeof msg._anthropic_compaction === 'string') {
          content = `${COMPACTION_SUMMARY_HEADER}\n${msg._anthropic_compaction}\n\n${content ?? ''}`;
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          if (content) {
            const textPart: SDKTextPart = { text: content };
            if (typeof msg._gemini_thought_signature === 'string') {
              (textPart as { thoughtSignature?: string }).thoughtSignature =
                msg._gemini_thought_signature;
            }
            parts.push(textPart);
          }
          for (const tc of msg.tool_calls) {
            const args: object = JSON.parse(tc.function.arguments);
            const part: SDKFunctionCallPart = {
              functionCall: {
                name: tc.function.name,
                args,
              },
            };
            // Echo the thought signature verbatim — Gemini 3 rejects
            // current-turn function calls without their signature.
            if (tc.thoughtSignature) {
              (part as { thoughtSignature?: string }).thoughtSignature = tc.thoughtSignature;
            }
            parts.push(part);
          }
        } else {
          const textPart: SDKTextPart = { text: content };
          if (typeof msg._gemini_thought_signature === 'string') {
            (textPart as { thoughtSignature?: string }).thoughtSignature =
              msg._gemini_thought_signature;
          }
          parts.push(textPart);
        }

        contents.push({ role: 'model', parts });
        continue;
      }

      let userContent = msg.content;
      if (typeof msg._anthropic_compaction === 'string') {
        userContent = `${COMPACTION_SUMMARY_HEADER}\n${msg._anthropic_compaction}\n\n${userContent}`;
      }
      const userTextPart: SDKTextPart = { text: userContent };
      const userParts: SDKPart[] = [userTextPart];
      // Convert attachments to Gemini inlineData/fileData parts
      if (msg.attachments?.length) {
        for (const att of msg.attachments) {
          if (att.data.startsWith('http') || att.data.startsWith('gs://')) {
            userParts.push({ fileData: { mimeType: att.mediaType, fileUri: att.data } });
          } else {
            userParts.push({ inlineData: { mimeType: att.mediaType, data: att.data } });
          }
        }
      }
      contents.push({
        role: 'user',
        parts: userParts,
      });
    }

    // Prefill degradation: Gemini doesn't support trailing `model` messages.
    if (contents.length > 0) {
      const last = contents[contents.length - 1];
      const lastFirstPart = last.parts[0];
      const isPlainModelMsg =
        last.role === 'model' &&
        last.parts.length === 1 &&
        'text' in lastFirstPart &&
        lastFirstPart.text !== undefined;

      if (isPlainModelMsg) {
        const popped = contents.pop();
        const poppedPart = popped?.parts[0];
        const prefillContent = poppedPart && 'text' in poppedPart ? (poppedPart.text ?? '') : '';

        for (let i = contents.length - 1; i >= 0; i--) {
          const firstPart = contents[i].parts[0];
          if (contents[i].role === 'user' && 'text' in firstPart && firstPart.text !== undefined) {
            const injectedText: SDKTextPart = {
              text: `${firstPart.text}\n\n${Prompts.getPrefillEnforcement(prefillContent)}`,
            };
            contents[i] = {
              ...contents[i],
              parts: [injectedText],
            };
            break;
          }
        }

        if (contents.every((c) => c.role !== 'user')) {
          const enforcementPart: SDKTextPart = {
            text: Prompts.getPrefillEnforcement(prefillContent),
          };
          systemParts.push(enforcementPart);
        }
      }
    }

    const payload: GeminiPayload = { messages: GeminiAdapter._mergeConsecutiveSameRole(contents) };

    if (systemParts.length > 0) {
      payload.systemInstruction = { parts: systemParts };
    }

    return payload;
  }

  /**
   * Collapses consecutive same-role `Content` entries into a single entry with
   * concatenated `parts`. Required because Gemini's `generateContent` API
   * rejects non-alternating contents with:
   *
   *   400 INVALID_ARGUMENT: Please ensure that multiturn requests alternate
   *   between user and model
   *
   * Triggered in practice by:
   * - **Parallel tool calls**: an assistant turn with N `tool_calls` produces
   *   N `role: 'user'` `functionResponse` entries (Gemini maps `tool` → `user`).
   *   Without merging, the contents become `[user, model, user, user, ..., user]`
   *   and the API rejects. The canonical Gemini shape for parallel function
   *   responses is ONE user `Content` with multiple `functionResponse` parts —
   *   exactly what this merge produces.
   * - **Tail-injected memory** with `MemoryConfig.memoryPlacement === 'before_history_tail'`
   *   when the caller emits memory as a separate user `Content` ahead of the
   *   user turn.
   * - **Stripped thinking** that leaves an otherwise-empty model turn (handled
   *   by other mechanisms; not addressed here).
   *
   * Anthropic auto-merges on the server side ([Messages API docs](https://docs.anthropic.com/en/api/messages))
   * and OpenAI tolerates consecutive same-role messages. Only Gemini requires
   * the client to normalize, so this merge lives exclusively in the Gemini
   * adapter — matching the strategy of `@tanstack/ai-gemini`
   * (`mergeConsecutiveSameRoleMessages`) and LangChain's `langchain-google-genai`.
   *
   * Runs AFTER prefill degradation so the trailing-model pop sees an
   * unmerged view of the conversation (a pre-merge would conflate the
   * prefill message with the preceding model turn).
   *
   * **Lazy allocation**: when the input is already strictly alternating
   * (the common case for normal conversations), returns the input array
   * unchanged — zero allocation. Only allocates a fresh result array on the
   * first detected merge point, and only clones envelopes from that index
   * onwards. The earlier portion of the input is shallow-copied lazily.
   *
   * Pure function: when allocation occurs, returns a new array with fresh
   * `Content` envelopes whose `parts` arrays are also fresh (callers may
   * safely mutate). Inner `SDKPart` objects are reference-shared with the
   * input — they are treated as immutable leaves by this adapter. When no
   * allocation occurs (already alternating), the input is returned as-is
   * and the contract is preserved because this function never mutates input.
   */
  private static _mergeConsecutiveSameRole(contents: SDKContent[]): SDKContent[] {
    if (contents.length <= 1) return contents;

    // Phase 1: scan for the first merge point. If none, the input is already
    // strictly alternating — return it as-is (zero allocation).
    let firstMergeIdx = -1;
    for (let i = 1; i < contents.length; i++) {
      if (contents[i].role === contents[i - 1].role) {
        firstMergeIdx = i;
        break;
      }
    }
    if (firstMergeIdx === -1) return contents;

    // Phase 2: clone the alternating prefix [0, firstMergeIdx-1] verbatim,
    // then resume the merge from `firstMergeIdx` onwards.
    const merged: SDKContent[] = contents
      .slice(0, firstMergeIdx)
      .map((c) => ({ role: c.role, parts: [...c.parts] }));
    for (let i = firstMergeIdx; i < contents.length; i++) {
      const last = merged[merged.length - 1];
      if (last.role === contents[i].role) {
        last.parts.push(...contents[i].parts);
      } else {
        merged.push({ role: contents[i].role, parts: [...contents[i].parts] });
      }
    }
    return merged;
  }
}
