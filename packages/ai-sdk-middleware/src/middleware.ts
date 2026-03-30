import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { Janitor, type Message } from '@context-chef/core';
import { generateText, type LanguageModelMiddleware } from 'ai';

import { fromAISDK, toAISDK } from './adapter';
import { truncateToolResults } from './truncator';
import type { ContextChefOptions } from './types';

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
  });

  return {
    specificationVersion: 'v3',

    transformParams: async ({ params }) => {
      let { prompt } = params;

      // 1. Truncate large tool results
      if (options.truncate) {
        prompt = await truncateToolResults(prompt, options.truncate);
      }

      // 2. Compress history if over token budget
      const irMessages = fromAISDK(prompt);
      const compressed = await janitor.compress(irMessages);

      // Only convert back if compression actually changed something
      if (compressed !== irMessages) {
        prompt = toAISDK(compressed);
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
