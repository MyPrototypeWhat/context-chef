import type { Janitor } from '../modules/janitor';
import {
  anchorLines,
  awaitsToolResults,
  compactWindow,
  dynamicStateSource,
  eventAnchor,
  FRESH_LEDGER_REPLIES,
  invalidatedMessages,
  type PrefixBreak,
  PrefixLedger,
  type PrefixMeta,
  type PrefixSent,
  plainSent,
  reasonedReplies,
  sourceEvents,
} from '../prefix';
import type { ChefLogger, Message } from '../types';
import { SessionPool } from '../utils/sessionPool';
import { type JanitorPoolConfig, janitorFactory } from './janitorPool';

/** A checkpoint one call applied, as `ContextChef` reports it in `prefix:break`. */
export type PrefixSessionBreak = NonNullable<PrefixMeta['break']>;

/** One call of a framework integration, in IR. */
export interface PrefixSessionCall {
  /**
   * The conversation the host sent with this call, without its system
   * messages: the host's whole history, every call, as the integrations
   * receive it.
   */
  readonly history: Message[];
  /** What the call sends ahead of the conversation — its system prompt and tools — as plain data. */
  readonly sent: PrefixSent;
  /** The `<dynamic_state>` block as it stands now, when the integration has dynamic state. */
  readonly dynamicState?: string;
  /** `false` leaves the window uncompressed this call: the provider manages the context. Default `true`. */
  readonly overflow?: boolean;
  /**
   * A request outside the conversation, such as a structured-output call
   * made with other tools: compiled as a call would be — its own checkpoints
   * applied to it — and then rolled back, so it is no checkpoint for the
   * conversation and lands no compression. A session that lost its ledger
   * leaves its warning to the next call, which meets the same checkpoint.
   * Default `false`.
   */
  readonly oneOff?: boolean;
  readonly signal?: AbortSignal;
}

/** What one call sends, and the checkpoints it took to get there. */
export interface PrefixSessionWindow {
  /**
   * The conversation to send: the head of the last compaction, then the
   * host's messages with the events appended among them, each message whose
   * thinking a checkpoint invalidated without it.
   */
  readonly messages: Message[];
  /** The checkpoints this call applied, in order. */
  readonly breaks: readonly PrefixSessionBreak[];
}

/**
 * The thinking a provider signed over everything before it, in an
 * integration's own format: what a checkpoint invalidates. Only a signature
 * breaks when the prefix changes, so other reasoning is no part of it — on a
 * provider that signs nothing, a checkpoint is only reported (spec §6.5).
 * Told by each part's own provenance, not by the model a call goes to.
 */
export interface SignedThinking {
  /** How many signed thinking blocks `message` holds. */
  count(message: Message): number;
  /**
   * `message` without them (as it is when it holds none), or `undefined`
   * when they were all it held: a reply with nothing left to send.
   */
  strip(message: Message): Message | undefined;
}

/** Configuration for {@link createPrefixSessionPool}. */
export interface PrefixSessionPoolConfig<THostMessages>
  extends Omit<JanitorPoolConfig<THostMessages>, 'persistenceWarning'> {
  /** What a checkpoint takes out of the messages it invalidated. */
  signedThinking: SignedThinking;
}

/**
 * `appendOnly` for one conversation of a framework integration. The host
 * sends its whole history with every call and never takes anything back, so
 * the session keeps what `ContextChef` keeps between compiles — a prefix
 * ledger — and rebuilds each call's window from (history, ledger): what was
 * sent before is sent again as it was, and only appended to.
 *
 * - Dynamic state is an event, appended once after the turn it changed in
 *   and replayed there from then on, never merged into a host message. The
 *   provider behind an integration is unknown, and a provider SDK may hoist a
 *   mid-conversation system message into the system prompt, so every event
 *   is a user message. Nothing is appended while tool calls wait for their
 *   results.
 * - A compression that lands is the ledger's head: later calls send it in
 *   place of the host messages it summarized instead of summarizing again,
 *   until the window is over budget once more. It lands with the chef's
 *   timing: at a user-turn boundary, or collapsing a tool turn that cannot
 *   wait because the request would be past the raw context window.
 * - Anything that rewrote what was sent — an edited history, a new system
 *   prompt or tool list, a compaction, a session that lost its ledger — is a
 *   checkpoint: reported, and the signed thinking it invalidated is never
 *   sent again ({@link SignedThinking}); a reply that held nothing else is
 *   left out. Reasoning nothing signed stays where it was.
 *
 * One call at a time: a call that arrives while another is in progress waits
 * for it, since each one reconciles, appends and commits the same ledger.
 * The session lives in its pool, which lives in the integration instance: a
 * restart, an eviction from the pool, or an instance created per request
 * loses the ledger, and the next call is a `ledger` checkpoint.
 */
export class PrefixSession {
  readonly ledger = new PrefixLedger();
  // Built by createPrefixSessionPool(); the package exports the type alone.
  private last: Promise<unknown> = Promise.resolve();

  constructor(
    /** The session's overflow runner; `null` when the integration compresses nothing. */
    readonly janitor: Janitor | null,
    private readonly options: {
      readonly signedThinking: SignedThinking;
      /** Logs `message` once per pool, by `key`. */
      readonly warnOnce: (key: string, message: string) => void;
    },
  ) {}

  /**
   * The window this call sends. A call that fails keeps nothing, nor does a
   * one-off: the next one starts where the last kept call left.
   */
  compile(call: PrefixSessionCall): Promise<PrefixSessionWindow> {
    const turn = this.last.then(() => this.run(call));
    this.last = turn.catch(() => undefined);
    return turn;
  }

  /**
   * The provider's input token count for the call last compiled: the
   * runner's reading, and from now until the next report, what the window
   * gains is counted on top of it.
   */
  reportTokenUsage(tokens: number): void {
    this.janitor?.feedTokenUsage(tokens);
    this.ledger.markReported();
  }

  private async run(call: PrefixSessionCall): Promise<PrefixSessionWindow> {
    const { history, dynamicState, overflow = true, oneOff = false, signal } = call;
    const { ledger, janitor } = this;
    const { signedThinking } = this.options;
    // One copy, compared and committed alike.
    const sent = plainSent(call.sent);
    const fresh = ledger.lastSent === undefined;
    const breaks: PrefixSessionBreak[] = [];
    // Messages are this call's own objects, and the head's: they are known by identity.
    // `invalidBefore` is what was invalid already when the checkpoint was applied.
    const report = (brk: PrefixBreak | undefined, invalidBefore: readonly Message[]) => {
      if (!brk) return;
      const before = new Set(invalidBefore);
      const strippedThinking = invalidatedMessages(history, ledger)
        .filter((message) => !before.has(message))
        .reduce((n, message) => n + signedThinking.count(message), 0);
      breaks.push({ reason: brk.reason, at: brk.at, signed: brk.signed, strippedThinking });
    };
    const checkpointed = (checkpoint: () => PrefixBreak | undefined) => {
      const before = invalidatedMessages(history, ledger);
      report(checkpoint(), before);
    };

    try {
      const reconciled = ledger.reconcile(history);
      report(reconciled.break, reconciled.invalidBefore ?? []);
      // A one-off keeps nothing: the next call meets the same checkpoint, and warns.
      if (fresh && !oneOff && breaks[0]?.reason === 'ledger') this.warnLostLedger(history);

      if (overflow && janitor && !oneOff) {
        const window = ledger.window();
        const { head } = await compactWindow({ ledger, history, window, runner: janitor, signal });
        if (head) checkpointed(() => ledger.checkpoint('compaction', head.cut, head));
      }

      if (!awaitsToolResults(history, ledger.head)) {
        const stated = sourceEvents(ledger, [dynamicStateSource(dynamicState, 'user')]);
        const events = [...stated, ...anchorLines(stated)];
        if (events.length > 0) ledger.append(events, eventAnchor(history, ledger.head));
      }

      checkpointed(() => ledger.reconcileSent(sent));

      // Asked of every message whose thinking is invalid, whatever its IR says:
      // only the integration knows what its own format carries.
      const invalid = new Set(invalidatedMessages(history, ledger));
      const messages = ledger.window().flatMap((message) => {
        if (!invalid.has(message)) return [message];
        const stripped = signedThinking.strip(message);
        return stripped ? [stripped] : [];
      });
      if (oneOff) ledger.rollback();
      else ledger.commit(history, sent);
      return { messages, breaks };
    } catch (error) {
      ledger.rollback();
      throw error;
    }
  }

  private warnLostLedger(history: readonly Message[]): void {
    const replies = reasonedReplies(history);
    if (replies <= FRESH_LEDGER_REPLIES) return;
    this.options.warnOnce(
      'lost-ledger',
      `[context-chef] appendOnly: a session's prefix ledger is empty, but its history already ` +
        `holds ${replies} replies with reasoning, sent by a session that is gone — so their ` +
        'signed thinking was invalidated (a `ledger` checkpoint). Sessions live in the ' +
        'integration instance (the middleware): one created per request starts every session ' +
        'empty, and every call is then a checkpoint, so create it once and reuse it. A restart, ' +
        'a serverless instance or a session the pool evicted (`maxSessions`) costs one. Each ' +
        'instance logs this once.',
    );
  }
}

/**
 * Builds the per-session pool of an integration with `appendOnly` on: one
 * {@link PrefixSession} per conversation, holding the session's Janitor when
 * compression is configured, built as {@link createJanitorPool} builds it.
 *
 * The pool exists whatever is configured — dynamic state alone needs a
 * ledger. `contextWindow` is required once a compression option is set.
 * Nothing warns that a summary goes unpersisted: the session sends its head
 * on every later call, so the payload does not grow back; `onCompress` is for
 * surviving the process.
 */
export function createPrefixSessionPool<THostMessages>(
  config: PrefixSessionPoolConfig<THostMessages>,
): SessionPool<PrefixSession> {
  const janitor = janitorFactory(config, () => {}, true);
  const warnOnce = onceEach(config.logger);
  return new SessionPool(
    () =>
      new PrefixSession(janitor?.() ?? null, {
        signedThinking: config.signedThinking,
        warnOnce,
      }),
    { maxSize: config.maxSessions },
  );
}

/** Logs each key's message once, for the whole pool. */
function onceEach(logger: ChefLogger): (key: string, message: string) => void {
  const warned = new Set<string>();
  return (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(message);
  };
}
