/**
 * `server()` — let the provider compact, when the provider can.
 */

import { type OverflowInput, type OverflowResult, type OverflowStrategy, unchanged } from './types';

/**
 * The strategy the pipeline recognises as "the provider owns overflow".
 * Chef reads `config` off it to build the payload's `context_management`
 * block, which is why the config travels on the strategy rather than in a
 * closure.
 */
export interface ServerOverflowStrategy extends OverflowStrategy {
  readonly kind: 'server';
  /** Provider-shaped edits config, passed through to the payload verbatim. */
  readonly config: unknown;
  /** What runs on targets with no server-side context management. */
  readonly fallback?: OverflowStrategy;
}

export function isServerStrategy(strategy: OverflowStrategy): strategy is ServerOverflowStrategy {
  return (strategy as ServerOverflowStrategy).kind === 'server';
}

/**
 * Delegates overflow to the provider's server-side context management.
 *
 * On a target that implements it (today: Anthropic, `compact_20260112`) the
 * client never compresses: the compile pipeline skips the overflow phase and
 * the adapt phase attaches `context_management` + the matching beta headers.
 * One model call fewer and exact token accounting.
 *
 * On every other target this strategy has nothing to delegate to, so it runs
 * `fallback` — that is what makes one configuration portable across providers.
 * Without a fallback the history is left alone.
 *
 * @param config Provider-shaped edits config, e.g.
 *   `{ edits: [{ type: 'compact_20260112', trigger: {...} }] }`. Omitted, the
 *   provider's default single-compaction config is emitted.
 * @example
 * overflow: { strategy: server(undefined, { fallback: summarize({ compressionModel }) }) }
 */
export function server(
  config?: unknown,
  options: { fallback?: OverflowStrategy } = {},
): ServerOverflowStrategy {
  const { fallback } = options;
  return {
    kind: 'server',
    name: fallback ? `server(fallback: ${fallback.name})` : 'server',
    config,
    fallback,
    async apply(input: OverflowInput): Promise<OverflowResult> {
      // Reaching apply() means the target is NOT server-managed: the pipeline
      // skips the overflow phase entirely when it is.
      if (!fallback) {
        return unchanged(
          input,
          'server',
          'the compile target has no server-side context management, and no fallback strategy is configured',
        );
      }
      return fallback.apply(input);
    },
    commit: (result) => fallback?.commit?.(result),
    pending: () => fallback?.pending?.() === true,
    snapshot: () => fallback?.snapshot?.(),
    restore: (state) => fallback?.restore?.(state),
    attach: (runner) => fallback?.attach?.(runner),
  };
}
