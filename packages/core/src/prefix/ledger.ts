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

/** What a compile can change, as the last commit left it: what `rollback()` puts back. */
interface Committed {
  readonly head?: PrefixHead;
  readonly entries: PrefixEntry[];
  readonly stripped: Range[];
  readonly seen: string[];
  readonly lastSent?: PrefixSent;
  readonly history: readonly Message[];
  readonly restarted: boolean;
}

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
 * `sent` as the ledger compares and keeps it: a plain JSON copy, which
 * whatever edits the payload it was read from afterwards does not reach.
 * Take it once per compile and pass the same copy to `reconcileSent()` and
 * `commit()`.
 */
export function plainSent(sent: PrefixSent): PrefixSent {
  return { system: jsonCopy(sent.system), tools: jsonCopy(sent.tools) };
}

/** Whether `value` is what `commit()` kept as `kept`, compared as the JSON it keeps. */
function sameAsKept(value: unknown, kept: unknown): boolean {
  return canonical(jsonCopy(value)) === canonical(kept);
}

/**
 * Digest of the fields of a host message that reach some provider's wire.
 * Anything else — breakpoints, pinning, host metadata — is not an edit.
 * `_anthropic_origin` counts by identity: dropping or replacing it makes the
 * Anthropic target rebuild the message from IR instead of replaying it.
 *
 * The role's initial leads in clear: where an entry renders depends on which
 * host messages are replies, and `seen` is all a restored ledger knows of the
 * history it committed.
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
  const hash = createHash('sha256').update(canonical(wire)).digest('hex').substring(0, 16);
  return `${message.role.charAt(0)}:${hash}`;
}

const isReplyDigest = (key: string): boolean => key.startsWith('a:');

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
 * Where an entry anchored at each host index renders, as the host index it
 * sits before: the first assistant message at or after the anchor, or
 * `length` while unanswered. Anchors past `length` have no place.
 */
function anchorPlaces(length: number, isReply: (index: number) => boolean): number[] {
  const place = new Array<number>(length + 1);
  place[length] = length;
  for (let i = length - 1; i >= 0; i--) place[i] = isReply(i) ? i : place[i + 1];
  return place;
}

/** Entries by the host index they render before, in the order they were appended. */
function groupEntries(
  entries: readonly PrefixEntry[],
  place: readonly number[],
): Map<number, PrefixEntry[]> {
  const groups = new Map<number, PrefixEntry[]>();
  for (const entry of entries) {
    const at = place[entry.anchor];
    if (at === undefined) continue;
    const group = groups.get(at);
    if (group) group.push(entry);
    else groups.set(at, [entry]);
  }
  return groups;
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
 * phases decide, then `reconcileSent()` once the payload exists, then
 * `commit()`; everything in between works on the history `reconcile()` was
 * given. A compile that fails instead calls `rollback()`: nothing it built was
 * sent, so nothing it did is kept.
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
  /** Set by `reset()`: the next `reconcile()` applies a `ledger` checkpoint at 0. */
  private restarted = false;
  /**
   * From the first `reconcile()` after a commit until the next commit: the
   * state committed, which `stable()` compares with and `rollback()` returns
   * to, and the lowest window index a checkpoint has changed since.
   */
  private pending?: { readonly committed: Committed; at: number };
  /** Digests taken in the compile in progress, so it reads the history once. */
  private readonly digests = new Map<Message, string>();

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
    ledger.restarted = copy.restarted === true;
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
   * history shorter than `head.cut`, a host message that is not the one seen,
   * an entry anchored past the end, a `reset()` since the last compile, a
   * ledger that has seen nothing meeting a history with a reply in it — the
   * first mismatch is applied as a checkpoint and reported in `break`; the
   * window is the one after it.
   */
  reconcile(history: readonly Message[]): PrefixReconcile {
    this.pending ??= { committed: this.capture(), at: Number.POSITIVE_INFINITY };
    this.digests.clear();
    this.history = [...history];
    const found = this.restarted ? { reason: 'ledger' as const, hostIndex: 0 } : this.findBreak();
    this.restarted = false;
    if (!found) return { window: this.window() };
    const applied = this.checkpoint(found.reason, found.hostIndex);
    return { window: this.window(), break: applied };
  }

  /**
   * Compares the system prompt and tools a compile sends with the ones last
   * committed, once its payload exists. A change — the system prompt is
   * checked first — is a `system` or `tools` checkpoint: every thinking block
   * after the head was signed over the old ones, so all of them are stripped,
   * while the entries stay, since what they say still holds. Before the first
   * commit there is nothing to compare with.
   */
  reconcileSent(sent: PrefixSent): PrefixBreak | undefined {
    const last = this._lastSent;
    if (!last) return undefined;
    if (!sameAsKept(sent.system, last.system)) return this.checkpoint('system', this.cut);
    if (!sameAsKept(sent.tools, last.tools)) return this.checkpoint('tools', this.cut);
    return undefined;
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
   *
   * `system` and `tools` change what comes before every message, not the
   * messages: entries, `seen` and the head stay, and `hostIndex` is `head.cut`
   * (`reconcileSent()` passes it), so all thinking after the head is stripped.
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

    const place = this.places();
    const previousCut = this.cut;
    if (head) {
      this._head = head;
      this.entries = this.entries.filter((e) => (place[e.anchor] ?? -1) > head.cut);
      this.seen = head.cut >= previousCut ? this.seen.slice(head.cut - previousCut) : [];
    } else if (reason === 'system' || reason === 'tools') {
      // Re-based by the next commit.
      this._lastSent = undefined;
    } else {
      if (hostIndex < previousCut) this._head = undefined;
      this.entries = this.entries.filter((e) => (place[e.anchor] ?? Infinity) <= hostIndex);
      this.seen = this.seen.slice(0, Math.max(0, hostIndex - previousCut));
    }

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
    if (this.pending) this.pending.at = Math.min(this.pending.at, at);
    return { reason, at, signed, ...(stripped ? { stripped } : {}) };
  }

  /**
   * How many leading messages of `window()` the window last committed also
   * started with, never counting past a checkpoint applied since:
   * `PrefixMeta.stable`. The windows are compared message by message rather
   * than read off `at`, which marks the changed host message — an entry kept
   * ahead of it may have moved there, and an unanswered tail may have been
   * rendered again.
   */
  stable(): number {
    const before = this.keys(this.pending?.committed ?? this.capture());
    const now = this.window().map((message) => this.digestOf(message));
    let same = 0;
    while (same < before.length && same < now.length && before[same] === now[same]) same++;
    return Math.min(same, this.pending?.at ?? same);
  }

  /** Records what a compile used: digests of `history` from `head.cut` on, and `sent`. */
  commit(history: readonly Message[], sent?: PrefixSent): void {
    this.history = [...history];
    this.seen = history.slice(this.cut).map((message) => this.digestOf(message));
    if (sent) this._lastSent = plainSent(sent);
    this.pending = undefined;
    this.digests.clear();
  }

  /**
   * Undoes everything since the first `reconcile()` after the last commit:
   * that compile failed, so nothing it built was sent, and the next one meets
   * the same checkpoints again. Nothing to undo after a commit.
   */
  rollback(): void {
    const committed = this.pending?.committed;
    this.pending = undefined;
    this.digests.clear();
    if (!committed) return;
    this._head = committed.head;
    this.entries = committed.entries;
    this._stripped = committed.stripped;
    this.seen = committed.seen;
    this._lastSent = committed.lastSent;
    this.history = committed.history;
    this.restarted = committed.restarted;
  }

  /**
   * Starts over, as `clearHistory()` does: the entries, head, stripped ranges
   * and what was seen are dropped, and the next `reconcile()` applies a
   * `ledger` checkpoint at 0, since the window sent before is not repeated.
   * What was last sent ahead of the window stays: it is not part of the
   * conversation.
   */
  reset(): void {
    this._head = undefined;
    this.entries = [];
    this._stripped = [];
    this.seen = [];
    this.history = [];
    this.restarted = true;
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
      ...(this.restarted ? { restarted: true as const } : {}),
    });
  }

  /** The first place the ledger stops matching the history being compiled. */
  private findBreak(): { reason: PrefixBreakReason; hostIndex: number } | undefined {
    const history = this.history;
    const cut = this.cut;
    if (history.length < cut) return { reason: 'ledger', hostIndex: 0 };
    // A reply answered a request this ledger never saw, sent with whatever was
    // appended to it then: nothing it was signed over can be vouched for.
    const blank = !this._head && this.entries.length === 0 && this.seen.length === 0;
    if (blank && history.some((m) => m.role === 'assistant')) {
      return { reason: 'ledger', hostIndex: 0 };
    }
    // A history break drops any entry anchored past the end along with the rest.
    for (let k = 0; k < this.seen.length; k++) {
      const i = cut + k;
      if (i >= history.length || this.digestOf(history[i]) !== this.seen[k]) {
        return { reason: 'history', hostIndex: i };
      }
    }
    if (this.entries.some((e) => e.anchor > history.length)) {
      return { reason: 'ledger', hostIndex: history.length };
    }
    return undefined;
  }

  /** Where an entry anchored at each host index renders, over the history being compiled. */
  private places(): number[] {
    const history = this.history;
    return anchorPlaces(history.length, (i) => history[i].role === 'assistant');
  }

  private groups(): Map<number, PrefixEntry[]> {
    return groupEntries(this.entries, this.places());
  }

  private digestOf(message: Message): string {
    let key = this.digests.get(message);
    if (key === undefined) {
      key = digest(message);
      this.digests.set(message, key);
    }
    return key;
  }

  private capture(): Committed {
    return {
      head: this._head,
      // `append()` pushes onto the live array.
      entries: [...this.entries],
      stripped: this._stripped,
      seen: this.seen,
      lastSent: this._lastSent,
      history: this.history,
      restarted: this.restarted,
    };
  }

  /**
   * The window `committed` rendered, one digest per message, rebuilt from its
   * `seen` alone: a restored ledger has no host message of it to render.
   */
  private keys(committed: Committed): string[] {
    const { head, seen } = committed;
    const cut = head?.cut ?? 0;
    const length = cut + seen.length;
    // An entry kept past a compaction has no reply before the cut, or it was summarized.
    const groups = groupEntries(
      committed.entries,
      anchorPlaces(length, (i) => i >= cut && isReplyDigest(seen[i - cut])),
    );
    const keys = (head?.replacement ?? []).map(digest);
    for (let i = cut; i <= length; i++) {
      const group = groups.get(i);
      if (group) keys.push(...renderGroup(group).map(digest));
      if (i < length) keys.push(seen[i - cut]);
    }
    return keys;
  }
}
