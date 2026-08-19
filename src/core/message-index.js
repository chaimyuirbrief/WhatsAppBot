/**
 * A rolling index of recently-seen group messages, kept so that banning someone
 * can also wipe what they posted.
 *
 * WhatsApp only honours "delete for everyone" for a limited window (about two
 * days), so there is no point remembering more than that - entries older than
 * the window are pruned on every write. Only the message *key* is stored (chat,
 * id, sender), never the text: this is a moderation tool, not a message archive,
 * and the box has little spare memory.
 */

const DAY = 86_400_000;
export const DEFAULT_WINDOW_MS = 2 * DAY;

/** Stable identity for a sender: phone number when known, else the raw JID. */
export function senderKeyOf({ senderNumber = null, senderJid = null } = {}) {
  if (senderNumber) return `num:${senderNumber}`;
  if (senderJid) return `lid:${senderJid}`;
  return null;
}

export class MessageIndex {
  /**
   * @param store   a StateStore namespace (get/set), or null to stay in-memory
   * @param windowMs how long a message stays eligible for delete-for-everyone
   * @param cap     hard ceiling on retained entries, oldest dropped first
   */
  constructor({ store = null, windowMs = DEFAULT_WINDOW_MS, cap = 20_000 } = {}) {
    this.store = store;
    this.windowMs = windowMs;
    this.cap = cap;
    this.entries = store?.get('entries', []) ?? [];
  }

  /** Record one inbound group message. Ignores DMs and our own messages. */
  record(msg, now = Date.now()) {
    if (!msg?.isGroup || msg.fromMe) return false;
    const key = senderKeyOf(msg);
    if (!key || !msg.id || !msg.chatJid) return false;
    this.entries.push({
      k: key,
      g: msg.chatJid,
      i: msg.id,
      p: msg.senderJid ?? null,
      t: msg.timestamp || now,
    });
    this.prune(now);
    this._persist();
    return true;
  }

  /** Drop anything outside the delete window, then enforce the cap. */
  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    this.entries = this.entries.filter((e) => (e.t ?? 0) >= cutoff);
    if (this.entries.length > this.cap) {
      this.entries.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
      this.entries = this.entries.slice(this.entries.length - this.cap);
    }
    return this.entries.length;
  }

  _persist() {
    try { this.store?.set('entries', this.entries); } catch { /* best effort */ }
  }

  /**
   * Every still-deletable message from one person, newest first.
   * Matches on phone number or JID so a @lid sender is found either way.
   */
  forSender({ number = null, jid = null } = {}, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const wantKeys = new Set([number && `num:${number}`, jid && `lid:${jid}`].filter(Boolean));
    return this.entries
      .filter((e) => (e.t ?? 0) >= cutoff && (wantKeys.has(e.k) || (jid && e.p === jid)))
      .sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
      .map((e) => ({
        groupJid: e.g,
        key: { remoteJid: e.g, fromMe: false, id: e.i, participant: e.p ?? undefined },
        ts: e.t,
      }));
  }

  /** Forget everything recorded for one person (after their messages are wiped). */
  forget({ number = null, jid = null } = {}) {
    const drop = new Set([number && `num:${number}`, jid && `lid:${jid}`].filter(Boolean));
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(drop.has(e.k) || (jid && e.p === jid)));
    this._persist();
    return before - this.entries.length;
  }

  get size() { return this.entries.length; }
}
