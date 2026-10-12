import type { AnnouncementChannel } from '../../chef';
import { Assembler } from '../../modules/assembler';
import {
  eventAnchor,
  followsUserTurn,
  type PrefixCandidate,
  type PrefixEntry,
  type PushSource,
  renderGroup,
  sourceEvents,
} from '../../prefix';
import { Prompts } from '../../prompts';
import type { Message } from '../../types';
import { announcementChannel, renderAnnouncement } from '../announcements';
import { checkTailInvariants, tailInsertionIndex } from '../checks';
import type { CompileContext, Phase, PipelineHost, PrefixCompile } from '../context';
import { escapeXmlAttribute } from '../xml';

/**
 * Tail stitch + announcements.
 *
 * Volatile content lands closest to the LLM generation point, composed in a
 * fixed inner order — skill instructions, memory data, dynamic state,
 * implicit context, announcements, anchor, guardrail — so callers reading the
 * final user message can rely on the layout. Under `appendOnly` the same
 * sources become events, appended in the same order only when they changed;
 * the `skill` and `memory` phases decide theirs.
 */
export const tailPhase: Phase = {
  name: 'tail',
  async run(ctx, host) {
    const { isAnthropicTarget } = ctx.target;
    const preTail = ctx.messages;
    const assembled = ctx.prefix ? appendEvents(ctx, host, ctx.prefix) : stitchTail(ctx, host);

    // Pre-flight the positional-system placement contract on the Anthropic
    // target so the diagnostic reaches THIS chef's logger, once per instance.
    // The adapter has its own console fallback warning, but the built-in
    // adapters are process-wide registry singletons — their warn-once fires
    // for the first chef in the process only, and ChefConfig.logger never
    // reaches them. Chef-injected announcements can't trip this (their
    // insertion point is always after a user/tool message, and an appendOnly
    // event with none before it is said as a user message); it catches
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

/** The 4.x tail: one stitch merged into (or after) the last user turn, every compile. */
function stitchTail(ctx: CompileContext, host: PipelineHost): Message[] {
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
    // announcements. Memory data already self-introduces via the active
    // vocabulary's `memoryBlockHeader` (legacy: "You recall the following
    // from previous conversations:"; unified: "Memory (context://memory/*)
    // currently holds:"), and skill instructions are self-describing inside
    // their own tag, so an anchor for those alone is redundant and reads as
    // noise to the model. Every Vocabulary must keep a self-introducing
    // header — the cache audit derives its memory markers from the same
    // field, so the two stay in step by construction.
    if (dynamicTailAdded) {
      tailParts.push(Prompts.STATE_ANCHOR);
    }
  }
  // Guardrail enforce-XML in 'last_user' placement: appended as the FINAL
  // tail element (after the anchor) — a standing output-format instruction,
  // not system state, so it sits closest to generation.
  if (ctx.guardrailTailXml) {
    tailParts.push(ctx.guardrailTailXml);
  }

  const tailXml = tailParts.join('\n\n');
  const rawPayload = host.assembler.compile(ctx.messages, { tailXml: tailXml || undefined });

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
  return assembled;
}

const ANNOUNCEMENT = 'announcement:';

const announcementSource = (id: string, current?: PushSource['current']): PushSource => ({
  source: `${ANNOUNCEMENT}${id}`,
  current,
  tombstone: (rev) =>
    Prompts.getWithdrawnBlock(
      'announcement',
      rev,
      Prompts.ANNOUNCEMENT_WITHDRAWN,
      escapeXmlAttribute(id),
    ),
});

/**
 * The guardrail at 'last_user' is an instruction, not state: no anchor line,
 * but a restatement says it replaces the one before. When the instructions
 * leave the user channel — cleared, or moved into the system layers — the
 * event sent earlier is withdrawn, pointing at the system prompt in the
 * second case.
 */
function guardrailSource(ctx: CompileContext): PushSource {
  const instructions = ctx.guardrailTailXml;
  return {
    source: 'guardrail',
    current: instructions
      ? { channel: 'user', render: (rev) => Prompts.getOutputFormatEvent(instructions, rev) }
      : undefined,
    tombstone: (rev) =>
      Prompts.getWithdrawnBlock(
        'output_format',
        rev,
        ctx.guardrailInSystemLayers ? Prompts.GUARDRAIL_MOVED : Prompts.GUARDRAIL_WITHDRAWN,
      ),
  };
}

/**
 * `messages` with the event group at the end of the window — `before`, as
 * the `prefix` phase rendered it — replaced by `after`, the same group with
 * this compile's `events` in it. Only `trailing` messages follow that group:
 * the prefill the history ends with, if any, then the guardrail's. If an
 * `after-assemble` handler moved or rewrote the group, only `events` go in
 * front of those, so nothing it left is sent twice.
 */
function replaceEventGroup(
  messages: Message[],
  trailing: number,
  before: Message[],
  after: Message[],
  events: readonly PrefixCandidate[],
  host: PipelineHost,
): Message[] {
  const end = Math.max(0, messages.length - trailing);
  const start = end - before.length;
  const found =
    start >= 0 &&
    before.every(
      (message, i) =>
        Assembler.stringifyPayload(messages[start + i]) === Assembler.stringifyPayload(message),
    );
  if (found) return [...messages.slice(0, start), ...after, ...messages.slice(end)];

  host.warnOnce(
    'append-only-events-moved',
    '[context-chef] appendOnly: an after-assemble handler moved or rewrote the events at the ' +
      "end of the window, so this compile's new events were added there on their own. " +
      'The payload no longer matches the window the ledger records, so the next compile may ' +
      'not start with it (warned once).',
  );
  const added = renderGroup(
    events,
    followsUserTurn(end, (i) => messages[i].role.charAt(0)),
  );
  return [...messages.slice(0, end), ...added, ...messages.slice(end)];
}

/**
 * `appendOnly`: each push source is compared with the last thing the window
 * holds from it, and only what changed is appended — at the end of the host
 * history, or before the assistant prefill it ends with — in the stitch's
 * order: skill instructions, memory, dynamic state, implicit context,
 * announcements, the anchor line on each channel that carried state, the
 * guardrail. Events never merge into a host message: the ledger renders
 * everything appended at one place as one user message and one positional
 * system message, and that group replaces the one the `prefix` phase
 * rendered there.
 *
 * With `clearAt` on Anthropic, the system-channel sources are turn-scoped
 * reminders in every request instead, rendered as one more system message.
 * A reminder needs a user turn right before it; a request without one (an
 * empty window, a compile right after a reply) goes without.
 */
function appendEvents(ctx: CompileContext, host: PipelineHost, prefix: PrefixCompile): Message[] {
  const { ledger } = prefix;
  const { isAnthropicTarget } = ctx.target;
  const channelOf = (channel: AnnouncementChannel): PrefixEntry['channel'] =>
    announcementChannel(channel, isAnthropicTarget) === 'system' ? 'system' : 'user';
  const anchor = eventAnchor(prefix.history, ledger.head?.cut ?? 0);
  const turnScoped = prefix.clearAt ? { anchor } : undefined;

  const standing = host.announcements;
  const ids = new Set(standing.map((a) => a.id));
  const retracted = ledger
    .sources()
    .filter((source) => source.startsWith(ANNOUNCEMENT))
    .map((source) => source.slice(ANNOUNCEMENT.length))
    .filter((id) => !ids.has(id));
  const dynamicStateXml = host.dynamicStateXml;
  const implicitContextXml = ctx.implicitContextXml;

  const sources: PushSource[] = [
    {
      source: 'dynamic-state',
      current: dynamicStateXml
        ? {
            channel: host.dynamicStatePlacement === 'system' ? 'system' : 'user',
            render: (rev) => Prompts.getEventBlock(dynamicStateXml, rev),
          }
        : undefined,
      tombstone: (rev) =>
        Prompts.getWithdrawnBlock('dynamic_state', rev, Prompts.DYNAMIC_STATE_WITHDRAWN),
    },
    {
      source: 'implicit-context',
      current: implicitContextXml
        ? { channel: 'user', render: (rev) => Prompts.getEventBlock(implicitContextXml, rev) }
        : undefined,
      tombstone: (rev) =>
        Prompts.getWithdrawnBlock('implicit_context', rev, Prompts.IMPLICIT_CONTEXT_WITHDRAWN),
    },
    ...standing.map((a) =>
      announcementSource(a.id, {
        channel: channelOf(a.channel),
        render: (rev) => Prompts.getEventBlock(renderAnnouncement(a), rev),
      }),
    ),
    ...retracted.map((id) => announcementSource(id)),
  ];
  const stated = sourceEvents(ledger, sources, turnScoped);
  // The `handoff` phase only sets the notice once per window: it is news every time it is here.
  const notice = ctx.handoffNotice;
  if (notice) {
    stated.push({
      channel: channelOf(notice.channel),
      content: renderAnnouncement(notice),
      sources: ['handoff'],
    });
  }
  // Skill instructions and memory introduce themselves: no anchor line for them, as in 4.x.
  // One for each message that states something: user, system, turn-scoped system.
  const anchors: PrefixCandidate[] = [];
  for (const [channel, clearAt] of [
    ['user', false],
    ['system', false],
    ['system', true],
  ] as const) {
    if (!stated.some((event) => event.channel === channel && !!event.clearAt === clearAt)) continue;
    const anchorLine = { channel, content: Prompts.EVENT_STATE_ANCHOR, sources: [] };
    anchors.push(clearAt ? { ...anchorLine, clearAt } : anchorLine);
  }
  let events = [
    ...ctx.skillEvents,
    ...ctx.memoryEvents,
    ...stated,
    ...anchors,
    ...sourceEvents(ledger, [guardrailSource(ctx)], turnScoped),
  ];
  // With no user turn right before it, a reminder would be said as a user message, which
  // cannot be turn-scoped: it waits for the next request that has one.
  if (events.some((event) => event.clearAt) && !ledger.turnScopedAt(anchor, events)) {
    events = events.filter((event) => !event.clearAt);
  }

  let messages = ctx.messages;
  if (events.length > 0) {
    const before = ledger.renderedAt(anchor);
    ledger.append(events, anchor);
    const trailing = prefix.history.length - anchor + ctx.guardrailMessages.length;
    const after = ledger.renderedAt(anchor);
    messages = replaceEventGroup(messages, trailing, before, after, events, host);
  }
  return host.assembler.compile(messages).messages;
}
