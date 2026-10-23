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
   * Where the usage of the request a run last sent goes: its session, when
   * that request was the window the ledger kept and something budgets;
   * otherwise null.
   */
  usage(ctx: ChatMiddlewareContext): ((tokens: number) => void) | null;
  /** `onChunk`: the signatures of thinking that answers a request the ledger did not keep. */
  chunk(ctx: ChatMiddlewareContext, chunk: StreamChunk): void;
}

type Sent = Pick<ChatMiddlewareConfig, 'messages' | 'systemPrompts'>;

/** What a run's last firing was compiled from, and what it returned. */
interface Carried extends Sent {
  readonly sent: Sent;
}

/**
 * What the middleware keeps of one chat() run, by the context object the
 * engine hands every hook of the run: runs on one thread may interleave.
 */
interface Run {
  /** Its last firing, so a config the engine carried can be read back. */
  carried?: Carried;
  /**
   * Whether the request it last sent is the window the ledger kept — not
   * while a firing runs, nor after one failed and went out as the engine had
   * it, nor after a one-off.
   */
  kept: boolean;
}

/**
 * How many signatures of an unkept request's reply a conversation holds
 * before its reply shows up. A reply comes back with the next firing (a
 * failed one's) or the next run (a structured one's), if the host stores it
 * at all; 16 covers several such requests, a few blocks each, at a few
 * kilobytes a conversation. The oldest goes first.
 */
const UNSEEN_SIGNATURES = 16;

/**
 * Signatures of thinking that answered a request the ledger did not keep,
 * per conversation: signed over a prefix it never had, so never replayed in
 * it. The host sends such a reply again on every call, so its signature is
 * kept while the host's conversation holds the reply, and dropped once it
 * no longer does.
 */
interface Foreign {
  /** Their reply has not shown up yet: capped, oldest first. */
  readonly unseen: Set<string>;
  /** Their reply is in the host's conversation, its thinking left out of every window. */
  readonly seen: Set<string>;
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
  const runs = new WeakMap<ChatMiddlewareContext, Run>();
  // Next to each session, and gone with it.
  const foreigners = new WeakMap<PrefixSession, Foreign>();
  const foreignOf = (session: PrefixSession): Foreign => {
    let foreign = foreigners.get(session);
    if (!foreign) {
      foreign = { unseen: new Set(), seen: new Set() };
      foreigners.set(session, foreign);
    }
    return foreign;
  };

  return {
    async config(ctx, config) {
      // No model call follows init before its own firing, and in between the
      // engine settles pending tool calls — which must not meet the
      // placeholder results the IR boundary gives them.
      if (ctx.phase === 'init') return undefined;

      const sessionId = steps.sessionKey(ctx);
      const session = sessions.get(sessionId);
      const run = runs.get(ctx) ?? { kept: false };
      runs.set(ctx, run);
      // Until this firing's window is kept, what goes out is not the ledger's.
      run.kept = false;
      // Only this run's own config is carried: one from another run is the host's.
      const last = run.carried;
      const messages = hostMessages(config.messages, last);
      const foreign = foreignOf(session);
      if (foreign.unseen.size + foreign.seen.size > 0) heldBy(messages, foreign);
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

      // The structured-output call goes out without tools. In a run with
      // tools that makes it a request outside the conversation, its own
      // checkpoints applied to it alone; in a run without, it is the run's
      // model call like any other.
      const oneOff = ctx.phase === 'structuredOutput' && config.tools.length > 0;
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

      const { seen } = foreign;
      const replayable =
        seen.size === 0
          ? window
          : window.flatMap((message) => {
              const kept = withoutThinkingBlocks(message, (block) =>
                seen.has(block.signature ?? ''),
              );
              return kept ? [kept] : [];
            });
      let sent: Sent = { messages: toTanStackAI(replayable), systemPrompts: ahead };
      if (options.transformContext) {
        sent = await options.transformContext(sent.messages, sent.systemPrompts, ctx);
      }
      run.carried = { messages, systemPrompts, sent };
      run.kept = !oneOff;
      return sent;
    },

    usage(ctx) {
      const session = sessions.get(steps.sessionKey(ctx));
      return session.janitor && runs.get(ctx)?.kept
        ? (tokens) => session.reportTokenUsage(tokens)
        : null;
    },

    chunk(ctx, chunk) {
      if (chunk.type !== EventType.STEP_FINISHED || !chunk.signature) return;
      // A stream with no firing of ours before it is no request the ledger kept either.
      if (runs.get(ctx)?.kept) return;
      const { unseen } = foreignOf(sessions.get(steps.sessionKey(ctx)));
      unseen.add(chunk.signature);
      if (unseen.size > UNSEEN_SIGNATURES) unseen.delete(unseen.values().next().value as string);
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

/**
 * Moves each signature whose reply the host's conversation now holds to
 * `seen`, and forgets each `seen` one whose reply it no longer holds.
 */
function heldBy(messages: readonly ModelMessage[], foreign: Foreign): void {
  const held = new Set(
    messages.flatMap((message) => message.thinking?.map((block) => block.signature) ?? []),
  );
  for (const signature of foreign.seen) {
    if (!held.has(signature)) foreign.seen.delete(signature);
  }
  for (const signature of foreign.unseen) {
    if (!held.has(signature)) continue;
    foreign.unseen.delete(signature);
    foreign.seen.add(signature);
  }
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
