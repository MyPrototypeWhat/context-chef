/**
 * `onDemandCompaction()` — let Anthropic summarize the start of the window
 * into a compaction block it signs.
 */

import {
  type AnthropicCompactionBlock,
  anthropicCompactionMessage,
  ON_DEMAND_COMPACTION_BETA,
} from '../adapters/anthropicAdapter';
import type { AnthropicPayload, Message } from '../types';
import { isServerStrategy } from './server';
import {
  detachedRunner,
  type OverflowInput,
  type OverflowResult,
  type OverflowRunner,
  type OverflowStrategy,
  unchanged,
} from './types';

/** `instructions` replace the default summarization prompt, up to this many characters. */
const MAX_INSTRUCTIONS_LENGTH = 16_384;

/** What an on-demand compaction asks the Messages API for. */
export interface OnDemandCompactionRequest {
  /**
   * The request to compact, shaped as `compile()` returns an Anthropic
   * payload: the system prompt and tools of the last payload sent, and the
   * window up to the cut byte for byte as it was sent. Send it as compiled
   * payloads are sent, with the conversation's own model. A copy.
   */
  readonly payload: AnthropicPayload;
  /** The request's `compaction` field. */
  readonly compaction: { readonly type: 'summarize'; readonly instructions?: string };
  /**
   * Every beta the request needs: the ones `payload` carries and
   * `compact-2026-09-04`. The request never carries `context_management`.
   */
  readonly betas: readonly string[];
}

/**
 * Sends `request` and returns the response. One that stopped for a
 * compaction (`stop_reason: 'compaction'`) holds the signed block; any other
 * counts as a failed compression.
 */
export type OnDemandCompactor = (
  request: OnDemandCompactionRequest,
  signal?: AbortSignal,
) => Promise<{ stop_reason: string | null; content: readonly unknown[] }>;

export interface OnDemandCompactionOptions {
  /** Calls the provider: the host's client, as `compressionModel` is for `summarize()`. */
  compact: OnDemandCompactor;
  /**
   * Turns kept after the block: each a reply to a user turn, with everything
   * up to the next one. `0` summarizes the whole window. Default 1.
   */
  keepRecentTurns?: number;
  /** Replace the provider's default summarization prompt; at most 16,384 characters. */
  instructions?: string;
  /**
   * The unsigned strategy that runs where no compaction can be signed —
   * another target, a chef without `appendOnly` or before its first request,
   * a window rewritten after it was sent, too few turns to keep — and, past
   * the raw context window, where a signed one failed. It runs only where an
   * unsigned compaction may: between turns, or collapsing a tool turn that
   * cannot wait. Without one the window is left alone, and past the raw
   * context window that counts as a failed compression. Give one.
   */
  fallback?: OverflowStrategy;
}

/**
 * Where a compaction may cut: `[0, cut)` ends in a user turn — the last
 * message that is not a system message is a user message or tool results,
 * and every tool call before it has its result — and the kept messages start
 * with an assistant reply, or there are none (`history.length`). In order.
 */
function cutPoints(history: readonly Message[]): number[] {
  const points: number[] = [];
  let afterUserTurn = false;
  const waiting = new Set<string>();
  for (let i = 0; i <= history.length; i++) {
    const message = history[i] as Message | undefined;
    if (afterUserTurn && waiting.size === 0 && (!message || message.role === 'assistant')) {
      points.push(i);
    }
    if (!message || message.role === 'system') continue;
    if (message.role === 'assistant') {
      waiting.clear();
      for (const call of message.tool_calls ?? []) waiting.add(call.id);
    } else if (message.role === 'tool' && message.tool_call_id) {
      waiting.delete(message.tool_call_id);
    }
    afterUserTurn = message.role === 'user' || message.role === 'tool';
  }
  return points;
}

/**
 * `input` for an unsigned strategy, where one may land on this compile:
 * between turns, or collapsing a tool turn — past the raw window, or when the
 * model asked for a new window — as the overflow phase hands an unsigned
 * strategy that turn. `null` in a tool turn otherwise: it waits for the turn
 * to end.
 */
function unsignedInput(input: OverflowInput): OverflowInput | null {
  if (!input.midToolTurn || input.collapse) return input;
  if (!input.pastLimit && !input.forced) return null;
  const { pastLimit: _pastLimit, ...rest } = input;
  return { ...rest, collapse: true };
}

/** The one signed compaction block of a response that stopped for it. */
function compactionBlock(content: readonly unknown[]): AnthropicCompactionBlock | undefined {
  const blocks = content.filter((block): block is AnthropicCompactionBlock => {
    const candidate = block as Partial<AnthropicCompactionBlock> | null;
    return (
      candidate?.type === 'compaction' &&
      typeof candidate.content === 'string' &&
      typeof candidate.signature === 'string'
    );
  });
  return blocks.length === 1 ? blocks[0] : undefined;
}

/**
 * Anthropic's on-demand compaction (beta `compact-2026-09-04`): the request
 * the model already answered — the window up to the reply `keepRecentTurns`
 * turns back, exactly as it was sent — goes back to the provider with
 * `compaction: { type: 'summarize' }`, and the signed block it returns
 * replaces it. The turns kept after the block keep their thinking: a
 * compaction no other strategy can produce under the thinking signature
 * check, and one that need not wait for a tool turn to end.
 *
 * It needs `appendOnly` on the Anthropic target, from the second request on:
 * the overflow phase then hands it the window as it was sent (`wire`).
 * Where it cannot sign, `fallback` runs instead, but only where an unsigned
 * compaction may: between turns, or collapsing a tool turn past the raw
 * context window. In a tool turn below it, it waits for the next compile.
 *
 * - The block goes first in every later request, as is; the next compaction
 *   summarizes it along with the turns after it.
 * - Pinned messages it summarizes are not put back — nothing may come
 *   between the block and the turns it keeps. The chef says them again as
 *   an event at the end of the window.
 * - A response that is not a compaction counts toward the circuit breaker
 *   and leaves the window alone — past the raw context window, `fallback`
 *   still runs, since the request cannot go out as it is.
 * - System messages, images and documents in the summarized span are gone
 *   from the window; the chef's own events among them are stated again.
 * - It does not combine with `server()`: a request with `context_management`
 *   cannot ask for it, and one that replays its block cannot be compacted by
 *   the server.
 * - Under `background()` the request is rendered when the job starts, and
 *   the job lands only while the window still renders it the same.
 * - A result its fallback has waiting (a `background()` job) lands on a call
 *   made just for it (`pendingOnly`), never in its place a new request; a
 *   signed compaction that lands first drops it.
 *
 * @example
 * overflow: {
 *   strategy: onDemandCompaction({
 *     compact: ({ payload, compaction, betas }, signal) =>
 *       client.beta.messages.create(
 *         { ...payload, model, max_tokens, thinking, compaction, betas },
 *         { signal },
 *       ),
 *     fallback: summarize({ compressionModel }),
 *   }),
 * }
 */
export function onDemandCompaction(options: OnDemandCompactionOptions): OverflowStrategy {
  const { compact, keepRecentTurns = 1, instructions, fallback } = options;
  if (!Number.isInteger(keepRecentTurns) || keepRecentTurns < 0) {
    throw new RangeError(
      `[context-chef] onDemandCompaction: keepRecentTurns must be a non-negative integer, got ${keepRecentTurns}`,
    );
  }
  if (instructions !== undefined && instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new RangeError(
      `[context-chef] onDemandCompaction: instructions may hold at most 16,384 characters, got ${instructions.length}`,
    );
  }

  const name = fallback ? `onDemandCompaction(fallback: ${fallback.name})` : 'onDemandCompaction';
  let runner: OverflowRunner = detachedRunner;
  /** The results the provider signed, as opposed to the fallback's. */
  const signedResults = new WeakSet<OverflowResult>();

  return {
    name,
    signed: true,
    parts: fallback ? [fallback] : [],

    async apply(input: OverflowInput): Promise<OverflowResult> {
      const { history, wire } = input;
      // Called only so the fallback's finished result can land: it goes there,
      // where an unsigned compaction may land, and nothing is asked for.
      if (input.pendingOnly) {
        const where = unsignedInput(input);
        if (fallback && where) return fallback.apply(where);
        return unchanged(
          input,
          name,
          "the fallback's finished result waits for the tool turn to end",
        );
      }
      // Past the raw window the request cannot go out as it is.
      const past = input.pastLimit === true || input.collapse === true;

      // No request can be signed: the fallback runs where an unsigned compaction
      // may. Without one, a window past the raw window is a failed compression.
      const unsignable = (reason: string): Promise<OverflowResult> | OverflowResult => {
        const where = unsignedInput(input);
        if (fallback && where) return fallback.apply(where);
        if (fallback) {
          return unchanged(input, name, `${reason}; the fallback waits for the tool turn to end`);
        }
        if (past) {
          runner.fail(`on-demand compaction: ${reason}, and no fallback strategy is configured`);
        }
        return unchanged(input, name, `${reason}, and no fallback strategy is configured`);
      };
      // The provider returned no block: a failed compression, which past the raw
      // window still leaves the fallback its turn.
      const failed = (reason: string, ...details: unknown[]) => {
        runner.fail(reason, ...details);
        const where = past ? unsignedInput(input) : null;
        if (fallback && where) return fallback.apply(where);
        return unchanged(input, name, reason);
      };

      if (wire?.target !== 'anthropic') {
        return unsignable(
          'nothing was sent that a compaction could be signed over (it needs appendOnly on the ' +
            'Anthropic target, from the second request on)',
        );
      }
      if (wire.history !== history) {
        return unsignable(
          'the window was rewritten after it was sent (an onBeforeCompress hook, an earlier ' +
            'chain() step), so no request can be signed over it',
        );
      }

      // A collapse keeps no turn the rules let it summarize.
      const keep = input.collapse ? 0 : keepRecentTurns;
      const points = cutPoints(history);
      const replies = points.filter((point) => point < history.length);
      const cut = keep === 0 ? points[points.length - 1] : replies[replies.length - keep];
      if (cut === undefined) {
        return unsignable(
          `the window holds no turn to compact ahead of the ${keep} kept turn${keep === 1 ? '' : 's'}`,
        );
      }

      // Rendered now, before anything is awaited: a background job reads the
      // window it started on, and the host gets a copy it may do anything with.
      const payload = wire.renderPrefix(cut) as AnthropicPayload;
      const request: OnDemandCompactionRequest = {
        payload: structuredClone(payload),
        compaction: { type: 'summarize', ...(instructions === undefined ? {} : { instructions }) },
        betas: [...new Set([...(payload.betas ?? []), ON_DEMAND_COMPACTION_BETA])],
      };
      const signedOver = structuredClone(payload);

      let response: Awaited<ReturnType<OnDemandCompactor>>;
      try {
        response = await compact(request, input.signal);
      } catch (error) {
        return failed('on-demand compaction request failed', error);
      }
      if (response.stop_reason !== 'compaction') {
        return failed(
          `on-demand compaction stopped with '${response.stop_reason}', not 'compaction'`,
        );
      }
      const block = compactionBlock(response.content);
      if (!block) return failed('on-demand compaction returned no signed compaction block');

      const span = history.slice(0, cut);
      const result: OverflowResult = {
        history: [anthropicCompactionMessage(block), ...history.slice(cut)],
        evicted: span,
        span,
        meta: {
          strategy: name,
          windowId: input.window.current,
          changed: true,
          signed: { request: signedOver },
        },
      };
      signedResults.add(result);
      return result;
    },

    commit(result) {
      // A signed landing leaves nothing for what the fallback had waiting to
      // land on: it is dropped, neither landed nor counted.
      if (signedResults.has(result)) fallback?.discard?.();
      else fallback?.commit?.(result);
    },
    pending: () => fallback?.pending?.() === true,
    discard: () => fallback?.discard?.(),
    snapshot: () => fallback?.snapshot?.(),
    restore: (state) => fallback?.restore?.(state),
    attach(installed) {
      runner = installed;
      fallback?.attach?.(installed);
    },
  };
}

/**
 * Whether `strategy` holds both `server()` and `onDemandCompaction()` — a
 * signed strategy — however deep in its combinators and fallbacks. They never
 * both run: the request that carries server-side `context_management` cannot
 * ask for an on-demand compaction, and one that replays a signed block cannot
 * be compacted by the server.
 */
export function combinesServerAndOnDemand(strategy: OverflowStrategy): boolean {
  const all: OverflowStrategy[] = [];
  const visit = (s: OverflowStrategy) => {
    all.push(s);
    for (const part of s.parts ?? []) visit(part);
  };
  visit(strategy);
  return all.some(isServerStrategy) && all.some((s) => s.signed === true);
}
