import {
  type ChefLogger,
  compactMessages as clearMessages,
  type Message,
  objectToXml,
  type PrefixSession,
  type SessionPool,
} from '@context-chef/core';
import {
  type ChatMiddlewareConfig,
  type ChatMiddlewareContext,
  convertSchemaToJsonSchema,
  type ModelMessage,
  type SystemPrompt,
  type Tool,
} from '@tanstack/ai';

import { systemPromptText, toTanStackAI } from './adapter';
import type { ContextChefOptions, PrefixBreakEvent } from './types';

/** The steps `appendOnly` shares with the 4.x transform, as the middleware runs them. */
export interface SharedSteps {
  /** Truncate, convert to IR, and compact. */
  prepare(messages: ModelMessage[]): Promise<Message[]>;
  /** `systemPrompts` with the skill's instructions and the clear explainer after them. */
  standing(systemPrompts: SystemPrompt[]): Promise<SystemPrompt[]>;
  /** The conversation a call belongs to. */
  sessionKey(ctx: ChatMiddlewareContext): string;
}

type Sent = Pick<ChatMiddlewareConfig, 'messages' | 'systemPrompts'>;

/** What a conversation's last call in a chat() run was compiled from, and what it returned. */
interface Carried extends Sent {
  /** The run (`ctx.requestId`): the engine carries a config within one chat() call only. */
  readonly run: string;
  readonly sent: Sent;
}

/**
 * `onConfig` with `appendOnly`: the session rebuilds the conversation from
 * its ledger — the head of the last compression, the host's messages, the
 * events appended among them — so what an earlier call sent is sent again as
 * it was. The host's system prompts, the skill and the clear explainer go
 * ahead of it as in 4.x; a change there is a checkpoint.
 */
export function appendOnlyTransform(
  options: ContextChefOptions,
  logger: ChefLogger,
  sessions: SessionPool<PrefixSession>,
  steps: SharedSteps,
): (ctx: ChatMiddlewareContext, config: ChatMiddlewareConfig) => Promise<Sent | undefined> {
  const reportBreak = (event: PrefixBreakEvent) => {
    try {
      options.onPrefixBreak?.(event);
    } catch (error) {
      logger.warn('[context-chef] onPrefixBreak threw — the call goes ahead', error);
    }
  };
  // Per conversation, so a config the engine carried within a run can be read back.
  const carried = new WeakMap<PrefixSession, Carried>();

  return async (ctx, config) => {
    // No model call follows init before its own firing, and in between the
    // engine settles pending tool calls — which must not meet the placeholder
    // results the IR boundary gives them.
    if (ctx.phase === 'init') return undefined;

    const sessionId = steps.sessionKey(ctx);
    const session = sessions.get(sessionId);
    const record = carried.get(session);
    // A config from another run is the host's own, whatever it opens with.
    const last = record && ctx.requestId && record.run === ctx.requestId ? record : undefined;
    const messages = hostMessages(config.messages, last);
    const systemPrompts =
      last && sameItems(config.systemPrompts, last.sent.systemPrompts)
        ? last.systemPrompts
        : config.systemPrompts;

    const conversation = await steps.prepare(messages);
    // Cleared before the session compares anything: a placeholder that moves
    // rewrites a message already sent, a checkpoint it has to see.
    const history = options.clear?.length
      ? clearMessages(conversation, { clear: options.clear })
      : conversation;
    const ahead = await steps.standing(systemPrompts);
    const state = options.dynamicState
      ? objectToXml(await options.dynamicState.getState(), 'dynamic_state')
      : undefined;

    const { messages: window, breaks } = await session.compile({
      history,
      // What the model reads ahead of the conversation; provider metadata (a
      // cache breakpoint moving) is not part of it. The structured-output
      // call goes out without tools.
      sent: {
        system: ahead.map(systemPromptText),
        tools: ctx.phase === 'structuredOutput' ? [] : config.tools.map(toolDefinition),
      },
      dynamicState: state,
      signal: ctx.signal,
    });
    for (const brk of breaks) reportBreak({ ...brk, sessionId });

    let sent: Sent = { messages: toTanStackAI(window), systemPrompts: ahead };
    if (options.transformContext) {
      sent = await options.transformContext(sent.messages, sent.systemPrompts, ctx);
    }
    carried.set(session, { run: ctx.requestId, messages, systemPrompts, sent });
    return sent;
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
        'the adapter is unknown and may move a mid-conversation system message into the system ' +
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
        'thinking is stripped from it on. Once a compression has landed, a rewrite that reaches ' +
        'a message it summarized also drops its summary, and the conversation is summarized ' +
        "again on every call. Use 'all', which rewrites each message once before it is first " +
        "sent, or the provider's own context editing.",
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
