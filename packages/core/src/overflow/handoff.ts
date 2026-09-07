/**
 * The handoff budget: the last turn before the window is cut.
 *
 * Overflow is mechanical — whatever a strategy evicts is gone from the window
 * whether or not the model was ready for it. The handoff budget reserves a
 * slice of headroom above the trigger and spends it on one notice, so the
 * model can write what matters into the context store while it still has the
 * conversation in front of it.
 */

import { Prompts } from '../prompts';
import type { HandoffConfig } from './types';

/** Substituted with the headroom left before the trigger, everywhere it appears. */
export const HANDOFF_REMAINING_PLACEHOLDER = '{n_remaining}';

/** A notice longer than this stops being a nudge and starts being context cost. */
const MAX_PROMPT_BYTES = 2000;

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Checks `overflow.handoff` and fills in the default prompt.
 *
 * Called at chef construction: a handoff budget that cannot work is a
 * configuration mistake, and the compile that would silently skip the notice
 * happens far away from the line that caused it. Throws with the offending
 * value in the message.
 */
export function validateHandoffConfig(config: HandoffConfig): Required<HandoffConfig> {
  const { budgetTokens } = config;
  if (!Number.isInteger(budgetTokens) || budgetTokens <= 0) {
    throw new Error(
      `[context-chef] overflow.handoff.budgetTokens must be a positive integer — received ${JSON.stringify(
        budgetTokens,
      )}. It is the headroom above the compression trigger reserved for the handoff notice, e.g. 2000.`,
    );
  }

  if (config.prompt === undefined) {
    return { budgetTokens, prompt: Prompts.HANDOFF_NOTICE_TEMPLATE };
  }

  const prompt = config.prompt.trim();
  if (prompt === '') {
    throw new Error(
      '[context-chef] overflow.handoff.prompt is empty. Omit it to use the built-in notice ' +
        '(Prompts.HANDOFF_NOTICE_TEMPLATE), or pass the text the model should see.',
    );
  }
  const bytes = utf8Bytes(prompt);
  if (bytes > MAX_PROMPT_BYTES) {
    throw new Error(
      `[context-chef] overflow.handoff.prompt is ${bytes} UTF-8 bytes, over the ${MAX_PROMPT_BYTES}-byte cap. ` +
        'The notice is injected into the tail of every compile that enters the handoff band — ' +
        'keep it to the instruction, and put the details in the system prompt.',
    );
  }
  return { budgetTokens, prompt };
}

/**
 * Renders the notice for one compile.
 *
 * `remaining` is rounded to a whole token and clamped at 0: it is read off the
 * budget the runner computes, which can be fractional (`limit * triggerRatio`)
 * and goes negative once the history is already over the trigger — and
 * "-1400 tokens remain" reads as nonsense to the model that has to act on it.
 */
export function renderHandoffNotice(prompt: string, remaining: number): string {
  const tokens = Math.max(0, Math.round(remaining));
  return prompt.split(HANDOFF_REMAINING_PLACEHOLDER).join(String(tokens));
}
