import type {
  LanguageModelV3,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { Janitor, type Message, XmlGenerator } from '@context-chef/core';
import { generateText, type LanguageModelMiddleware } from 'ai';

import { fromAISDK, toAISDK } from './adapter';
import { truncateToolResults } from './truncator';
import type { ContextChefOptions, DynamicStateConfig } from './types';

type CompressRole = 'system' | 'user' | 'assistant';

/**
 * Creates a LanguageModelMiddleware that transparently applies
 * context-chef compression and truncation to AI SDK model calls.
 *
 * The middleware holds a stateful Janitor instance that tracks
 * token usage across calls for compression decisions.
 */
export function createMiddleware(options: ContextChefOptions): LanguageModelMiddleware {
  let usageWarned = false;

  const janitor = new Janitor({
    contextWindow: options.contextWindow,
    tokenizer: options.tokenizer ? (msgs: Message[]) => options.tokenizer?.(msgs) ?? 0 : undefined,
    preserveRatio: options.compress?.preserveRatio ?? 0.8,
    compressionModel: options.compress?.model
      ? createCompressionAdapter(options.compress.model)
      : undefined,
    onCompress: options.onCompress
      ? (summary, count) => options.onCompress?.(summary.content, count)
      : undefined,
    onBudgetExceeded: options.onBudgetExceeded,
  });

  return {
    specificationVersion: 'v3',

    transformParams: async ({ params }) => {
      let { prompt } = params;

      // 1. Truncate large tool results
      if (options.truncate) {
        prompt = await truncateToolResults(prompt, options.truncate);
      }

      // 2. Convert to IR
      let irMessages = fromAISDK(prompt);

      // 3. Compact (mechanical, zero LLM cost) before compression
      if (options.compact) {
        const preCompact = irMessages;
        irMessages = janitor.compact(irMessages, options.compact);

        // When thinking is stripped, invalidate adapter pass-through
        // so toAISDK reconstructs from IR fields (without reasoning)
        if (options.compact.clear.includes('thinking')) {
          for (let i = 0; i < irMessages.length; i++) {
            if (preCompact[i].thinking && !irMessages[i].thinking) {
              delete irMessages[i]._assistantContent;
            }
          }
        }
      }

      // 4. Compress history if over token budget
      irMessages = await janitor.compress(irMessages);

      // 5. Convert back to AI SDK format
      prompt = toAISDK(irMessages);

      // 6. Dynamic state injection
      if (options.dynamicState) {
        prompt = await injectDynamicState(prompt, options.dynamicState);
      }

      // 7. Custom transform hook
      if (options.transformContext) {
        prompt = await options.transformContext(prompt);
      }

      return { ...params, prompt };
    },

    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();

      if (result.usage?.inputTokens?.total != null) {
        janitor.feedTokenUsage(result.usage.inputTokens.total);
      } else if (!usageWarned && !options.tokenizer) {
        usageWarned = true;
        console.warn(
          '[context-chef] Model response did not include usage.inputTokens.total. ' +
            'Token-based compression may not trigger accurately. ' +
            'Consider providing a tokenizer for precise token counting.',
        );
      }

      return result;
    },

    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();

      const transform = new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(chunk, controller) {
          if (chunk.type === 'finish') {
            if (chunk.usage?.inputTokens?.total != null) {
              janitor.feedTokenUsage(chunk.usage.inputTokens.total);
            } else if (!usageWarned && !options.tokenizer) {
              usageWarned = true;
              console.warn(
                '[context-chef] Stream finish did not include usage.inputTokens.total. ' +
                  'Token-based compression may not trigger accurately. ' +
                  'Consider providing a tokenizer for precise token counting.',
              );
            }
          }
          controller.enqueue(chunk);
        },
      });

      return { ...rest, stream: stream.pipeThrough(transform) };
    },
  };
}

/**
 * Injects dynamic state XML into the AI SDK prompt.
 *
 * - `last_user`: Appends to the last user message's content parts.
 *   Leverages Recency Bias for maximum LLM attention.
 * - `system`: Adds as a standalone system message at the end.
 */
async function injectDynamicState(
  prompt: LanguageModelV3Prompt,
  config: DynamicStateConfig,
): Promise<LanguageModelV3Prompt> {
  const state = await config.getState();
  const xml = XmlGenerator.objectToXml(state, 'dynamic_state');
  const placement = config.placement ?? 'last_user';

  if (placement === 'system') {
    return [...prompt, { role: 'system', content: `CURRENT TASK STATE:\n${xml}` }];
  }

  // last_user: inject into the last user message
  const result = [...prompt];
  const stateBlock = `\n\n${xml}\nAbove is the current system state. Use it to guide your next action.`;

  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role === 'user') {
      result[i] = {
        ...msg,
        content: [...msg.content, { type: 'text', text: stateBlock }],
      };
      return result;
    }
  }

  // No user message found — append as new user message
  result.push({
    role: 'user',
    content: [{ type: 'text', text: stateBlock.trim() }],
  });
  return result;
}

/**
 * Maps an IR role to a role accepted by generateText.
 * Tool messages are handled separately before this is called.
 */
function toCompressRole(role: string): CompressRole {
  if (role === 'system' || role === 'user' || role === 'assistant') return role;
  return 'user';
}

/**
 * Adapts an AI SDK LanguageModelV3 into the compressionModel callback
 * that Janitor expects: (messages: Message[]) => Promise<string>
 *
 * Tool messages are converted to user messages describing the tool interaction,
 * since generateText only accepts system/user/assistant roles.
 */
function createCompressionAdapter(
  model: LanguageModelV3,
): (messages: Message[]) => Promise<string> {
  return async (messages: Message[]): Promise<string> => {
    const formatted = messages.map((m): { role: CompressRole; content: string } => {
      if (m.role === 'tool') {
        return {
          role: 'user' satisfies CompressRole,
          content: `[Tool result${m.tool_call_id ? ` (${m.tool_call_id})` : ''}: ${m.content}]`,
        };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const toolCallsDesc = m.tool_calls
          .map((tc) => `[Called tool: ${tc.function.name}(${tc.function.arguments})]`)
          .join('\n');
        return {
          role: 'assistant' satisfies CompressRole,
          content: m.content ? `${m.content}\n${toolCallsDesc}` : toolCallsDesc,
        };
      }
      return {
        role: toCompressRole(m.role),
        content: m.content,
      };
    });

    const { text } = await generateText({
      model,
      messages: formatted,
      maxOutputTokens: 2048,
    });

    return text || '[Compression produced no output]';
  };
}
