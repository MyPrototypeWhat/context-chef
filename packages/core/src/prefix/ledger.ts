import { createHash } from 'node:crypto';
import { Assembler } from '../modules/assembler';
import type { Message } from '../types';
import type {
  InjectionSource,
  PrefixBreak,
  PrefixBreakReason,
  PrefixCandidate,
  PrefixEntry,
  PrefixHead,
  PrefixLedgerSnapshot,
  PrefixReconcile,
  PrefixSent,
} from './types';

type Range = [from: number, until: number];

/** Key order and cache breakpoints don't change what the model saw. */
function canonical(value: unknown): string {
  return JSON.stringify(Assembler.orderKeysDeterministically(value), (key, v) =>
    key === 'cache_control' ? undefined : v,
  );
}

/**
 * Digest of a host message as sent. Breakpoint placement, pinning and the
 * Anthropic origin record are chef bookkeeping: moving a breakpoint or pinning
 * a message must not read as an edit. Provider fields (`_gemini_thought_signature`,
 * `_openai_reasoning`, …) reach their wire and count.
 */
function digest(message: Message): string {
  const { _cache_breakpoint, _anthropic_origin, pinned: _pinned, ...sent } = message;
  return createHash('sha256').update(canonical(sent)).digest('hex').substring(0, 16);
}

/** One message per run of joined entries; a system event stays positional. */
function renderEvents(entries: readonly PrefixEntry[]): Message[] {
  const messages: Message[] = [];
  for (const entry of entries) {
    const last = messages[messages.length - 1];
    if (entry.joined && last) {
      last.content = `${last.content}\n\n${entry.content}`;
    } else if (entry.channel === 'system') {
      messages.push({ role: 'system', content: entry.content, _positional: true });
    } else {
      messages.push({ role: 'user', content: entry.content });
    }
  }
  return messages;
}

/**
 * A positional system message must be answered: the API rejects one that a
 * user turn follows (tool results count as one). A turn-scoped one is cleared
 * by that user turn instead.
 */
function hasStrandedSystemEvent(group: readonly PrefixEntry[], host: Message | undefined): boolean {
  return group.some((entry, i) => {
    if (entry.channel !== 'system' || entry.clearAt) return false;
    const following = group.slice(i + 1).find((e) => !e.joined);
    const role = following ? following.channel : host?.role;
    return role === 'user' || role === 'tool';
  });
}

/** Sorted, empty ranges dropped, overlapping and touching ones merged. */
function mergeRanges(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  const sorted = ranges.filter(([from, until]) => from < until).sort((a, b) => a[0] - b[0]);
  for (const [from, until] of sorted) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], until);
    else merged.push([from, until]);
  }
  return merged;
}

/** Still replayed in place, but no longer any source's last word. */
const absorbed = (entry: PrefixEntry): PrefixEntry => ({ ...entry, sources: [] });

/**
 * What the chef appended to the window and where, and what it last saw of the
 * host history. The window is rebuilt from (host history, ledger) on every
 * compile — `head.replacement`, then host messages from `head.cut` on, each
 * entry placed immediately before `host[anchor]` — so the host history stays
 * the only source of its own messages; the ledger never copies them.
 *
 * Anchors are positions, validated by per-message digests (`seen`). When the
 * history stops matching, the ledger does not try to realign old entries: it
 * applies a checkpoint and reports it, and the caller re-states current state
 * at the tail.
 *
 * One compile runs `reconcile()`, then `append()` / `checkpoint()` as its
 * phases decide, then `commit()`. The ledger tracks the length of the history
 * it was last reconciled or committed against — the tail `append()` defaults
 * to, and where a checkpoint's stripped range ends.
 *
 * Pure: no `ContextChef` dependency, so the integration packages reuse it.
 */
export class PrefixLedger {
  private _head?: PrefixHead;
  private entries: PrefixEntry[] = [];
  private _stripped: Range[] = [];
  /** Digests of `host[cut, cut + seen.length)` as last committed. */
  private seen: string[] = [];
  private _lastSent?: PrefixSent;
  private hostLength = 0;

  /** A ledger in the state `snapshot()` captured. */
  static fromSnapshot(snapshot: PrefixLedgerSnapshot): PrefixLedger {
    if (snapshot.version !== 1) {
      throw new Error(`Unsupported prefix ledger snapshot version: ${String(snapshot.version)}`);
    }
    const copy = structuredClone(snapshot);
    const ledger = new PrefixLedger();
    ledger._head = copy.head;
    ledger.entries = [...copy.entries];
    ledger._stripped = copy.stripped.map(([from, until]) => [from, until]);
    ledger.seen = [...copy.seen];
    ledger._lastSent = copy.lastSent;
    ledger.hostLength = ledger.cut + ledger.seen.length;
    return ledger;
  }

  /** The latest compaction checkpoint, if any. */
  get head(): PrefixHead | undefined {
    return this._head;
  }

  /** Host ranges `[from, until)` whose thinking is stripped, sorted and merged. */
  get stripped(): ReadonlyArray<readonly [number, number]> {
    return this._stripped;
  }

  /** The system prompt and tools last committed. */
  get lastSent(): PrefixSent | undefined {
    return this._lastSent;
  }

  private get cut(): number {
    return this._head?.cut ?? 0;
  }

  /**
   * Rebuilds the window over `history`. When the ledger no longer matches —
   * history shorter than `head.cut`, `sent` differing from what was last
   * sent, a host message that is not the one seen, an entry that no longer
   * fits — the first mismatch is applied as a checkpoint and reported in
   * `break`; the window is the one after it.
   */
  reconcile(history: readonly Message[], sent?: PrefixSent): PrefixReconcile {
    this.hostLength = history.length;
    const found = this.findBreak(history, sent);
    if (!found) return { window: this.window(history) };
    const applied = this.checkpoint(found.reason, found.at);
    return { window: this.window(history), break: applied };
  }

  /**
   * The window as the ledger stands: `head.replacement`, then
   * `history[head.cut..]` with the entries spliced in. Assumes the ledger
   * matches `history` — call `reconcile()` first in a compile.
   */
  window(history: readonly Message[]): Message[] {
    const groups = this.groups();
    const window: Message[] = [...(this._head?.replacement ?? [])];
    for (let i = this.cut; i <= history.length; i++) {
      const group = groups.get(i);
      if (group) window.push(...renderEvents(group));
      if (i < history.length) window.push(history[i]);
    }
    return window;
  }

  /**
   * Records `candidates` before `host[anchor]` — by default at the tail.
   * Consecutive candidates of one channel (and the same `clearAt`) share a
   * message; give user candidates before system ones, since a positional
   * system message must not be followed by a user turn.
   */
  append(candidates: readonly PrefixCandidate[], anchor = this.hostLength): void {
    if (anchor < this.cut || anchor > this.hostLength) {
      throw new RangeError(
        `PrefixLedger.append: anchor ${anchor} is outside the window (${this.cut}..${this.hostLength})`,
      );
    }
    candidates.forEach((candidate, i) => {
      const previous = candidates[i - 1];
      const joined =
        previous !== undefined &&
        previous.channel === candidate.channel &&
        previous.clearAt === candidate.clearAt;
      this.entries.push({
        anchor,
        channel: candidate.channel,
        content: candidate.content,
        sources: [...candidate.sources],
        ...(candidate.clearAt ? { clearAt: true as const } : {}),
        ...(candidate.withdrawn ? { withdrawn: true as const } : {}),
        ...(joined ? { joined: true as const } : {}),
      });
    });
  }

  /**
   * The entry `source` last appended since the latest checkpoint: its current
   * statement, or a tombstone (`withdrawn`). `undefined` means the caller has
   * not stated it in this window yet.
   */
  lastAppended(source: InjectionSource): PrefixEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].sources.includes(source)) return this.entries[i];
    }
    return undefined;
  }

  /**
   * Concept three: a rewrite of what was already sent. `at` is the host index
   * the break starts at — the first message that changed, or for a compaction
   * `head.cut`, the first message kept. Call it after `reconcile()` for the
   * history being compiled.
   *
   * Without a `head`, entries anchored at or after `at` are dropped, and so is
   * a head whose cut lies past it. With one, the head replaces `host[0, cut)`:
   * entries anchored at or before the cut went into the summary, later ones
   * stay where they are behind it. Either way the entries kept stop counting
   * as any source's last word, and `seen` is cut back to what still holds
   * until the next `commit()`. Unless the head is signed, thinking in
   * `host[at, length)` is stripped for good.
   */
  checkpoint(reason: PrefixBreakReason, at: number, head?: PrefixHead): PrefixBreak {
    if (at < 0 || at > this.hostLength) {
      throw new RangeError(
        `PrefixLedger.checkpoint: at ${at} is outside the host history (length ${this.hostLength})`,
      );
    }
    const previousCut = this.cut;
    if (head) {
      this._head = head;
      this.entries = this.entries.filter((e) => e.anchor > head.cut).map(absorbed);
      this.seen = head.cut >= previousCut ? this.seen.slice(head.cut - previousCut) : [];
    } else {
      if (at < previousCut) this._head = undefined;
      this.entries = this.entries.filter((e) => e.anchor < at).map(absorbed);
      this.seen = this.seen.slice(0, Math.max(0, at - previousCut));
    }
    if (reason === 'system' || reason === 'tools') this._lastSent = undefined;

    const signed = head?.signed ?? false;
    const stripped: Range | undefined =
      !signed && at < this.hostLength ? [at, this.hostLength] : undefined;
    // Indices past the history are forgotten: a message appended there later is a new one.
    this._stripped = mergeRanges([
      ...this._stripped.map(([from, until]): Range => [from, Math.min(until, this.hostLength)]),
      ...(stripped ? [stripped] : []),
    ]);

    const fromStart = head !== undefined || reason === 'system' || reason === 'tools';
    const windowAt = fromStart
      ? 0
      : (this._head?.replacement.length ?? 0) + (at - this.cut) + this.entries.length;
    return { reason, at: windowAt, signed, ...(stripped ? { stripped } : {}) };
  }

  /** Records what a compile used: digests of `history` from `head.cut` on, and `sent`. */
  commit(history: readonly Message[], sent?: PrefixSent): void {
    this.hostLength = history.length;
    this.seen = history.slice(this.cut).map(digest);
    if (sent) this._lastSent = structuredClone({ system: sent.system, tools: sent.tools });
  }

  /** Plain data, safe for `structuredClone` and JSON. */
  snapshot(): PrefixLedgerSnapshot {
    return structuredClone({
      version: 1 as const,
      entries: this.entries,
      ...(this._head ? { head: this._head } : {}),
      stripped: this._stripped,
      seen: this.seen,
      ...(this._lastSent ? { lastSent: this._lastSent } : {}),
    });
  }

  /** The first place the ledger stops matching, as a host index. */
  private findBreak(
    history: readonly Message[],
    sent: PrefixSent | undefined,
  ): { reason: PrefixBreakReason; at: number } | undefined {
    const cut = this.cut;
    if (history.length < cut) return { reason: 'ledger', at: 0 };
    // System and tools come before every message: a change invalidates everything after the head.
    if (sent && this._lastSent) {
      if (canonical(sent.system) !== canonical(this._lastSent.system)) {
        return { reason: 'system', at: cut };
      }
      if (canonical(sent.tools) !== canonical(this._lastSent.tools)) {
        return { reason: 'tools', at: cut };
      }
    }

    let edited: number | undefined;
    for (let k = 0; k < this.seen.length; k++) {
      const i = cut + k;
      if (i >= history.length || digest(history[i]) !== this.seen[k]) {
        edited = i;
        break;
      }
    }
    // Entries at or after an edit go with it; the ones before must still fit.
    for (const [anchor, group] of this.groups()) {
      if (edited !== undefined && anchor >= edited) break;
      if (anchor > history.length) return { reason: 'ledger', at: history.length };
      if (hasStrandedSystemEvent(group, history[anchor])) return { reason: 'ledger', at: anchor };
    }
    return edited === undefined ? undefined : { reason: 'history', at: edited };
  }

  /** Entries by anchor, ascending; insertion order within an anchor. */
  private groups(): Map<number, PrefixEntry[]> {
    const groups = new Map<number, PrefixEntry[]>();
    for (const entry of [...this.entries].sort((a, b) => a.anchor - b.anchor)) {
      const group = groups.get(entry.anchor);
      if (group) group.push(entry);
      else groups.set(entry.anchor, [entry]);
    }
    return groups;
  }
}
