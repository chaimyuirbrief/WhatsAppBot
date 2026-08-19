import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import qrcode from 'qrcode';
import log from '../util/logger.js';

const logger = log.scope('bot');

// Baileys is CommonJS-ish with a default export; import lazily so the app can
// boot (and show the web UI) even if the dependency is not installed yet.
let baileys = null;
async function loadBaileys() {
  if (!baileys) {
    const mod = await import('@whiskeysockets/baileys');
    baileys = mod.default ?? mod;
    baileys.__ns = mod;
  }
  return baileys;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gap between individual group setting changes during a bulk lock/unlock.
// Locking every group is a burst of writes against the same connection, and
// WhatsApp answers a burst by throttling - or dropping the socket outright.
// Five seconds a group is slow on purpose; it is what keeps the connection up.
const DEFAULT_LOCKDOWN_PACE_MS = 5000;

/**
 * Pull a real phone number out of a WhatsApp JID.
 *
 * Only `@s.whatsapp.net` JIDs carry the phone number in the user part.
 * WhatsApp's newer `@lid` (linked-ID) JIDs are opaque and are NOT phone
 * numbers, so those are rejected here and recovered from a companion field.
 */
function phoneFromJid(jid) {
  if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null;
  const num = jid.split('@')[0].split(':')[0];
  return /^[0-9]{7,15}$/.test(num) ? num : null;
}

/**
 * Best-effort sender phone number, trying every field WhatsApp is known to
 * put it in. Under LID migration the participant JID may be a `@lid`, and the
 * real number then arrives in a parallel `...Pn` field.
 */
function senderNumberFrom(raw, key, chatJid, isGroup) {
  const candidates = [
    key.participantPn, raw.participantPn, raw.key?.participantPn,
    key.participantAlt, raw.participantAlt,
    isGroup ? (key.participant ?? raw.participant) : chatJid,
  ];
  for (const c of candidates) {
    const n = phoneFromJid(c);
    if (n) return n;
  }
  return null;
}

/** Human-friendly rendering: +1 (424) 428-4888 for US, +<digits> otherwise. */
function formatPhone(num) {
  if (!num) return null;
  if (num.length === 11 && num.startsWith('1')) {
    return `+1 (${num.slice(1, 4)}) ${num.slice(4, 7)}-${num.slice(7)}`;
  }
  if (num.length === 10) {
    return `(${num.slice(0, 3)}) ${num.slice(3, 6)}-${num.slice(6)}`;
  }
  return `+${num}`;
}

/**
 * Connection states surfaced to the UI:
 *   stopped | connecting | awaiting-pairing | awaiting-qr | connected | conflict | error
 */
export class WhatsAppBot extends EventEmitter {
  constructor({ configStore, dataDir }) {
    super();
    this.setMaxListeners(50);
    this.configStore = configStore;
    this.authDir = path.join(dataDir, 'session');
    this.sock = null;
    this.state = 'stopped';
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.me = null;
    this.lastError = null;
    this.groupCache = new Map();
    this.reconnectAttempts = 0;
    this.stopping = false;
    this._lastGroupFetch = 0;
    this._groupTimer = null;
    this._groupBusy = false;
    this._lastActionAt = 0;
    this._lockAllRun = null;
  }

  get config() { return this.configStore.get(); }

  _setState(state, extra = {}) {
    this.state = state;
    this.emit('state', this.status());
    logger.info(`state -> ${state}${extra.detail ? ` (${extra.detail})` : ''}`);
  }

  status() {
    return {
      state: this.state,
      me: this.me,
      qr: this.qrDataUrl,
      pairingCode: this.pairingCode,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
      groupCount: this.groupCache.size,
    };
  }

  isConnected() {
    return this.state === 'connected' && !!this.sock;
  }

  /** Wipe the linked-device session so a fresh number can be paired. */
  async logout({ wipe = true } = {}) {
    this.stopping = true;
    clearTimeout(this._groupTimer);
    try { await this.sock?.logout(); } catch {}
    try { this.sock?.end?.(); } catch {}
    this.sock = null;
    if (wipe && fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      logger.warn('session wiped');
    }
    this.me = null;
    this.qrDataUrl = null;
    this.pairingCode = null;
    this._setState('stopped');
    this.stopping = false;
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this._groupTimer);
    try { this.sock?.end?.(); } catch {}
    this.sock = null;
    this._setState('stopped');
    this.stopping = false;
  }

  async start() {
    if (this.sock) {
      logger.warn('start() called while a socket already exists; restarting');
      try { this.sock.end?.(); } catch {}
      this.sock = null;
    }
    this.stopping = false;
    this.lastError = null;
    this._appStateSyncTried = false;   // a fresh connection gets a fresh attempt
    this._setState('connecting');

    let B;
    try {
      B = await loadBaileys();
    } catch (err) {
      this.lastError = `Baileys not installed: ${err.message}. Run: npm install`;
      this._setState('error');
      return;
    }

    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = {
      ...B,
      ...B.__ns,
    };

    fs.mkdirSync(this.authDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
      logger.info(`using WhatsApp Web version ${version.join('.')}`);
    } catch (err) {
      logger.warn(`could not fetch WA version, using library default: ${err.message}`);
    }

    const cfg = this.config.whatsapp;
    const usePairing = cfg.loginMethod === 'pairing' && !authState.creds.registered;

    this.sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: authState,
      // Identifies as a normal linked desktop client, which is what this is.
      browser: Browsers ? Browsers.ubuntu('Desktop') : ['Ubuntu', 'Desktop', '22.04'],
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: !!cfg.markOnline,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      retryRequestDelayMs: 1000,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (usePairing) {
          // Pairing mode: the phone gets a code to type, no QR scanning.
          this.qrDataUrl = null;
        } else {
          this.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
          this._setState('awaiting-qr');
        }
      }

      if (connection === 'open') {
        this.reconnectAttempts = 0;
        this.qrDataUrl = null;
        this.pairingCode = null;
        this.me = {
          id: this.sock.user?.id ?? null,
          name: this.sock.user?.name ?? this.sock.user?.verifiedName ?? null,
        };
        this._setState('connected');
        // WhatsApp rate-limits group enumeration hard right after connecting,
        // so give it a moment rather than asking straight away.
        this.scheduleGroupRefresh(6000);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reasonName = Object.entries(DisconnectReason ?? {})
          .find(([, v]) => v === statusCode)?.[0] ?? String(statusCode ?? 'unknown');
        this.lastError = `disconnected: ${reasonName}`;
        logger.warn(`connection closed (${reasonName})`);

        this.sock = null;

        if (this.stopping) return;

        if (statusCode === DisconnectReason?.loggedOut) {
          logger.error('logged out on the phone - session wiped, re-link required');
          try { fs.rmSync(this.authDir, { recursive: true, force: true }); } catch {}
          this.me = null;
          this._setState('stopped');
          return;
        }

        if (statusCode === DisconnectReason?.connectionReplaced) {
          // Another WhatsApp Web session took over this slot.
          this._setState('conflict');
          return;
        }

        if (this.config.whatsapp.autoReconnect) {
          this.reconnectAttempts += 1;
          const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.reconnectAttempts, 5));
          logger.info(`reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`);
          this._setState('connecting');
          await sleep(delay);
          if (!this.stopping) this.start().catch((e) => logger.error(`reconnect failed: ${e.message}`));
        } else {
          this._setState('stopped');
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;   // ignore history backfill
      for (const raw of messages) {
        // Ground truth for group mentions: WhatsApp gives us no documentation
        // of the in-text token it links against, and Baileys has no first-class
        // support, so log any INBOUND message that carries one. A single real
        // group mention sent from a phone tells us the exact convention.
        try {
          const ci = raw.message?.extendedTextMessage?.contextInfo;
          if (ci?.groupMentions?.length) {
            logger.info(`📎 GROUP-MENTION SAMPLE text=${JSON.stringify(raw.message.extendedTextMessage.text)} ` +
              `groupMentions=${JSON.stringify(ci.groupMentions)} mentionedJid=${JSON.stringify(ci.mentionedJid ?? null)}`);
          }
        } catch { /* diagnostic only */ }
        const msg = this.normalize(raw);
        if (msg) this.emit('message', msg);
      }
    });

    // These fire often - every subject change, every participant edit.
    // Coalesce them into one refresh rather than one call per event.
    // Admin activity feed: joins/leaves/removals/promotions with the actor.
    this.sock.ev.on('group-participants.update', (u) => {
      try {
        this.emit('group-event', {
          ts: Date.now(),
          groupJid: u.id,
          groupName: this.groupCache.get(u.id)?.subject ?? u.id,
          action: u.action,
          actor: u.author ?? null,
          actorNumber: u.author ? this.numberFromJid(u.author) : null,
          targets: (u.participants ?? []).map((pj) => ({ jid: pj, number: this.numberFromJid(pj) })),
        });
      } catch (err) { logger.warn(`group-event capture failed: ${err.message}`); }
      this.scheduleGroupRefresh(15_000);
    });
    this.sock.ev.on('group.join-request', (u) => {
      const who = u.participant ?? u.author ?? null;
      this.emit('group-event', {
        ts: Date.now(), groupJid: u.id ?? u.jid ?? null,
        groupName: this.groupCache.get(u.id ?? u.jid)?.subject ?? (u.id ?? u.jid),
        action: 'join-request', actor: who, actorNumber: this.numberFromJid(who ?? ''),
        targets: [{ jid: who, number: this.numberFromJid(who ?? '') }],
      });
    });

    this.sock.ev.on('groups.upsert', () => this.scheduleGroupRefresh(30_000));
    this.sock.ev.on('groups.update', () => this.scheduleGroupRefresh(120_000));

    if (usePairing) {
      const phone = String(cfg.phoneNumber || '').replace(/[^0-9]/g, '');
      if (!phone) {
        this.lastError = 'Set your WhatsApp phone number in Settings before linking.';
        this._setState('error');
        return;
      }
      this._setState('awaiting-pairing');
      // The socket needs a moment to establish before it can request a code.
      await sleep(3000);
      try {
        const code = await this.sock.requestPairingCode(phone);
        this.pairingCode = code?.match(/.{1,4}/g)?.join('-') ?? code;
        logger.info(`pairing code issued for +${phone}: ${this.pairingCode}`);
        this.emit('state', this.status());
      } catch (err) {
        this.lastError = `Could not request pairing code: ${err.message}`;
        this._setState('error');
      }
    }
  }

  /** Flatten a Baileys message into a stable shape plugins can rely on. */
  normalize(raw) {
    if (!raw?.message) return null;
    const key = raw.key ?? {};
    const chatJid = key.remoteJid;
    if (!chatJid || chatJid === 'status@broadcast') return null;

    const isGroup = chatJid.endsWith('@g.us');
    const inner = raw.message.ephemeralMessage?.message
      ?? raw.message.viewOnceMessage?.message
      ?? raw.message.viewOnceMessageV2?.message
      ?? raw.message;

    const text =
      inner.conversation ??
      inner.extendedTextMessage?.text ??
      inner.imageMessage?.caption ??
      inner.videoMessage?.caption ??
      inner.documentWithCaptionMessage?.message?.documentMessage?.caption ??
      '';

    const senderJid = isGroup ? (key.participant ?? raw.participant ?? null) : chatJid;
    const senderNumber = senderNumberFrom(raw, key, chatJid, isGroup);

    // Number extraction is validated against real LID traffic, so only log
    // when it FAILS - otherwise every group message spams the debug log and
    // buries the pipeline milestones.
    if (isGroup && !key.fromMe && !senderNumber) {
      log.scope('bot').debug(
        `could not resolve sender number: participant=${key.participant ?? '-'} ` +
        `participantPn=${key.participantPn ?? raw.participantPn ?? '-'}`,
      );
    }

    return {
      id: key.id,
      key,
      chatJid,
      isGroup,
      fromMe: !!key.fromMe,
      senderJid,
      senderNumber,
      senderNumberDisplay: formatPhone(senderNumber),
      pushName: raw.pushName ?? null,
      text: String(text || '').trim(),
      timestamp: Number(raw.messageTimestamp ?? 0) * 1000,
      messageType: Object.keys(inner)[0] ?? 'unknown',
      raw,
    };
  }

  /** Space out outbound actions so the bot does not flood a group. */
  async _pace() {
    const { minActionDelayMs: min = 0, maxActionDelayMs: max = 0 } = this.config.whatsapp;
    if (max <= 0) return;
    const wait = min + Math.random() * Math.max(0, max - min);
    const since = Date.now() - this._lastActionAt;
    const remaining = wait - since;
    if (remaining > 0) await sleep(remaining);
    this._lastActionAt = Date.now();
  }

  _requireSock() {
    if (!this.sock || this.state !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
    return this.sock;
  }

  async react(msg, emoji) {
    const sock = this._requireSock();
    await this._pace();
    await sock.sendMessage(msg.chatJid, { react: { text: emoji, key: msg.key } });
    logger.debug(`reacted ${emoji} on ${msg.id}`);
  }

  /**
   * @param mentions       person JIDs to @-mention (text must contain @number)
   * @param groupMentions  [{ groupJid, groupSubject }] - tappable group links,
   *                       which WhatsApp only renders for groups in the same
   *                       community. The text must contain the matching
   *                       @<jid-local-part> token (see groupMentionToken).
   */
  async sendText(jid, text, { quoted = null, mentions = null, groupMentions = null } = {}) {
    const sock = this._requireSock();
    await this._pace();
    const content = { text };
    if (mentions?.length) content.mentions = mentions;
    if (groupMentions?.length) {
      content.contextInfo = {
        ...(content.contextInfo ?? {}),
        groupMentions: groupMentions.map((g) => ({
          groupJid: g.groupJid,
          groupSubject: g.groupSubject ?? this.groupCache.get(g.groupJid)?.subject ?? '',
        })),
      };
    }
    return sock.sendMessage(jid, content, quoted ? { quoted: quoted.raw } : {});
  }

  /**
   * The token placed in message text for a group mention.
   *
   * Group mentions deliberately invert the person-mention convention: a person
   * is "@" + the JID's LOCAL part (@15551234567), but a group is "@" + the
   * WHOLE serialized JID, domain included (@1203631668...@g.us). WhatsApp scans
   * the body for that literal string, matches it against
   * contextInfo.groupMentions[].groupJid, and swaps it for a tappable chip
   * showing groupSubject. Get the token wrong and the entry is silently
   * ignored - which is why "@1203631668..." (domain stripped) rendered to
   * recipients as a raw number.
   */
  groupMentionToken(groupJid) {
    const jid = String(groupJid || '');
    return jid ? `@${jid}` : '';
  }

  /** Are these two groups in the same community? (group mentions need this.) */
  sameCommunity(jidA, jidB) {
    const a = this.groupCache.get(jidA)?.community ?? null;
    const b = this.groupCache.get(jidB)?.community ?? null;
    return !!a && !!b && a === b;
  }

  /**
   * Send a file as a document - this is the paperclip -> Document path,
   * which preserves the original file instead of re-compressing it as video.
   */
  async sendDocument(jid, filePath, { fileName, mimetype = 'application/octet-stream', caption, quoted = null } = {}) {
    const sock = this._requireSock();
    const name = fileName ?? path.basename(filePath);
    const stat = fs.statSync(filePath);
    await this._pace();
    logger.info(`sending document ${name} (${(stat.size / 1048576).toFixed(1)} MB) -> ${jid}`);
    // Passing a path lets Baileys stream from disk instead of buffering the
    // whole file in memory, which matters a lot on a small server.
    return sock.sendMessage(
      jid,
      { document: { url: filePath }, mimetype, fileName: name, ...(caption ? { caption } : {}) },
      quoted ? { quoted: quoted.raw } : {},
    );
  }

  /**
   * Delete a chat from the bot's own account (housekeeping so the chat list
   * doesn't clutter with one-off PMs). This is a local delete on the bot's
   * side — it does NOT delete the message for the other person, who keeps it.
   */
  /**
   * WhatsApp app-state edits (deleting/archiving a chat) are encrypted with a
   * key the phone shares during app-state sync. We connect with
   * syncFullHistory disabled, so that key can be absent and every chatModify
   * then fails with "App state key not present!". Ask for a sync once, lazily,
   * the first time we actually need it.
   */
  async _ensureAppStateKey() {
    const sock = this._requireSock();
    if (sock.authState?.creds?.myAppStateKeyId) return true;
    if (this._appStateSyncTried) return !!sock.authState?.creds?.myAppStateKeyId;
    this._appStateSyncTried = true;
    try {
      logger.info('app-state key missing - requesting a sync from the phone');
      await sock.resyncAppState(['critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true);
    } catch (err) {
      logger.debug(`app-state resync failed: ${err.message}`);
    }
    return !!sock.authState?.creds?.myAppStateKeyId;
  }

  async deleteChat(jid, lastMsg = null) {
    const sock = this._requireSock();
    if (!(await this._ensureAppStateKey())) {
      throw new Error('WhatsApp has not shared the app-state key with this device yet, so chats cannot be deleted');
    }
    const lastMessages = lastMsg?.key
      ? [{ key: lastMsg.key, messageTimestamp: lastMsg.messageTimestamp ?? Math.floor(Date.now() / 1000) }]
      : [];
    await sock.chatModify({ delete: true, lastMessages }, jid);
    logger.debug(`deleted chat ${jid}`);
  }

  async sendPresence(jid, kind = 'composing') {
    try {
      await this.sock?.sendPresenceUpdate(kind, jid);
    } catch { /* presence is best-effort */ }
  }

  /**
   * Queue a group refresh. Repeated calls collapse into one, which matters
   * because groups.update can fire dozens of times in a burst.
   */
  scheduleGroupRefresh(delay = 10_000, attempt = 0) {
    clearTimeout(this._groupTimer);
    this._groupTimer = setTimeout(() => {
      // Deliberately NOT forced. WhatsApp emits groups.update constantly, and
      // forcing here bypassed the cache and produced a permanent cycle of
      // refresh -> rate-limit -> back off -> refresh. Only an explicit press
      // of Refresh in the UI forces a fetch.
      this.refreshGroups().catch((err) => {
        const rateLimited = /rate.?overlimit|429|too many/i.test(err.message ?? '');
        if (rateLimited && attempt < 5) {
          // Back off properly: 30s, 1m, 2m, 4m, 8m.
          const backoff = Math.min(480_000, 30_000 * 2 ** attempt);
          logger.warn(`group list rate-limited by WhatsApp, retrying in ${Math.round(backoff / 1000)}s`);
          this.scheduleGroupRefresh(backoff, attempt + 1);
        } else {
          logger.warn(`group refresh failed: ${err.message}`);
        }
      });
    }, delay);
    this._groupTimer.unref?.();
  }

  /**
   * Fetch the group list. Cached for a minute - the UI can ask freely, and
   * WhatsApp will not see a request per page load.
   */
  async refreshGroups({ force = false } = {}) {
    if (this._groupBusy) return this.groups();
    if (!force && Date.now() - this._lastGroupFetch < 300_000) return this.groups();

    const sock = this._requireSock();
    this._groupBusy = true;
    let all;
    try {
      all = await sock.groupFetchAllParticipating();
      this._lastGroupFetch = Date.now();
    } finally {
      this._groupBusy = false;
    }
    this.groupCache.clear();
    for (const [jid, meta] of Object.entries(all ?? {})) {
      // Capture member identities so we can tell whether a requester is in a
      // given group and how to @-mention them. Under WhatsApp's LID system a
      // participant id may be a phone JID (…@s.whatsapp.net) or an opaque
      // …@lid, so we index both the raw id and any phone number we can derive.
      const memberIds = new Set();
      const memberNumbers = new Set();
      const members = [];
      for (const pp of meta.participants ?? []) {
        if (pp.id) memberIds.add(pp.id);
        let number = null;
        if (pp.id?.endsWith('@s.whatsapp.net')) {
          number = pp.id.split('@')[0].split(':')[0];
          memberNumbers.add(number);
        }
        const pn = pp.phoneNumber ?? pp.jid;
        if (typeof pn === 'string') {
          const digits = pn.replace(/[^0-9]/g, '');
          if (digits.length >= 7) { memberNumbers.add(digits); if (!number) number = digits; }
        }
        members.push({ id: pp.id ?? null, number: number || null, admin: pp.admin ?? null });
      }
      this.groupCache.set(jid, {
        jid,
        subject: meta.subject ?? '(no name)',
        desc: meta.desc ?? '',
        size: meta.participants?.length ?? 0,
        isAdmin: !!meta.participants?.find((p) => p.admin && this.isSelf(p.id)),
        owner: meta.owner ?? null,
        // The community this group belongs to. Group @-mentions only render
        // for groups inside the same community, so we need it to decide
        // whether tagging another group is worth doing.
        community: meta.linkedParent ?? null,
        memberIds,
        memberNumbers,
        members,
      });
    }
    logger.info(`group cache refreshed: ${this.groupCache.size} groups`);
    this.emit('groups', this.groups());
    return this.groups();
  }

  groups() {
    return [...this.groupCache.values()]
      // drop internal Sets and the heavier per-member/desc fields from the list
      .map(({ memberIds, memberNumbers, members, desc, ...g }) => g)
      .sort((a, b) => a.subject.localeCompare(b.subject));
  }

  /** [{ jid, subject, desc }] for every cached group - for backup + editing. */
  groupDescriptionsSnapshot() {
    return [...this.groupCache.values()]
      .map((g) => ({ jid: g.jid, subject: g.subject, desc: g.desc ?? '' }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
  }

  /** Groups including per-member admin status (for the cross-group roster). */
  groupsWithMembers() {
    return [...this.groupCache.values()].map((g) => ({
      jid: g.jid,
      subject: g.subject,
      members: (g.members ?? []).map((m) => ({ ...m })),
    }));
  }

  /** Apply a batch of description edits: [{ jid, desc }] -> per-group results. */
  async applyDescriptions(plan = []) {
    const results = [];
    for (const item of plan ?? []) {
      const jid = item?.jid;
      const subject = this.groupCache.get(jid)?.subject ?? jid;
      if (!jid) { results.push({ jid, ok: false, error: 'missing jid' }); continue; }
      try {
        await this.setGroupDescription(jid, String(item.desc ?? ''));
        const cached = this.groupCache.get(jid);
        if (cached) cached.desc = String(item.desc ?? '');
        results.push({ jid, subject, ok: true });
      } catch (err) {
        results.push({ jid, subject, ok: false, error: err.message });
      }
      await sleep(1500);   // pace edits so WhatsApp does not rate-limit us
    }
    return results;
  }

  /** Bare phone number from a JID, or null for opaque @lid ids. */
  numberFromJid(jid) {
    if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null;
    const n = jid.split('@')[0].split(':')[0];
    return /^[0-9]{7,15}$/.test(n) ? n : null;
  }

  /** Full metadata for one group: description + members with admin status. */
  async groupDetails(jid) {
    const sock = this._requireSock();
    const meta = await sock.groupMetadata(jid);
    return {
      jid,
      subject: meta.subject ?? '',
      desc: meta.desc ?? '',
      owner: meta.owner ?? null,
      size: meta.participants?.length ?? 0,
      botIsAdmin: !!meta.participants?.find((p) => p.admin && this.isSelf(p.id)),
      members: (meta.participants ?? []).map((p) => ({
        id: p.id,
        number: this.numberFromJid(p.id) ?? (p.phoneNumber ? String(p.phoneNumber).replace(/[^0-9]/g, '') : null),
        admin: p.admin ?? null,
      })).sort((a, b) => (b.admin ? 1 : 0) - (a.admin ? 1 : 0)),
    };
  }

  async setGroupDescription(jid, description) {
    const sock = this._requireSock();
    await sock.groupUpdateDescription(jid, description ?? '');
    logger.info(`updated description for ${jid}`);
  }

  async setGroupSubject(jid, subject) {
    const sock = this._requireSock();
    await sock.groupUpdateSubject(jid, subject);
    logger.info(`updated subject for ${jid}`);
  }

  async modifyParticipants(jid, targets, action) {
    const sock = this._requireSock();
    if (!['add', 'remove', 'promote', 'demote'].includes(action)) {
      throw new Error(`invalid participant action: ${action}`);
    }
    const jids = (Array.isArray(targets) ? targets : [targets]).map((t) => {
      const v = String(t).trim();
      if (v.includes('@')) return v;
      return `${v.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    });
    const results = [];
    for (let i = 0; i < jids.length; i += 5) {
      const chunk = jids.slice(i, i + 5);
      const res = await sock.groupParticipantsUpdate(jid, chunk, action);
      for (const r of res ?? []) results.push({ jid: r.jid, status: r.status });
      if (i + 5 < jids.length) await sleep(1500);
    }
    logger.info(`${action} ${jids.length} participant(s) in ${jid}`);
    this.refreshGroups({ force: true }).catch(() => {});
    return results;
  }

  /** Lock (admins-only messaging) or unlock a single group. */
  async setGroupLocked(jid, locked) {
    const sock = this._requireSock();
    await sock.groupSettingUpdate(jid, locked ? 'announcement' : 'not_announcement');
  }

  /**
   * Gap to leave between group setting changes during a bulk lock/unlock.
   *
   * An explicit `override` from a caller is trusted (0 is a legitimate "no
   * pacing, I know what I am doing"). A value out of config is not: `null`,
   * `''` and `0` all coerce to "fire everything at once", which is the exact
   * flood this pacing exists to prevent, so anything that is not a positive
   * number falls back to the 5s default.
   */
  _lockdownPaceMs(override) {
    if (override !== undefined && override !== null) {
      const n = Number(override);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    const cfg = Number(this.config.lockdown?.paceMs);
    return Number.isFinite(cfg) && cfg > 0 ? cfg : DEFAULT_LOCKDOWN_PACE_MS;
  }

  /**
   * Lock or unlock EVERY group the bot administers.
   *
   * Deliberately slow: strictly one group at a time, with `paceMs` (5s by
   * default) of quiet between each one. Firing the whole set at WhatsApp at
   * once is what gets the connection throttled or dropped, so the pacing is
   * the feature rather than an accident - budget roughly five seconds per
   * group when a run is going to take a while.
   *
   * Runs are also serialized against each other: if a second bulk run is asked
   * for while one is still walking the groups, it waits its turn rather than
   * interleaving and leaving groups in mixed states. (The scheduler refuses a
   * second run outright; this chain is what protects direct callers, e.g. a
   * plugin.)
   *
   * Reports per group, including which ones were skipped because the bot is
   * not an admin.
   *
   * @param {boolean} locked
   * @param {{paceMs?: number, onProgress?: (p: {done:number,total:number,jid:string|null,subject:string|null}) => void}} [opts]
   */
  setAllGroupsLocked(locked, opts = {}) {
    const prior = this._lockAllRun ?? Promise.resolve();
    // Chain onto whatever is still walking the groups, so at most one setting
    // change is ever in flight no matter who asked for it.
    const run = prior.then(() => this._setAllGroupsLocked(locked, opts));
    this._lockAllRun = run.catch(() => {});   // failures must not poison the chain
    return run;
  }

  async _setAllGroupsLocked(locked, { paceMs, onProgress } = {}) {
    const gap = this._lockdownPaceMs(paceMs);
    const alwaysLocked = new Set(this.config.lockdown?.alwaysLocked ?? []);
    const all = this.groups();
    // Never OPEN a group that is meant to stay admins-only permanently. Those
    // cost no WhatsApp call, so they are not part of the paced count either.
    const skip = (g) => !locked && alwaysLocked.has(g.jid);
    const total = all.filter((g) => !skip(g)).length;

    logger.info(`${locked ? 'locking' : 'unlocking'} ${total} group(s) — one at a time, ${gap}ms apart`);
    onProgress?.({ done: 0, total, jid: null, subject: null });

    const results = [];
    let done = 0;
    for (const g of all) {
      if (skip(g)) {
        results.push({ jid: g.jid, subject: g.subject, skipped: 'always locked' });
        continue;
      }
      try {
        await this.setGroupLocked(g.jid, locked);
        results.push({ jid: g.jid, subject: g.subject, ok: true });
      } catch (err) {
        const notAdmin = /not-authorized|forbidden|403/i.test(err.message ?? '');
        results.push({ jid: g.jid, subject: g.subject, error: notAdmin ? 'bot is not admin' : err.message });
      }
      done += 1;
      logger.debug(`${locked ? 'locked' : 'unlocked'} ${done}/${total}: ${g.subject || g.jid}`);
      onProgress?.({ done, total, jid: g.jid, subject: g.subject ?? null });
      // Wait between groups - never after the last one, which would only
      // stall the caller for nothing.
      if (done < total && gap > 0) await sleep(gap);
    }
    logger.info(`${locked ? 'locked' : 'unlocked'} ${results.filter((r) => r.ok).length}/${results.length} groups`);
    return results;
  }

  /** Raw participant update for one group (used by the cross-group helpers). */
  async _rawParticipant(jid, number, action) {
    const sock = this._requireSock();
    const target = `${String(number).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    const res = await sock.groupParticipantsUpdate(jid, [target], action);
    return res?.[0]?.status ?? null;
  }

  /** Remove a number from every group it is currently in. */
  /**
   * Delete-for-everyone every message this person posted that is still inside
   * WhatsApp's revoke window. Requires the bot to be admin in the group; where
   * it is not, that group's deletions simply fail and are reported.
   */
  async deleteRecentMessagesFrom({ number = null, jid = null } = {}) {
    if (!this.messageIndex) return { deleted: 0, failed: 0, groups: [] };
    const sock = this._requireSock();
    const targets = this.messageIndex.forSender({ number, jid });
    let deleted = 0, failed = 0;
    const groups = new Set();
    for (const t of targets) {
      try {
        await sock.sendMessage(t.groupJid, { delete: t.key });
        deleted++;
        groups.add(this.groupCache.get(t.groupJid)?.subject ?? t.groupJid);
        await sleep(400);          // pace revokes so WhatsApp does not throttle us
      } catch (err) {
        failed++;
        logger.debug(`revoke failed in ${t.groupJid}: ${err.message}`);
      }
    }
    if (deleted || failed) {
      logger.info(`wiped ${deleted} message(s) from ${number ? `+${number}` : jid}` +
        `${failed ? ` (${failed} could not be deleted)` : ''}`);
    }
    this.messageIndex.forget({ number, jid });
    return { deleted, failed, groups: [...groups] };
  }

  async banFromAllGroups(number, { wipeMessages = true } = {}) {
    // Wipe their recent posts BEFORE removing them - once they are out of the
    // group the revoke can be rejected, and the message keys reference them.
    let wiped = { deleted: 0, failed: 0, groups: [] };
    if (wipeMessages) {
      try { wiped = await this.deleteRecentMessagesFrom({ number }); }
      catch (err) { logger.warn(`could not wipe messages for +${number}: ${err.message}`); }
    }
    const results = [];
    for (const g of this.groups()) {
      const info = this.groupMemberInfo(g.jid, { number });
      if (!info.isMember) continue;                    // only where they actually are
      try {
        const status = await this._rawParticipant(g.jid, number, 'remove');
        results.push({ jid: g.jid, subject: g.subject, status: status ?? 'removed' });
      } catch (err) {
        results.push({ jid: g.jid, subject: g.subject, error: err.message });
      }
      await sleep(1000);
    }
    this.refreshGroups({ force: true }).catch(() => {});
    logger.info(`banned +${number} from ${results.length} group(s)`);
    results.wiped = wiped;
    return results;
  }

  /** add / promote / demote a number across a chosen set of groups. */
  async participantAcrossGroups(number, groupJids, action) {
    const results = [];
    for (const jid of groupJids) {
      try {
        const status = await this._rawParticipant(jid, number, action);
        results.push({ jid, subject: this.groupCache.get(jid)?.subject ?? jid, status: status ?? 'ok' });
      } catch (err) {
        results.push({ jid, subject: this.groupCache.get(jid)?.subject ?? jid, error: err.message });
      }
      await sleep(1000);
    }
    this.refreshGroups({ force: true }).catch(() => {});
    logger.info(`${action} +${number} across ${groupJids.length} group(s)`);
    return results;
  }

  /**
   * Decide whether `requester` is in `groupJid`, and how to tag them.
   * Matches on the LID/JID first (stable per user across groups) and falls
   * back to the phone number. Returns { isMember, mentionJid, mentionText }.
   */
  groupMemberInfo(groupJid, { jid = null, number = null } = {}) {
    const g = this.groupCache.get(groupJid);
    const digits = number ? String(number).replace(/[^0-9]/g, '') : null;
    if (!g) return { isMember: false, mentionJid: null, mentionText: digits };

    const isMember =
      (jid && g.memberIds.has(jid)) ||
      (digits && (g.memberNumbers.has(digits) || g.memberIds.has(`${digits}@s.whatsapp.net`)));

    // Prefer a phone-JID mention so the tag renders as @<number> rather than
    // an opaque @<lid>. Fall back to the raw jid if that is all we have.
    const mentionJid = digits ? `${digits}@s.whatsapp.net` : jid;
    return { isMember: !!isMember, mentionJid, mentionText: digits ?? (jid ? jid.split('@')[0] : null) };
  }

  /** Is this person an admin of the group? (used to exempt staff from rules) */
  isGroupAdmin(groupJid, { jid = null, number = null } = {}) {
    const g = this.groupCache.get(groupJid);
    if (!g?.members) return false;
    const digits = number ? String(number).replace(/[^0-9]/g, '') : null;
    return g.members.some((m) => !!m.admin && (
      (jid && m.id === jid) ||
      (digits && (m.number === digits || m.id === `${digits}@s.whatsapp.net`))
    ));
  }

  /** Delete one message for everyone. Needs the bot to be a group admin. */
  async deleteMessage(msg) {
    const sock = this._requireSock();
    const key = msg?.key ?? msg;
    if (!key?.id || !key?.remoteJid) throw new Error('no message key');
    await sock.sendMessage(key.remoteJid, {
      delete: {
        remoteJid: key.remoteJid,
        fromMe: !!key.fromMe,
        id: key.id,
        participant: key.participant ?? msg?.senderJid ?? undefined,
      },
    });
  }

  /**
   * Every JID form this account can appear as in a participant list.
   *
   * Under WhatsApp's LID system our own entry may be the opaque `…@lid` rather
   * than the phone JID, and either form can carry a `:device` suffix. Matching
   * only one form made the bot believe it was never an admin anywhere, which
   * made the portal warn that every edit would fail - while the edits actually
   * worked. Collect all of them and compare against the set.
   */
  _selfIds() {
    const u = this.sock?.user ?? {};
    const out = new Set();
    const add = (v) => {
      if (typeof v !== 'string' || !v.includes('@')) return;
      const [local, domain] = v.split('@');
      const bare = local.split(':')[0];
      if (bare && domain) { out.add(`${bare}@${domain}`); out.add(v); }
    };
    add(u.id); add(u.lid); add(u.jid);
    const digits = String(u.id ?? '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    if (digits.length >= 7) out.add(`${digits}@s.whatsapp.net`);
    return out;
  }

  /** Is this participant id us? (LID- and device-suffix aware) */
  isSelf(jid) {
    if (typeof jid !== 'string' || !jid.includes('@')) return false;
    const [local, domain] = jid.split('@');
    return this._selfIds().has(`${local.split(':')[0]}@${domain}`);
  }

  /** Milliseconds since the group list was last actually fetched. */
  groupCacheAge() {
    return this._lastGroupFetch ? Date.now() - this._lastGroupFetch : Infinity;
  }
}
