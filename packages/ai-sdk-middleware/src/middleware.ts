import type {
  LanguageModelV4,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import {
  type ChefLogger,
  type CompressionDetails,
  compactMessages,
  DEFAULT_SESSION_KEY,
  dedupeConstructionWarnings,
  flattenForCompression,
  Janitor,
  type Message,
  normalizeSessionKey,
  Prompts,
  SessionPool,
  type SummarizeHistoryOptions,
  summarizeHistory,
  XmlGenerator,
} from '@context-chef/core';
import {
  generateText,
  type LanguageModel,
  type LanguageModelMiddleware,
  type ModelMessage,
  pruneMessages,
} from 'ai';

import { fromAISDK, toAISDK } from './adapter';
import { fromModelMessages } from './modelMessageAdapter';
import { truncateToolResults } from './truncator';
import type { ContextChefOptions, DynamicStateConfig } from './types';

/**
 * After this many compressions fire without an `onCompress` persistence hook,
 * warn once. The middleware compresses in-flight only — it never mutates the
 * caller's message store — so without write-back the history re-expands every
 * call and the outgoing payload grows unbounded. A couple of fires is a
 * transient spike (fine); repeated fires signal a sustained over-budget
 * conversation that needs durable persistence.
 */
const COMPRESS_WITHOUT_PERSISTENCE_WARN_THRESHOLD = 3;

/**
 * Creates a LanguageModelMiddleware that transparently applies
 * context-chef compression and truncation to AI SDK model calls.
 *
 * The middleware holds a stateful Janitor instance that tracks
 * token usage across calls for compression decisions.
 */
export function createMiddleware(options: ContextChefOptions): LanguageModelMiddleware {
  const logger = options.logger ?? console;
  let usageWarned = false;

  // Budget-dependent features: compression and its hooks. Any of them
  // signals compression intent and needs a Janitor — and therefore a
  // `contextWindow`. Truncate/compact/skill/dynamicState-only
  // configurations get no Janitor at all: no budget checks, no token-usage
  // capture, and none of the Janitor's missing-tokenizer warnings.
  const budgeting = Boolean(options.compress || options.onCompress || options.onBeforeCompress);

  if (budgeting && options.contextWindow == null) {
    throw new Error(
      '[context-chef] `contextWindow` is required when a compression option (`compress`, ' +
        '`onCompress`, `onBeforeCompress`) is configured — the budget ' +
        'check has nothing to compare against without it.',
    );
  }

  // Surface the in-flight-without-persistence footgun: if compression keeps
  // firing but no `onCompress` is configured, the summary is discarded each
  // call and history re-expands, so the payload grows unbounded (and
  // compression effectively skips every other call via E10 suppression).
  let compressionsFired = 0;
  let persistenceWarned = false;
  const onCompressionFired = () => {
    compressionsFired++;
    if (
      persistenceWarned ||
      options.onCompress ||
      compressionsFired < COMPRESS_WITHOUT_PERSISTENCE_WARN_THRESHOLD
    ) {
      return;
    }
    persistenceWarned = true;
    logger.warn(
      `[context-chef] compress has fired ${compressionsFired}× but no \`onCompress\` is ` +
        'configured. In-flight compression only rewrites each outgoing request — the summary is ' +
        'not persisted, so your message history re-expands on the next call and the payload grows ' +
        'unbounded (eventually overflowing the context window). For sustained compression, persist ' +
        'the summary via `onCompress` (replace the compressed slice in your own store), or use ' +
        '`compactModelMessages` for durable compaction.',
    );
  };

  // One Janitor per session. A middleware instance is usually created once at
  // module scope (`const model = withContextChef(...)`) but serves many
  // conversations — sharing one Janitor would leak token-usage feeds,
  // compression suppression, and circuit-breaker counts across them. Callers
  // opt in per call via `providerOptions: { contextChef: { sessionId } }`;
  // calls without a sessionId share the default session (prior behavior).
  // Construction-time config nags are deduped across sessions — the config
  // is identical for every pooled Janitor, so once is enough.
  const janitors = budgeting
    ? new SessionPool(
        dedupeConstructionWarnings(logger, (constructionLogger) =>
          createJanitor(
            options,
            options.contextWindow as number,
            constructionLogger,
            onCompressionFired,
          ),
        ),
        { maxSize: options.maxSessions },
      )
    : null;

  let invalidSessionKeyWarned = false;
  const flagInvalidSessionKey = (raw: unknown) => {
    if (invalidSessionKeyWarned) return;
    invalidSessionKeyWarned = true;
    logger.warn(
      '[context-chef] Invalid providerOptions.contextChef sessionId (expected a non-empty ' +
        `string, got ${raw === '' ? 'empty string' : typeof raw}); routing to the default session.`,
    );
  };

  const janitorFor = (params: { providerOptions?: Record<string, unknown> }): Janitor | null => {
    if (!janitors) return null;
    const ns = params.providerOptions?.contextChef;
    if (ns != null && typeof ns !== 'object') {
      // Malformed namespace (e.g. contextChef: 'abc') — never a session key.
      flagInvalidSessionKey(ns);
      return janitors.get(DEFAULT_SESSION_KEY);
    }
    const raw = ns ? (ns as Record<string, unknown>).sessionId : undefined;
    return janitors.get(normalizeSessionKey(raw, flagInvalidSessionKey));
  };

  const clearsToolResults = !!options.clear?.some(
    (t) => t === 'tool-result' || (typeof t === 'object' && t.target === 'tool-result'),
  );

  // `clear` only round-trips tool-result placeholders through the adapter.
  // Reasoning lives in the assistant message's content parts, which the
  // adapter passes through untouched unless the text content changed — so a
  // `'thinking'` target here is a silent no-op. Reasoning removal belongs to
  // `compact` (pruneMessages), which strips reasoning parts for real.
  if (options.clear?.some((t) => t === 'thinking')) {
    logger.warn(
      "[context-chef] `clear: ['thinking']` has no effect in the middleware — reasoning " +
        'parts pass through the adapter unchanged. Use `compact: { reasoning: ... }` to remove reasoning.',
    );
  }

  return {
    specificationVersion: 'v4',

    transformParams: async ({ params }) => {
      const janitor = janitorFor(params);
      let { prompt } = params;

      // 1. Truncate large tool results
      if (options.truncate) {
        prompt = await truncateToolResults(prompt, options.truncate, logger);
      }

      // 2. Compact (mechanical, zero LLM cost) via pruneMessages
      if (options.compact) {
        prompt = compactPrompt(prompt, options.compact);
      }

      // 3. Convert to IR and separate system messages from conversation.
      // System messages are standing instructions — they must not be
      // compressed away. Only conversation history goes through compact/compress.
      const allIR = fromAISDK(prompt);
      const systemMessages = allIR.filter((m) => m.role === 'system');
      let conversation = allIR.filter((m) => m.role !== 'system');

      // 4. Compress conversation history if over token budget (budgeting only)
      if (janitor) {
        conversation = await janitor.compress(conversation);
      }

      // 4.5 Placeholder-style clearing (core semantics) — after compress so
      // the summarizer saw full content; placeholders only hit the kept tail.
      if (options.clear?.length) {
        conversation = compactMessages(conversation, { clear: options.clear });
      }

      // 5. Reassemble sandwich: user system + skill instructions + conversation.
      //    The skill slot mirrors @context-chef/core compile() ordering
      //    (SKILL_SPEC §6.3): a dedicated system message AFTER user system
      //    and BEFORE the conversation history. Empty instructions are
      //    skipped to avoid emitting an empty system message.
      const skillMessages = await resolveSkillMessages(options.skill);
      // The clear explainer is placed after skill messages, just before the
      // conversation, so the model sees the explanation immediately ahead of
      // the placeholders it describes.
      const clearNotice: Message[] = clearsToolResults
        ? [{ role: 'system', content: Prompts.TOOL_RESULT_CLEARED_INSTRUCTION }]
        : [];
      const irMessages = [...systemMessages, ...skillMessages, ...clearNotice, ...conversation];

      // 6. Convert back to AI SDK format
      prompt = toAISDK(irMessages);

      // 7. Dynamic state injection
      if (options.dynamicState) {
        prompt = await injectDynamicState(prompt, options.dynamicState);
      }

      // 8. Custom transform hook
      if (options.transformContext) {
        prompt = await options.transformContext(prompt);
      }

      return { ...params, prompt };
    },

    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();

      const janitor = janitorFor(params);
      if (!janitor) return result;

      if (result.usage?.inputTokens?.total != null) {
        janitor.feedTokenUsage(result.usage.inputTokens.total);
      } else if (!usageWarned && !options.tokenizer) {
        usageWarned = true;
        logger.warn(
          '[context-chef] Model response did not include usage.inputTokens.total. ' +
            'Token-based compression may not trigger accurately. ' +
            'Consider providing a tokenizer for precise token counting.',
        );
      }

      return result;
    },

    wrapStream: async ({ doStream, params }) => {
      const janitor = janitorFor(params);
      if (!janitor) return doStream();

      const { stream, ...rest } = await doStream();

      const transform = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(chunk, controller) {
          if (chunk.type === 'finish') {
            if (chunk.usage?.inputTokens?.total != null) {
              janitor.feedTokenUsage(chunk.usage.inputTokens.total);
            } else if (!usageWarned && !options.tokenizer) {
              usageWarned = true;
              logger.warn(
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
 * Builds the stateful Janitor for budget-dependent configurations.
 *
 * The Janitor config is a discriminated union on `tokenizer`. Build the
 * two branches separately so the literal type matches one of the union
 * members exactly — a single literal carrying `tokenizer: Fn | undefined`
 * would not narrow to either branch.
 */
function createJanitor(
  options: ContextChefOptions,
  contextWindow: number,
  logger: ChefLogger,
  onCompressionFired: () => void,
): Janitor {
  const userOnCompress = options.onCompress;
  const sharedJanitorConfig = {
    contextWindow,
    toolResultStubThreshold: options.compress?.toolResultStubThreshold,
    compressionModel: options.compress?.model
      ? createCompressionAdapter(options.compress.model)
      : undefined,
    // Always installed so every compression is counted for the
    // persistence warning; the user's hook is forwarded when configured.
    onCompress: (summary: Message, count: number, details: CompressionDetails) => {
      onCompressionFired();
      userOnCompress?.(summary.content, count, {
        compressedMessages: toAISDK(details.compressedMessages),
      });
    },
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

  return options.tokenizer
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
}

/**
 * Prunes a LanguageModelV4Prompt via AI SDK's pruneMessages.
 *
 * LanguageModelV4Message (from @ai-sdk/provider) and ModelMessage
 * (from @ai-sdk/provider-utils) share identical runtime structure but
 * differ at the TypeScript level (e.g. ImagePart, FilePart.data).
 * Since pruneMessages only filters — never transforms — every content
 * part in the output is an original V4 part, making the casts safe.
 */
function compactPrompt(
  prompt: LanguageModelV4Prompt,
  config: Omit<Parameters<typeof pruneMessages>[0], 'messages'>,
): LanguageModelV4Prompt {
  const messages = prompt.map(
    (msg) =>
      ({
        role: msg.role,
        content: msg.content,
        providerOptions: msg.providerOptions,
      }) as ModelMessage,
  );
  const pruned = pruneMessages({ messages, ...config });
  return pruned.map(
    (msg) =>
      ({
        role: msg.role,
        content: msg.content,
        providerOptions: msg.providerOptions,
      }) as LanguageModelV4Message,
  );
}

/**
 * Resolves the `skill` option into IR system messages to insert between
 * user system messages and conversation. Returns `[]` when no skill is
 * active, the resolver returns null/undefined, or instructions are empty.
 *
 * The function form is invoked on every transformParams call so the
 * caller can swap skills dynamically without recreating the middleware.
 */
async function resolveSkillMessages(skill: ContextChefOptions['skill']): Promise<Message[]> {
  if (!skill) return [];
  const resolved = typeof skill === 'function' ? await skill() : skill;
  // Treat whitespace-only instructions as empty — they would otherwise pollute
  // the prompt and create a needless cache breakpoint between system and history.
  if (!resolved?.instructions?.trim()) return [];
  return [{ role: 'system', content: resolved.instructions }];
}

/**
 * Injects dynamic state XML into the AI SDK prompt.
 *
 * - `last_user`: Appends to the last user message's content parts.
 *   Leverages Recency Bias for maximum LLM attention.
 * - `system`: Adds as a standalone system message at the end.
 */
async function injectDynamicState(
  prompt: LanguageModelV4Prompt,
  config: DynamicStateConfig,
): Promise<LanguageModelV4Prompt> {
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
 * Adapts an AI SDK LanguageModelV4 into the compressionModel callback
 * that Janitor expects: (messages: Message[]) => Promise<string>
 *
 * Tool messages are converted to user messages describing the tool interaction,
 * since generateText only accepts system/user/assistant roles.
 */
export function createCompressionAdapter(
  model: LanguageModel,
): (messages: Message[]) => Promise<string> {
  return async (messages: Message[]): Promise<string> => {
    const { text } = await generateText({
      model,
      messages: flattenForCompression(messages),
      maxOutputTokens: 2048,
    });

    return text || '[Compression produced no output]';
  };
}

/**
 * Options for {@link summarizeMessages}. Currently a structural alias of core's
 * `SummarizeHistoryOptions` — add middleware-specific fields here if they ever
 * diverge.
 */
export type SummarizeMessagesOptions = SummarizeHistoryOptions;

/**
 * Summarize an AI-SDK prompt slice into a single summary string, using the
 * SAME pipeline as the in-flight `compress` path: role-flattening via the
 * compression adapter + core `summarizeHistory`. System messages are dropped
 * (they are standing instructions, not conversation). Returns the extracted
 * summary text — wrap it with `getCompactSummaryWrapper` from
 * `@context-chef/core` for the "continued conversation" framing. An empty
 * prompt returns `''` without a model call; throws if the model call fails.
 *
 * For hosts that own their conversation store and persist compression
 * themselves (durable compaction) instead of relying on in-flight middleware
 * compression. IMPORTANT: if you drive summarization this way, do NOT also
 * configure `compress` (with a `model`) on the same middleware instance for the
 * same conversation path — that would compress twice (model compression at call
 * time, then again at persist time). A notification-only `onCompress`, plus
 * `truncate`, `clear`, and `dynamicState`, remain safe to use alongside.
 */
export async function summarizeMessages(
  prompt: LanguageModelV4Prompt,
  model: LanguageModelV4,
  opts: SummarizeMessagesOptions = {},
): Promise<string> {
  const ir = fromAISDK(prompt).filter((m) => m.role !== 'system');
  return summarizeHistory(ir, createCompressionAdapter(model), opts);
}

/**
 * ModelMessage-altitude sibling of {@link summarizeMessages}: summarize a
 * `ModelMessage[]` slice into a single summary string via the same pipeline
 * (role-flattening + core `summarizeHistory`). System messages are dropped.
 * Empty input returns `''` without a model call; throws if the model call fails.
 */
export async function summarizeModelMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  opts: SummarizeMessagesOptions = {},
): Promise<string> {
  const ir = fromModelMessages(messages).filter((m) => m.role !== 'system');
  return summarizeHistory(ir, createCompressionAdapter(model), opts);
}
