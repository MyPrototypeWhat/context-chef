import type { Message } from '../types';
import type { PrefixCandidate, PrefixEntry, PrefixHead } from './types';

/**
 * Whether a message placed at `end` follows a user turn: the last message
 * before it that is not a system message is a user message or tool results.
 * `initial(i)` is the role initial of message `i`, as digests lead with it.
 */
export function followsUserTurn(end: number, initial: (i: number) => string): boolean {
  for (let i = end - 1; i >= 0; i--) {
    const role = initial(i);
    if (role !== 's') return role === 'u' || role === 't';
  }
  return false;
}

/**
 * The messages of the entries that render at one place: user events, then
 * system events (a positional system message must not be followed by a user
 * turn), then turn-scoped ones (`_clear_at`), since `clear_at` applies per
 * message.
 *
 * A positional system message is only valid right after a user turn. When
 * neither the group's own user event nor the message before the group is
 * one — an empty window, a reply right before — the system events are said
 * as user messages instead, 4.x's fallback; the entries keep their channel.
 * A user message cannot be turn-scoped, so turn-scoped entries are only
 * appended where they stay system messages (`turnScopedAt()`). A pure
 * function of the group and what precedes it, so a tail renders the same
 * bytes once answered. Every message is marked `_chef_event`, which no
 * adapter sends.
 */
export function renderGroup(
  entries: readonly PrefixCandidate[],
  afterUserTurn: boolean,
): Message[] {
  const text = (part: readonly PrefixCandidate[]) => part.map((e) => e.content).join('\n\n');
  const user = entries.filter((e) => e.channel === 'user');
  const system = entries.filter((e) => e.channel === 'system' && !e.clearAt);
  const turnScoped = entries.filter((e) => e.channel === 'system' && e.clearAt);
  const positional = afterUserTurn || user.length > 0;
  const messages: Message[] = [];
  if (user.length > 0) messages.push({ role: 'user', content: text(user), _chef_event: true });
  const say = (part: readonly PrefixCandidate[], scope: Pick<Message, '_clear_at'>) => {
    if (part.length === 0) return;
    messages.push(
      positional
        ? { role: 'system', content: text(part), _positional: true, ...scope, _chef_event: true }
        : { role: 'user', content: text(part), _chef_event: true },
    );
  };
  say(system, {});
  say(turnScoped, { _clear_at: 'next_user_message' });
  return messages;
}

/**
 * Whether the window opens after a user turn: what `head` puts in front of
 * `host[head.cut]` ends with one. Without a head, nothing comes first.
 */
export function opensAfterUserTurn(head?: PrefixHead): boolean {
  const replacement = head?.replacement ?? [];
  return followsUserTurn(replacement.length, (k) => replacement[k].role.charAt(0));
}

/**
 * Where an entry anchored at each host index renders, as the host index it
 * sits before: the first assistant message at or after the anchor, or
 * `length` while unanswered. A run of the host's own system messages right
 * before that place that follows a user turn stays positional, and a user
 * message must not follow it, so the entry goes in front of it (from the
 * anchor on); a run after a reply is hoisted, and the entry stays behind it.
 * `role(i)` is the role initial of host message `i`; `opening` says whether
 * the window opens after a user turn (`opensAfterUserTurn`). Anchors past
 * `length` have no place.
 */
export function anchorPlaces(
  length: number,
  cut: number,
  role: (index: number) => string,
  opening: boolean,
): number[] {
  const positional: boolean[] = [];
  let afterUserTurn = opening;
  for (let i = cut; i < length; i++) {
    const initial = role(i);
    if (initial === 's') positional[i] = afterUserTurn;
    else afterUserTurn = initial === 'u' || initial === 't';
  }
  const place = new Array<number>(length + 1);
  place[length] = length;
  for (let i = length - 1; i >= 0; i--) {
    const ahead = role(i) === 'a' || (positional[i] === true && place[i + 1] === i + 1);
    place[i] = ahead ? i : place[i + 1];
  }
  return place;
}

/** Entries by the host index they render before, in the order they were appended. */
export function groupEntries(
  entries: readonly PrefixEntry[],
  place: readonly number[],
): Map<number, PrefixEntry[]> {
  const groups = new Map<number, PrefixEntry[]>();
  for (const entry of entries) {
    const at = place[entry.anchor];
    if (at === undefined) continue;
    const group = groups.get(at);
    if (group) group.push(entry);
    else groups.set(at, [entry]);
  }
  return groups;
}
