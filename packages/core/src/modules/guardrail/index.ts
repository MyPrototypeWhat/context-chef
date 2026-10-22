import { Prompts } from '../../prompts';
import type { Message } from '../../types';

export interface GuardrailOptions {
  enforceXML?: {
    outputTag: string;
  };
  prefill?: string;
  /**
   * How `prefill` reaches the model:
   *
   * - `'native'` (default): a trailing assistant message the model continues
   *   from. Targets without native prefill (OpenAI, Gemini) turn it into an
   *   instruction on their own.
   * - `'instruction'`: never a trailing assistant message. An instruction to
   *   start the response with the prefill text travels with the enforce-XML
   *   instruction, wherever `placement` puts it. Claude Sonnet 4.6, Sonnet 5,
   *   Sonnet 5.5 and Haiku 5.5 reject a prefilled last assistant turn with a
   *   400, so use this mode for them. ContextChef does not know the model id
   *   and cannot choose for you.
   *
   * Unset, it is `'native'` — except with `ChefConfig.appendOnly` on a target
   * without native prefill, where it is `'instruction'`: the adapter would
   * append the instruction to whichever user message is last, a different one
   * every turn.
   */
  prefillMode?: 'native' | 'instruction';
  /**
   * Where the guardrail's instructions are delivered (the enforce-XML rules,
   * plus the prefill under `prefillMode: 'instruction'`):
   *
   * - `'system'` (default): a `role: 'system'` message at the sandwich tail.
   *   NOTE — on the Anthropic target every system-role message is hoisted
   *   into the top-level `system` parameter, so changing guardrail options
   *   invalidates any prompt-cache breakpoints downstream of it.
   * - `'last_user'`: injected into the last user message via the Assembler
   *   tail (same channel as dynamic state). Cache-safe on every provider —
   *   the tail segment is expected to change each turn anyway. The
   *   `<EPHEMERAL_MESSAGE>` wording was originally designed for exactly this
   *   user-stream delivery.
   *
   * A native `prefill` is unaffected: it is always a trailing assistant
   * message.
   *
   * With `ChefConfig.appendOnly`, `'system'` makes the instructions the last
   * system layer, where new options are a `system` checkpoint, and
   * `'last_user'` sends them as their own user message, appended once each
   * time the options change.
   */
  placement?: 'system' | 'last_user';
}

export class Guardrail {
  /**
   * Applies robust format guardrails and optional prefill to the dynamic state.
   * Uses the Claude Code-inspired EPHEMERAL_MESSAGE pattern for maximum compliance.
   */
  public apply(dynamicState: Message[], options: GuardrailOptions): Message[] {
    const state = [...dynamicState];
    const instructions = this.instructions(options);

    if (instructions) {
      // Combine with existing system message to avoid extra fragmentation
      if (state.length > 0 && state[0].role === 'system') {
        state[0] = {
          ...state[0],
          content: `${state[0].content}\n\n${instructions}`,
        };
      } else {
        state.push({ role: 'system', content: instructions });
      }
    }

    if (options.prefill && options.prefillMode !== 'instruction') {
      // Keep as assistant message internally.
      // Target adapters will degrade this for providers that don't support trailing assistant messages.
      state.push({ role: 'assistant', content: options.prefill });
    }

    return state;
  }

  /**
   * The guardrail's instruction text: the enforce-XML rules, and the prefill
   * when `prefillMode` is `'instruction'`. Empty when there is nothing to say.
   */
  public instructions(options: GuardrailOptions): string {
    const parts: string[] = [];
    if (options.enforceXML) {
      parts.push(Prompts.getXMLGuardrail(options.enforceXML.outputTag));
    }
    if (options.prefill && options.prefillMode === 'instruction') {
      parts.push(Prompts.getPrefillEnforcement(options.prefill));
    }
    return parts.join('\n\n');
  }
}
