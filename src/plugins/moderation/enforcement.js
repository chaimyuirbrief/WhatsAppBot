/**
 * Decide whether a message in a moderated group breaks the posting rules and
 * should be removed.
 *
 * This module is the whole decision — pure and side-effect free, so every rule
 * below is unit-tested without touching WhatsApp.
 *
 * Returns null to leave a message alone, or { reason, detail } to delete it.
 * Being conservative matters more than being thorough here: a false positive
 * deletes a real person's message, so anything ambiguous is left alone, and
 * every rule is off until an admin switches it on.
 */

/** Message types that count as plain text. Everything else is media. */
const TEXT_TYPES = ['conversation', 'extendedTextMessage'];

/**
 * A link, deliberately narrow. An explicit scheme or `www.` is unambiguous;
 * a bare domain is only matched on a known TLD so ordinary sentences
 * ("see section 3.2", "ok...fine") are never mistaken for links.
 */
const URL_RE = new RegExp(
  '(?:https?://|www\\.)\\S+' +
  '|\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.' +
  '(?:com|net|org|io|co|me|ly|gg|xyz|info|biz|link|app|site|shop|online|store|club|live|tv|uk|de)' +
  '\\b(?:/\\S*)?',
  'i',
);

export function containsLink(text = '') {
  return URL_RE.test(String(text));
}

/**
 * @param {object} msg    normalized inbound message
 * @param {object} cfg    the `moderation` config section
 * @param {{isAdmin?:boolean, isCommand?:boolean}} ctx
 *        isCommand marks a recognised bot command (e.g. `#rules`), which is
 *        never moderated — the rules command has to keep working even in a
 *        strictly moderated group.
 */
export function checkMessage(msg, cfg = {}, { isAdmin = false, isCommand = false } = {}) {
  if (!cfg.enabled) return null;
  if (msg.fromMe) return null;
  if (isAdmin && cfg.exemptAdmins !== false) return null;
  if (isCommand) return null;

  // Non-text posts: pictures, screenshots, voice notes, stickers.
  if (cfg.deleteMedia && !TEXT_TYPES.includes(msg.messageType)) {
    return { reason: 'media', detail: 'only text messages are allowed here' };
  }

  const text = (msg.text || '').trim();
  if (!text) return null;

  if (cfg.deleteLinks && containsLink(text)) {
    return { reason: 'link', detail: 'links are not allowed here' };
  }

  if (!cfg.deleteOffFormat) return null;

  const lower = text.toLowerCase();
  const prefix = (cfg.prefix ?? '').trim();

  if (cfg.requirePrefix) {
    if (!prefix) return null;                       // misconfigured: do nothing
    if (!lower.startsWith(prefix.toLowerCase())) {
      return { reason: 'no-prefix', detail: `messages must start with ${prefix}` };
    }
  }

  const body = cfg.requirePrefix ? text.slice(prefix.length).trim() : text;
  const min = Number.isFinite(cfg.minLength) ? cfg.minLength : 2;
  if (body.length < min) {
    return { reason: 'empty', detail: 'there was no message after the prefix' };
  }

  return null;
}

/** Human-readable note for the person whose message was removed. */
export function violationNotice(check, cfg = {}, { rulesCommand = '#rules' } = {}) {
  const prefix = (cfg.prefix ?? '').trim();
  const why = {
    'no-prefix': prefix ? `it didn't start with *${prefix}*` : 'it was not in the required format',
    'media': "it wasn't a plain-text message (no pictures, screenshots or voice notes)",
    'link': 'it contained a link',
    'empty': 'it had no actual content',
  }[check.reason] ?? 'it did not follow the group rules';

  const example = (cfg.formatExample ?? '').trim()
    || (prefix ? `${prefix} your message here` : '');

  return `Your message in the group was removed because ${why}.` +
    (example ? `\n\nPlease post one message like:\n*${example}*` : '') +
    `\n\nSend *${rulesCommand}* here for the full rules.`;
}
