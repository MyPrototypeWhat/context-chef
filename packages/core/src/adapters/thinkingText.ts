import type { ChefLogger, Message } from '../types';

/**
 * Degrades Anthropic-style thinking to a `<thinking>...</thinking>` text
 * prefix on the message content, so reasoning survives cross-provider replay
 * on targets with no native reasoning-input channel.
 *
 * Returns the content unchanged when the message carries no thinking.
 */
export type ThinkingTextifier = (
  content: string,
  source: Pick<Message, 'thinking' | 'redacted_thinking'>,
) => string;

/**
 * Builds the `preserveThinkingAsText` degradation used by the OpenAI and
 * Gemini targets — neither accepts reasoning as request input, so thinking is
 * either dropped or carried as text.
 *
 * `redacted_thinking` is never textified: it is an opaque encrypted blob that
 * only its issuing provider can read, so it is dropped with a warning logged
 * once per adapter instance (a long replay would otherwise warn per message).
 *
 * @param target Provider name used in the warning, e.g. `'OpenAI'`.
 */
export function createThinkingTextifier(target: string, logger?: ChefLogger): ThinkingTextifier {
  let redactedWarned = false;

  return (content, source) => {
    const out = source.thinking?.thinking
      ? `<thinking>\n${source.thinking.thinking}\n</thinking>\n\n${content ?? ''}`
      : content;

    if (source.redacted_thinking && !redactedWarned) {
      redactedWarned = true;
      (logger ?? console).warn(
        '[context-chef] redacted_thinking is an opaque encrypted blob and cannot be ' +
          `preserved as text — dropped on the ${target} target (warned once).`,
      );
    }

    return out;
  };
}
