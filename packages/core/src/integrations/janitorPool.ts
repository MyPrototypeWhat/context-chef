import {
  type CompressionDetails,
  Janitor,
  type JanitorConfig,
  type UsagePreferenceWithoutTokenizer,
  type UsagePreferenceWithTokenizer,
} from '../modules/janitor';
import { combinesServerAndOnDemand } from '../overflow/onDemand';
import type { CompressionArchiveConfig, OverflowStrategy } from '../overflow/types';
import type { ChefLogger, Message } from '../types';
import { dedupeConstructionWarnings, SessionPool } from '../utils/sessionPool';
import { estimateMessages } from '../utils/tokenUtils';

/**
 * After this many compressions fire without a persistence hook, warn once.
 * A couple of fires is a transient spike (fine); repeated fires signal a
 * sustained over-budget conversation that needs durable persistence.
 */
const COMPRESS_WITHOUT_PERSISTENCE_WARN_THRESHOLD = 3;

/** Compression tuning shared by the framework integrations. */
export interface IntegrationCompressOptions {
  /** Ratio of context window to preserve for recent messages. Default: 0.8 */
  preserveRatio?: number;
  /** Fraction of `contextWindow` at which compression triggers (0–1]. */
  triggerRatio?: number;
  /** Minimum character shrink a summary must achieve to be accepted (0–1). */
  minShrinkRatio?: number;
  /** Stub tool results longer than this before summarization. */
  toolResultStubThreshold?: number;
  /** Trigger-source strategy when both a tokenizer and reported usage exist. */
  usagePreference?: UsagePreferenceWithTokenizer;
}

/**
 * Configuration for {@link createJanitorPool}. `THostMessages` is the
 * integration's own message format — the `onCompress` boundary is reported in
 * host shape, so each integration passes its IR→host converter as
 * `toHostMessages`.
 */
export interface JanitorPoolConfig<THostMessages> {
  /**
   * The model's context window in tokens. Required whenever a compression
   * option is configured; ignored (and unused) otherwise.
   */
  contextWindow?: number;
  compress?: IntegrationCompressOptions;
  /** Resolved summarizer callback, built from the integration's model type. */
  compressionModel?: (messages: Message[]) => Promise<string>;
  tokenizer?: (messages: Message[]) => number;
  /**
   * The host's post-compression hook, reported in host message shape. With
   * `appendOnly`, `details.replacement` is what to write back in place of the
   * compressed messages to persist the compaction (`CompressionDetails`).
   */
  onCompress?: (
    summary: string,
    truncatedCount: number,
    details: { compressedMessages: THostMessages; replacement?: THostMessages },
  ) => void;
  onBeforeCompress?: JanitorConfig['onBeforeCompress'];
  /** Converts the compressed IR slice into the host's message format. */
  toHostMessages: (messages: Message[]) => THostMessages;
  /**
   * Builds the warning logged once when compression keeps firing without an
   * `onCompress` hook. Integration-specific: each names its own durable
   * compaction helper and its own call vocabulary.
   */
  persistenceWarning: (firedCount: number) => string;
  logger: ChefLogger;
  /** Cap on concurrently pooled sessions. Default: 256. */
  maxSessions?: number;
  /**
   * The overflow axis, as `ChefConfig.overflow` exposes it minus the pieces
   * that need a compile pipeline: an explicit strategy replaces the one the
   * `compress` options describe, and an archive keeps the evicted span
   * retrievable. `handoff` is not offered — the notice rides the tail channel,
   * which only `ContextChef.compile()` has.
   */
  overflow?: IntegrationOverflowOptions;
}

/** The overflow options a framework integration can forward to its Janitor. */
export interface IntegrationOverflowOptions {
  /**
   * Replaces the policy the `compress` options describe. When set, those
   * options are ignored — two descriptions of one thing would disagree.
   */
  strategy?: OverflowStrategy;
  /**
   * Where evicted spans are stored so the summary can cite them. Takes the
   * explicit `{ store }` form only: the `'vfs'` shorthand substitutes a
   * ContextChef-owned Offloader, which an integration does not have.
   */
  archive?: CompressionArchiveConfig;
}

/**
 * Builds the per-session Janitor pool shared by the framework integrations.
 *
 * Returns `null` for configurations with no compression intent (`compress` /
 * `onCompress` / `onBeforeCompress` / `overflow.strategy` all absent): those need no budget check,
 * no token-usage capture, and none of the Janitor's missing-tokenizer
 * warnings. Throws when compression IS configured without a `contextWindow` —
 * the budget check has nothing to compare against.
 *
 * A middleware instance is usually created once but serves many
 * conversations, so each session gets its own Janitor: sharing one would leak
 * token-usage feeds, compression suppression, and circuit-breaker counts
 * across conversations. Construction-time config nags are deduped across
 * sessions — the config is identical for every pooled Janitor.
 */
export function createJanitorPool<THostMessages>(
  config: JanitorPoolConfig<THostMessages>,
): SessionPool<Janitor> | null {
  const build = janitorFactory(config, createPersistenceWarner(config));
  return build && new SessionPool(build, { maxSize: config.maxSessions });
}

/**
 * What builds one session's Janitor from an integration's config: the
 * Janitor half of {@link createJanitorPool}, which the `appendOnly` session
 * pool shares. `null` when no option signals compression intent; throws when
 * one does without a `contextWindow`.
 *
 * `onCompressionFired` is told of every compression that lands. With
 * `appendOnly` the session's ledger owns the window: each Janitor counts
 * attachments at a flat cost in every reading, as the session's own check
 * does.
 *
 * @internal
 */
export function janitorFactory<THostMessages>(
  config: Omit<JanitorPoolConfig<THostMessages>, 'persistenceWarning'>,
  onCompressionFired: () => void,
  appendOnly = false,
): (() => Janitor) | null {
  const budgeting = Boolean(
    config.compress || config.onCompress || config.onBeforeCompress || config.overflow?.strategy,
  );
  if (!budgeting) return null;

  const { contextWindow } = config;
  if (contextWindow == null) {
    throw new Error(
      '[context-chef] `contextWindow` is required when a compression option (`compress`, ' +
        '`onCompress`, `onBeforeCompress`, `overflow.strategy`) is configured — the budget ' +
        'check has nothing to compare against without it.',
    );
  }

  const strategy = config.overflow?.strategy;
  if (strategy && combinesServerAndOnDemand(strategy)) {
    config.logger.warn(
      '[context-chef] server() and onDemandCompaction() are configured together, and neither ' +
        'reaches the provider here: an integration sends no server-side context_management and ' +
        'has no compiled request for an on-demand compaction, so each one only runs its ' +
        'fallback. Keep one of the two.',
    );
  }

  return dedupeConstructionWarnings(config.logger, (constructionLogger) =>
    buildJanitor(config, contextWindow, constructionLogger, onCompressionFired, appendOnly),
  );
}

/**
 * Surfaces the in-flight-without-persistence footgun: if compression keeps
 * firing but no `onCompress` is configured, the summary is discarded each
 * call and history re-expands, so every call over budget summarizes the whole
 * growing history again.
 *
 * Shared by every pooled Janitor so the fire count is per middleware
 * instance, not per session.
 */
function createPersistenceWarner<THostMessages>(
  config: JanitorPoolConfig<THostMessages>,
): () => void {
  let compressionsFired = 0;
  let warned = false;
  return () => {
    compressionsFired++;
    if (
      warned ||
      config.onCompress ||
      compressionsFired < COMPRESS_WITHOUT_PERSISTENCE_WARN_THRESHOLD
    ) {
      return;
    }
    warned = true;
    config.logger.warn(config.persistenceWarning(compressionsFired));
  };
}

/**
 * Builds one stateful Janitor.
 *
 * The Janitor config is a discriminated union on `tokenizer`. Build the two
 * branches separately so the literal type matches one of the union members
 * exactly — a single literal carrying `tokenizer: Fn | undefined` would not
 * narrow to either branch.
 */
function buildJanitor<THostMessages>(
  config: Omit<JanitorPoolConfig<THostMessages>, 'persistenceWarning'>,
  contextWindow: number,
  logger: ChefLogger,
  onCompressionFired: () => void,
  appendOnly: boolean,
): Janitor {
  const { onCompress, toHostMessages } = config;
  const sharedJanitorConfig = {
    contextWindow,
    strategy: config.overflow?.strategy,
    archive: config.overflow?.archive,
    triggerRatio: config.compress?.triggerRatio,
    minShrinkRatio: config.compress?.minShrinkRatio,
    toolResultStubThreshold: config.compress?.toolResultStubThreshold,
    compressionModel: config.compressionModel,
    // Always installed so every compression is counted for the persistence
    // warning; the host's hook is forwarded when configured.
    onCompress: (summary: Message, count: number, details: CompressionDetails) => {
      onCompressionFired();
      onCompress?.(summary.content, count, {
        compressedMessages: toHostMessages(details.compressedMessages),
        ...(details.replacement ? { replacement: toHostMessages(details.replacement) } : {}),
      });
    },
    onBeforeCompress: config.onBeforeCompress,
    logger,
    ...(appendOnly ? { estimate: estimateMessages } : {}),
  };

  let usagePreference = config.compress?.usagePreference;
  if (usagePreference === 'tokenizerFirst' && !config.tokenizer) {
    logger.warn(
      "[context-chef] compress.usagePreference: 'tokenizerFirst' requires a tokenizer. " +
        "Falling back to 'max'.",
    );
    usagePreference = 'max';
  }

  return config.tokenizer
    ? new Janitor({
        ...sharedJanitorConfig,
        tokenizer: (msgs: Message[]) => config.tokenizer?.(msgs) ?? 0,
        preserveRatio: config.compress?.preserveRatio ?? 0.8,
        usagePreference,
      })
    : new Janitor({
        ...sharedJanitorConfig,
        // 'tokenizerFirst' has been sanitized above; the cast narrows the
        // remaining values to the no-tokenizer branch.
        usagePreference: usagePreference as UsagePreferenceWithoutTokenizer | undefined,
      });
}
