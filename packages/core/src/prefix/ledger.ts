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

/** A JSON copy of plain data: functions and `undefined` drop out, as on the wire. */
function jsonCopy(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

/**
 * Digest of the fields of a host message that reach some provider's wire.
 * Anything else — breakpoints, pinning, host metadata — is not an edit.
 * `_anthropic_origin` counts by identity: dropping or replacing it makes the
 * Anthropic target rebuild the message from IR instead of replaying it.
 */
function digest(message: Message): string {
  const origin = message._anthropic_origin;
  const wire = [
    message.role,
    message.content,
    message.name,
    message.tool_calls,
    message.tool_call_id,
    message.thinking,
    message.redacted_thinking,
    message.attachments,
    message._anthropic_compaction,
    origin && {
      hash: origin.hash,
      part: origin.part,
      parts: origin.parts,
      blocks: origin.blocks !== undefined,
    },
    message._gemini_thought_signature,
    message._openai_reasoning,
    message._positional,
  ];
  return createHash('sha256').update(canonical(wire)).digest('hex').substring(0, 16);
}

/**
 * The messages of the entries that render at one place: user events, then
 * system events (a positional system message must not be followed by a user
 * turn), then turn-scoped ones, since `clear_at` applies per message. A pure
 * function of the group, so a tail renders the same bytes once answered.
 */
function renderGroup(entries: readonly PrefixEntry[]): Message[] {
  const text = (part: PrefixEntry[]) => part.map((e) => e.content).join('\n\n');
  const user = entries.filter((e) => e.channel === 'user');
  const system = entries.filter((e) => e.channel === 'system' && !e.clearAt);
  const turnScoped = entries.filter((e) => e.channel === 'system' && e.clearAt);
  const messages: Message[] = [];
  if (user.length > 0) messages.push({ role: 'user', content: text(user) });
  for (const part of [system, turnScoped]) {
    if (part.length > 0) messages.push({ role: 'system', content: text(part), _positional: true });
  }
  return messages;
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

/**
 * What the chef appended to the window and where, and what it last saw of the
 * host history. The window is rebuilt from (host history, ledger) on every
 * compile — `head.replacement`, then host messages from `head.cut` on, with
 * the entries rendered among them — so the host history stays the only source
 * of its own messages; the ledger never copies them.
 *
 * An entry renders before the first assistant message at or after its anchor,
 * the reply to the request that carried it. Until that reply exists it is
 * provisional and renders at the current tail; once answered, the group it
 * rendered in is fixed. Finality is read off the history, not stored.
 *
 * Anchors are positions, validated by per-message digests (`seen`). When the
 * history stops matching, the ledger does not try to realign old entries: it
 * applies a checkpoint and reports it, and the caller re-states what changed
 * at the tail.
 *
 * One compile runs `reconcile()`, then `append()` / `checkpoint()` as its
 * phases decide, then `commit()`; everything in between works on the history
 * `reconcile()` was given.
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
  /** The host history being compiled: the last one reconciled or committed. */
  private history: readonly Message[] = [];

  /** A ledger in the state `snapshot()` captured; `reconcile()` it before anything else. */
  static fromSnapshot(snapshot: PrefixLedgerSnapshot): PrefixLedger {
    if (snapshot.version !== 1) {
      throw new Error(
        `[context-chef] Unsupported prefix ledger snapshot version: ${String(snapshot.version)}`,
      );
    }
    const copy = structuredClone(snapshot);
    const ledger = new PrefixLedger();
    ledger._head = copy.head;
    ledger.entries = [...copy.entries];
    ledger._stripped = copy.stripped.map(([from, until]) => [from, until]);
    ledger.seen = [...copy.seen];
    ledger._lastSent = copy.lastSent;
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
   * sent, a host message that is not the one seen, an entry anchored past the
   * end — the first mismatch is applied as a checkpoint and reported in
   * `break`; the window is the one after it.
   */
  reconcile(history: readonly Message[], sent?: PrefixSent): PrefixReconcile {
    this.history = [...history];
    const found = this.findBreak(sent);
    if (!found) return { window: this.window() };
    const applied = this.checkpoint(found.reason, found.hostIndex);
    return { window: this.window(), break: applied };
  }

  /** The window as the ledger stands, over the history being compiled. */
  window(): Message[] {
    const history = this.history;
    const groups = this.groups();
    const window: Message[] = [...(this._head?.replacement ?? [])];
    for (let i = this.cut; i <= history.length; i++) {
      const group = groups.get(i);
      if (group) window.push(...renderGroup(group));
      if (i < history.length) window.push(history[i]);
    }
    return window;
  }

  /**
   * Records `candidates` at `anchor` — by default the end of the history; pass
   * the slot before a trailing assistant prefill when there is one.
   */
  append(candidates: readonly PrefixCandidate[], anchor = this.history.length): void {
    if (anchor < this.cut || anchor > this.history.length) {
      throw new RangeError(
        `[context-chef] PrefixLedger.append: anchor ${anchor} is outside the window ` +
          `(${this.cut}..${this.history.length})`,
      );
    }
    for (const candidate of candidates) {
      this.entries.push({
        anchor,
        channel: candidate.channel,
        content: candidate.content,
        sources: [...candidate.sources],
        ...(candidate.clearAt ? { clearAt: true as const } : {}),
        ...(candidate.withdrawn ? { withdrawn: true as const } : {}),
      });
    }
  }

  /**
   * The newest entry still in the window that speaks for `source`: its
   * current statement, or a tombstone (`withdrawn`). `undefined` means the
   * window holds nothing from it.
   */
  lastAppended(source: InjectionSource): PrefixEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].sources.includes(source)) return this.entries[i];
    }
    return undefined;
  }

  /**
   * Concept three: a rewrite of what was already sent, applied to the history
   * being compiled. `hostIndex` is a host index: the first host message that
   * changed, or for a compaction `head.cut`, the first message kept. The
   * returned `at` is a window index.
   *
   * Without a `head`, entries that render after `host[hostIndex]` are
   * dropped, and so is a head whose cut lies past it; the ones before it stay
   * and still count for `lastAppended()`. With a head (`reason`
   * `'compaction'` only), it replaces `host[0, cut)`: entries rendering before
   * `host[cut]` went into the summary, later ones stay where they are. `seen`
   * is cut back to what still holds until the next `commit()`. Unless the head
   * is signed, thinking in `host[hostIndex, length)` is stripped for good.
   */
  checkpoint(reason: PrefixBreakReason, hostIndex: number, head?: PrefixHead): PrefixBreak {
    const length = this.history.length;
    if ((reason === 'compaction') !== (head !== undefined)) {
      throw new Error(
        `[context-chef] PrefixLedger.checkpoint: a 'compaction' checkpoint takes the new head, ` +
          `and no other does (reason '${reason}', head ${head ? 'given' : 'missing'})`,
      );
    }
    if (hostIndex < 0 || hostIndex > length) {
      throw new RangeError(
        `[context-chef] PrefixLedger.checkpoint: hostIndex ${hostIndex} is outside the host history (length ${length})`,
      );
    }
    if (head && (head.cut < 0 || head.cut > length)) {
      throw new RangeError(
        `[context-chef] PrefixLedger.checkpoint: head.cut ${head.cut} is outside the host history (length ${length})`,
      );
    }

    const placeOf = this.placer();
    const previousCut = this.cut;
    if (head) {
      this._head = head;
      this.entries = this.entries.filter((e) => (placeOf(e) ?? -1) > head.cut);
      this.seen = head.cut >= previousCut ? this.seen.slice(head.cut - previousCut) : [];
    } else {
      if (hostIndex < previousCut) this._head = undefined;
      this.entries = this.entries.filter((e) => (placeOf(e) ?? Infinity) <= hostIndex);
      this.seen = this.seen.slice(0, Math.max(0, hostIndex - previousCut));
    }
    if (reason === 'system' || reason === 'tools') this._lastSent = undefined;

    const signed = head?.signed ?? false;
    const stripped: Range | undefined =
      !signed && hostIndex < length ? [hostIndex, length] : undefined;
    // Indices past the history are forgotten: a message appended there later is a new one.
    this._stripped = mergeRanges([
      ...this._stripped.map(([from, until]): Range => [from, Math.min(until, length)]),
      ...(stripped ? [stripped] : []),
    ]);

    // Every entry kept renders before host[hostIndex].
    const fromStart = head !== undefined || reason === 'system' || reason === 'tools';
    const at = fromStart
      ? 0
      : (this._head?.replacement.length ?? 0) +
        (hostIndex - this.cut) +
        [...this.groups().values()].reduce((n, group) => n + renderGroup(group).length, 0);
    return { reason, at, signed, ...(stripped ? { stripped } : {}) };
  }

  /** Records what a compile used: digests of `history` from `head.cut` on, and `sent`. */
  commit(history: readonly Message[], sent?: PrefixSent): void {
    this.history = [...history];
    this.seen = history.slice(this.cut).map(digest);
    if (sent) this._lastSent = { system: jsonCopy(sent.system), tools: jsonCopy(sent.tools) };
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

  /** The first place the ledger stops matching the history being compiled. */
  private findBreak(
    sent: PrefixSent | undefined,
  ): { reason: PrefixBreakReason; hostIndex: number } | undefined {
    const history = this.history;
    const cut = this.cut;
    if (history.length < cut) return { reason: 'ledger', hostIndex: 0 };
    // System and tools come before every message: a change invalidates everything after the head.
    if (sent && this._lastSent) {
      if (canonical(sent.system) !== canonical(this._lastSent.system)) {
        return { reason: 'system', hostIndex: cut };
      }
      if (canonical(sent.tools) !== canonical(this._lastSent.tools)) {
        return { reason: 'tools', hostIndex: cut };
      }
    }
    // A history break drops any entry anchored past the end along with the rest.
    for (let k = 0; k < this.seen.length; k++) {
      const i = cut + k;
      if (i >= history.length || digest(history[i]) !== this.seen[k]) {
        return { reason: 'history', hostIndex: i };
      }
    }
    if (this.entries.some((e) => e.anchor > history.length)) {
      return { reason: 'ledger', hostIndex: history.length };
    }
    return undefined;
  }

  /**
   * Where each entry renders, as the host index it sits before: the first
   * assistant message at or after its anchor, or the history length while
   * unanswered. `undefined` for an anchor past the end.
   */
  private placer(): (entry: PrefixEntry) => number | undefined {
    const history = this.history;
    const reply = new Array<number>(history.length + 1);
    reply[history.length] = history.length;
    for (let i = history.length - 1; i >= 0; i--) {
      reply[i] = history[i].role === 'assistant' ? i : reply[i + 1];
    }
    return (entry) => (entry.anchor <= history.length ? reply[entry.anchor] : undefined);
  }

  /** Entries by the host index they render before, in the order they were appended. */
  private groups(): Map<number, PrefixEntry[]> {
    const placeOf = this.placer();
    const groups = new Map<number, PrefixEntry[]>();
    for (const entry of this.entries) {
      const place = placeOf(entry);
      if (place === undefined) continue;
      const group = groups.get(place);
      if (group) group.push(entry);
      else groups.set(place, [entry]);
    }
    return groups;
  }
}
