import { adapterRegistry } from '../../adapters/adapterRegistry';
import { AnthropicAdapter } from '../../adapters/anthropicAdapter';
import type { Phase } from '../context';

/**
 * `compile:start` + abort check + target resolution.
 *
 * The event is emitted unconditionally — observers may want to log even
 * aborted compiles. `throwIfAborted` runs immediately after so the expensive
 * overflow phase is skipped on a pre-aborted signal.
 */
export const startPhase: Phase = {
  name: 'start',
  async run(ctx, host) {
    await host.emit(
      'compile:start',
      { systemPrompt: host.systemPrompt, history: host.history },
      ctx.signal,
    );
    ctx.signal?.throwIfAborted();

    // Resolve the target adapter up front — the server-side context
    // management decision below is per-target.
    const target = ctx.options.target ?? host.defaultTarget ?? 'openai';
    const adapter = typeof target === 'string' ? adapterRegistry.get(target) : target;
    const isAnthropicTarget = target === 'anthropic' || adapter instanceof AnthropicAdapter;
    const serverManaged = host.contextManagement?.strategy === 'server' && isAnthropicTarget;
    if (host.contextManagement?.strategy === 'server' && !isAnthropicTarget) {
      host.warnOnce(
        'server-fallback',
        "[context-chef] contextManagement.strategy 'server' is configured, but the current " +
          'compile target has no server-side context management implementation — falling back ' +
          'to client-side compression for this target. Only the Anthropic target is server-managed.',
      );
    }

    ctx.target = { adapter, isAnthropicTarget, serverManaged };
  },
};
