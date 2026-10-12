/**
 * The append-only prefix (`ChefConfig.appendOnly`): once a turn is sent, the
 * next turn's payload repeats it and only appends. Thinking-signed models
 * (Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5) sign every thinking block
 * over everything before it, and OpenAI / Gemini prefix caches key on the same
 * bytes.
 *
 * Three rules hold it together. Injections are events, appended once where
 * they became true and replayed in place after that. What the model can pull
 * through the `context` tool is not pushed. And every rewrite of what was
 * already sent is an explicit checkpoint, reported, never silent.
 */

import type { Message } from '../types';

export interface AppendOnlyConfig {
  /**
   * On Anthropic, push the system-channel sources as a turn-scoped reminder
   * on every compile (`clear_at: 'next_user_message'`) instead of once. Each
   * reminder still stays in place and costs no tokens once cleared. Needs the
   * `mid-conversation-system-clear-at-2026-08-21` beta. Default `false`.
   */
  clearAt?: boolean;
}

/** Where an appended event came from. */
export type InjectionSource =
  | 'dynamic-state'
  | 'implicit-context'
  | 'memory'
  | 'skill'
  | 'guardrail'
  | 'handoff'
  | 'pinned'
  | `announcement:${string}`;

/** Something the chef appended to the window, and where. */
export interface PrefixEntry {
  /** Sits immediately before `host[anchor]` (absolute host index; the host length is the tail). */
  readonly anchor: number;
  readonly channel: 'system' | 'user';
  /** What `sources` said: their current state, or the withdrawal notice of a tombstone. */
  readonly content: string;
  /**
   * The sources this entry speaks for. A checkpoint empties it on the entries
   * it keeps: they are still replayed, but no longer any source's last word,
   * so the caller re-states current state.
   */
  readonly sources: readonly InjectionSource[];
  /** Turn-scoped (`clear_at`); only on the system channel. */
  readonly clearAt?: true;
  /** A tombstone: `sources` were withdrawn and `content` says so. */
  readonly withdrawn?: true;
  /**
   * Rendered into the same message as the entry before it. One `append()`
   * call puts consecutive entries of one channel into one message; a later
   * call at the same anchor starts a new one, so the message already sent
   * stays as it was.
   */
  readonly joined?: true;
}

/** An entry to append; the ledger sets the anchor and how it joins its neighbours. */
export type PrefixCandidate = Omit<PrefixEntry, 'anchor' | 'joined'>;

/** The latest compaction checkpoint, which replaced the start of the window. */
export interface PrefixHead {
  /** `host[0, cut)` is replaced by `replacement`. */
  readonly cut: number;
  /** The summary message or signed compaction message, plus re-inserted pinned messages. */
  readonly replacement: readonly Message[];
  /** An on-demand compaction block signed by the provider: later turns keep their thinking. */
  readonly signed: boolean;
}

export type PrefixBreakReason = 'compaction' | 'history' | 'system' | 'tools' | 'ledger';

/** The top-level system prompt and tools of a sent payload. */
export interface PrefixSent {
  readonly system?: unknown;
  readonly tools?: unknown;
}

export interface PrefixLedgerSnapshot {
  readonly version: 1;
  readonly entries: readonly PrefixEntry[];
  readonly head?: PrefixHead;
  /** Host ranges `[from, until)` whose thinking an unsigned checkpoint stripped; never put back. */
  readonly stripped: ReadonlyArray<readonly [number, number]>;
  /** Digests of the host messages last seen (after `transform-tool-results`), from `head.cut` on. */
  readonly seen: readonly string[];
  /** What was last sent: compared to detect a change, and reused by an on-demand compaction request. */
  readonly lastSent?: PrefixSent;
}

/** A checkpoint the ledger applied. */
export interface PrefixBreak {
  readonly reason: PrefixBreakReason;
  /** Window index of the first message the checkpoint changed; `0` for compaction, system and tools. */
  readonly at: number;
  readonly signed: boolean;
  /**
   * The host range `[from, until)` this checkpoint stripped thinking from.
   * Absent when signed or empty. It may overlap ranges stripped earlier.
   */
  readonly stripped?: readonly [number, number];
}

export interface PrefixReconcile {
  /** `head.replacement`, then host messages with the entries spliced in. */
  readonly window: Message[];
  /** Present when the ledger no longer matched what it is replayed over; already applied. */
  readonly break?: PrefixBreak;
}

/** `CompileMeta.prefix`: present only when `appendOnly` is on. */
export interface PrefixMeta {
  /** Window messages identical to the previous turn's. */
  readonly stable: number;
  readonly break?: {
    readonly reason: PrefixBreakReason;
    readonly at: number;
    readonly signed: boolean;
    readonly strippedThinking: number;
  };
}
