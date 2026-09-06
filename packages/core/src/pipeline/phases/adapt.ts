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
    // The two library-owned tool sets never co-exist in one payload: they
    // describe the same operations in two vocabularies, and a model handed
    // both has to guess which one the host actually dispatches.
    //
    // @deprecated The `legacy` branch emits Memory's `create_memory` /
    //   `modify_memory`. Set `tools: 'unified'` for the `context` tool, which
    //   reaches `notes/`, `vfs/` and `archive/` as well. `legacy` is removed
    //   in 5.0, when `'unified'` becomes the default.
    const libraryTools = host.toolsMode === 'unified' ? host.contextTools() : ctx.memoryTools;
    const tools = [...host.prunerTools(), ...libraryTools];

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
