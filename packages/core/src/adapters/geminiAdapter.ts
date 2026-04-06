import type {
  Content as SDKContent,
  FunctionCallPart as SDKFunctionCallPart,
  FunctionResponsePart as SDKFunctionResponsePart,
  Part as SDKPart,
  TextPart as SDKTextPart,
} from '@google/generative-ai';
import { Prompts } from '../prompts';
import type { GeminiPayload, Message } from '../types';
import type { ITargetAdapter } from './targetAdapter';

// Re-export Gemini-specific types for consumers who want strong typing without importing the SDK
export type GeminiTextPart = SDKTextPart;
export type GeminiFunctionCallPart = SDKFunctionCallPart;
export type GeminiFunctionResponsePart = SDKFunctionResponsePart;
export type GeminiPart = SDKPart;
export type GeminiContent = SDKContent;

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
      contents.push({
        role: 'user',
        parts: [userTextPart],
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
