import type { Announcement, AnnouncementChannel } from '../chef';
import { escapeXmlAttribute } from './xml';

/**
 * The channel an announcement is delivered on for one compile.
 *
 * `'auto'` routes by TARGET only — chef does not know the model id. The
 * Anthropic target gets `'system'` because mid-conversation system messages
 * leave the cached prefix intact and carry operator precedence; every other
 * target gets `'user_tail'`. Anthropic models WITHOUT mid-conversation system
 * support (Sonnet 5) must therefore pass `channel: 'user_tail'` explicitly —
 * mechanism, not policy. So may Sonnet 5.5 / Haiku 5.5 callers whose
 * announcements go unheeded after tool results (see `ContextChef.announce`).
 */
export function announcementChannel(
  channel: AnnouncementChannel,
  isAnthropicTarget: boolean,
): Exclude<AnnouncementChannel, 'auto'> {
  if (channel !== 'auto') return channel;
  return isAnthropicTarget ? 'system' : 'user_tail';
}

/** One announcement as the model reads it. */
export function renderAnnouncement(announcement: Announcement): string {
  return `<announcement id="${escapeXmlAttribute(announcement.id)}">\n${announcement.content}\n</announcement>`;
}
