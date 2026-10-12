import type { Phase } from '../context';
import { commitPrefix } from './prefix';

/** The append-only ledger's commit, then the final observation event. */
export const donePhase: Phase = {
  name: 'done',
  async run(ctx, host) {
    commitPrefix(ctx);
    await host.emit('compile:done', { payload: ctx.requirePayload() }, ctx.signal);
  },
};
