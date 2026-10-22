import {
  type ChefLogger,
  compactMessages as clearMessages,
  type Message,
  objectToXml,
  type PrefixSession,
  prefixBreakReporter,
  type SessionPool,
} from '@context-chef/core';
import {
  type ChatMiddlewareConfig,
  type ChatMiddlewareContext,
  convertSchemaToJsonSchema,
  EventType,
  type ModelMessage,
  type StreamChunk,
  type SystemPrompt,
  type Tool,
} from '@tanstack/ai';

import { systemPromptText, toTanStackAI, withoutThinkingBlocks } from './adapter';
import type { ContextChefOptions } from './types';

/** The steps `appendOnly` shares with the 4.x transform, as the middleware runs them. */
export interface SharedSteps {
  /** Truncate, convert to IR, and compact. */
  prepare(messages: ModelMessage[]): Promise<Message[]>;
  /** `systemPrompts` with the skill's instructions and the clear explainer after them. */
  standing(systemPrompts: SystemPrompt[]): Promise<SystemPrompt[]>;
  /** The conversation a call belongs to. */
  sessionKey(ctx: ChatMiddlewareContext): string;
}

/** The middleware hooks `appendOnly` runs. */
export interface AppendOnlyHooks {
  /** `onConfig`: the request one firing sends. */
  config(ctx: ChatMiddlewareContext, config: ChatMiddlewareConfig): Promise<Sent | undefined>;
  /**
   * Where the usage of the request a conversation last sent goes: its
   * session, when that request was the window the ledger kept and something
   * budgets; otherwise null.
   */
  usage(ctx: ChatMiddlewareContext): ((tokens: number) => void) | null;
  /** `onChunk`: the signatures of thinking that answers a request the ledger did not keep. */
  chunk(ctx: ChatMiddlewareContext, chunk: StreamChunk): void;
}

type Sent = Pick<ChatMiddlewareConfig, 'messages' | 'systemPrompts'>;

/** What a conversation's last call in a chat() run was compiled from, and what it returned. */
interface Carried extends Sent {
  /** The run (`ctx.requestId`): the engine carries a config within one chat() call only. */
  readonly run: string;
  readonly sent: Sent;
}

/** What the middleware keeps of a conversation next to its session. */
interface Conversation {
  /** Its last call, so a config the engine carried within the run can be read back. */
  carried?: Carried;
  /**
   * Whether the request it last sent is the window its ledger kept — not
   * while a firing runs, nor after one failed and went out as the engine had
   * it, nor after a one-off.
   */
  kept: boolean;
  /**
   * Signatures of thinking that answered a request the ledger did not keep:
   * signed over a prefix the conversation never had, so never replayed in it.
   */
  readonly foreign: Set<string>;
}

/**
 * `appendOnly`: the session rebuilds the conversation from its ledger — the
 * head of the last compression, the host's messages, the events appended
 * among them — so what an earlier call sent is sent again as it was. The
 * host's system prompts, the skill and the clear explainer go ahead of it as
 * in 4.x; a change there is a checkpoint.
 */
export function appendOnlyHooks(
  options: ContextChefOptions,
  logger: ChefLogger,
  sessions: SessionPool<PrefixSession>,
  steps: SharedSteps,
): AppendOnlyHooks {
  const reportBreak = prefixBreakReporter(options.onPrefixBreak, logger);
  // Next to each session, and gone with it.
  const conversations = new WeakMap<PrefixSession, Conversation>();
  const conversationOf = (session: PrefixSession): Conversation => {
    let conversation = conversations.get(session);
    if (!conversation) {
      conversation = { kept: false, foreign: new Set() };
      conversations.set(session, conversation);
    }
    return conversation;
  };

  return {
    async config(ctx, config) {
      // No model call follows init before its own firing, and in between the
      // engine settles pending tool calls — which must not meet the
      // placeholder results the IR boundary gives them.
      if (ctx.phase === 'init') return undefined;

      const sessionId = steps.sessionKey(ctx);
      const session = sessions.get(sessionId);
      const conversation = conversationOf(session);
      // Until this firing's window is kept, what goes out is not the ledger's.
      conversation.kept = false;
      const record = conversation.carried;
      // A config from another run is the host's own, whatever it opens with.
      const last = record && ctx.requestId && record.run === ctx.requestId ? record : undefined;
      const messages = hostMessages(config.messages, last);
      const systemPrompts =
        last && sameItems(config.systemPrompts, last.sent.systemPrompts)
          ? last.systemPrompts
          : config.systemPrompts;

      const prepared = await steps.prepare(messages);
      // Cleared before the session compares anything: a placeholder that moves
      // rewrites a message already sent, a checkpoint it has to see.
      const history = options.clear?.length
        ? clearMessages(prepared, { clear: options.clear })
        : prepared;
      const ahead = await steps.standing(systemPrompts);
      const state = options.dynamicState
        ? objectToXml(await options.dynamicState.getState(), 'dynamic_state')
        : undefined;

      // The structured-output call goes out without tools, a request outside
      // the conversation: its own checkpoints apply to it alone.
      const oneOff = ctx.phase === 'structuredOutput';
      const { messages: window, breaks } = await session.compile({
        history,
        // What the model reads ahead of the conversation; provider metadata (a
        // cache breakpoint moving) is not part of it.
        sent: {
          system: ahead.map(systemPromptText),
          tools: oneOff ? [] : config.tools.map(toolDefinition),
        },
        dynamicState: state,
        oneOff,
        signal: ctx.signal,
      });
      if (!oneOff) for (const brk of breaks) reportBreak({ ...brk, sessionId });

      const { foreign } = conversation;
      const replayable =
        foreign.size === 0
          ? window
          : window.flatMap((message) => {
              const kept = withoutThinkingBlocks(message, (block) =>
                foreign.has(block.signature ?? ''),
              );
              return kept ? [kept] : [];
            });
      let sent: Sent = { messages: toTanStackAI(replayable), systemPrompts: ahead };
      if (options.transformContext) {
        sent = await options.transformContext(sent.messages, sent.systemPrompts, ctx);
      }
      conversation.carried = { run: ctx.requestId, messages, systemPrompts, sent };
      conversation.kept = !oneOff;
      return sent;
    },

    usage(ctx) {
      const session = sessions.get(steps.sessionKey(ctx));
      return session.janitor && conversations.get(session)?.kept
        ? (tokens) => session.reportTokenUsage(tokens)
        : null;
    },

    chunk(ctx, chunk) {
      if (chunk.type !== EventType.STEP_FINISHED || !chunk.signature) return;
      const conversation = conversations.get(sessions.get(steps.sessionKey(ctx)));
      if (conversation && !conversation.kept) conversation.foreign.add(chunk.signature);
    },
  };
}

/**
 * The host's conversation behind a call's messages. Within a run the engine
 * carries what `onConfig` returned into the next iteration and only appends
 * to it — the assistant turn, its tool results — so messages that open with
 * the last call's are that call's host conversation plus what came since.
 * Any other messages are the host's own.
 */
function hostMessages(messages: ModelMessage[], last: Carried | undefined): ModelMessage[] {
  const sent = last?.sent.messages ?? [];
  if (!last || sent.length === 0 || !sameItems(messages.slice(0, sent.length), sent)) {
    return messages;
  }
  return [...last.messages, ...messages.slice(sent.length)];
}

/** The same message or prompt: the same object, or a copy of it. */
const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

const sameItems = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((item, i) => same(item, b[i]));

/**
 * What the model reads of a tool: its name, description and input schema,
 * and its metadata but for a cache breakpoint (`@tanstack/ai-anthropic`'s
 * `cacheControl`) — a provider tool's settings live there too.
 */
function toolDefinition({ name, description, inputSchema, metadata }: Tool) {
  const { cacheControl: _breakpoint, ...settings } = metadata ?? {};
  return {
    name,
    description,
    inputSchema: convertSchemaToJsonSchema(inputSchema),
    ...(Object.keys(settings).length > 0 ? { metadata: settings } : {}),
  };
}
