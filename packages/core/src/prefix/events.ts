import type { Message } from '../types';
import type { PrefixLedger } from './ledger';
import type { InjectionSource, PrefixCandidate, PrefixEntry } from './types';

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
 */
export function sourceEvents(
  ledger: PrefixLedger,
  sources: readonly PushSource[],
): PrefixCandidate[] {
  const events: PrefixCandidate[] = [];
  for (const { source, current, tombstone } of sources) {
    const last = ledger.lastAppended(source);
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
 * Where a compile's events anchor: the end of the host history, or the slot
 * before the assistant prefill it ends with — never inside the head.
 */
export function eventAnchor(history: readonly Message[], cut: number): number {
  let anchor = history.length;
  while (anchor > cut && history[anchor - 1].role === 'assistant') anchor--;
  return anchor;
}
