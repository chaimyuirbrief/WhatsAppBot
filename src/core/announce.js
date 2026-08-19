import log from '../util/logger.js';

const logger = log.scope('announce');

/**
 * Posts a running commentary of group admin activity — joins, leaves,
 * removals, promotions, lock/unlock — into one nominated announcements group.
 *
 * Two kinds of tagging, both optional and both fail-soft:
 *
 *   the person   @-mentioned only when they are actually a member of the
 *                announcements group (WhatsApp renders a mention of a
 *                non-member as a raw number, which is worse than no tag), and
 *                never when their number is on the `noTag` opt-out list.
 *
 *   the group    `{group}` in the text is replaced by a tappable group
 *                mention when both groups belong to the same community, and
 *                by the plain group name when they do not — WhatsApp only
 *                renders group mentions within a community.
 *
 * A placeholder is always substituted, so an unresolvable group can never
 * leak a raw `{group}` to readers.
 */
export class Announcer {
  constructor({ bot, getConfig, log: scopedLog = logger }) {
    this.bot = bot;
    this.getConfig = getConfig;
    this.log = scopedLog;
  }

  /** Is this event type switched on? */
  enabled(event) {
    const cfg = this.getConfig() ?? {};
    if (!cfg.group) return false;
    if (event && cfg.events && cfg.events[event] === false) return false;
    return true;
  }

  /**
   * @param {string|null} event   key in `announce.events`; null skips the check
   * @param {string} text         body, may contain the `{group}` placeholder
   * @param {{number?:string, jid?:string}} who  the person the event is about
   * @param {{tagGroup?:string}} opts  group JID the `{group}` placeholder means
   */
  async post(event, text, who = {}, { tagGroup = null } = {}) {
    const cfg = this.getConfig() ?? {};
    if (!this.enabled(event)) return;
    if (!this.bot.isConnected()) return;

    let body = text;
    let mentions = null;
    let groupMentions = null;
    let tagged = false;

    const digits = String(who?.number ?? '').replace(/[^0-9]/g, '');
    const muted = (cfg.noTag ?? []).some((x) => String(x).replace(/[^0-9]/g, '') === digits);

    if (!muted && cfg.tagActor !== false && (who?.number || who?.jid)) {
      const info = this.bot.groupMemberInfo(cfg.group, { jid: who.jid, number: who.number });
      if (info.isMember && info.mentionJid) {
        body = `@${info.mentionText} ${body}`;
        mentions = [info.mentionJid];
        tagged = true;
      }
    }

    // Done after the person-mention rewrite so it survives it.
    if (tagGroup && cfg.tagGroup !== false) {
      const subject = this.bot.groupCache?.get(tagGroup)?.subject;
      if (subject) {
        if (this.bot.sameCommunity(cfg.group, tagGroup)) {
          body = body.replace('{group}', this.bot.groupMentionToken(tagGroup));
          groupMentions = [{ groupJid: tagGroup, groupSubject: subject }];
        } else {
          body = body.replace('{group}', subject);
        }
      }
    }
    // Never let an unsubstituted placeholder reach the group.
    body = body.replace('{group}', 'the group');

    try {
      await this.bot.sendText(cfg.group, body, { mentions, groupMentions });
      this.log.info(`🔔 announce [${event ?? '-'}] ${tagged ? `tagged ${who.number}` : 'no tag'}` +
        `${groupMentions ? ' +group' : ''}: ${text}`);
    } catch (err) {
      this.log.warn(`announce (${event}) failed: ${err.message}`);
    }
  }
}

/** Map a bot 'group-event' action to the `announce.events` key that gates it. */
export const EVENT_KEYS = {
  add: 'join',
  join: 'join',
  invite: 'join',
  'join-request': 'join',
  leave: 'leave',
  remove: 'remove',
  promote: 'promote',
  demote: 'demote',
};

/** Human sentence for a group-event, with `{group}` left for the announcer. */
export function describeEvent(ev) {
  const who = (ev.targets ?? [])
    .map((t) => (t.number ? `+${t.number}` : t.jid))
    .filter(Boolean)
    .join(', ');
  const by = ev.actorNumber ? ` by +${ev.actorNumber}` : '';

  switch (ev.action) {
    case 'add':
    case 'join':
    case 'invite':
      return `➕ ${who || 'someone'} joined {group}${by}`;
    case 'join-request':
      return `🙋 ${who || 'someone'} asked to join {group}`;
    case 'leave':
      return `👋 ${who || 'someone'} left {group}`;
    case 'remove':
      return `➖ ${who || 'someone'} was removed from {group}${by}`;
    case 'promote':
      return `⭐ ${who || 'someone'} is now an admin of {group}${by}`;
    case 'demote':
      return `☆ ${who || 'someone'} is no longer an admin of {group}${by}`;
    default:
      return `👥 ${ev.action} in {group}${who ? `: ${who}` : ''}${by}`;
  }
}
