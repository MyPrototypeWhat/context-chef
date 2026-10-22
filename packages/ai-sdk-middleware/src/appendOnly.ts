import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider';
import {
  type ChefLogger,
  compactMessages,
  type Message,
  objectToXml,
  type PrefixSession,
  type SessionPool,
} from '@context-chef/core';

import { toAISDK } from './adapter';
import type { ContextChefOptions, PrefixBreakEvent } from './types';

/** The steps `appendOnly` shares with the 4.x transform, as the middleware runs them. */
export interface SharedSteps {
  /** Steps 1–3: truncate, compact, and split the IR into system messages and the conversation. */
  prepare(prompt: LanguageModelV4Prompt): Promise<{
    systemMessages: Message[];
    conversation: Message[];
  }>;
  /** What goes after the host's system messages: the skill, then the clear explainer. */
  standing(): Promise<Message[]>;
  /** The session a call belongs to. */
  sessionKey(params: LanguageModelV4CallOptions): string;
  /** Whether a call leaves compression to provider-side context management (warned once). */
  yieldsToServer(params: LanguageModelV4CallOptions): boolean;
}

/**
 * `transformParams` with `appendOnly`: the session rebuilds the conversation
 * from its ledger — the head of the last compression, the host's messages,
 * the events appended among them — so what an earlier call sent is sent
 * again as it was. The system messages, skill and clear explainer go ahead
 * of it as in 4.x; a change there is a checkpoint.
 */
export function appendOnlyTransform(
  options: ContextChefOptions,
  logger: ChefLogger,
  sessions: SessionPool<PrefixSession>,
  steps: SharedSteps,
): (params: LanguageModelV4CallOptions) => Promise<LanguageModelV4CallOptions> {
  const reportBreak = (event: PrefixBreakEvent) => {
    try {
      options.onPrefixBreak?.(event);
    } catch (error) {
      logger.warn('[context-chef] onPrefixBreak threw — the call goes ahead', error);
    }
  };

  return async (params) => {
    const sessionId = steps.sessionKey(params);
    const session = sessions.get(sessionId);
    const { systemMessages, conversation } = await steps.prepare(params.prompt);
    // Cleared before the session compares anything: a placeholder that moves
    // rewrites a message already sent, a checkpoint it has to see.
    const history = options.clear?.length
      ? compactMessages(conversation, { clear: options.clear })
      : conversation;
    const ahead = [...systemMessages, ...(await steps.standing())];
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
      overflow: session.janitor !== null && !steps.yieldsToServer(params),
      signal: params.abortSignal,
    });
    for (const brk of breaks) reportBreak({ ...brk, sessionId });

    let prompt = toAISDK([...ahead, ...messages]);
    if (options.transformContext) {
      prompt = await options.transformContext(prompt);
    }
    return { ...params, prompt };
  };
}

/**
 * `appendOnly`: the settings that cost what it is for, warned by each
 * middleware instance as it is created. `clearAt` has nothing to act on here,
 * and a `compact` or `clear` cut that moves with the conversation rewrites a
 * message an earlier call sent on nearly every call.
 */
export function warnAppendOnlyConfig(options: ContextChefOptions, logger: ChefLogger): void {
  if (typeof options.appendOnly === 'object' && options.appendOnly.clearAt) {
    logger.warn(
      '[context-chef] appendOnly: `clearAt` is ignored by the middleware. The provider behind ' +
        'the model is unknown and may move a mid-conversation system message into the system ' +
        'prompt, so every event is a user message here, and a user message cannot be ' +
        'turn-scoped.',
    );
  }
  const moving = movingRewrites(options);
  if (moving.length > 0) {
    logger.warn(
      `[context-chef] appendOnly: ${moving.join(', ')} ${moving.length > 1 ? 'move' : 'moves'} ` +
        'with the conversation, rewriting messages earlier calls sent, so nearly every call is a ' +
        "checkpoint: the provider's prefix cache misses from the rewritten message, and signed " +
        "reasoning is stripped from it on. Use 'all', which rewrites each message once before it " +
        "is first sent, or the provider's own context editing " +
        '(providerOptions.anthropic.contextManagement).',
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
