import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import log from '../util/logger.js';

const logger = log.scope('archive');

/**
 * Everything the bot sees, kept.
 *
 * Append-only JSON lines in data/archive/<YYYY-MM-DD>/<HH>.jsonl, one file per
 * UTC hour, never pruned. This is the record an admin goes back to when
 * something happened in a group and has to be looked into: what was said, by
 * whom, what was deleted afterwards, who joined and left around it.
 *
 * A line is filed under the hour it was WRITTEN, not the hour the message was
 * sent (that is kept in `at`). A history sync can deliver last week's messages
 * today; filing them by send time would append to hours that are already
 * finished and sealed into the off-box backup, and a sealed hour must never
 * change. Filed by write time, a finished hour is genuinely finished.
 *
 * record() never throws. Losing one line to a full disk is bad; taking the
 * message pipeline down with it is far worse.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;
export const MAX_RAW_INLINE_BYTES = 64;
export const DEFAULT_MAX_IDS = 20_000;
export const SNAPSHOT_EVERY_MS = 6 * HOUR;
export const REQUEST_SCAN_EVERY_MS = MINUTE;

/** The UTC day and hour a timestamp falls in, as the archive names them. */
export function hourParts(ts) {
  const iso = new Date(ts).toISOString();          // always UTC, always 24-hour
  return { day: iso.slice(0, 10), hour: iso.slice(11, 13) };
}

/** Start of the UTC hour after the one `day`/`hour` names, in ms. */
export function hourEnd(day, hour) {
  return Date.parse(`${day}T${hour}:00:00.000Z`) + HOUR;
}

const isBytes = (v) => Buffer.isBuffer(v) || v instanceof Uint8Array;
const isLong = (v) => v && typeof v === 'object' && 'low' in v && 'high' in v && 'unsigned' in v;

/**
 * A raw Baileys message made safe to keep: media keys, thumbnails and other
 * binary blobs would otherwise serialise as huge arrays of numbers. Short ones
 * (keys, hashes) are kept as base64 so nothing that identifies the message is
 * lost; anything over 64 bytes is recorded only by size.
 */
export function trimRaw(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (depth > 16) return '[depth]';
  if (isBytes(v)) {
    const buf = Buffer.from(v);
    return buf.length > MAX_RAW_INLINE_BYTES ? { bytes: buf.length } : { b64: buf.toString('base64') };
  }
  // A serialised Buffer ({type:'Buffer', data:[...]}) comes back from JSON stores.
  if (typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) return trimRaw(Buffer.from(v.data), depth);
  if (isLong(v)) {
    try { return typeof v.toNumber === 'function' ? v.toNumber() : Number(BigInt.asUintN(64, (BigInt(v.high >>> 0) << 32n) | BigInt(v.low >>> 0))); }
    catch { return null; }
  }
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map((x) => trimRaw(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'function' || x === undefined) continue;
      out[k] = trimRaw(x, depth + 1);
    }
    return out;
  }
  return v;
}

const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v ?? null)).digest('hex');

/** The message under ephemeral / view-once wrappers. */
function innerOf(message) {
  return message?.ephemeralMessage?.message
    ?? message?.viewOnceMessage?.message
    ?? message?.viewOnceMessageV2?.message
    ?? message?.viewOnceMessageV2Extension?.message
    ?? message?.documentWithCaptionMessage?.message
    ?? message
    ?? {};
}

function textOf(inner) {
  return inner?.conversation
    ?? inner?.extendedTextMessage?.text
    ?? inner?.imageMessage?.caption
    ?? inner?.videoMessage?.caption
    ?? inner?.documentMessage?.caption
    ?? inner?.documentMessage?.fileName
    ?? inner?.buttonsResponseMessage?.selectedDisplayText
    ?? inner?.listResponseMessage?.title
    ?? '';
}

function contextOf(inner) {
  for (const v of Object.values(inner ?? {})) {
    if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
  }
  return null;
}

// WhatsApp's protocolMessage types that matter here.
const PROTO_REVOKE = 0;
const PROTO_EDIT = 14;

export class DataArchive {
  /**
   * @param dataDir  the bot's data directory; the archive lives in dataDir/archive
   * @param now      clock, injectable for tests
   * @param maxIds   how many message ids to remember for de-duplication
   */
  constructor({ dataDir, now = Date.now, maxIds = DEFAULT_MAX_IDS } = {}) {
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, 'archive');
    this.now = now;
    this.maxIds = maxIds;
    this.seen = new Set();
    this.timers = [];
    this.stats = { written: 0, dropped: 0, errors: 0, duplicates: 0, lastWriteAt: null, lastError: null, byKind: {} };
    this.requestHashes = this._loadJson('.request-hashes.json', {});
    this.snapshotHashes = this._loadJson('.snapshot-hashes.json', {});
    this.requestStores = [];
    this.snapshots = {};
    this.seed = {};
  }

  /* ----------------------------- writing ----------------------------- */

  /** Append one record. Never throws; returns whether it was written. */
  record(kind, data = {}) {
    try {
      const ts = this.now();
      const { day, hour } = hourParts(ts);
      const dir = path.join(this.dir, day);
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({ kind, ts, ...data });
      fs.appendFileSync(path.join(dir, `${hour}.jsonl`), `${line}\n`);
      this.stats.written++;
      this.stats.lastWriteAt = ts;
      this.stats.byKind[kind] = (this.stats.byKind[kind] ?? 0) + 1;
      return true;
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = err.message;
      if (this.stats.errors <= 3 || this.stats.errors % 100 === 0) logger.warn(`archive write failed: ${err.message}`);
      return false;
    }
  }

  /** Remember an id; false if it was already seen. Bounded, oldest forgotten first. */
  _firstTime(id) {
    if (this.seen.has(id)) { this.stats.duplicates++; return false; }
    this.seen.add(id);
    if (this.seen.size > this.maxIds) {
      const drop = this.seen.size - this.maxIds;
      let i = 0;
      for (const k of this.seen) { if (i++ >= drop) break; this.seen.delete(k); }
    }
    return true;
  }

  /**
   * One raw Baileys message, from any source: live, the reconnect backfill or
   * a history sync. Sorts it into a message, a reaction, an edit or a revoke.
   *
   * `normalize` is the bot's own flattener, used for the sender and number so
   * the archive resolves @lid senders exactly the way the rest of the bot does.
   */
  recordMessage(raw, { source = 'live', normalize = null } = {}) {
    try {
      if (!raw?.key || !raw.message) return false;
      const key = raw.key;
      const chat = key.remoteJid;
      if (!chat || chat === 'status@broadcast') return false;
      const inner = innerOf(raw.message);
      const norm = (() => { try { return normalize?.(raw) ?? null; } catch { return null; } })();
      const isGroup = chat.endsWith('@g.us');
      const from = norm?.senderJid ?? (isGroup ? (key.participant ?? raw.participant ?? null) : (key.fromMe ? null : chat));
      const who = {
        chat,
        id: key.id ?? null,
        from,
        number: norm?.senderNumber ?? null,
        pushName: raw.pushName ?? null,
        fromMe: !!key.fromMe,
        at: Number(trimRaw(raw.messageTimestamp) ?? 0) * 1000 || null,
        source,
      };

      const proto = inner.protocolMessage;
      if (proto && Number(proto.type) === PROTO_REVOKE) {
        const target = proto.key?.id ?? null;
        if (!this._firstTime(`${chat}/${target}/d`)) return false;
        return this.record('deleted', { ...who, target, raw: trimRaw(raw) });
      }

      let mode = 'm';
      let extra = {};
      if (inner.reactionMessage) {
        mode = 'r';
        extra = { reaction: inner.reactionMessage.text ?? '', target: inner.reactionMessage.key?.id ?? null };
      } else if ((proto && Number(proto.type) === PROTO_EDIT) || inner.editedMessage) {
        mode = 'e';
        const edited = innerOf(proto?.editedMessage ?? inner.editedMessage?.message ?? inner.editedMessage);
        extra = { edit: textOf(edited), target: proto?.key?.id ?? null };
      } else if (proto) {
        return false;    // other protocol traffic (keys, history notices) is not a message
      }

      if (!this._firstTime(`${chat}/${who.id}/${mode}`)) return false;
      const ctx = contextOf(inner);
      return this.record('message', {
        ...who,
        mode,
        type: Object.keys(inner)[0] ?? 'unknown',
        text: mode === 'm' ? String(textOf(inner) || '') : '',
        replyTo: ctx?.stanzaId ? { id: ctx.stanzaId, from: ctx.participant ?? null } : null,
        mentions: Array.isArray(ctx?.mentionedJid) && ctx.mentionedJid.length ? ctx.mentionedJid : null,
        ...extra,
        raw: trimRaw(raw),
      });
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = err.message;
      return false;
    }
  }

  recordMessages(list, opts = {}) {
    let n = 0;
    for (const raw of Array.isArray(list) ? list : []) if (this.recordMessage(raw, opts)) n++;
    return n;
  }

  /** Something the bot sent, reacted with, edited or deleted - or failed to. */
  recordBot({ jid, content, result = null, error = null, op = 'send' } = {}) {
    let kind = op;
    if (content?.react) kind = 'react';
    else if (content?.delete) kind = 'delete';
    else if (content?.edit) kind = 'edit';
    return this.record('bot', {
      op: kind,
      chat: jid ?? null,
      id: result?.key?.id ?? null,
      text: content?.text ?? content?.caption ?? content?.react?.text ?? null,
      content: trimRaw(content),
      ok: !error,
      error: error ? String(error.message ?? error) : null,
    });
  }

  /** A join, leave, removal, promotion or join request. */
  recordGroupEvent(ev) {
    return this.record('group-event', trimRaw(ev ?? {}));
  }

  /* ------------------------- request versions ------------------------ */

  /**
   * Every row of every request store, hashed; a row is written whenever it is
   * new or has changed since it was last written. The hashes are kept on disk,
   * so a restart does not write every row again.
   *
   * A store is `{ name, rows: () => [row] }` where each row has an `id`.
   */
  scanRequests() {
    let written = 0;
    for (const store of this.requestStores) {
      let rows = [];
      try { rows = store.rows() ?? []; } catch (err) { logger.debug(`request store ${store.name}: ${err.message}`); continue; }
      for (const row of rows) {
        const id = row?.id ?? row?.key ?? null;
        if (id === null || id === undefined) continue;
        const k = `${store.name}/${id}`;
        const h = hash(row);
        if (this.requestHashes[k] === h) continue;
        if (this.record('request', { store: store.name, rowId: id, row: trimRaw(row) })) {
          this.requestHashes[k] = h;
          written++;
        }
      }
    }
    if (written) this._saveJson('.request-hashes.json', this.requestHashes);
    return written;
  }

  /* ----------------------------- snapshots --------------------------- */

  /** Each snapshot source, written only when it differs from the last one written. */
  checkSnapshots() {
    let written = 0;
    for (const [name, get] of Object.entries(this.snapshots)) {
      let data;
      try { data = get(); } catch (err) { logger.debug(`snapshot ${name}: ${err.message}`); continue; }
      if (data === undefined) continue;
      const h = hash(data);
      if (this.snapshotHashes[name] === h) continue;
      if (this.record('snapshot', { name, data: trimRaw(data) })) {
        this.snapshotHashes[name] = h;
        written++;
      }
    }
    if (written) this._saveJson('.snapshot-hashes.json', this.snapshotHashes);
    return written;
  }

  /* -------------------------------- seed ----------------------------- */

  /**
   * Once per box: everything the bot already held before the archive existed,
   * so the record starts with the history rather than on the day it was
   * switched on. A .seeded marker makes it once.
   */
  seedOnce() {
    const marker = path.join(this.dir, '.seeded');
    if (fs.existsSync(marker)) return 0;
    let written = 0;
    for (const [name, get] of Object.entries(this.seed)) {
      let data;
      try { data = get(); } catch (err) { logger.debug(`seed ${name}: ${err.message}`); continue; }
      if (data === undefined || data === null) continue;
      if (this.record(`seed:${name}`, { data: trimRaw(data) })) written++;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(marker, JSON.stringify({ at: this.now(), sources: Object.keys(this.seed) }));
    } catch (err) { logger.warn(`could not write seed marker: ${err.message}`); }
    if (written) logger.info(`archive seeded with ${written} existing data set(s)`);
    return written;
  }

  /* ----------------------------- reading ----------------------------- */

  /** Every hour file, oldest first: { day, hour, file, bytes }. */
  files() {
    const out = [];
    let days = [];
    try { days = fs.readdirSync(this.dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); } catch { return out; }
    for (const day of days) {
      let hours = [];
      try { hours = fs.readdirSync(path.join(this.dir, day)).filter((f) => /^\d{2}\.jsonl$/.test(f)).sort(); } catch { continue; }
      for (const f of hours) {
        const file = path.join(this.dir, day, f);
        let bytes = 0;
        try { bytes = fs.statSync(file).size; } catch { /* vanished */ }
        out.push({ day, hour: f.slice(0, 2), file, bytes });
      }
    }
    return out;
  }

  /**
   * Walk the archive, newest hour first unless `oldestFirst`.
   *   keep(rec)   - which records match (default: all)
   *   pick(rec)   - what to return for each (default: the record)
   *   since       - skip hours that ended before this time
   */
  search({ pick = (r) => r, keep = () => true, limit = 200, since = null, oldestFirst = false } = {}) {
    const out = [];
    const max = Math.max(1, Math.min(Number(limit) || 200, 100_000));
    let files = this.files();
    if (since) files = files.filter((f) => hourEnd(f.day, f.hour) > since);
    if (!oldestFirst) files.reverse();
    for (const f of files) {
      let lines;
      try { lines = fs.readFileSync(f.file, 'utf8').split('\n'); } catch { continue; }
      if (!oldestFirst) lines.reverse();
      for (const line of lines) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (since && (rec.ts ?? 0) < since) continue;
        let ok = false;
        try { ok = keep(rec); } catch { ok = false; }
        if (!ok) continue;
        out.push(pick(rec));
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  status() {
    const files = this.files();
    return {
      dir: this.dir,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      oldest: files[0] ? `${files[0].day} ${files[0].hour}:00` : null,
      newest: files.length ? `${files.at(-1).day} ${files.at(-1).hour}:00` : null,
      seeded: fs.existsSync(path.join(this.dir, '.seeded')),
      running: this.timers.length > 0,
      ...this.stats,
    };
  }

  /* --------------------------- the routine ---------------------------- */

  /**
   * requestStores: [{ name, rows() }] scanned every minute
   * snapshots:     { name: () => data } checked a minute after start, then six-hourly
   * seed:          { name: () => data } written once per box
   */
  start({ requestStores = [], snapshots = {}, seed = {} } = {}) {
    this.stop();
    this.requestStores = requestStores;
    this.snapshots = snapshots;
    this.seed = seed;
    try { this.seedOnce(); } catch (err) { logger.warn(`seed failed: ${err.message}`); }
    const every = (ms, fn) => { const t = setInterval(() => { try { fn(); } catch (err) { logger.warn(err.message); } }, ms); t.unref?.(); this.timers.push(t); };
    const once = (ms, fn) => { const t = setTimeout(() => { try { fn(); } catch (err) { logger.warn(err.message); } }, ms); t.unref?.(); this.timers.push(t); };
    every(REQUEST_SCAN_EVERY_MS, () => this.scanRequests());
    once(MINUTE, () => this.checkSnapshots());
    every(SNAPSHOT_EVERY_MS, () => this.checkSnapshots());
    logger.info(`archive running -> ${this.dir}`);
  }

  stop() {
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = [];
  }

  _loadJson(name, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return fallback; }
  }

  _saveJson(name, value) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, name);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) { logger.debug(`could not save ${name}: ${err.message}`); }
  }
}
