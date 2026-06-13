import {
  type ChefLogger,
  type CompressionDetails,
  compactMessages as clearMessages,
  Janitor,
  type Message,
  Prompts,
  XmlGenerator,
} from '@context-chef/core';
import type { AnyTextAdapter, ChatMiddleware, ModelMessage } from '@tanstack/ai';

import { fromTanStackAI, toTanStackAI } from './adapter';
import { compactMessages } from './compact';
import { truncateToolResults } from './truncator';
import type { ContextChefOptions, DynamicStateConfig } from './types';

type CompressRole = 'system' | 'user' | 'assistant';

/**
 * Creates a TanStack AI ChatMiddleware that transparently applies
 * context-chef compression and truncation to chat() calls.
 *
 * The middleware holds a stateful Janitor instance that tracks
 * token usage across calls for compression decisions.
 *
 * @example
 * ```typescript
 * import { contextChefMiddleware } from '@context-chef/tanstack-ai';
 * import { chat } from '@tanstack/ai';
 * import { openaiText } from '@tanstack/ai-openai';
 *
 * const stream = chat({
 *   adapter: openaiText('gpt-4o'),
 *   messages,
 *   middleware: [
 *     contextChefMiddleware({
 *       contextWindow: 128_000,
 *       compress: { adapter: openaiText('gpt-4o-mini') },
 *       truncate: { threshold: 5000, headChars: 500, tailChars: 1000 },
 *     }),
 *   ],
 * });
 * ```
 */
export function contextChefMiddleware(options: ContextChefOptions): ChatMiddleware {
  const logger: ChefLogger = options.logger ?? console;
  const clearsToolResults = !!options.clear?.some(
    (t) => t === 'tool-result' || (typeof t === 'object' && t.target === 'tool-result'),
  );
  let usageWarned = false;

  // The Janitor config is a discriminated union on `tokenizer`. Build the two
  // branches separately so the literal type matches one of the union members
  // exactly — a single literal carrying `tokenizer: Fn | undefined` would not
  // narrow to either branch.
  const sharedJanitorConfig = {
    contextWindow: options.contextWindow,
    toolResultStubThreshold: options.compress?.toolResultStubThreshold,
    compressionModel: options.compress?.adapter
      ? createCompressionAdapter(options.compress.adapter)
      : undefined,
    onCompress: options.onCompress
      ? (summary: Message, count: number, details: CompressionDetails) =>
          options.onCompress?.(summary.content, count, {
            compressedMessages: toTanStackAI(details.compressedMessages),
          })
      : undefined,
    onBeforeCompress: options.onBeforeCompress,
    logger,
  };

  let usagePreference = options.compress?.usagePreference;
  if (usagePreference === 'tokenizerFirst' && !options.tokenizer) {
    logger.warn(
      "[context-chef] compress.usagePreference: 'tokenizerFirst' requires a tokenizer. " +
        "Falling back to 'max'.",
    );
    usagePreference = 'max';
  }

  const janitor = options.tokenizer
    ? new Janitor({
        ...sharedJanitorConfig,
        tokenizer: (msgs: Message[]) => options.tokenizer?.(msgs) ?? 0,
        preserveRatio: options.compress?.preserveRatio ?? 0.8,
        usagePreference,
      })
    : new Janitor({
        ...sharedJanitorConfig,
        // 'tokenizerFirst' has been sanitized above; the cast narrows the
        // remaining values to the no-tokenizer branch.
        usagePreference: usagePreference as 'max' | 'feedFirst' | undefined,
      });

  return {
    name: 'context-chef',

    onConfig: async (_ctx, config) => {
      let { messages } = config;
      let systemPrompts = [...config.systemPrompts];

      // 1. Truncate large tool results
      if (options.truncate) {
        messages = await truncateToolResults(messages, options.truncate, logger);
      }

      // 2. Convert to IR
      let irMessages = fromTanStackAI(messages);

      // 3. Compact (mechanical, zero LLM cost)
      if (options.compact) {
        irMessages = compactMessages(irMessages, options.compact);
      }

      // 4. Compress conversation history if over token budget
      irMessages = await janitor.compress(irMessages);

      // 4.5 Placeholder-style clearing (core semantics) — after compress so
      // the summarizer saw full content; placeholders only hit the kept tail.
      if (options.clear?.length) {
        irMessages = clearMessages(irMessages, { clear: options.clear });
      }

      // 5. Convert back to TanStack AI format
      messages = toTanStackAI(irMessages);

      // 6. Skill instructions injection (appended after user system prompts,
      //    before dynamicState — matches @context-chef/core compile() ordering).
      if (options.skill) {
        const instructions = await resolveSkillInstructions(options.skill);
        if (instructions) systemPrompts = [...systemPrompts, instructions];
      }

      // Append tool-result clearing explainer when tool results are targeted,
      // so the model doesn't misread placeholders as an error.
      if (clearsToolResults) {
        systemPrompts = [...systemPrompts, Prompts.TOOL_RESULT_CLEARED_INSTRUCTION];
      }

      // 7. Dynamic state injection
      if (options.dynamicState) {
        const injected = await injectDynamicState(messages, systemPrompts, options.dynamicState);
        messages = injected.messages;
        systemPrompts = injected.systemPrompts;
      }

      // 8. Custom transform hook
      if (options.transformContext) {
        const transformed = await options.transformContext(messages, systemPrompts);
        messages = transformed.messages;
        systemPrompts = transformed.systemPrompts;
      }

      return { messages, systemPrompts };
    },

    onUsage: (_ctx, usage) => {
      if (usage.promptTokens != null) {
        janitor.feedTokenUsage(usage.promptTokens);
      } else if (!usageWarned && !options.tokenizer) {
        usageWarned = true;
        logger.warn(
          '[context-chef] Model response did not include usage.promptTokens. ' +
            'Token-based compression may not trigger accurately. ' +
            'Consider providing a tokenizer for precise token counting.',
        );
      }
    },
  };
}

/**
 * Adapts a TanStack AI TextAdapter into the compressionModel callback
 * that Janitor expects: (messages: Message[]) => Promise<string>
 *
 * Calls the adapter's chatStream() directly to bypass the middleware stack.
 * Tool messages are converted to user messages describing the tool interaction,
 * since most providers only accept user/assistant roles for simple text generation.
 */
function createCompressionAdapter(
  adapter: AnyTextAdapter,
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

    // Convert to ModelMessage format for chatStream
    const modelMessages: ModelMessage[] = formatted.map((m) => ({
      role: m.role === 'system' ? ('user' as const) : (m.role as 'user' | 'assistant'),
      content: m.content,
    }));

    const stream = adapter.chatStream({
      model: adapter.model,
      messages: modelMessages,
      maxTokens: 2048,
    });

    let text = '';
    for await (const chunk of stream) {
      if (chunk.type === 'TEXT_MESSAGE_CONTENT') {
        text += chunk.delta;
      }
    }

    return text || '[Compression produced no output]';
  };
}

/**
 * Injects dynamic state XML into the TanStack AI messages/system prompts.
 *
 * - `last_user`: Appends to the last user message's content.
 *   Leverages Recency Bias for maximum LLM attention.
 * - `system`: Adds as a standalone system prompt at the end.
 */
async function injectDynamicState(
  messages: ModelMessage[],
  systemPrompts: string[],
  config: DynamicStateConfig,
): Promise<{ messages: ModelMessage[]; systemPrompts: string[] }> {
  const state = await config.getState();
  const xml = XmlGenerator.objectToXml(state, 'dynamic_state');
  const placement = config.placement ?? 'last_user';

  if (placement === 'system') {
    return {
      messages,
      systemPrompts: [...systemPrompts, `CURRENT TASK STATE:\n${xml}`],
    };
  }

  // last_user: inject into the last user message
  const result = [...messages];
  const stateBlock = `\n\n${xml}\nAbove is the current system state. Use it to guide your next action.`;

  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role === 'user') {
      const currentContent = msg.content;
      const newContent =
        typeof currentContent === 'string'
          ? currentContent + stateBlock
          : currentContent == null
            ? stateBlock.trim()
            : Array.isArray(currentContent)
              ? [...currentContent, { type: 'text' as const, content: stateBlock.trim() }]
              : currentContent;
      result[i] = { ...msg, content: newContent };
      return { messages: result, systemPrompts };
    }
  }

  // No user message found — add as system prompt
  return {
    messages,
    systemPrompts: [...systemPrompts, `CURRENT TASK STATE:\n${xml}`],
  };
}

function toCompressRole(role: string): CompressRole {
  if (role === 'system' || role === 'user' || role === 'assistant') return role;
  return 'user';
}

/**
 * Resolves the `skill` option to its instructions string.
 * Returns the instructions when a Skill is active and has non-empty
 * instructions; returns undefined otherwise (no injection).
 */
async function resolveSkillInstructions(
  skill: NonNullable<ContextChefOptions['skill']>,
): Promise<string | undefined> {
  const resolved = typeof skill === 'function' ? await skill() : skill;
  const instructions = resolved?.instructions;
  // Treat whitespace-only instructions as empty — they would otherwise pollute
  // the systemPrompts array and create a needless cache breakpoint.
  return instructions?.trim() ? instructions : undefined;
}
