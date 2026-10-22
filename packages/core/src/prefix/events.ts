import type { Message } from '../types';
import { opensAfterUserTurn, type PrefixLedger } from './ledger';
import type { InjectionSource, PrefixCandidate, PrefixEntry, PrefixHead } from './types';

/**
 * A push source as one compile sees it: what it says now, and the tombstone
 * it leaves once it has nothing to say.
 *
 * A state block carries its revision as its first attribute (`<tag rev="N"`,
 * `Prompts.getEventBlock`). The number is not stored: it is read back from
 * the last entry the window holds for the source, so it keeps counting where
 * that entry left off, also when a compaction summarized the ones before it.
 * Content without a revision (an instruction) is compared as it is.
 */
export interface PushSource {
  readonly source: InjectionSource;
  /** What it says now, rendered at revision `rev`; absent when it has nothing to say. */
  readonly current?: {
    readonly channel: PrefixEntry['channel'];
    render(rev: number): string;
  };
  /** Its tombstone at revision `rev`, appended on the channel its last statement took. */
  tombstone(rev: number): string;
}

const REVISION = /^<[\w-]+ rev="(\d+)"/;

/** The revision `content` opens with, `0` when it carries none. */
export function revisionOf(content: string): number {
  const match = REVISION.exec(content);
  return match ? Number(match[1]) : 0;
}

/**
 * Concept one, per source: compared with the last entry the window holds
 * from it, a source that says something else is appended at the next
 * revision, one that went quiet leaves a tombstone, and one that says the
 * same thing again leaves nothing. "The same thing" is its current content
 * rendered at that entry's own revision.
 *
 * With `turnScoped` (`appendOnly.clearAt` on Anthropic), the system-channel
 * sources take {@link reminderEvents} instead; `anchor` is where this
 * compile appends.
 */
export function sourceEvents(
  ledger: PrefixLedger,
  sources: readonly PushSource[],
  turnScoped?: { readonly anchor: number },
): PrefixCandidate[] {
  const events: PrefixCandidate[] = [];
  for (const push of sources) {
    const { source, current, tombstone } = push;
    const last = ledger.lastAppended(source);
    if (turnScoped && (current ? current.channel === 'system' : last?.clearAt === true)) {
      events.push(...reminderEvents(ledger, push, turnScoped.anchor));
      continue;
    }
    const rev = last ? revisionOf(last.content) : 0;
    if (current) {
      const unchanged =
        last !== undefined &&
        !last.withdrawn &&
        last.channel === current.channel &&
        last.content === current.render(rev);
      if (!unchanged) {
        events.push({
          channel: current.channel,
          content: current.render(rev + 1),
          sources: [source],
        });
      }
    } else if (last && !last.withdrawn) {
      events.push({
        channel: last.channel,
        content: tombstone(rev + 1),
        sources: [source],
        withdrawn: true,
      });
    }
  }
  return events;
}

/**
 * `clearAt`: a system-channel source says what it says now in every request,
 * as a turn-scoped reminder the API clears once a user message follows it.
 * The reminder keeps the revision of the state it repeats and moves to the
 * next one when the state changes. A request that already shows it — a
 * retry — gets nothing more. A source that goes quiet just stops; only a
 * reminder still showing in the request being built gets a turn-scoped
 * tombstone. A statement the source made earlier that stays in place (it was
 * on the user channel, or `clearAt` was off) is withdrawn first: it would
 * outlive every reminder.
 */
function reminderEvents(
  ledger: PrefixLedger,
  { source, current, tombstone }: PushSource,
  anchor: number,
): PrefixCandidate[] {
  const entries = ledger.appended(source);
  const last = entries[entries.length - 1];
  let rev = last ? revisionOf(last.content) : 0;
  let said = last && !last.withdrawn ? last.content : undefined;
  const events: PrefixCandidate[] = [];

  const standing = lastOf(entries, (entry) => !entry.clearAt);
  if (standing && !standing.withdrawn) {
    rev += 1;
    events.push({
      channel: standing.channel,
      content: tombstone(rev),
      sources: [source],
      withdrawn: true,
    });
    said = undefined;
  }

  const showing = lastOf(
    ledger.entriesAt(anchor),
    (entry) => entry.clearAt === true && entry.sources.includes(source),
  );
  if (current) {
    const content =
      said !== undefined && said === current.render(revisionOf(said))
        ? said
        : current.render(rev + 1);
    if (showing?.content !== content) {
      events.push({ channel: 'system', content, sources: [source], clearAt: true });
    }
  } else if (showing && !showing.withdrawn) {
    events.push({
      channel: 'system',
      content: tombstone(rev + 1),
      sources: [source],
      clearAt: true,
      withdrawn: true,
    });
  }
  return events;
}

/** The last of `entries` that `test` accepts. */
function lastOf(
  entries: readonly PrefixEntry[],
  test: (entry: PrefixEntry) => boolean,
): PrefixEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (test(entries[i])) return entries[i];
  return undefined;
}

/**
 * A prefill: an assistant message the host wrote for the model to continue.
 * One that carries what only a model's reply has — thinking, tool calls, a
 * provider's own fields — is a reply, and Anthropic rejects a prefill with
 * thinking anyway.
 */
export function isPrefill(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    !message.thinking &&
    !message.redacted_thinking &&
    !message.tool_calls?.length &&
    message._anthropic_origin === undefined &&
    message._anthropic_compaction === undefined &&
    message._openai_reasoning === undefined &&
    message._gemini_thought_signature === undefined
  );
}

/**
 * Whether the host history after `head` ends, past any system messages, in
 * tool calls not all answered yet. An event appended now would go between
 * the calls and their results, and move behind the results once they
 * arrive; it waits for them instead, and so does whatever it would have
 * said.
 */
export function awaitsToolResults(history: readonly Message[], head?: PrefixHead): boolean {
  const answered = new Set<string>();
  for (let i = history.length - 1; i >= (head?.cut ?? 0); i--) {
    const message = history[i];
    if (message.role === 'tool') {
      if (message.tool_call_id) answered.add(message.tool_call_id);
    } else if (message.role !== 'system') {
      return (
        message.role === 'assistant' &&
        (message.tool_calls ?? []).some((call) => !answered.has(call.id))
      );
    }
  }
  return false;
}

/**
 * Where a compile's events anchor: the end of the host history, or the slot
 * before the one prefill it ends with — never inside the head. Never before
 * a reply: an entry anchored there would join the group that reply answered,
 * whose bytes its signature covers. Ahead of a run of the host's own system
 * messages the history (or the prefill) ends with, when that run follows a
 * user turn: it stays positional, and a user message must not follow it. A
 * run after a reply is hoisted; the events go behind it, or they would make
 * it positional and change the system prompt. The ledger places entries by
 * the same rule.
 */
export function eventAnchor(history: readonly Message[], head?: PrefixHead): number {
  const cut = head?.cut ?? 0;
  const aheadOfSystem = (end: number) => {
    let at = end;
    while (at > cut && history[at - 1].role === 'system') at--;
    if (at === end) return end;
    const before = at > cut ? history[at - 1].role : undefined;
    const afterUserTurn =
      before === undefined ? opensAfterUserTurn(head) : before === 'user' || before === 'tool';
    return afterUserTurn ? at : end;
  };
  const anchor = aheadOfSystem(history.length);
  return anchor > cut && isPrefill(history[anchor - 1]) ? aheadOfSystem(anchor - 1) : anchor;
}
