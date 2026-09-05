/**
 * `summarize()` — replace the oldest turns with an LLM summary.
 *
 * The 4.x default overflow policy (`janitor.compressionMode: 'rewrite'`), and
 * the engine behind `anchored()`: the two differ only in which instruction the
 * compression model gets and whether the result is merged into a persistent
 * anchor document.
 */

import { Prompts } from '../prompts';
import type { Message } from '../types';
import { renderSummaryMessage, summarizeHistory } from './summary';
import { groupIntoTurns, type Turn } from './turns';
import {
  detachedRunner,
  type OverflowInput,
  type OverflowResult,
  type OverflowRunner,
  type OverflowStrategy,
  unchanged,
} from './types';

const DEFAULT_PRESERVE_RATIO = 0.8;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 1;
/**
 * A compression result must shrink the compressed span's character length by
 * at least this ratio by default, or it is treated as a failed compression.
 * Guards against the "compression that doesn't shrink" death loop observed in
 * production agents (each turn re-triggers compression, costs grow unbounded).
 */
const DEFAULT_MIN_SHRINK_RATIO = 0.5;
/**
 * The shrink guard only applies to spans at least this long. A tiny span
 * cannot meaningfully shrink below a well-formed summary's natural length,
 * and the death-loop scenario the guard prevents only occurs on large spans.
 */
const MIN_SHRINK_GUARD_SPAN_CHARS = 2000;

/**
 * How the boundary between "summarize" and "keep verbatim" is chosen. Both
 * cut on turn boundaries — only the size of the preserved tail differs.
 *
 * - `'ratio'`: keep as many recent turns as fit in
 *   `budget.trigger * preserveRatio` tokens. Needs a real tokenizer to be
 *   meaningful (the runner supplies its own, or a heuristic).
 * - `'recent-turns'`: keep the last `preserveRecentMessages` turns, whatever
 *   they cost. The right choice when token counts come from the provider
 *   (`feedTokenUsage`) rather than a local tokenizer.
 */
export type SplitMode = 'ratio' | 'recent-turns';

export interface SummarizeOptions {
  /**
   * Async hook to call a low-cost LLM (e.g. gpt-4o-mini) to summarize the
   * evicted span. Without one the span is dropped: the messages leave the
   * window and only the runner's `onCompress` sees a placeholder summary.
   *
   * Contract: may reject. A rejection counts toward the runner's circuit
   * breaker and leaves history unchanged.
   */
  compressionModel?: (messagesToCompress: Message[]) => Promise<string>;
  /**
   * Structured domain guidelines appended (numbered) to the compression
   * prompt, after the default scaffolding and before
   * `customCompressionInstructions`.
   */
  compressionGuidelines?: string[];
  /**
   * Additional focused instructions appended to the default compression
   * prompt. Does NOT replace the default — the scaffolding that enforces the
   * `<analysis>`/`<summary>` contract is always preserved.
   */
  customCompressionInstructions?: string;
  /**
   * A compression result must shrink the compressed span's character length
   * by at least this ratio (0–1, default 0.5). Set to 0 to disable the check.
   */
  minShrinkRatio?: number;
  /**
   * Post-summarization validation gate. Return `false` to REJECT the summary:
   * rejection is treated as a compression failure (history unchanged, circuit
   * breaker incremented). A throwing/rejecting hook is treated as `false`
   * with a logged warning.
   */
  validateCompression?: (
    summary: string,
    info: { compressed: Message[]; kept: Message[] },
  ) => boolean | Promise<boolean>;
  /**
   * [`split: 'ratio'`] Fraction of the trigger budget to preserve for recent
   * turns. Default 0.8.
   */
  preserveRatio?: number;
  /**
   * [`split: 'recent-turns'`] Number of recent turns to keep. A "turn" is an
   * atomic unit: a single message, or an assistant with tool_calls plus all
   * its subsequent tool results. Default 1.
   */
  preserveRecentMessages?: number;
  /**
   * Replace tool-result content longer than this many characters with a
   * one-line metadata stub before the span is sent to the compression model.
   * Only affects what the model sees. Default: disabled.
   */
  toolResultStubThreshold?: number;
  /**
   * Which split rule to use. Defaults to `'recent-turns'` when
   * `preserveRecentMessages` is the only preserve option given, `'ratio'`
   * otherwise.
   */
  split?: SplitMode;
}

/**
 * The anchor document of `anchored()`: a summary that is merged into, rather
 * than rewritten, on every compression. Its own object so the summarizing
 * engine can treat "no anchor" as absence rather than a mode flag.
 */
export class AnchorDocument {
  value: string | null = null;
}

/**
 * The engine behind {@link summarize} and `anchored()`.
 *
 * @internal Construct it through the factories — they are the public surface.
 */
export class SummarizingStrategy implements OverflowStrategy {
  private runner: OverflowRunner = detachedRunner;
  /**
   * Anchor updates waiting for {@link commit} — a result computed by a
   * background job may never enter the window, and one that doesn't must
   * leave the anchor untouched.
   */
  private readonly pendingAnchor = new WeakMap<OverflowResult, string>();

  constructor(
    readonly name: string,
    private readonly options: SummarizeOptions,
    /** Non-null in anchored mode. */
    private readonly anchor: AnchorDocument | null = null,
  ) {}

  attach(runner: OverflowRunner): void {
    this.runner = runner;
  }

  commit(result: OverflowResult): void {
    const anchorUpdate = this.pendingAnchor.get(result);
    if (anchorUpdate !== undefined && this.anchor) this.anchor.value = anchorUpdate;
  }

  snapshot(): unknown {
    return this.anchor ? { anchorDoc: this.anchor.value } : undefined;
  }

  restore(state: unknown): void {
    if (!this.anchor) return;
    const anchorDoc = (state as { anchorDoc?: string | null } | undefined)?.anchorDoc;
    this.anchor.value = anchorDoc ?? null;
  }

  async apply(input: OverflowInput): Promise<OverflowResult> {
    const { history } = input;
    const splitIndex = this.splitIndex(input);
    if (splitIndex === null || splitIndex <= 0) {
      return unchanged(input, this.name, 'no turn boundary above the preserved tail');
    }

    const toCompress = history.slice(0, splitIndex);
    const toKeep = history.slice(splitIndex);

    // Pinned (turn-scoped) messages survive verbatim in all outcomes below.
    // The split lands on a turn boundary, so a turn is never half-pinned.
    const pinnedSet = new Set(input.pinned);
    const pinnedInSpan = toCompress.filter((m) => pinnedSet.has(m));
    const evicted =
      pinnedInSpan.length === 0 ? toCompress : toCompress.filter((m) => !pinnedSet.has(m));
    const meta = { strategy: this.name, windowId: input.window.current, changed: true };

    // No compression model: drop the span, keeping pinned messages. The
    // runner reports the boundary through `onCompress` with a placeholder
    // summary — nothing is inserted into history.
    if (!this.options.compressionModel) {
      return { history: [...pinnedInSpan, ...toKeep], evicted, meta };
    }

    const summary = await this.summarizeSpan(toCompress, toKeep);
    if (summary === null) {
      return unchanged(input, this.name, 'compression rejected — history left unchanged');
    }

    const result: OverflowResult = {
      history: [renderSummaryMessage(summary), ...pinnedInSpan, ...toKeep],
      evicted,
      summary,
      meta,
    };
    // The anchor moves in `commit`, not here: a background job discarded as
    // stale computed this summary but never put it in the window, and it must
    // not pollute the anchor the next compression builds on.
    if (this.anchor) this.pendingAnchor.set(result, summary);
    return result;
  }

  /**
   * Where to cut, on a turn boundary. `null` means "nothing worth
   * compressing" — the preserved tail already covers the whole history.
   */
  private splitIndex(input: OverflowInput): number | null {
    const turns = groupIntoTurns(input.history);
    if (turns.length === 0) return null;
    return this.resolveSplit() === 'ratio'
      ? this.ratioSplit(input, turns)
      : this.recentTurnsSplit(turns);
  }

  private resolveSplit(): SplitMode {
    if (this.options.split) return this.options.split;
    return this.options.preserveRatio === undefined &&
      this.options.preserveRecentMessages !== undefined
      ? 'recent-turns'
      : 'ratio';
  }

  /**
   * Iterate turns from the tail, accumulating token costs per turn, until the
   * preserve budget is exhausted. `preserveRatio` applies to the effective
   * trigger budget (not the raw window) so post-compression usage lands safely
   * below the trigger point (no compress-every-turn thrash).
   */
  private ratioSplit(input: OverflowInput, turns: Turn[]): number | null {
    const preserveTarget = Math.floor(
      input.budget.trigger * (this.options.preserveRatio ?? DEFAULT_PRESERVE_RATIO),
    );

    let accumulatedTokens = 0;
    let splitTurn = turns.length;

    for (let t = turns.length - 1; t >= 0; t--) {
      const turnMessages = input.history.slice(turns[t].startIndex, turns[t].endIndex);
      const turnTokens = input.tokenizer(turnMessages);
      if (accumulatedTokens + turnTokens > preserveTarget) {
        break;
      }
      accumulatedTokens += turnTokens;
      splitTurn = t;
    }

    // Keep at least 1 turn if a single turn exceeds the preserve budget
    if (splitTurn === turns.length) {
      splitTurn = turns.length - 1;
    }

    if (splitTurn <= 0) return null;
    return turns[splitTurn].startIndex;
  }

  /** Keep the last N turns (not messages), compress everything else. */
  private recentTurnsSplit(turns: Turn[]): number | null {
    const keepCount = Math.min(
      this.options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES,
      turns.length,
    );
    const splitTurn = turns.length - keepCount;
    if (splitTurn <= 0) return null;
    return turns[splitTurn].startIndex;
  }

  /**
   * Produce the summary for a compressed span, applying the quality guards.
   *
   * Returns null on ANY failure — model throw, shrink-guard rejection, or
   * validateCompression rejection. Every failure is reported to the runner
   * (warning + circuit breaker) and leaves history for the caller to return
   * UNCHANGED (never a lossy placeholder truncation — the pre-4.0 behavior of
   * dropping the span with a bare notice applied only to the model-throw path
   * and made a bad situation worse).
   */
  private async summarizeSpan(toCompress: Message[], toKeep: Message[]): Promise<string | null> {
    const compressionModel = this.options.compressionModel;
    if (!compressionModel) return null;
    const anchor = this.anchor;

    // ── Model call
    let summaryText: string;
    try {
      summaryText = await summarizeHistory(toCompress, compressionModel, {
        customCompressionInstructions: this.options.customCompressionInstructions,
        toolResultStubThreshold: this.options.toolResultStubThreshold,
        compressionGuidelines: this.options.compressionGuidelines,
        baseInstruction: anchor
          ? Prompts.getAnchoredCompactionInstruction(anchor.value)
          : undefined,
      });
    } catch (error) {
      this.runner.fail('compression model failed', error);
      return null;
    }

    // ── Shrink guard: a summary that doesn't shrink the span is a failure.
    //    Only applied to spans >= MIN_SHRINK_GUARD_SPAN_CHARS — tiny spans
    //    can't shrink below a well-formed summary's natural length, and the
    //    death loop this prevents only occurs on large spans.
    //    Span size counts everything the summarizer consumes: content,
    //    thinking, AND tool-call arguments (write/edit tools routinely carry
    //    the bulk of a coding-agent span in `arguments`).
    //    Anchored mode compares GROWTH, not absolute size — the anchor is
    //    cumulative, so comparing it against only the newly evicted span
    //    would inevitably trip the breaker in healthy long sessions.
    const minShrink = this.options.minShrinkRatio ?? DEFAULT_MIN_SHRINK_RATIO;
    if (minShrink > 0) {
      const spanChars = toCompress.reduce(
        (sum, m) =>
          sum +
          m.content.length +
          (m.thinking?.thinking.length ?? 0) +
          (m.tool_calls?.reduce((s, tc) => s + tc.function.arguments.length, 0) ?? 0),
        0,
      );
      const allowance = (1 - minShrink) * spanChars;
      const effectiveSize = anchor
        ? summaryText.length - (anchor.value?.length ?? 0)
        : summaryText.length;
      if (spanChars >= MIN_SHRINK_GUARD_SPAN_CHARS && effectiveSize > allowance) {
        this.runner.fail(
          `compression result failed the shrink guard (${anchor ? 'anchor growth' : 'summary'} ` +
            `${effectiveSize} chars vs span ${spanChars} chars, minShrinkRatio ${minShrink})`,
        );
        return null;
      }
    }

    // ── Validation gate
    if (this.options.validateCompression) {
      let valid: boolean;
      try {
        valid = await this.options.validateCompression(summaryText, {
          compressed: toCompress,
          kept: toKeep,
        });
      } catch (error) {
        this.runner.logger.warn(
          '[context-chef] validateCompression threw — treating the summary as rejected',
          error,
        );
        valid = false;
      }
      if (!valid) {
        this.runner.fail('compression summary rejected by validateCompression');
        return null;
      }
    }

    // Success is a model-health signal — a later stale discard doesn't change
    // that the model succeeded.
    this.runner.succeed();
    return summaryText;
  }
}

/**
 * Replaces the oldest turns with an LLM summary of them, keeping recent turns
 * verbatim. The 4.x default.
 *
 * @example
 * new ContextChef({
 *   janitor: { contextWindow: 128_000, tokenizer },
 *   overflow: { strategy: summarize({ compressionModel: summarizeWithHaiku }) },
 * });
 */
export function summarize(options: SummarizeOptions = {}): OverflowStrategy {
  return new SummarizingStrategy('summarize', options);
}
