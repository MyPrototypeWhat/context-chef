import type { Phase } from '../context';
import type { BeforeAssembleContext } from '../slots';

/**
 * `before-assemble` slot: inject externally-retrieved context (RAG, AST, MCP,
 * …) as `<implicit_context>`, without touching the caller's message array.
 * Runs after overflow so handlers see the history the model will actually get.
 */
export const injectPhase: Phase = {
  name: 'inject',
  async run(ctx, host) {
    const handlers = host.slots.get('before-assemble');
    if (handlers.length > 0) {
      const injected: string[] = [];
      const slotContext: BeforeAssembleContext = {
        systemPrompt: host.systemPrompt,
        history: ctx.history,
        dynamicState: host.dynamicState,
        dynamicStateXml: host.dynamicStateXml,
        inject(text: string) {
          if (text) injected.push(text);
        },
      };
      for (const handler of handlers) {
        await handler(slotContext);
      }
      if (injected.length > 0) {
        ctx.implicitContextXml = `<implicit_context>\n${injected.join('\n\n')}\n</implicit_context>`;
      }
    }

    // appendOnly: both reach the window as events the `tail` phase appends —
    // dynamic state on its placement's channel, implicit context on the user
    // channel — so neither becomes a system message after the history here.
    if (ctx.prefix) return;

    // For system placement, append implicit_context directly to the dynamic
    // state message (the Assembler only handles last_user injection).
    let dynamicState = host.dynamicState;
    if (
      ctx.implicitContextXml &&
      host.dynamicStatePlacement === 'system' &&
      dynamicState.length > 0
    ) {
      const implicitContextXml = ctx.implicitContextXml;
      dynamicState = dynamicState.map((msg) =>
        msg.content.includes('CURRENT TASK STATE')
          ? { ...msg, content: `${msg.content}\n${implicitContextXml}` }
          : msg,
      );
    }
    ctx.dynamicState = dynamicState;
  },
};
