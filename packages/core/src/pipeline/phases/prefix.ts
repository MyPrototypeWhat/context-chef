import { type PrefixBreak, type PrefixMeta, type PrefixSent, plainSent } from '../../prefix';
import type { Message, TargetPayload } from '../../types';
import type { PrefixComparable } from '../checks';
import type { CompileContext, Phase, PipelineHost, PrefixCompile } from '../context';

/**
 * More replies than this behind a fresh ledger's `ledger` checkpoint, and the
 * host most likely creates a chef per request without keeping the ledger.
 */
const FRESH_LEDGER_REPLIES = 2;

const isThinkingBlock = (block: unknown): boolean => {
  const type = (block as { type?: unknown } | null)?.type;
  return type === 'thinking' || type === 'redacted_thinking';
};

/** The thinking blocks a message is sent with: its original Anthropic blocks when it carries them. */
function thinkingBlocks(message: Message): number {
  const blocks = message._anthropic_origin?.blocks;
  if (blocks) return blocks.filter(isThinkingBlock).length;
  return (message.thinking ? 1 : 0) + (message.redacted_thinking ? 1 : 0);
}

/** Thinking blocks in the host range `brk` stripped that no earlier checkpoint had stripped. */
function newlyStrippedThinking(
  history: readonly Message[],
  brk: PrefixBreak,
  strippedBefore: ReadonlyArray<readonly [number, number]>,
): number {
  if (!brk.stripped) return 0;
  const [from, until] = brk.stripped;
  let count = 0;
  for (let i = from; i < until; i++) {
    if (!strippedBefore.some(([f, u]) => f <= i && i < u)) count += thinkingBlocks(history[i]);
  }
  return count;
}

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
 * Reports a checkpoint this compile applied: `prefix:break` now, and
 * `meta.prefix.break` once the payload exists. `strippedBefore` is
 * `ledger.stripped` from before the checkpoint, so only the thinking it newly
 * strips is counted, and only on the Anthropic target — the one that strips.
 */
export async function reportPrefixBreak(
  ctx: CompileContext,
  host: PipelineHost,
  brk: PrefixBreak,
  strippedBefore: ReadonlyArray<readonly [number, number]>,
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
      ? newlyStrippedThinking(prefix.history, brk, strippedBefore)
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
    const strippedBefore = ledger.stripped;
    const { window, break: brk } = ledger.reconcile(history);
    ctx.prefix = { ledger, history, breaks: [] };
    ctx.history = window;
    if (!brk) return;

    if (fresh && brk.reason === 'ledger') {
      const replies = history.filter((m) => m.role === 'assistant').length;
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
    await reportPrefixBreak(ctx, host, brk, strippedBefore);
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
  const strippedBefore = prefix.ledger.stripped;
  const brk = prefix.ledger.reconcileSent(prefix.sent);
  if (brk) await reportPrefixBreak(ctx, host, brk, strippedBefore);
  ctx.meta.prefix = prefixMeta(prefix.ledger.stable(), prefix.breaks);
}

/**
 * `appendOnly`: the payload is final, so the ledger records the history this
 * compile used and what it sent ahead of it. A compile that does not get here
 * commits nothing — the chef rolls the ledger back instead.
 */
export function commitPrefix(ctx: CompileContext): void {
  ctx.prefix?.ledger.commit(ctx.prefix.history, ctx.prefix.sent);
}
