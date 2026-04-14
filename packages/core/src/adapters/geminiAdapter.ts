import type {
  Content as SDKContent,
  FunctionCallPart as SDKFunctionCallPart,
  FunctionResponsePart as SDKFunctionResponsePart,
  Part as SDKPart,
  TextPart as SDKTextPart,
} from '@google/generative-ai';
import { Prompts } from '../prompts';
import type { Attachment, GeminiPayload, HistoryMessage, Message, ParsedMessages } from '../types';
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
    }[] = [];

    for (const part of content.parts) {
      if ('text' in part && part.text != null) {
        textParts.push(part.text);
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
        const id = `gemini-fc-${part.functionCall.name}-${toolCalls.length}`;
        toolCalls.push({
          id,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        });
      } else if ('functionResponse' in part && part.functionResponse) {
        // Gemini has no native tool call IDs. Use a synthetic ID derived from
        // the function name to enable cross-provider compilation (e.g. → OpenAI).
        const name = part.functionResponse.name;
        // Try to match a preceding functionCall by name for ID correlation
        const matchingCall = toolCalls.find((tc) => tc.function.name === name);
        history.push({
          role: 'tool',
          content: JSON.stringify(part.functionResponse.response),
          name,
          tool_call_id: matchingCall?.id ?? `gemini-fc-${name}-0`,
        });
      }
    }

    // Only push if there's meaningful content (skip if only functionResponses were extracted)
    if (textParts.length || toolCalls.length || attachments.length) {
      const ir: HistoryMessage = { role, content: textParts.join('\n') };
      if (attachments.length) ir.attachments = attachments;
      if (toolCalls.length) ir.tool_calls = toolCalls;
      history.push(ir);
    }
  }

  return { system, history };
}

// ─── Output: IR → Gemini ───

/**
 * Adapts ContextChef IR to Google Gemini's generateContent format.
 *
 * Key differences from OpenAI/Anthropic:
 * - System messages go into a top-level `systemInstruction` field, not in `contents`.
 * - Roles are `user` and `model` (not `assistant`).
 * - Tool calls use `functionCall` parts with `name` + `args`.
 * - Tool results use `functionResponse` parts with `name` + `response`, sent as `role: "user"`.
 * - `_cache_breakpoint` is silently ignored (Gemini uses a separate CachedContent API).
 * - Prefill degradation follows the same pattern as OpenAI (Gemini doesn't support trailing model messages).
 */
export class GeminiAdapter implements ITargetAdapter {
  compile(messages: Message[]): GeminiPayload {
    const systemParts: SDKTextPart[] = [];
    const contents: SDKContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const textPart: SDKTextPart = { text: msg.content };
        systemParts.push(textPart);
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

        // thinking / redacted_thinking have no Gemini request equivalent — silently discard.
        // thought:true is an output-only field in Gemini responses; multi-turn thinking
        // is maintained via thoughtSignature at the Content level (handled by the SDK).

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          if (msg.content) {
            const textPart: SDKTextPart = { text: msg.content };
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
            parts.push(part);
          }
        } else {
          const textPart: SDKTextPart = { text: msg.content };
          parts.push(textPart);
        }

        contents.push({ role: 'model', parts });
        continue;
      }

      const userTextPart: SDKTextPart = { text: msg.content };
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

    const payload: GeminiPayload = { messages: contents };

    if (systemParts.length > 0) {
      payload.systemInstruction = { parts: systemParts };
    }

    return payload;
  }
}
