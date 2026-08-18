import { Prompts } from '../../prompts';
import type { Message } from '../../types';

export interface GuardrailOptions {
  enforceXML?: {
    outputTag: string;
  };
  prefill?: string;
  /**
   * Where the enforce-XML instruction is delivered:
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
   * `prefill` is unaffected: it is always a trailing assistant message
   * (degraded by adapters without native prefill).
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

    if (options.enforceXML) {
      const tag = options.enforceXML.outputTag;
      const instructions = Prompts.getXMLGuardrail(tag);

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

    if (options.prefill) {
      // Keep as assistant message internally.
      // Target adapters will degrade this for providers that don't support trailing assistant messages.
      state.push({ role: 'assistant', content: options.prefill });
    }

    return state;
  }
}
