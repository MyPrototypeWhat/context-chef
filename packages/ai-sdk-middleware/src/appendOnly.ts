import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider';
import {
  type ChefLogger,
  compactMessages,
  type Message,
  objectToXml,
  type PrefixSession,
  prefixBreakReporter,
  type SessionPool,
} from '@context-chef/core';

import { toAISDK } from './adapter';
import type { ContextChefOptions } from './types';

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
  const reportBreak = prefixBreakReporter(options.onPrefixBreak, logger);

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
