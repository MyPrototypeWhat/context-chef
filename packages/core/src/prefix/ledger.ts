import { createHash } from 'node:crypto';
import { Assembler } from '../modules/assembler';
import type { Message } from '../types';
import { invalidatedMessages, thinkingBlocks } from './thinking';
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

/**
 * What a head stands for: digests of the host messages it summarized,
 * `host[0, cut)` when it landed, and how many of them lead with thinking
 * signed over the host messages before them alone (`intact`) — up to the
 * first event the compaction absorbed, or an older head's cut; none once the
 * system prompt or tools changed under the head.
 */
interface Summarized {
  readonly digests: readonly string[];
  readonly intact: number;
}

/** What a compile can change, as the last commit left it: what `rollback()` puts back. */
interface Committed {
  readonly head?: PrefixHead;
  readonly summarized?: Summarized;
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

/** Whether two payloads, or parts of one, send the model the same thing. */
export function sameOnWire(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
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
  return sameOnWire(jsonCopy(value), kept);
}

/**
 * Digest of the fields of a message that reach some provider's wire: two
 * messages with the same digest are the same message to the model. Anything
 * else — breakpoints, pinning, host metadata, the `_chef_event` mark — is not
 * an edit. `_anthropic_origin` counts by identity: dropping or replacing it
 * makes the Anthropic target rebuild the message from IR instead of
 * replaying it.
 *
 * The role's initial leads in clear: where an entry renders depends on which
 * host messages are replies, and `seen` is all a restored ledger knows of the
 * history it committed.
 */
export function wireDigest(message: Message): string {
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
    message._clear_at,
  ];
  const hash = createHash('sha256').update(canonical(wire)).digest('hex').substring(0, 16);
  return `${message.role.charAt(0)}:${hash}`;
}

/** An assistant message that answered a request: not a compaction block, which stands for earlier ones. */
export const isReply = (message: Message): boolean =>
  message.role === 'assistant' && message._anthropic_compaction === undefined;

/**
 * More replies with reasoning (`reasonedReplies`) than this behind a fresh
 * ledger's `ledger` checkpoint, and the ledger that sent them was not kept: a
 * chef created per request that does not persist it, or an integration
 * session that lost it with its process.
 */
export const FRESH_LEDGER_REPLIES = 2;

/**
 * The replies `history` holds that something follows: a trailing assistant
 * message nothing follows yet — a prefill — answered nothing so far.
 */
function answeredReplies(history: readonly Message[]): number {
  return countReplies(history, isReply);
}

/**
 * The answered replies (`answeredReplies`) that carry reasoning a provider
 * replays with them: thinking, OpenAI reasoning items, a Gemini thought
 * signature. Those are what a `ledger` checkpoint costs; plain replies, such
 * as few-shot examples, lose nothing.
 */
export function reasonedReplies(history: readonly Message[]): number {
  return countReplies(
    history,
    (message) =>
      isReply(message) &&
      (thinkingBlocks(message) > 0 ||
        message._openai_reasoning !== undefined ||
        message._gemini_thought_signature !== undefined),
  );
}

function countReplies(history: readonly Message[], counts: (message: Message) => boolean): number {
  let replies = 0;
  for (let i = 0; i < history.length - 1; i++) if (counts(history[i])) replies++;
  return replies;
}

/**
 * Whether a message placed at `end` follows a user turn: the last message
 * before it that is not a system message is a user message or tool results.
 * `initial(i)` is the role initial of message `i`, as digests lead with it.
 */
export function followsUserTurn(end: number, initial: (i: number) => string): boolean {
  for (let i = end - 1; i >= 0; i--) {
    const role = initial(i);
    if (role !== 's') return role === 'u' || role === 't';
  }
  return false;
}

/**
 * The messages of the entries that render at one place: user events, then
 * system events (a positional system message must not be followed by a user
 * turn), then turn-scoped ones (`_clear_at`), since `clear_at` applies per
 * message.
 *
 * A positional system message is only valid right after a user turn. When
 * neither the group's own user event nor the message before the group is
 * one — an empty window, a reply right before — the system events are said
 * as user messages instead, 4.x's fallback; the entries keep their channel.
 * A user message cannot be turn-scoped, so turn-scoped entries are only
 * appended where they stay system messages (`turnScopedAt()`). A pure
 * function of the group and what precedes it, so a tail renders the same
 * bytes once answered. Every message is marked `_chef_event`, which no
 * adapter sends.
 */
export function renderGroup(
  entries: readonly PrefixCandidate[],
  afterUserTurn: boolean,
): Message[] {
  const text = (part: readonly PrefixCandidate[]) => part.map((e) => e.content).join('\n\n');
  const user = entries.filter((e) => e.channel === 'user');
  const system = entries.filter((e) => e.channel === 'system' && !e.clearAt);
  const turnScoped = entries.filter((e) => e.channel === 'system' && e.clearAt);
  const positional = afterUserTurn || user.length > 0;
  const messages: Message[] = [];
  if (user.length > 0) messages.push({ role: 'user', content: text(user), _chef_event: true });
  const say = (part: readonly PrefixCandidate[], scope: Pick<Message, '_clear_at'>) => {
    if (part.length === 0) return;
    messages.push(
      positional
        ? { role: 'system', content: text(part), _positional: true, ...scope, _chef_event: true }
        : { role: 'user', content: text(part), _chef_event: true },
    );
  };
  say(system, {});
  say(turnScoped, { _clear_at: 'next_user_message' });
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
 * Whether the window opens after a user turn: what `head` puts in front of
 * `host[head.cut]` ends with one. Without a head, nothing comes first.
 */
export function opensAfterUserTurn(head?: PrefixHead): boolean {
  const replacement = head?.replacement ?? [];
  return followsUserTurn(replacement.length, (k) => replacement[k].role.charAt(0));
}

/**
 * Where an entry anchored at each host index renders, as the host index it
 * sits before: the first assistant message at or after the anchor, or
 * `length` while unanswered. A run of the host's own system messages right
 * before that place that follows a user turn stays positional, and a user
 * message must not follow it, so the entry goes in front of it (from the
 * anchor on); a run after a reply is hoisted, and the entry stays behind it.
 * `role(i)` is the role initial of host message `i`; `opening` says whether
 * the window opens after a user turn (`opensAfterUserTurn`). Anchors past
 * `length` have no place.
 */
function anchorPlaces(
  length: number,
  cut: number,
  role: (index: number) => string,
  opening: boolean,
): number[] {
  const positional: boolean[] = [];
  let afterUserTurn = opening;
  for (let i = cut; i < length; i++) {
    const initial = role(i);
    if (initial === 's') positional[i] = afterUserTurn;
    else afterUserTurn = initial === 'u' || initial === 't';
  }
  const place = new Array<number>(length + 1);
  place[length] = length;
  for (let i = length - 1; i >= 0; i--) {
    const ahead = role(i) === 'a' || (positional[i] === true && place[i + 1] === i + 1);
    place[i] = ahead ? i : place[i + 1];
  }
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
 * the reply to the request that carried it, and ahead of a run of the host's
 * own system messages right before that if the run follows a user turn.
 * Until that reply exists it is provisional and renders at the current tail;
 * once answered, the group it rendered in is fixed. Finality is read off the
 * history, not stored.
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
  /** What the head stands for, while there is one. */
  private summarized?: Summarized;
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
   * Leading window messages the last usage report covers: the window
   * committed when it came, or 0 once a commit since changed one of them.
   */
  private _reported?: number;
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
    ledger.summarized = copy.summarized;
    ledger.entries = [...copy.entries];
    ledger._stripped = copy.stripped.map(([from, until]) => [from, until]);
    ledger.seen = [...copy.seen];
    ledger._lastSent = copy.lastSent;
    ledger.restarted = copy.restarted === true;
    ledger._reported = copy.reported;
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

  /**
   * How many leading messages of the window the last usage report covers
   * (`markReported()`), as the last commit left it; `undefined` before any
   * report.
   */
  get reported(): number | undefined {
    return this._reported;
  }

  /**
   * How many leading messages of the window being compiled the last usage
   * report describes: those of the payload it came back for, while the window
   * still starts with them — and none once one of them changed, since the
   * report then counts a payload that no longer exists. `undefined` before
   * any report.
   */
  reportCovers(): number | undefined {
    const reported = this._reported;
    if (reported === undefined) return undefined;
    return this.stable() < reported ? 0 : reported;
  }

  /**
   * A usage report came back for the window last committed: until the next
   * one, the report covers that many leading messages of the window, however
   * many compiles commit after it without a report — and none once one of
   * them commits a window that changed a message it covered
   * (`reportCovers()`). Survives a rollback — the report describes what was
   * sent, not what a failed compile built.
   */
  markReported(): void {
    this._reported = this.keys(this.pending?.committed ?? this.capture()).length;
  }

  private get cut(): number {
    return this._head?.cut ?? 0;
  }

  /** Nothing in the window was ever sent through this ledger: no head, no entry, nothing seen. */
  private get blank(): boolean {
    return !this._head && this.entries.length === 0 && this.seen.length === 0;
  }

  /**
   * Rebuilds the window over `history`. When the ledger no longer matches —
   * a host message that is not the one seen, an entry anchored past the end,
   * a `reset()` since the last compile, a ledger that has seen nothing
   * meeting a history with a reply in it — the first mismatch is applied as a
   * checkpoint and reported in `break`; the window is the one after it.
   *
   * A head stands in only for the host messages it summarized, while the
   * history holds them as they were. A history that opens with the head's
   * messages instead took it in — a host that persisted the compaction, an
   * `onCompress` sink writing them back — and the head becomes the host's:
   * the same conversation, as far as it matches the window. Any other
   * history is one the head no longer applies to: a `history` checkpoint,
   * and the window is the host's history again.
   */
  reconcile(history: readonly Message[]): PrefixReconcile {
    this.pending ??= { committed: this.capture(), at: Number.POSITIVE_INFINITY };
    this.digests.clear();
    this.history = [...history];
    const found = this.restarted
      ? { reason: 'ledger' as const, hostIndex: 0, headLost: false }
      : this.findBreak();
    this.restarted = false;
    if (!found) return { window: this.window() };
    const invalidBefore = found.headLost
      ? this.invalidLeft()
      : invalidatedMessages(this.history, this);
    const applied = this.checkpoint(found.reason, found.hostIndex);
    return { window: this.window(), break: applied, invalidBefore };
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
    return this.render().window;
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
   * Every entry still in the window that speaks for `source`, oldest first:
   * all the window says from it, for a source whose statements add up rather
   * than replace each other.
   */
  appended(source: InjectionSource): PrefixEntry[] {
    return this.entries.filter((entry) => entry.sources.includes(source));
  }

  /**
   * Every source an entry still in the window speaks for, in the order they
   * first appear: how a caller finds one that went quiet since.
   */
  sources(): InjectionSource[] {
    return [...new Set(this.entries.flatMap((entry) => entry.sources))];
  }

  /**
   * The messages of the group an entry anchored at `anchor` joins, as the
   * window renders them now; empty when no entry renders there yet.
   */
  renderedAt(anchor: number): Message[] {
    const at = this.places()[anchor];
    return (at === undefined ? undefined : this.render().groups.get(at)) ?? [];
  }

  /**
   * The entries of the group an entry anchored at `anchor` joins, oldest
   * first: what the request being built says there so far.
   */
  entriesAt(anchor: number): PrefixEntry[] {
    const at = this.places()[anchor];
    return (at === undefined ? undefined : this.groups().get(at)) ?? [];
  }

  /**
   * Whether turn-scoped entries appended at `anchor` along with `candidates`
   * would be sent as turn-scoped system messages. A positional system message
   * needs a user turn right before it — the group's own user event, or a user
   * or tool message ahead of the group; without one the group says its
   * system entries as user messages, which cannot be turn-scoped.
   */
  turnScopedAt(anchor: number, candidates: readonly PrefixCandidate[]): boolean {
    const at = this.places()[anchor];
    if (at === undefined) return false;
    const group = [...(this.groups().get(at) ?? []), ...candidates];
    if (group.some((entry) => entry.channel === 'user')) return true;
    const { window, starts } = this.render();
    return followsUserTurn(starts[at], (k) => window[k].role.charAt(0));
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
      const absorbed = this.entries
        .map((e) => place[e.anchor])
        .filter((at): at is number => at !== undefined && at <= head.cut);
      this.summarized = {
        digests: this.history.slice(0, head.cut).map((message) => this.digestOf(message)),
        // Past an older head's cut, thinking was signed over that head.
        intact: this._head ? (this.summarized?.intact ?? 0) : Math.min(head.cut, ...absorbed),
      };
      this._head = head;
      this.entries = this.entries.filter((e) => (place[e.anchor] ?? -1) > head.cut);
      this.seen = head.cut >= previousCut ? this.seen.slice(head.cut - previousCut) : [];
    } else if (reason === 'system' || reason === 'tools') {
      // Re-based by the next commit.
      this._lastSent = undefined;
      // Every signature before the head was over the old ones too: none survives the head.
      if (this.summarized) this.summarized = { ...this.summarized, intact: 0 };
    } else {
      if (hostIndex < previousCut) {
        this._head = undefined;
        this.summarized = undefined;
      }
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
        // A group is the same number of messages on either channel.
        [...this.groups().values()].reduce((n, group) => n + renderGroup(group, true).length, 0);
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

  /**
   * Records what a compile used: digests of `history` from `head.cut` on, and
   * `sent`. The last usage report describes no window once this one changed
   * a message it covered.
   */
  commit(history: readonly Message[], sent?: PrefixSent): void {
    this._reported = this.reportCovers();
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
    this.summarized = committed.summarized;
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
   * `ledger` checkpoint at 0, since the window sent before is not repeated —
   * unless nothing was ever sent in it. What was last sent ahead of the window
   * stays: it is not part of the conversation.
   */
  reset(): void {
    this.restarted ||= !this.blank;
    this._head = undefined;
    this.summarized = undefined;
    this.entries = [];
    this._stripped = [];
    this.seen = [];
    this.history = [];
    this._reported = undefined;
  }

  /** Plain data, safe for `structuredClone` and JSON. */
  snapshot(): PrefixLedgerSnapshot {
    return structuredClone({
      version: 1 as const,
      entries: this.entries,
      ...(this._head ? { head: this._head } : {}),
      ...(this.summarized ? { summarized: this.summarized } : {}),
      stripped: this._stripped,
      seen: this.seen,
      ...(this._lastSent ? { lastSent: this._lastSent } : {}),
      ...(this.restarted ? { restarted: true as const } : {}),
      ...(this._reported !== undefined ? { reported: this._reported } : {}),
    });
  }

  /**
   * Where the head stands with the history being compiled. It stands in for
   * the host messages it summarized while the history holds them as they
   * were. A history that opens with all of the head's messages took it in,
   * and the head becomes the host's. Otherwise it no longer applies: the host
   * index to drop it at — where the history first differs from what was
   * summarized, or earlier, where thinking was signed over events or an older
   * head the window no longer holds.
   */
  private placeHead(head: PrefixHead): number | undefined {
    const summarized = this.summarized;
    if (summarized && this.leading(summarized.digests) === head.cut) return undefined;
    const replacement = head.replacement.map((message) => this.digestOf(message));
    // A head with no message of its own is taken in only by a history that goes
    // on with what followed the cut, or every history would open with it.
    const continues =
      replacement.length > 0 || (this.seen.length > 0 && this.leading(this.seen.slice(0, 1)) === 1);
    if (continues && this.leading(replacement) === replacement.length) {
      this.takeHeadIn();
      return undefined;
    }
    return Math.min(this.leading(summarized?.digests ?? []), summarized?.intact ?? 0);
  }

  /** How many leading messages of the history being compiled have `digests`, in order. */
  private leading(digests: readonly string[]): number {
    const history = this.history;
    let k = 0;
    while (k < digests.length && k < history.length && this.digestOf(history[k]) === digests[k]) {
      k++;
    }
    return k;
  }

  /**
   * The messages of the history being compiled whose thinking was invalid in
   * the window built until now, known by digest: a head that no longer
   * applies leaves no host index to read the old ranges by. The host history
   * that window was built over is read off what the ledger kept of it — what
   * the head summarized, then what was seen after the cut — which a ledger
   * restored from a snapshot holds too.
   */
  private invalidLeft(): Message[] {
    const summarized = this.summarized?.digests ?? new Array<string>(this.cut).fill('');
    const host = [...summarized, ...this.seen];
    const invalid = new Set([
      ...this._stripped.flatMap(([from, until]) => host.slice(from, until)),
      // What the head itself held that was invalid: it is no message of the history.
      ...invalidatedMessages([], this).map((message) => this.digestOf(message)),
    ]);
    return this.history.filter((message) => invalid.has(this.digestOf(message)));
  }

  /**
   * The head becomes the host's: its messages are `host[0, replacement.length)`
   * from now on, with their thinking as invalid as it was in the head, and
   * every host index from the cut on moves with them. The window renders the
   * same; whatever of the history differs from it is found next.
   */
  private takeHeadIn(): void {
    const head = this._head;
    if (!head) return;
    const taken = head.replacement.length;
    const shift = taken - head.cut;
    // An entry kept past the compaction renders after the cut, wherever it was anchored.
    this.entries = this.entries.map((entry) => ({
      ...entry,
      anchor: Math.max(taken, entry.anchor + shift),
    }));
    const invalid = head.replacement.flatMap((message, i): Range[] =>
      head.signed && message._anthropic_compaction !== undefined ? [] : [[i, i + 1]],
    );
    const kept = this._stripped.flatMap(([from, until]): Range[] =>
      until > head.cut ? [[Math.max(from, head.cut) + shift, until + shift]] : [],
    );
    this._stripped = mergeRanges([...invalid, ...kept]);
    this.seen = [...head.replacement.map((message) => this.digestOf(message)), ...this.seen];
    this._head = undefined;
    this.summarized = undefined;
  }

  /**
   * The first place the ledger stops matching the history being compiled;
   * `headLost` when the head no longer applies to it.
   */
  private findBreak():
    | { reason: PrefixBreakReason; hostIndex: number; headLost: boolean }
    | undefined {
    if (this._head) {
      const lost = this.placeHead(this._head);
      if (lost !== undefined) return { reason: 'history', hostIndex: lost, headLost: true };
    }
    const history = this.history;
    const cut = this.cut;
    // A reply answered a request this ledger never saw, sent with whatever was
    // appended to it then: nothing it was signed over can be vouched for. An
    // assistant message nothing follows yet — a prefill — answered nothing, and
    // nor does the compaction block a resumed history opens with: it stands
    // for what came before it, and a reply after it is still one.
    if (this.blank && answeredReplies(history) > 0) {
      return { reason: 'ledger', hostIndex: 0, headLost: false };
    }
    // A history break drops any entry anchored past the end along with the rest.
    for (let k = 0; k < this.seen.length; k++) {
      const i = cut + k;
      if (i >= history.length || this.digestOf(history[i]) !== this.seen[k]) {
        return { reason: 'history', hostIndex: i, headLost: false };
      }
    }
    if (this.entries.some((e) => e.anchor > history.length)) {
      return { reason: 'ledger', hostIndex: history.length, headLost: false };
    }
    return undefined;
  }

  /** Where an entry anchored at each host index renders, over the history being compiled. */
  private places(): number[] {
    const history = this.history;
    return anchorPlaces(
      history.length,
      this.cut,
      (i) => history[i].role.charAt(0),
      opensAfterUserTurn(this._head),
    );
  }

  private groups(): Map<number, PrefixEntry[]> {
    return groupEntries(this.entries, this.places());
  }

  /**
   * The window; the messages each group rendered as, by the host index it
   * renders before; and where in the window a group before each host index
   * starts (`starts[i]`, from `head.cut` on).
   */
  private render(): { window: Message[]; groups: Map<number, Message[]>; starts: number[] } {
    const history = this.history;
    const groups = this.groups();
    const window: Message[] = [...(this._head?.replacement ?? [])];
    const rendered = new Map<number, Message[]>();
    const starts: number[] = [];
    for (let i = this.cut; i <= history.length; i++) {
      starts[i] = window.length;
      const group = groups.get(i);
      if (group) {
        const afterUserTurn = followsUserTurn(window.length, (k) => window[k].role.charAt(0));
        const messages = renderGroup(group, afterUserTurn);
        rendered.set(i, messages);
        window.push(...messages);
      }
      if (i < history.length) window.push(history[i]);
    }
    return { window, groups: rendered, starts };
  }

  private digestOf(message: Message): string {
    let key = this.digests.get(message);
    if (key === undefined) {
      key = wireDigest(message);
      this.digests.set(message, key);
    }
    return key;
  }

  private capture(): Committed {
    return {
      head: this._head,
      summarized: this.summarized,
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
    // An entry kept past a compaction renders after the cut, or it was summarized.
    const groups = groupEntries(
      committed.entries,
      anchorPlaces(
        length,
        cut,
        (i) => (i >= cut ? seen[i - cut].charAt(0) : 'u'),
        opensAfterUserTurn(head),
      ),
    );
    const keys = (head?.replacement ?? []).map(wireDigest);
    for (let i = cut; i <= length; i++) {
      const group = groups.get(i);
      if (group) {
        const afterUserTurn = followsUserTurn(keys.length, (k) => keys[k].charAt(0));
        keys.push(...renderGroup(group, afterUserTurn).map(wireDigest));
      }
      if (i < length) keys.push(seen[i - cut]);
    }
    return keys;
  }
}
