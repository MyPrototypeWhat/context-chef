import {
  type ChefLogger,
  compactMessages as clearMessages,
  createJanitorPool,
  flattenForCompression,
  type Janitor,
  type Message,
  normalizeSessionKey,
  objectToXml,
  Prompts,
} from '@context-chef/core';
import {
  type AnyTextAdapter,
  type ChatMiddleware,
  type ChatMiddlewareConfig,
  type ChatMiddlewareContext,
  EventType,
  type ModelMessage,
  type SystemPrompt,
} from '@tanstack/ai';
import { resolveDebugOption } from '@tanstack/ai/adapter-internals';

import { fromTanStackAI, toTanStackAI } from './adapter';
import { compactMessages } from './compact';
import { truncateToolResults } from './truncator';
import type { ContextChefOptions, DynamicStateConfig } from './types';

/**
 * Creates a TanStack AI ChatMiddleware that transparently applies
 * context-chef compression and truncation to chat() calls.
 *
 * The middleware holds a stateful Janitor per conversation (keyed by
 * `ctx.threadId`) that tracks token usage across calls for compression
 * decisions.
 *
 * `onConfig` fires at `phase: 'init'` AND at the start of every agent
 * iteration (`phase: 'beforeModel'`), and the engine carries the transformed
 * config into the next firing — every transform here is therefore
 * idempotent: injections (skill, clear explainer, dynamic state) check for /
 * replace their previous output instead of appending again.
 *
 * Robustness: middleware hooks that throw FAIL the host chat() run in
 * TanStack AI. Every hook body is wrapped — on an unexpected error the
 * middleware logs through the configured logger and passes the request
 * through unchanged instead of breaking the run.
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
 *   threadId: 'conversation-1', // keys per-conversation compression state
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
  let usageWarned = false;

  // One Janitor per conversation. A middleware instance is usually created
  // once and reused across chat() calls for many conversations — sharing one
  // Janitor would leak token-usage feeds, compression suppression, and
  // circuit-breaker counts across them. TanStack AI supplies the conversation
  // identity via ctx.threadId (auto-generated per run when the caller passes
  // none — pass an explicit `threadId` to chat() for cross-call continuity).
  // Null for truncate/compact/clear/skill/dynamicState-only configurations:
  // no budget checks, no token-usage capture, and none of the Janitor's
  // missing-tokenizer warnings.
  const janitors = createJanitorPool({
    contextWindow: options.contextWindow,
    compress: options.compress,
    compressionModel: options.compress?.adapter
      ? createCompressionAdapter(options.compress.adapter)
      : undefined,
    tokenizer: options.tokenizer,
    onCompress: options.onCompress,
    onBeforeCompress: options.onBeforeCompress,
    overflow: options.overflow,
    toHostMessages: toTanStackAI,
    // In-flight-without-persistence footgun: the summary is discarded when
    // the run ends and the caller's history re-expands on the next chat().
    persistenceWarning: (firedCount) =>
      `[context-chef] compress has fired ${firedCount}× but no \`onCompress\` is ` +
      'configured. In-flight compression only rewrites the outgoing request — the summary is ' +
      'not persisted, so your message history re-expands on the next chat() call and the ' +
      'payload grows unbounded (eventually overflowing the context window). For sustained ' +
      'compression, persist the summary via `onCompress` (replace the compressed slice in ' +
      'your own store), or use `compactTanStackMessages` for durable compaction.',
    logger,
    maxSessions: options.maxSessions,
  });

  let invalidThreadIdWarned = false;
  const flagInvalidThreadId = (raw: unknown) => {
    if (invalidThreadIdWarned) return;
    invalidThreadIdWarned = true;
    logger.warn(
      '[context-chef] Invalid ctx.threadId (expected a non-empty string, got ' +
        `${raw === '' ? 'empty string' : typeof raw}); routing to the default conversation slot.`,
    );
  };

  const janitorFor = (ctx: { threadId?: string; conversationId?: string }): Janitor | null => {
    if (!janitors) return null;
    // conversationId is a deprecated alias of threadId — fall back to it for
    // contexts constructed by pre-rename hosts or hand-rolled test doubles.
    return janitors.get(
      normalizeSessionKey(ctx.threadId ?? ctx.conversationId, flagInvalidThreadId),
    );
  };

  const clearsToolResults = !!options.clear?.some(
    (t) => t === 'tool-result' || (typeof t === 'object' && t.target === 'tool-result'),
  );

  const transformConfig = async (
    ctx: ChatMiddlewareContext,
    config: ChatMiddlewareConfig,
  ): Promise<Partial<ChatMiddlewareConfig>> => {
    const janitor = janitorFor(ctx);
    let { messages } = config;
    let systemPrompts = [...config.systemPrompts];

    // 1. Truncate large tool results
    if (options.truncate) {
      messages = await truncateToolResults(messages, options.truncate, logger);
    }

    // 2–5. IR pipeline: convert to IR, compact (mechanical, zero LLM cost),
    // compress when over budget (budgeting only), then placeholder-style
    // clearing (after compress so the summarizer saw full content), and
    // convert back. Skipped entirely when no IR-consuming option is
    // configured — truncate works on ModelMessages directly and the
    // skill/dynamicState/systemPrompts paths below never need IR, so the
    // round-trip would be pure per-call overhead (it also rebuilds every
    // message object; the fast path passes them through by identity).
    if (options.compact || janitor || options.clear?.length) {
      let irMessages = fromTanStackAI(messages);
      if (options.compact) {
        irMessages = compactMessages(irMessages, options.compact);
      }
      if (janitor) {
        irMessages = await janitor.compress(irMessages);
      }
      if (options.clear?.length) {
        irMessages = clearMessages(irMessages, { clear: options.clear });
      }
      messages = toTanStackAI(irMessages);
    }

    // 6. Skill instructions injection (appended after user system prompts,
    //    before dynamicState — matches @context-chef/core compile() ordering).
    //    Idempotent: skipped when the instructions are already present.
    if (options.skill) {
      const instructions = await resolveSkillInstructions(options.skill);
      if (instructions && !hasSystemPrompt(systemPrompts, instructions)) {
        systemPrompts = [...systemPrompts, instructions];
      }
    }

    // Append tool-result clearing explainer when tool results are targeted,
    // so the model doesn't misread placeholders as an error. Idempotent.
    if (
      clearsToolResults &&
      !hasSystemPrompt(systemPrompts, Prompts.TOOL_RESULT_CLEARED_INSTRUCTION)
    ) {
      systemPrompts = [...systemPrompts, Prompts.TOOL_RESULT_CLEARED_INSTRUCTION];
    }

    // 7. Dynamic state injection (replaces the previous iteration's block)
    if (options.dynamicState) {
      const injected = await injectDynamicState(messages, systemPrompts, options.dynamicState);
      messages = injected.messages;
      systemPrompts = injected.systemPrompts;
    }

    // 8. Custom transform hook
    if (options.transformContext) {
      const transformed = await options.transformContext(messages, systemPrompts, ctx);
      messages = transformed.messages;
      systemPrompts = transformed.systemPrompts;
    }

    return { messages, systemPrompts };
  };

  return {
    name: 'context-chef',

    onConfig: async (ctx, config) => {
      // A throwing onConfig fails the whole chat() run in TanStack AI —
      // degrade to pass-through instead of breaking the host call.
      try {
        return await transformConfig(ctx, config);
      } catch (error) {
        logger.warn(
          '[context-chef] onConfig transform failed; passing the request through unchanged. ' +
            `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    },

    onUsage: (ctx, usage) => {
      try {
        const janitor = janitorFor(ctx);
        if (!janitor) return;

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
      } catch (error) {
        logger.warn(
          '[context-chef] onUsage failed; token usage not recorded for this iteration. ' +
            `Error: ${error instanceof Error ? error.message : String(error)}`,
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
 * Tool messages are role-flattened to user messages describing the tool
 * interaction, since providers only accept user/assistant roles for simple
 * text generation.
 */
export function createCompressionAdapter(
  adapter: AnyTextAdapter,
): (messages: Message[]) => Promise<string> {
  // chatStream requires the engine's internal logger when called directly.
  // Fully silenced — errors propagate as throws and are reported by the
  // caller (Janitor circuit breaker / durable-compaction helpers).
  const internalLogger = resolveDebugOption(false);

  return async (messages: Message[]): Promise<string> => {
    // Role-flatten via the shared core helper, then convert to ModelMessage
    // for chatStream — providers reject a `system` role mid-conversation
    // here, so it degrades to `user`.
    const modelMessages: ModelMessage[] = flattenForCompression(messages).map((m) => ({
      role: m.role === 'system' ? ('user' as const) : m.role,
      content: m.content,
    }));

    const stream = adapter.chatStream({
      model: adapter.model,
      messages: modelMessages,
      logger: internalLogger,
    });

    let text = '';
    for await (const chunk of stream) {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        text += chunk.delta;
      }
    }

    return text || '[Compression produced no output]';
  };
}

/** Extracts the comparable text of a SystemPrompt entry. */
function systemPromptText(prompt: SystemPrompt): string {
  return typeof prompt === 'string' ? prompt : prompt.content;
}

/** Whether `systemPrompts` already contains an entry with this exact content. */
function hasSystemPrompt(systemPrompts: SystemPrompt[], content: string): boolean {
  return systemPrompts.some((p) => systemPromptText(p) === content);
}

const DYNAMIC_STATE_SYSTEM_PREFIX = 'CURRENT TASK STATE:\n<dynamic_state>';
const DYNAMIC_STATE_USER_SUFFIX =
  'Above is the current system state. Use it to guide your next action.';
/** Matches a previously injected last_user dynamic-state block (any state). */
const DYNAMIC_STATE_BLOCK_RE =
  /\n*<dynamic_state>[\s\S]*?<\/dynamic_state>\nAbove is the current system state\. Use it to guide your next action\./g;

/**
 * Injects dynamic state XML into the TanStack AI messages/system prompts.
 *
 * - `last_user`: Appends to the last user message's content.
 *   Leverages Recency Bias for maximum LLM attention.
 * - `system`: Adds as a standalone system prompt at the end.
 *
 * Idempotent across agent iterations: any block injected by a previous
 * `onConfig` firing is removed before the fresh state is placed, so state
 * is REPLACED, never accumulated. User-authored system prompts (including
 * object-form entries with metadata) are preserved untouched.
 */
async function injectDynamicState(
  messages: ModelMessage[],
  systemPrompts: SystemPrompt[],
  config: DynamicStateConfig,
): Promise<{ messages: ModelMessage[]; systemPrompts: SystemPrompt[] }> {
  const state = await config.getState();
  const xml = objectToXml(state, 'dynamic_state');
  const placement = config.placement ?? 'last_user';

  if (placement === 'system') {
    // Replace (not append after) any block from a previous iteration.
    const withoutPrevious = systemPrompts.filter(
      (p) => !(typeof p === 'string' && p.startsWith(DYNAMIC_STATE_SYSTEM_PREFIX)),
    );
    return {
      messages,
      systemPrompts: [...withoutPrevious, `CURRENT TASK STATE:\n${xml}`],
    };
  }

  // last_user: inject into the last user message
  const result = [...messages];
  const stateBlock = `\n\n${xml}\n${DYNAMIC_STATE_USER_SUFFIX}`;

  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role !== 'user') continue;

    const currentContent = msg.content;
    let newContent: ModelMessage['content'];
    if (typeof currentContent === 'string') {
      newContent = currentContent.replace(DYNAMIC_STATE_BLOCK_RE, '') + stateBlock;
    } else if (currentContent == null) {
      newContent = stateBlock.trim();
    } else {
      const withoutPrevious = currentContent.filter(
        (part) => !(part.type === 'text' && isDynamicStateText(part.content)),
      );
      newContent = [...withoutPrevious, { type: 'text' as const, content: stateBlock.trim() }];
    }
    result[i] = { ...msg, content: newContent };
    return { messages: result, systemPrompts };
  }

  // No user message found — add as system prompt (replace previous block)
  const withoutPrevious = systemPrompts.filter(
    (p) => !(typeof p === 'string' && p.startsWith(DYNAMIC_STATE_SYSTEM_PREFIX)),
  );
  return {
    messages,
    systemPrompts: [...withoutPrevious, `CURRENT TASK STATE:\n${xml}`],
  };
}

/** Whether a text part is a previously injected dynamic-state block. */
function isDynamicStateText(content: string): boolean {
  return content.startsWith('<dynamic_state>') && content.endsWith(DYNAMIC_STATE_USER_SUFFIX);
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
