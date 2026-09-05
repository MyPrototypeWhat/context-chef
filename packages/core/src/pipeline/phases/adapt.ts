import { anthropicServerContextManagement } from '../../adapters/anthropicAdapter';
import type { AnthropicPayload, TargetPayload } from '../../types';
import type { Phase } from '../context';

/**
 * Target adapter + tools + server-managed payload fields.
 */
export const adaptPhase: Phase = {
  name: 'adapt',
  async run(ctx, host) {
    for (const handler of host.slots.get('before-adapt')) {
      await handler(ctx.messages);
    }

    const adapterPayload = ctx.target.adapter.compile(ctx.messages);
    const tools = [...host.prunerTools(), ...ctx.memoryTools];

    const payload: TargetPayload = { ...adapterPayload, meta: ctx.meta };
    if (tools.length > 0) payload.tools = tools;

    // Server-side context management: on the server-managed (Anthropic)
    // target, carry the edits config + required beta headers in the payload.
    // What those two fields contain is the adapter layer's business.
    if (ctx.target.serverManaged) {
      const anthropicPayload = payload as AnthropicPayload;
      const { context_management, betas } = anthropicServerContextManagement(
        host.contextManagement?.server,
      );
      anthropicPayload.context_management = context_management;
      anthropicPayload.betas = betas;
    }

    ctx.payload = payload;

    for (const handler of host.slots.get('after-adapt')) {
      await handler(payload);
    }
  },
};
