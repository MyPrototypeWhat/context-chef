import { Prompts } from '../../prompts';
import type { Message } from '../../types';

export interface GovernanceOptions {
  enforceXML?: {
    outputTag: string;
  };
  prefill?: string;
}

export class Governor {
  /**
   * Applies robust format guardrails and optional prefill to the dynamic state.
   * Uses the Claude Code-inspired EPHEMERAL_MESSAGE pattern for maximum compliance.
   */
  public applyGovernance(dynamicState: Message[], options: GovernanceOptions): Message[] {
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
