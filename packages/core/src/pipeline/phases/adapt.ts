import {
  anthropicServerContextManagement,
  ON_DEMAND_COMPACTION_BETA,
} from '../../adapters/anthropicAdapter';
import type { AnthropicPayload, TargetPayload } from '../../types';
import type { Phase } from '../context';
import { reconcilePrefixSent, withoutStrippedThinking } from './prefix';

/** Whether two lists of host ranges hold the same ranges. */
const sameRanges = (
  a: ReadonlyArray<readonly [number, number]>,
  b: ReadonlyArray<readonly [number, number]>,
): boolean =>
  a.length === b.length && a.every(([from, until], i) => from === b[i][0] && until === b[i][1]);

/** `betas` with `more` added, each once. */
const withBetas = (betas: string[] | undefined, more: readonly string[]): string[] => [
  ...new Set([...(betas ?? []), ...more]),
];

/**
 * Target adapter + tools + server-managed payload fields.
 *
 * Under `appendOnly` on Anthropic, the adapter renders the messages without
 * the thinking unsigned checkpoints stripped, and the betas a replayed
 * signed compaction needs are added.
 */
export const adaptPhase: Phase = {
  name: 'adapt',
  async run(ctx, host) {
    for (const handler of host.slots.get('before-adapt')) {
      await handler(ctx.messages);
    }

    const render = () => ctx.target.adapter.compile(withoutStrippedThinking(ctx, ctx.messages));
    const adapterPayload = render();
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
      anthropicPayload.betas = withBetas(anthropicPayload.betas, betas);
    }
    // A signed compaction leads the window: the block it replays needs its beta.
    if (ctx.target.isAnthropicTarget && ctx.prefix?.ledger.head?.signed) {
      const anthropicPayload = payload as AnthropicPayload;
      anthropicPayload.betas = withBetas(anthropicPayload.betas, [ON_DEMAND_COMPACTION_BETA]);
    }

    ctx.payload = payload;
    // appendOnly: a changed system prompt or tool list is a checkpoint; then meta.prefix.
    const strippedBefore = ctx.prefix?.ledger.stripped ?? [];
    await reconcilePrefixSent(ctx, host);
    const prefix = ctx.prefix;
    if (
      prefix &&
      ctx.target.isAnthropicTarget &&
      !sameRanges(strippedBefore, prefix.ledger.stripped)
    ) {
      // That checkpoint stripped thinking signed over what was sent before: render without it.
      payload.messages = render().messages;
    }

    for (const handler of host.slots.get('after-adapt')) {
      await handler(payload);
    }
  },
};
