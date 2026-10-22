import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import {
  type ChefLogger,
  compactMessages,
  createJanitorPool,
  createPrefixSessionPool,
  DEFAULT_SESSION_KEY,
  flattenForCompression,
  type Janitor,
  type Message,
  normalizeSessionKey,
  objectToXml,
  type PrefixSession,
  Prompts,
  type SessionPool,
  type SummarizeHistoryOptions,
  summarizeHistory,
} from '@context-chef/core';
import {
  generateText,
  type LanguageModel,
  type LanguageModelMiddleware,
  type ModelMessage,
  pruneMessages,
} from 'ai';

import { fromAISDK, toAISDK, withoutReasoning } from './adapter';
import { fromModelMessages } from './modelMessageAdapter';
import { truncateToolResults } from './truncator';
import type { ContextChefOptions, DynamicStateConfig, PrefixBreakEvent } from './types';

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

  // One Janitor per session. A middleware instance is usually created once at
  // module scope (`const model = withContextChef(...)`) but serves many
  // conversations — sharing one Janitor would leak token-usage feeds,
  // compression suppression, and circuit-breaker counts across them. Callers
  // opt in per call via `providerOptions: { contextChef: { sessionId } }`;
  // calls without a sessionId share the default session (prior behavior).
  // Null for truncate/compact/skill/dynamicState-only configurations: no
  // budget checks, no token-usage capture, and none of the Janitor's
  // missing-tokenizer warnings.
  const janitorConfig = {
    contextWindow: options.contextWindow,
    compress: options.compress,
    compressionModel: options.compress?.model
      ? createCompressionAdapter(options.compress.model)
      : undefined,
    tokenizer: options.tokenizer,
    onCompress: options.onCompress,
    onBeforeCompress: options.onBeforeCompress,
    overflow: options.overflow,
    toHostMessages: toAISDK,
    logger,
    maxSessions: options.maxSessions,
  };
  // With appendOnly every session also keeps the prefix ledger its calls are
  // replayed from — dynamic state alone needs one — so the pool holds
  // sessions, each with its Janitor when compression is configured.
  const sessions = options.appendOnly
    ? createPrefixSessionPool({ ...janitorConfig, withoutThinking: withoutReasoning })
    : null;
  const janitors = options.appendOnly
    ? null
    : createJanitorPool({
        ...janitorConfig,
        // In-flight-without-persistence footgun: the summary is discarded each
        // call and history re-expands, so the payload grows unbounded (and
        // compression effectively skips every other call via E10 suppression).
        persistenceWarning: (firedCount) =>
          `[context-chef] compress has fired ${firedCount}× but no \`onCompress\` is ` +
          'configured. In-flight compression only rewrites each outgoing request — the summary is ' +
          'not persisted, so your message history re-expands on the next call and the payload grows ' +
          'unbounded (eventually overflowing the context window). For sustained compression, persist ' +
          'the summary via `onCompress` (replace the compressed slice in your own store), or use ' +
          '`compactModelMessages` for durable compaction.',
      });
  if (options.appendOnly) warnAppendOnlyConfig(options, logger);

  let invalidSessionKeyWarned = false;
  const flagInvalidSessionKey = (raw: unknown) => {
    if (invalidSessionKeyWarned) return;
    invalidSessionKeyWarned = true;
    logger.warn(
      '[context-chef] Invalid providerOptions.contextChef sessionId (expected a non-empty ' +
        `string, got ${raw === '' ? 'empty string' : typeof raw}); routing to the default session.`,
    );
  };

  const sessionKey = (params: { providerOptions?: Record<string, unknown> }): string => {
    const ns = params.providerOptions?.contextChef;
    if (ns != null && typeof ns !== 'object') {
      // Malformed namespace (e.g. contextChef: 'abc') — never a session key.
      flagInvalidSessionKey(ns);
      return DEFAULT_SESSION_KEY;
    }
    const raw = ns ? (ns as Record<string, unknown>).sessionId : undefined;
    return normalizeSessionKey(raw, flagInvalidSessionKey);
  };

  const janitorFor = (params: { providerOptions?: Record<string, unknown> }): Janitor | null =>
    janitors ? janitors.get(sessionKey(params)) : null;

  /**
   * Where a response's input token count goes: the session's Janitor, and
   * with appendOnly the session's ledger too, which takes it to describe the
   * call it last compiled. Null when nothing budgets.
   */
  const usageFor = (params: {
    providerOptions?: Record<string, unknown>;
  }): ((tokens: number) => void) | null => {
    if (sessions) {
      const session = sessions.get(sessionKey(params));
      return session.janitor ? (tokens) => session.reportTokenUsage(tokens) : null;
    }
    const janitor = janitorFor(params);
    return janitor ? (tokens) => janitor.feedTokenUsage(tokens) : null;
  };

  // Anti-double-compression guard: when a call opts into Anthropic
  // server-side context management, the server already compacts/clears the
  // history — compressing it here as well would rewrite it twice. Warned
  // once per middleware instance; `allowDoubleCompression: true` disables
  // the guard entirely.
  let doubleCompressionWarned = false;
  const warnServerManagedOnce = (warning: string) => {
    if (doubleCompressionWarned) return;
    doubleCompressionWarned = true;
    logger.warn(warning);
  };
  /** Whether this call leaves compression to the server (see above). */
  const yieldsToServer = (params: { providerOptions?: Record<string, unknown> }): boolean => {
    const warning = options.allowDoubleCompression
      ? null
      : serverContextManagementWarning(params.providerOptions);
    if (warning) warnServerManagedOnce(warning);
    return warning !== null;
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

  /**
   * Steps 1–3, in both modes: truncate large tool results, compact
   * mechanically, and split the IR into the standing instructions and the
   * conversation.
   */
  const prepare = async (
    sent: LanguageModelV4Prompt,
  ): Promise<{ systemMessages: Message[]; conversation: Message[] }> => {
    let prompt = sent;

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
    return {
      systemMessages: allIR.filter((m) => m.role === 'system'),
      conversation: allIR.filter((m) => m.role !== 'system'),
    };
  };

  // The clear explainer is placed after skill messages, just before the
  // conversation, so the model sees the explanation immediately ahead of the
  // placeholders it describes.
  const clearNotice: Message[] = clearsToolResults
    ? [{ role: 'system', content: Prompts.TOOL_RESULT_CLEARED_INSTRUCTION }]
    : [];

  const reportBreak = (event: PrefixBreakEvent) => {
    try {
      options.onPrefixBreak?.(event);
    } catch (error) {
      logger.warn('[context-chef] onPrefixBreak threw — the call goes ahead', error);
    }
  };

  /**
   * `appendOnly`: the session rebuilds the conversation from its ledger — the
   * head of the last compression, the host's messages, the events appended
   * among them — so what an earlier call sent is sent again as it was. The
   * system messages, skill and clear explainer go ahead of it as in 4.x; a
   * change there is a checkpoint.
   */
  const appendOnlyParams = async (
    params: LanguageModelV4CallOptions,
    pool: SessionPool<PrefixSession>,
  ): Promise<LanguageModelV4CallOptions> => {
    const sessionId = sessionKey(params);
    const session = pool.get(sessionId);
    const { systemMessages, conversation } = await prepare(params.prompt);
    // Cleared before the session compares anything: a placeholder that moves
    // rewrites a message already sent, a checkpoint it has to see.
    const history = options.clear?.length
      ? compactMessages(conversation, { clear: options.clear })
      : conversation;
    const ahead = [
      ...systemMessages,
      ...(await resolveSkillMessages(options.skill)),
      ...clearNotice,
    ];
    const state = options.dynamicState
      ? objectToXml(await options.dynamicState.getState(), 'dynamic_state')
      : undefined;

    const { messages, breaks } = await session.compile({
      history,
      // What the model reads ahead of the conversation; provider options
      // (a cache breakpoint moving) are not part of it.
      sent: {
        system: ahead.map((m) => m.content),
        tools: params.tools?.map((tool) => {
          if (tool.type !== 'function') return tool;
          const { providerOptions: _options, ...definition } = tool;
          return definition;
        }),
      },
      dynamicState: state,
      overflow: session.janitor !== null && !yieldsToServer(params),
      signal: params.abortSignal,
    });
    for (const brk of breaks) reportBreak({ ...brk, sessionId });

    // A reply that held nothing but reasoning has nothing left to send once stripped.
    let prompt = toAISDK([...ahead, ...messages]).filter(
      (m) => m.role !== 'assistant' || m.content.length > 0,
    );
    if (options.transformContext) {
      prompt = await options.transformContext(prompt);
    }
    return { ...params, prompt };
  };

  return {
    specificationVersion: 'v4',

    transformParams: async ({ params }) => {
      if (sessions) return appendOnlyParams(params, sessions);

      const janitor = janitorFor(params);
      const { systemMessages, conversation: prepared } = await prepare(params.prompt);
      let conversation = prepared;

      // 4. Compress conversation history if over token budget (budgeting
      //    only). Yields to Anthropic server-side context management when
      //    the call declares it (see warnServerManagedOnce above) — every
      //    other step still runs; only this one is skipped.
      if (janitor && !yieldsToServer(params)) {
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
      const irMessages = [...systemMessages, ...skillMessages, ...clearNotice, ...conversation];

      // 6. Convert back to AI SDK format
      let prompt = toAISDK(irMessages);

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

      const report = usageFor(params);
      if (!report) return result;

      if (result.usage?.inputTokens?.total != null) {
        report(result.usage.inputTokens.total);
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
      const report = usageFor(params);
      if (!report) return doStream();

      const { stream, ...rest } = await doStream();

      const transform = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(chunk, controller) {
          if (chunk.type === 'finish') {
            if (chunk.usage?.inputTokens?.total != null) {
              report(chunk.usage.inputTokens.total);
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
 * `appendOnly`: the settings that cost what it is for, warned once per
 * middleware instance. `clearAt` has nothing to act on here, and a `compact`
 * or `clear` cut that moves with the conversation rewrites a message an
 * earlier call sent on nearly every call.
 */
function warnAppendOnlyConfig(options: ContextChefOptions, logger: ChefLogger): void {
  if (typeof options.appendOnly === 'object' && options.appendOnly.clearAt) {
    logger.warn(
      '[context-chef] appendOnly: `clearAt` is ignored by the middleware. The provider behind ' +
        'the model is unknown and may move a mid-conversation system message into the system ' +
        'prompt, so every event is a user message here, and a user message cannot be ' +
        'turn-scoped (warned once).',
    );
  }
  const moving = movingRewrites(options);
  if (moving.length > 0) {
    logger.warn(
      `[context-chef] appendOnly: ${moving.join(', ')} ${moving.length > 1 ? 'move' : 'moves'} ` +
        'with the conversation, rewriting messages earlier calls sent, so nearly every call is a ' +
        "checkpoint: the provider's prefix cache misses from the rewritten message, and reasoning " +
        "is stripped from it on. Use 'all', which rewrites each message once before it is first " +
        "sent, or the provider's own context editing (providerOptions.anthropic.contextManagement) " +
        '(warned once).',
    );
  }
}

/** The `compact` / `clear` settings whose cut moves with the conversation, as written. */
function movingRewrites({ compact, clear }: ContextChefOptions): string[] {
  const moving: string[] = [];
  if (compact?.reasoning === 'before-last-message') {
    moving.push("compact.reasoning: 'before-last-message'");
  }
  const toolCalls = compact?.toolCalls;
  const types =
    typeof toolCalls === 'string' ? [toolCalls] : (toolCalls ?? []).map((entry) => entry.type);
  for (const type of types) {
    if (type.startsWith('before-last-')) moving.push(`compact.toolCalls: '${type}'`);
  }
  for (const target of clear ?? []) {
    if (typeof target === 'object' && target.keepRecent !== undefined) {
      moving.push(`clear: { target: '${target.target}', keepRecent: ${target.keepRecent} }`);
    }
  }
  return moving;
}

/**
 * The warning to log when a call opts into Anthropic server-side context
 * management (`providerOptions.anthropic.contextManagement`, per
 * `@ai-sdk/anthropic`) — the signal that middleware compression must yield
 * for that call. Returns null when the option is absent or malformed.
 *
 * The wording splits on whether the edits array holds exclusively `clear_*`
 * edits (e.g. `clear_tool_uses_20250919`, `clear_thinking_20251015`) instead
 * of a `compact_20260112`: the server clears rather than compacts, which
 * changes only the explanation, never the skip decision.
 */
function serverContextManagementWarning(
  providerOptions: Record<string, unknown> | undefined,
): string | null {
  const anthropic = providerOptions?.anthropic;
  if (anthropic == null || typeof anthropic !== 'object') return null;
  const contextManagement = (anthropic as Record<string, unknown>).contextManagement;
  if (contextManagement == null || typeof contextManagement !== 'object') return null;
  const edits = (contextManagement as Record<string, unknown>).edits;
  const clearOnly =
    Array.isArray(edits) &&
    edits.length > 0 &&
    edits.every(
      (edit) =>
        edit != null &&
        typeof edit === 'object' &&
        typeof (edit as Record<string, unknown>).type === 'string' &&
        ((edit as Record<string, unknown>).type as string).startsWith('clear_'),
    );

  return clearOnly
    ? '[context-chef] Anthropic server-side context management detected ' +
        '(providerOptions.anthropic.contextManagement with only clear_* edits). The server ' +
        'is already managing context by clearing old tool uses/thinking, so middleware ' +
        'compression is skipped for these calls to avoid managing the same history twice. ' +
        'Set `allowDoubleCompression: true` to compress anyway.'
    : '[context-chef] Anthropic server-side context management detected ' +
        '(providerOptions.anthropic.contextManagement). The server manages the context ' +
        'window (including compaction), so middleware compression is skipped for these ' +
        'calls to avoid compressing the same history twice. Set ' +
        '`allowDoubleCompression: true` to compress anyway.';
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
  const xml = objectToXml(state, 'dynamic_state');
  const placement = config.placement ?? 'last_user';

  if (placement === 'system') {
    return [...prompt, { role: 'system', content: `CURRENT TASK STATE:\n${xml}` }];
  }

  // last_user: inject into the last user message
  const result = [...prompt];
  const stateBlock = `\n\n${xml}\n${Prompts.STATE_ANCHOR}`;

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
