import type { Message } from '../../types';
import { checkAssembleInvariants } from '../checks';
import type { Phase } from '../context';

/**
 * Sandwich assembly, then the `after-assemble` slot.
 *
 * Guardrail messages (instructions + prefill) are applied from the stored
 * options at compile time, closest to generation — independent of
 * `setDynamicState` call order by design. Placement 'last_user' routes the
 * instructions through the Assembler tail instead (cache-safe on Anthropic,
 * where system-role messages are hoisted into the top-level prefix); only a
 * native prefill remains as a trailing assistant message in that mode.
 *
 * Under `appendOnly`, 'last_user' instructions become a user event the
 * `tail` phase appends when they change, and placement 'system' makes them
 * the last system layer: the Anthropic target hoisted them there anyway, and
 * Chat Completions no longer moves them down as the history grows. New
 * options are then a `system` checkpoint, like any other system prompt change.
 * On a target without native prefill, an unset `prefillMode` means
 * 'instruction' there: its adapter would append the prefill to whichever user
 * message is last, a different one every turn.
 */
export const assemblePhase: Phase = {
  name: 'assemble',
  async run(ctx, host) {
    let options = host.guardrailOptions;
    if (ctx.prefix && options?.prefill && !ctx.target.nativePrefill) {
      if (options.prefillMode === undefined) options = { ...options, prefillMode: 'instruction' };
      else if (options.prefillMode === 'native') {
        host.warnOnce(
          'append-only-native-prefill',
          "[context-chef] appendOnly: the guardrail's prefillMode 'native' on a target without " +
            'native prefill: its adapter folds the prefill into the last user message of each ' +
            'request, a different message every turn, so each request stops repeating the one ' +
            "before. Leave prefillMode unset or set 'instruction' (warned once).",
        );
      }
    }
    const nativePrefill = options?.prefillMode === 'instruction' ? undefined : options?.prefill;
    const guardrailLayer: Message[] = [];
    if (options?.placement === 'last_user') {
      ctx.guardrailMessages = host.guardrail.apply([], { prefill: nativePrefill });
      ctx.guardrailTailXml = host.guardrail.instructions(options);
    } else if (options && ctx.prefix) {
      const instructions = host.guardrail.instructions(options);
      if (instructions) guardrailLayer.push({ role: 'system', content: instructions });
      ctx.guardrailInSystemLayers = guardrailLayer.length > 0;
      ctx.guardrailMessages = host.guardrail.apply([], { prefill: nativePrefill });
    } else {
      ctx.guardrailMessages = options ? host.guardrail.apply([], options) : [];
      ctx.guardrailTailXml = '';
    }

    ctx.systemLayers = [
      ...host.systemPrompt,
      ...ctx.skillMessages,
      ...ctx.memoryMessages,
      ...guardrailLayer,
    ];
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
