import { Prompts } from '../prompts';
import type { Message, TargetPayload } from '../types';
import type { ITargetAdapter } from './ITargetAdapter';
import type {
  Content as SDKContent,
  Part as SDKPart,
  TextPart as SDKTextPart,
  FunctionCallPart as SDKFunctionCallPart,
  FunctionResponsePart as SDKFunctionResponsePart,
} from '@google/generative-ai';

// Re-export our own public types (mirrors SDK but owned by us, won't leak into .d.ts consumers)
export type GeminiTextPart = SDKTextPart;
export type GeminiFunctionCallPart = SDKFunctionCallPart;
export type GeminiFunctionResponsePart = SDKFunctionResponsePart;
export type GeminiPart = SDKPart;
export type GeminiContent = SDKContent;

export interface GeminiPayload {
  messages: GeminiContent[];
  systemInstruction?: { parts: GeminiTextPart[] };
}

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
  compile(messages: Message[]): TargetPayload {
    const systemParts: SDKTextPart[] = [];
    const contents: SDKContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push({ text: msg.content } as SDKTextPart);
        continue;
      }

      if (msg.role === 'tool') {
        let parsedResponse: object;
        try {
          parsedResponse = JSON.parse(msg.content) as object;
        } catch {
          parsedResponse = { result: msg.content };
        }
        const part: SDKFunctionResponsePart = {
          functionResponse: {
            name: msg.name ?? msg.tool_call_id ?? 'unknown',
            response: parsedResponse,
          },
        } as SDKFunctionResponsePart;
        contents.push({ role: 'user', parts: [part] });
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: SDKPart[] = [];

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          if (msg.content) {
            parts.push({ text: msg.content } as SDKTextPart);
          }
          for (const tc of msg.tool_calls) {
            const part: SDKFunctionCallPart = {
              functionCall: {
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments) as object,
              },
            } as SDKFunctionCallPart;
            parts.push(part);
          }
        } else {
          parts.push({ text: msg.content } as SDKTextPart);
        }

        contents.push({ role: 'model', parts });
        continue;
      }

      contents.push({
        role: 'user',
        parts: [{ text: msg.content } as SDKTextPart],
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
            contents[i] = {
              ...contents[i],
              parts: [
                {
                  text: firstPart.text + '\n\n' + Prompts.getPrefillEnforcement(prefillContent),
                } as SDKTextPart,
              ],
            };
            break;
          }
        }

        if (contents.every((c) => c.role !== 'user')) {
          systemParts.push({ text: Prompts.getPrefillEnforcement(prefillContent) } as SDKTextPart);
        }
      }
    }

    const payload: GeminiPayload = {
      messages: contents,
    };

    if (systemParts.length > 0) {
      payload.systemInstruction = { parts: systemParts };
    }

    return payload as unknown as TargetPayload;
  }
}
