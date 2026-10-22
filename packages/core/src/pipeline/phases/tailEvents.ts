import type { AnnouncementChannel } from '../../chef';
import { Assembler } from '../../modules/assembler';
import { extractPinnedMessages } from '../../overflow/turns';
import {
  anchorLines,
  awaitsToolResults,
  dynamicStateSource,
  eventAnchor,
  followsUserTurn,
  type PrefixCandidate,
  type PrefixEntry,
  type PushSource,
  renderGroup,
  sourceEvents,
  wireDigest,
} from '../../prefix';
import { Prompts } from '../../prompts';
import type { Message } from '../../types';
import { announcementChannel, renderAnnouncement } from '../announcements';
import { tailInsertionIndex } from '../checks';
import type { CompileContext, PipelineHost, PrefixCompile } from '../context';
import { escapeXmlAttribute } from '../xml';

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

/** A pinned message as its restatement lists it: who said it, and what, tool calls included. */
function pinnedMessageXml(message: Message): string {
  const answers = message.tool_call_id
    ? ` tool_call_id="${escapeXmlAttribute(message.tool_call_id)}"`
    : '';
  const calls = (message.tool_calls ?? []).map(
    (call) =>
      `\n<tool_call id="${escapeXmlAttribute(call.id)}" name="${escapeXmlAttribute(call.function.name)}">` +
      `${call.function.arguments}</tool_call>`,
  );
  return `<message role="${message.role}"${answers}>${message.content}${calls.join('')}</message>`;
}

/**
 * Pinned host messages the head stands for without carrying them — an
 * on-demand compaction's block, which only the turns it kept may follow —
 * said again as one event at the end of the window, all of them each time.
 * A compaction the host history holds is the head's to replace, pinned or
 * not. Once the host unpins them, the restatement is withdrawn.
 */
function pinnedSource({ ledger, history }: PrefixCompile): PushSource {
  const head = ledger.head;
  const carried = new Set(head?.replacement.map(wireDigest));
  const summarized = head
    ? extractPinnedMessages(history.slice(0, head.cut)).filter(
        (message) =>
          message._anthropic_compaction === undefined && !carried.has(wireDigest(message)),
      )
    : [];
  const messagesXml = summarized.map(pinnedMessageXml).join('\n');
  return {
    source: 'pinned',
    current:
      summarized.length > 0
        ? { channel: 'user', render: (rev) => Prompts.getPinnedEvent(messagesXml, rev) }
        : undefined,
    tombstone: (rev) => Prompts.getWithdrawnBlock('pinned_messages', rev, Prompts.PINNED_WITHDRAWN),
  };
}

/** Whether `messages` from `at` on are `expected`, as the wire sees them. */
const sameAt = (messages: Message[], at: number, expected: readonly Message[]): boolean =>
  at >= 0 &&
  expected.every(
    (message, i) =>
      Assembler.stringifyPayload(messages[at + i]) === Assembler.stringifyPayload(message),
  );

/**
 * `messages` with the event group at the end of the window — `before`, as
 * the `prefix` phase rendered it — replaced by `after`, the same group with
 * this compile's `events` in it. Only `trailing` follows that group: the
 * host messages after the anchor (a prefill the history ends with), then the
 * guardrail's. If a slot handler moved or rewrote the group or what follows
 * it — an `after-assemble` one, or one that edited the history in place
 * (overflow itself only ever hands on the ledger's window) — only `events`
 * go in, so nothing it left is sent twice: in front of `trailing` if that is
 * still there, else after the last user turn.
 */
function replaceEventGroup(
  messages: Message[],
  trailing: readonly Message[],
  before: Message[],
  after: Message[],
  events: readonly PrefixCandidate[],
  host: PipelineHost,
): Message[] {
  const trailed = sameAt(messages, messages.length - trailing.length, trailing);
  let end = messages.length - trailing.length;
  if (!trailed) {
    end = tailInsertionIndex(messages);
    if (messages[end]?.role === 'user' || messages[end]?.role === 'tool') end++;
  }
  const start = end - before.length;
  if (trailed && sameAt(messages, start, before)) {
    return [...messages.slice(0, start), ...after, ...messages.slice(end)];
  }

  host.warnOnce(
    'append-only-events-moved',
    '[context-chef] appendOnly: the events at the end of the window were moved or rewritten, ' +
      'or the messages after them changed, after the ledger rendered them — by an ' +
      'after-assemble handler, or a slot handler that edited the history in place — so this ' +
      "compile's new events were added there on their own. The payload no longer matches the " +
      'window the ledger records, so the next compile may not start with it (warned once).',
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
 * order, after the pinned messages a compaction summarized: skill
 * instructions, memory, dynamic state, implicit context, announcements, the
 * anchor line on each channel that carried state, the guardrail. Pinned
 * messages are conversation, not state, and come first; like skill
 * instructions and memory they need no anchor line. Events never merge into
 * a host message: the ledger renders everything appended at one place as one
 * user message and one positional system message, and that group replaces
 * the one the `prefix` phase rendered there.
 *
 * With `clearAt` on Anthropic, the system-channel sources are turn-scoped
 * reminders in every request instead, rendered as one more system message.
 * A reminder needs a user turn right before it; a request without one (an
 * empty window, a compile right after a reply) goes without.
 *
 * Nothing is appended while the history ends in tool calls still waiting for
 * results: the events would sit between the calls and their results.
 */
export function appendEvents(
  ctx: CompileContext,
  host: PipelineHost,
  prefix: PrefixCompile,
): Message[] {
  const { ledger } = prefix;
  if (awaitsToolResults(prefix.history, ledger.head)) {
    return host.assembler.compile(ctx.messages).messages;
  }
  const { isAnthropicTarget } = ctx.target;
  const channelOf = (channel: AnnouncementChannel): PrefixEntry['channel'] =>
    announcementChannel(channel, isAnthropicTarget) === 'system' ? 'system' : 'user';
  const anchor = eventAnchor(prefix.history, ledger.head);
  const turnScoped = prefix.clearAt ? { anchor } : undefined;

  const standing = host.announcements;
  const ids = new Set(standing.map((a) => a.id));
  const retracted = ledger
    .sources()
    .filter((source) => source.startsWith(ANNOUNCEMENT))
    .map((source) => source.slice(ANNOUNCEMENT.length))
    .filter((id) => !ids.has(id));
  const implicitContextXml = ctx.implicitContextXml;

  const sources: PushSource[] = [
    dynamicStateSource(
      host.dynamicStateXml,
      host.dynamicStatePlacement === 'system' ? 'system' : 'user',
    ),
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
  let events = [
    ...sourceEvents(ledger, [pinnedSource(prefix)]),
    ...ctx.skillEvents,
    ...ctx.memoryEvents,
    ...stated,
    // Skill instructions and memory introduce themselves: no anchor line for them, as in 4.x.
    ...anchorLines(stated),
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
    const trailing = [...prefix.history.slice(anchor), ...ctx.guardrailMessages];
    const after = ledger.renderedAt(anchor);
    messages = replaceEventGroup(messages, trailing, before, after, events, host);
  }
  return host.assembler.compile(messages).messages;
}
