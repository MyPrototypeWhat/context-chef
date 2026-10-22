import { Assembler } from '../../modules/assembler';
import type { OverflowResult, OverflowWire } from '../../overflow/types';
import type { PrefixHead } from '../../prefix';
import type { Message, ToolDefinition } from '../../types';
import type { CompileContext, Phase, PipelineHost, PrefixCompile } from '../context';
import { invalidatedThinking, reportPrefixBreak, withoutStrippedThinking } from './prefix';

/**
 * Budget check + the installed overflow strategy.
 *
 * The Janitor runner owns everything inside: evaluating the budget, applying
 * the strategy, archiving what left the window, reporting it. This phase is
 * the boundary — it fires the slots around that call and decides whether it
 * runs at all.
 *
 * When the target is server-managed (Anthropic + a `server()` strategy, in
 * either its explicit or its `contextManagement` spelling) the provider
 * compacts — client-side overflow is skipped entirely (mechanical `compact()`
 * and every other module remain available). Non-server-managed targets fall
 * back to the strategy's own client-side policy.
 *
 * A pending `chef.requestNewContext()` makes the runner apply the strategy
 * whatever the budget says. It does not override the two ways a compile can
 * decline to overflow at all — a server-managed target and a `before-overflow`
 * veto — because both are statements about who owns this window, not about
 * whether it is full. It is consumed either way, and the drop is REPORTED:
 * the model was told a new window was starting, and something has to say that
 * it did not.
 *
 * Under `appendOnly` the runner reads the window, and a result that lands is a
 * `compaction` checkpoint: its head replaces the host messages it summarized
 * in every later window, so nothing is summarized again until the window is
 * over budget once more. Nothing else of the run reaches the window — a
 * result that did not land leaves it as the ledger rendered it, whatever an
 * `onBeforeCompress` hook handed the strategy. In the middle of a tool turn a
 * compaction waits for the turn to end, unless it cannot wait; then the whole
 * window collapses into the summary. One the provider signs
 * (`onDemandCompaction`) waits for nothing and strips nothing.
 */
export const overflowPhase: Phase = {
  name: 'overflow',
  async run(ctx, host) {
    const before = ctx.history;
    // Read-and-clear: a `requestNewContext()` is answered by exactly one
    // compile — including one that ends up skipping overflow, because the
    // answer "not this time" is still an answer and re-asking is the caller's
    // call, not the pipeline's.
    const forced = host.takeForcedOverflow();
    let skipped = ctx.target.serverManaged;

    const beforeHandlers = host.slots.get('before-overflow');
    if (beforeHandlers.length > 0) {
      // Budget is read only when someone is listening — the tokenizer path
      // walks the whole history.
      const budget = host.readBudget(before);
      for (const handler of beforeHandlers) {
        if ((await handler({ history: before, budget })) === false) skipped = true;
      }
    }

    if (forced && skipped) {
      const message = ctx.target.serverManaged
        ? '[context-chef] a requestNewContext() / new_context request was dropped: the compile ' +
          'target is server-managed, so the provider decides when this window ends. The request ' +
          'is consumed either way. Configure a client-side strategy (or drop new_context from ' +
          'the tool set) if the model is meant to be able to close the window.'
        : '[context-chef] a requestNewContext() / new_context request was dropped: a ' +
          'before-overflow handler vetoed this compile. The request is consumed either way — ' +
          'call requestNewContext() again once the handler is willing to let the window turn.';
      host.warnOnce(
        ctx.target.serverManaged ? 'forced-overflow-server-managed' : 'forced-overflow-vetoed',
        message,
      );
      await host.emit('pipeline:invariant', { phase: 'overflow', message }, ctx.signal);
    }

    let result: OverflowResult | null = null;
    if (!skipped && ctx.prefix) {
      result = await overflowWindow(ctx, host, ctx.prefix, forced);
    } else if (!skipped) {
      result = await host.overflow(before, { signal: ctx.signal, force: forced });
      ctx.history = result.history;
    }
    // Read after the runner ran: a landed overflow closed the window this
    // compile started in, and the payload belongs to the one it opened.
    ctx.meta.windowId = ctx.window.current;
    await host.emit('compress:end', { compressed: ctx.history !== before }, ctx.signal);

    for (const handler of host.slots.get('after-overflow')) {
      await handler({ history: ctx.history, result });
    }
  },
};

/**
 * `appendOnly`: one overflow pass over the window, or `null` while a
 * compaction waits for a tool turn to end. A result that lands is a
 * `compaction` checkpoint; the window is then rendered from the ledger again,
 * so what the payload sends is what the ledger records.
 */
async function overflowWindow(
  ctx: CompileContext,
  host: PipelineHost,
  prefix: PrefixCompile,
  forced: boolean,
): Promise<OverflowResult | null> {
  const wire = wireOf(ctx, prefix);
  const midTurn = inToolTurn(prefix);
  // A signed strategy handed a wire waits for no tool turn to end.
  const waits = midTurn && !(host.signedOverflow && wire !== undefined);
  const timing = compactionTiming(prefix, host, ctx.history, forced, waits);
  if (timing === 'wait') return null;
  const result = await host.overflow(ctx.history, {
    signal: ctx.signal,
    force: forced,
    appendOnly: true,
    midToolTurn: midTurn,
    pastLimit: timing === 'past-limit',
    collapse: timing === 'collapse',
    wire,
  });
  if (!result.meta.changed) return result;

  const head = compactionHead(ctx.history, result, prefix);
  const before = invalidatedThinking(prefix.history, prefix.ledger);
  const brk = prefix.ledger.checkpoint('compaction', head.cut, head);
  ctx.history = prefix.ledger.window();
  await reportPrefixBreak(ctx, host, brk, before);
  return result;
}

/**
 * `appendOnly`: when a compaction may land (D3). Between turns, as in 4.x.
 * There, once the request about to be sent is past the raw context window
 * (`'past-limit'`), nothing may wait for a later compile, a background job
 * included, and the runner's own verdict, which may read only an earlier
 * report, does not decide. While a tool turn is in progress (`midTurn`)
 * it waits for the turn to end: the turns it keeps lose their thinking, and
 * the one in progress still needs it. It cannot wait once the model asked
 * for a new window or the request is past the raw context window; then it
 * collapses the whole window.
 *
 * A signed strategy, handed a wire, has nothing to wait for: the turns it
 * keeps keep their thinking, the one in progress included, so it lands in a
 * tool turn as it does between turns, and is told it is in one
 * (`midToolTurn`) for a fallback it may run instead.
 */
function compactionTiming(
  prefix: PrefixCompile,
  host: PipelineHost,
  window: Message[],
  forced: boolean,
  midTurn: boolean,
): 'now' | 'past-limit' | 'wait' | 'collapse' {
  if (midTurn && forced) return 'collapse';
  const past = pastLimit(prefix, host, window);
  if (!midTurn) return past ? 'past-limit' : 'now';
  return past ? 'collapse' : 'wait';
}

/**
 * Whether the request about to be sent is past the raw context window. With
 * none configured (the default) nothing is read: nothing can be past it.
 *
 * Reading consumes no reported usage, so a compile that waits leaves it for
 * the one that ends the turn — except one that predates the last landing,
 * which the first reading after it drops (E10). A report describes the
 * request it came back for, possibly several compiles ago, so everything the
 * window gained since that request is counted on top of it. Once a message of
 * that request changed, the report counts a payload that no longer exists,
 * and the whole window is counted locally instead.
 */
function pastLimit(prefix: PrefixCompile, host: PipelineHost, window: Message[]): boolean {
  host.dropStaleUsage();
  if (!Number.isFinite(host.contextWindow)) return false;
  // A usage fed past `reportTokenUsage()` is taken to cover the window last
  // committed; one that describes none of the window is no report at all.
  const covered = prefix.ledger.reportCovers() ?? prefix.ledger.stable();
  const { current, limit } = host.readRequestBudget(
    window,
    covered > 0 ? window.slice(covered) : null,
  );
  return current > limit;
}

/**
 * Whether a tool turn is in progress: the host history after the head ends,
 * past any system messages, in tool results or in tool calls not answered yet.
 */
function inToolTurn({ history, ledger }: PrefixCompile): boolean {
  for (let i = history.length - 1; i >= (ledger.head?.cut ?? 0); i--) {
    const message = history[i];
    if (message.role === 'system') continue;
    return (
      message.role === 'tool' || (message.role === 'assistant' && !!message.tool_calls?.length)
    );
  }
  return false;
}

/**
 * `appendOnly` on Anthropic, once a payload was sent: the window as it went
 * over the wire, for a strategy the provider signs a compaction for. The
 * messages render as the `tail` and `adapt` phases render them; the system
 * prompt and tools are the ones the ledger last committed.
 */
function wireOf(ctx: CompileContext, prefix: PrefixCompile): OverflowWire | undefined {
  const sent = prefix.ledger.lastSent;
  if (!ctx.target.isAnthropicTarget || !sent) return undefined;
  const window = ctx.history;
  return {
    target: 'anthropic',
    history: window,
    renderPrefix(end) {
      const messages = window.slice(0, end).map((m) => Assembler.orderKeysDeterministically(m));
      const {
        system: _system,
        tools: _tools,
        ...payload
      } = ctx.target.adapter.compile(withoutStrippedThinking(ctx, messages));
      return {
        ...payload,
        ...(sent.system === undefined ? {} : { system: sent.system }),
        ...(sent.tools === undefined ? {} : { tools: sent.tools as ToolDefinition[] }),
      };
    },
  };
}

/**
 * The head a landed result puts in front of the host history. A strategy
 * keeps the end of the window it was handed by reference, so the first host
 * message of that kept end is where the host history resumes (`cut`), and
 * everything the result puts before it is the replacement: the summary,
 * pinned messages put back, and whatever of the previous head it kept.
 * Events kept ahead of that message go with what was summarized — the ledger
 * drops entries that render before `host[cut]`, and the `tail` phase states
 * their sources again. A result that kept no host message replaces them all.
 * A result the provider signed is a signed head: nothing is stripped.
 */
function compactionHead(
  window: readonly Message[],
  result: OverflowResult,
  { history, ledger }: PrefixCompile,
): PrefixHead {
  const landed = result.history;
  const previous = ledger.head?.replacement ?? [];
  // The window is the head, then the host messages from its cut with the
  // events among them: walk it to find which messages are host ones.
  let next = ledger.head?.cut ?? 0;
  const hostIndex = window.map((message) =>
    next < history.length && message === history[next] ? next++ : -1,
  );
  let kept = 0;
  while (
    kept < window.length &&
    kept < landed.length &&
    window[window.length - 1 - kept] === landed[landed.length - 1 - kept]
  ) {
    kept++;
  }
  const start = window.length - kept;
  let first = start;
  while (first < window.length && hostIndex[first] === -1) first++;
  return {
    cut: first < window.length ? hostIndex[first] : history.length,
    replacement: [
      ...landed.slice(0, landed.length - kept),
      ...window.slice(start, first).filter((message) => previous.includes(message)),
    ],
    signed: result.meta.signed !== undefined,
  };
}
