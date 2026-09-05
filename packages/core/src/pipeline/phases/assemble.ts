import { Prompts } from '../../prompts';
import type { Message } from '../../types';
import { checkAssembleInvariants } from '../checks';
import type { Phase } from '../context';

/**
 * Sandwich assembly, then the `after-assemble` slot.
 *
 * Guardrail messages (enforce-XML instruction + prefill) are applied from the
 * stored options at compile time, closest to generation — independent of
 * `setDynamicState` call order by design. Placement 'last_user' routes the
 * enforce-XML text through the Assembler tail instead (cache-safe on
 * Anthropic, where system-role messages are hoisted into the top-level
 * prefix); only the prefill remains as a trailing assistant message in that
 * mode.
 */
export const assemblePhase: Phase = {
  name: 'assemble',
  async run(ctx, host) {
    const options = host.guardrailOptions;
    const guardrailTailMode = options?.placement === 'last_user';
    ctx.guardrailMessages = options
      ? host.guardrail.apply(
          [],
          guardrailTailMode ? { ...options, enforceXML: undefined } : options,
        )
      : [];
    ctx.guardrailTailXml =
      guardrailTailMode && options?.enforceXML
        ? Prompts.getXMLGuardrail(options.enforceXML.outputTag)
        : '';

    ctx.systemLayers = [...host.systemPrompt, ...ctx.skillMessages, ...ctx.memoryMessages];
    ctx.messages = [
      ...ctx.systemLayers,
      ...ctx.history,
      ...ctx.dynamicState,
      ...ctx.guardrailMessages,
    ];

    const handlers = host.slots.get('after-assemble');
    if (handlers.length === 0) return;

    const beforeHandlers: Message[] = host.pipelineChecks ? [...ctx.messages] : [];
    for (const handler of handlers) {
      ctx.messages = await handler(ctx.messages);
    }
    if (host.pipelineChecks) {
      for (const violation of checkAssembleInvariants(beforeHandlers, ctx.messages)) {
        await host.reportInvariant('assemble', violation, ctx.signal);
      }
    }
  },
};
