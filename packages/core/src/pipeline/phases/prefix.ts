import { withoutThinking } from '../../adapters/anthropicAdapter';
import {
  answeredReplies,
  FRESH_LEDGER_REPLIES,
  invalidatedThinking,
  newlyStrippedThinking,
  type PrefixBreak,
  type PrefixMeta,
  type PrefixSent,
  plainSent,
  thinkingKeys,
} from '../../prefix';
import type { Message, TargetPayload } from '../../types';
import type { PrefixComparable } from '../checks';
import type { CompileContext, Phase, PipelineHost, PrefixCompile } from '../context';

/**
 * What `payload` sends ahead of the window: the target's top-level system
 * prompt — `system`, `systemInstruction` or `instructions`, the fields
 * `checkPrefixContinuity` compares — and its tools. Chat Completions has no
 * such field: there the system prompt is the `ahead` messages the window
 * follows, one per system layer.
 */
function sentAhead(payload: TargetPayload, ahead: number): PrefixSent {
  const sent = payload as PrefixComparable;
  const inline = ahead > 0 ? (sent.messages ?? sent.input)?.slice(0, ahead) : undefined;
  return {
    system: sent.system ?? sent.systemInstruction ?? sent.instructions ?? inline,
    tools: sent.tools,
  };
}

/**
 * One break for the payload: the checkpoint nearest the start of the window
 * (the earlier one on a tie), counting every thinking block this compile
 * stripped.
 */
function prefixMeta(stable: number, breaks: PrefixCompile['breaks']): PrefixMeta {
  if (breaks.length === 0) return { stable };
  const first = breaks.reduce((nearest, brk) => (brk.at < nearest.at ? brk : nearest));
  const strippedThinking = breaks.reduce((n, brk) => n + brk.strippedThinking, 0);
  return { stable, break: { ...first, strippedThinking } };
}

/**
 * Reports a checkpoint this compile just applied: `prefix:break` now, and
 * `meta.prefix.break` once the payload exists. `before` is
 * `invalidatedThinking()` from before the checkpoint, so only the thinking it
 * newly strips is counted, and only on the Anthropic target — the one that
 * strips.
 *
 * The event carries the window the checkpoint applied to: a `history` or
 * `ledger` checkpoint, found before overflow, the window the compile started
 * in; a compaction the window it opens, as `CompileMeta.windowId` does; a
 * `system` or `tools` checkpoint, found once the payload exists, the
 * payload's window.
 */
export async function reportPrefixBreak(
  ctx: CompileContext,
  host: PipelineHost,
  brk: PrefixBreak,
  before: ReadonlySet<string>,
): Promise<void> {
  const prefix = ctx.prefix;
  if (!prefix) {
    throw new Error(
      '[context-chef] compile pipeline: a prefix checkpoint was reported before the prefix phase ran',
    );
  }
  const reported = {
    reason: brk.reason,
    at: brk.at,
    signed: brk.signed,
    strippedThinking: ctx.target.isAnthropicTarget
      ? newlyStrippedThinking(prefix.history, prefix.ledger, before)
      : 0,
  };
  prefix.breaks.push(reported);
  await host.emit('prefix:break', { ...reported, windowId: ctx.window.current }, ctx.signal);
}

/**
 * `appendOnly`: the window. The ledger rebuilds it from the host history and
 * what it appended there, and a history it no longer matches — an earlier
 * message edited, the history shorter than what it saw, an entry anchored
 * past the end, a `clearHistory()`, replies to requests it never saw — is a
 * checkpoint, applied and reported here. Every later phase works on the
 * window; the host history stays on `ctx.prefix` for the commit.
 *
 * Off, the phase does nothing and the compile is 4.x. So it does for a compile
 * a hook starts inside another one: what that builds is not the next request.
 */
export const prefixPhase: Phase = {
  name: 'prefix',
  async run(ctx, host) {
    const ledger = host.ledger;
    if (!ledger || ctx.nested) return;

    const history = ctx.history;
    // Every committed compile records what it sent, so a ledger without it has
    // never seen one.
    const fresh = ledger.lastSent === undefined;
    const before = invalidatedThinking(history, ledger);
    const { window, break: brk } = ledger.reconcile(history);
    const clearAt = host.clearAt && ctx.target.isAnthropicTarget;
    ctx.prefix = { ledger, history, breaks: [], clearAt };
    ctx.history = window;
    if (!brk) return;

    if (fresh && brk.reason === 'ledger') {
      const replies = answeredReplies(history);
      if (replies > FRESH_LEDGER_REPLIES) {
        host.warnOnce(
          'append-only-fresh-ledger',
          `[context-chef] appendOnly: the prefix ledger is empty, but the history already ` +
            `holds ${replies} replies, compiled by a chef whose ledger was not kept — the ` +
            'thinking in them was invalidated (a `ledger` checkpoint). A chef created per ' +
            'request must persist `snapshot().prefixLedger` and restore it with the history ' +
            '(warned once).',
        );
      }
    }
    await reportPrefixBreak(ctx, host, brk, before);
  },
};

/**
 * `appendOnly`, once `adapt` built the payload: a system prompt or tool list
 * other than the one last sent is a checkpoint at 0 that keeps the entries
 * and strips every thinking block after the head. Then `meta.prefix` is
 * written. Off: nothing.
 */
export async function reconcilePrefixSent(ctx: CompileContext, host: PipelineHost): Promise<void> {
  const prefix = ctx.prefix;
  if (!prefix) return;

  // A copy, read before the after-adapt handlers: what is compared is what is committed.
  prefix.sent = plainSent(sentAhead(ctx.requirePayload(), ctx.systemLayers.length));
  const before = invalidatedThinking(prefix.history, prefix.ledger);
  const brk = prefix.ledger.reconcileSent(prefix.sent);
  if (brk) await reportPrefixBreak(ctx, host, brk, before);
  ctx.meta.prefix = prefixMeta(prefix.ledger.stable(), prefix.breaks);
}

/**
 * `appendOnly` on Anthropic: `messages` without the thinking unsigned
 * checkpoints invalidated (`invalidatedThinking`), so it is never sent again.
 * A message holding such a block loses all its thinking. Blocks are known by
 * their signature (a redacted one by its data) rather than by message: the
 * phases since `prefix` work on copies of the host's messages. The host's
 * own objects are never touched; one `fromAnthropic` parsed is still
 * replayed from its original, minus the thinking blocks (`withoutThinking`).
 */
export function withoutStrippedThinking(ctx: CompileContext, messages: Message[]): Message[] {
  const prefix = ctx.prefix;
  if (!prefix || !ctx.target.isAnthropicTarget) return messages;

  const invalid = invalidatedThinking(prefix.history, prefix.ledger);
  if (invalid.size === 0) return messages;
  return messages.map((message) =>
    thinkingKeys(message).some((key) => invalid.has(key)) ? withoutThinking(message) : message,
  );
}

/**
 * `appendOnly`: the payload is final, so the ledger records the history this
 * compile used and what it sent ahead of it. A compile that does not get here
 * commits nothing — the chef rolls the ledger back instead.
 */
export function commitPrefix(ctx: CompileContext): void {
  ctx.prefix?.ledger.commit(ctx.prefix.history, ctx.prefix.sent);
}
