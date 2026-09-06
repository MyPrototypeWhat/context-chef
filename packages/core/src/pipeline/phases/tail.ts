import { Assembler } from '../../modules/assembler';
import type { Message } from '../../types';
import { checkTailInvariants, tailInsertionIndex } from '../checks';
import type { Phase } from '../context';

/**
 * Tail stitch + announcements.
 *
 * Volatile content lands closest to the LLM generation point. The stitch is
 * composed in a fixed inner order — skill instructions, memory data, dynamic
 * state, implicit context, announcements, anchor — so callers reading the
 * final user message can rely on the layout.
 */
export const tailPhase: Phase = {
  name: 'tail',
  async run(ctx, host) {
    const { isAnthropicTarget } = ctx.target;
    // The handoff notice rides along as an announcement of this compile only —
    // same rendering, same channel resolution, no standing state.
    const announcementXml = host.resolveAnnouncementChannels(
      isAnthropicTarget,
      ctx.handoffNotice && [ctx.handoffNotice],
    );
    const tailParts = ctx.tailParts;

    // skillPlacement 'tail': standing mode instructions lead the stitch, so
    // the model reads "who you are right now" before the state it applies to.
    if (ctx.skillTailXml) {
      tailParts.push(ctx.skillTailXml);
    }
    if (ctx.memoryTailDataXml) {
      tailParts.push(ctx.memoryTailDataXml);
    }
    {
      let dynamicTailAdded = false;
      if (host.dynamicStatePlacement === 'last_user') {
        if (host.dynamicStateXml) {
          tailParts.push(host.dynamicStateXml);
          dynamicTailAdded = true;
        }
        if (ctx.implicitContextXml) {
          tailParts.push(ctx.implicitContextXml);
          dynamicTailAdded = true;
        }
      }
      // Announcements are system-state statements too, so they do trigger the
      // anchor — unlike skill instructions and memory data.
      if (announcementXml.tailXml) {
        tailParts.push(announcementXml.tailXml);
        dynamicTailAdded = true;
      }
      // The anchor refers specifically to dynamic state / implicit context /
      // announcements. Memory data already self-introduces via
      // `Prompts.MEMORY_BLOCK_HEADER` ("You recall the following from previous
      // conversations:"), and skill instructions are self-describing inside
      // their own tag, so an anchor for those alone is redundant and reads as
      // noise to the model. If `MEMORY_BLOCK_HEADER` is ever changed or
      // removed in `prompts.ts`, this suppression rule needs re-evaluating.
      if (dynamicTailAdded) {
        tailParts.push('Above is the current system state. Use it to guide your next action.');
      }
    }
    // Guardrail enforce-XML in 'last_user' placement: appended as the FINAL
    // tail element (after the anchor) — a standing output-format instruction,
    // not system state, so it sits closest to generation.
    if (ctx.guardrailTailXml) {
      tailParts.push(ctx.guardrailTailXml);
    }

    const preTail = ctx.messages;
    const tailXml = tailParts.join('\n\n');
    const rawPayload = host.assembler.compile(preTail, { tailXml: tailXml || undefined });

    // System-channel announcements: ONE positional system message placed after
    // the conversational tail of the ASSEMBLED result — deliberately after the
    // assembler ran, because the tail stitch either merged into the last user
    // message or added a new user message for a tool-result tail. Scanning the
    // result puts the announcement after that user content (a system message
    // following the user turn is the shape Anthropic documents) and still
    // before any trailing assistant prefill. Same last-user/tool scan the
    // Assembler uses; kept inline rather than widening the Assembler's
    // internal API.
    const assembled = [...rawPayload.messages];
    if (announcementXml.systemXml) {
      let tail = -1;
      for (let i = assembled.length - 1; i >= 0; i--) {
        if (assembled[i].role === 'user' || assembled[i].role === 'tool') {
          tail = i;
          break;
        }
      }
      if (tail !== -1) {
        assembled.splice(
          tail + 1,
          0,
          Assembler.orderKeysDeterministically<Message>({
            role: 'system',
            content: announcementXml.systemXml,
            _positional: true,
          }),
        );
      } else {
        // No conversational tail at all. The degrade below is an ANTHROPIC-only
        // constraint: a positional system message that precedes every user turn
        // is invalid on that API, and the adapter's hoist fallback would land
        // the volatile text back in the cacheable prefix (the exact failure
        // this channel exists to avoid). Other targets accept a leading inline
        // system message (OpenAI natively; Gemini via the adapter's user
        // degrade), so they keep the positional shape.
        let insertAt = assembled.length;
        while (insertAt > 0 && assembled[insertAt - 1].role === 'assistant') insertAt--;
        if (isAnthropicTarget) {
          host.warnOnce(
            'announcement-no-tail',
            '[context-chef] system-channel announcements need a conversational tail ' +
              '(a user or tool message) to attach after — none exists, and the Anthropic ' +
              'API rejects a leading mid-conversation system message, so the announcements ' +
              'were delivered as a user message instead (warned once).',
          );
          assembled.splice(
            insertAt,
            0,
            Assembler.orderKeysDeterministically<Message>({
              role: 'user',
              content: announcementXml.systemXml,
            }),
          );
        } else {
          assembled.splice(
            insertAt,
            0,
            Assembler.orderKeysDeterministically<Message>({
              role: 'system',
              content: announcementXml.systemXml,
              _positional: true,
            }),
          );
        }
      }
    }

    // Pre-flight the positional-system placement contract on the Anthropic
    // target so the diagnostic reaches THIS chef's logger, once per instance.
    // The adapter has its own console fallback warning, but the built-in
    // adapters are process-wide registry singletons — their warn-once fires
    // for the first chef in the process only, and ChefConfig.logger never
    // reaches them. Chef-injected announcements can't trip this (their
    // insertion point is always after a user/tool message); it catches
    // hand-written `_positional` messages in history.
    if (isAnthropicTarget && !host.hasWarned('positional-hoist')) {
      for (let i = 0; i < assembled.length; i++) {
        const msg = assembled[i];
        if (msg.role !== 'system' || !msg._positional) continue;
        // Walk back over ALL system messages, not just positional ones — this
        // mirrors the adapter, which never resets its user-turn tracking on a
        // system message (a hoisted non-positional system leaves the wire
        // stream, so adjacency to the user turn survives; consecutive
        // positional messages form one API section).
        let j = i - 1;
        while (j >= 0 && assembled[j].role === 'system') j--;
        const prev = assembled[j];
        if (prev && (prev.role === 'user' || prev.role === 'tool')) continue;
        host.warnOnce(
          'positional-hoist',
          '[context-chef] a positional system message is not immediately after a user turn — ' +
            'the Anthropic API rejects it there, so the adapter will hoist it into the ' +
            'top-level system prompt (its text then sits in the cacheable prefix; ' +
            'warned once).',
        );
        break;
      }
    }

    ctx.messages = assembled;

    if (host.pipelineChecks) {
      for (const violation of checkTailInvariants(
        preTail,
        assembled,
        tailInsertionIndex(preTail),
      )) {
        await host.reportInvariant('tail', violation, ctx.signal);
      }
    }
  },
};
