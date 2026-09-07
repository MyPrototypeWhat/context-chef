import type { Phase } from '../context';

/** Final observation event. */
export const donePhase: Phase = {
  name: 'done',
  async run(ctx, host) {
    await host.emit('compile:done', { payload: ctx.requirePayload() }, ctx.signal);
  },
};
