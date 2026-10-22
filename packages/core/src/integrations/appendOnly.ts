import type { ChefLogger, ClearTarget } from '../types';

/**
 * How an integration names things in its `appendOnly` warnings.
 *
 * @internal
 */
export interface AppendOnlyWording {
  /** What the provider is reached through: `'model'`, `'adapter'`. */
  readonly provider: string;
  /** What a provider signs over the prefix: `'reasoning'`, `'thinking'`. */
  readonly thinking: string;
  /** Where the integration's options turn on the provider's own context editing, if they do. */
  readonly contextEditing?: string;
}

/**
 * The integration options the `appendOnly` warnings read.
 *
 * @internal
 */
export interface AppendOnlyOptions {
  readonly appendOnly?: boolean | { readonly clearAt?: boolean };
  readonly compact?: {
    readonly reasoning?: string;
    readonly toolCalls?: string | ReadonlyArray<{ readonly type: string }>;
  };
  readonly clear?: readonly ClearTarget[];
  /** The integration's hook over each call's request, after the conversation is recorded. */
  readonly transformContext?: unknown;
}

/**
 * `appendOnly` in a framework integration: the settings that cost what it is
 * for, warned once as the integration is created. `clearAt` has nothing to
 * act on there; a `compact` or `clear` cut that moves with the conversation
 * rewrites a message an earlier call sent on nearly every call; and
 * `transformContext` changes each request after the ledger recorded it,
 * where no checkpoint can see it. Nothing with `appendOnly` off.
 *
 * @internal
 */
export function warnAppendOnlyConfig(
  options: AppendOnlyOptions,
  logger: ChefLogger,
  wording: AppendOnlyWording,
): void {
  if (!options.appendOnly) return;
  if (typeof options.appendOnly === 'object' && options.appendOnly.clearAt) {
    logger.warn(
      '[context-chef] appendOnly: `clearAt` is ignored by the middleware. The provider behind ' +
        `the ${wording.provider} is unknown and may move a mid-conversation system message ` +
        'into the system prompt, so every event is a user message here, and a user message ' +
        'cannot be turn-scoped.',
    );
  }
  const moving = movingRewrites(options);
  if (moving.length > 0) {
    const editing = wording.contextEditing ? ` (${wording.contextEditing})` : '';
    logger.warn(
      `[context-chef] appendOnly: ${moving.join(', ')} ${moving.length > 1 ? 'move' : 'moves'} ` +
        'with the conversation, rewriting messages earlier calls sent, so nearly every call is a ' +
        "checkpoint: the provider's prefix cache misses from the rewritten message, and signed " +
        `${wording.thinking} is stripped from it on. Once a compression has landed, a rewrite ` +
        'that reaches a message it summarized also drops its summary, and the conversation is ' +
        "summarized again on every call. Use 'all', which rewrites each message once before it " +
        `is first sent, or the provider's own context editing${editing}.`,
    );
  }
  if (options.transformContext) {
    logger.warn(
      '[context-chef] appendOnly: `transformContext` runs on every call after the conversation ' +
        'is recorded, so whatever it adds or changes must come out byte-identical, at the same ' +
        `position, on every call: otherwise ${wording.thinking} signed over an earlier call is ` +
        'replayed over a prefix it was not signed over, and nothing reports it. Put content ' +
        'that changes from call to call in `dynamicState`, which is appended once, as an event.',
    );
  }
}

/** The `compact` / `clear` settings whose cut moves with the conversation, as written. */
function movingRewrites({ compact, clear }: AppendOnlyOptions): string[] {
  const moving: string[] = [];
  if (compact?.reasoning === 'before-last-message') {
    moving.push("compact.reasoning: 'before-last-message'");
  }
  const toolCalls = compact?.toolCalls;
  const types =
    typeof toolCalls === 'string' ? [toolCalls] : (toolCalls ?? []).map((entry) => entry.type);
  for (const type of types) {
    if (type.startsWith('before-last-')) moving.push(`compact.toolCalls: '${type}'`);
  }
  for (const target of clear ?? []) {
    if (typeof target === 'object' && target.keepRecent !== undefined) {
      moving.push(`clear: { target: '${target.target}', keepRecent: ${target.keepRecent} }`);
    }
  }
  return moving;
}

/**
 * An integration's `onPrefixBreak`, called so that a handler that throws
 * only warns: the call goes ahead.
 *
 * @internal
 */
export function prefixBreakReporter<TEvent>(
  onPrefixBreak: ((event: TEvent) => void) | undefined,
  logger: ChefLogger,
): (event: TEvent) => void {
  return (event) => {
    try {
      onPrefixBreak?.(event);
    } catch (error) {
      logger.warn('[context-chef] onPrefixBreak threw — the call goes ahead', error);
    }
  };
}
