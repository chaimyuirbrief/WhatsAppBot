import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import log from '../util/logger.js';
import { hourEnd } from './data-archive.js';

const logger = log.scope('archive-backup');

/**
 * The data archive, copied off the box.
 *
 * The archive is only worth keeping if it outlives the machine it is on. Each
 * FINISHED hour is sealed (gzip, then AES-256-GCM) and committed to an orphan
 * branch, `data-archive`, of the bot's own git remote. The branch holds
 * nothing readable: without BACKUP_PASSPHRASE from .env every file on it is
 * noise.
 *
 * Every hour file is written to the branch exactly once. The current hour is
 * never sealed, because it is still being written to. The branch is also the
 * way back: an hour the branch has and this box lacks (a rebuilt box, a lost
 * disk) is opened and put back into data/archive.
 *
 * Without a passphrase it refuses with a clear error rather than pushing
 * anything in the clear; the archive then stays on this box only.
 */

export const BRANCH = 'data-archive';
export const MAGIC = Buffer.from('WADAT1');
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT_CONTEXT = 'whatsapp-bot data-archive';
export const MAX_HOURS_PER_PUSH = 500;
const MINUTE = 60_000;
export const RETRY_MS = 15 * MINUTE;
export const MORE_MS = MINUTE;
export const FIRST_PASS_MS = 30_000;

export const NO_PASSPHRASE =
  'BACKUP_PASSPHRASE is not set in .env, so the data archive is NOT backed up off this box. ' +
  'Add BACKUP_PASSPHRASE=<a long secret> to .env and restart. Keep the passphrase somewhere safe: ' +
  'without it the backup cannot be opened.';

const README = `# Data archive backup

Every file in this branch was written by the bot, not by a person.

\`archive/<day>/<HH>.jsonl.gz.enc\` is one finished UTC hour of the bot's data
archive, gzipped and then sealed with AES-256-GCM. The key comes from the
BACKUP_PASSPHRASE in the bot's .env together with the random salt in
\`KEY-SALT\`. Without the passphrase the files cannot be read.

Do not edit, rename or delete anything here. Each hour is written once and
never changes; the bot restores hours from this branch onto a box that lacks
them.
`;

export function deriveKey(passphrase, saltHex) {
  return crypto.scryptSync(String(passphrase), `${SALT_CONTEXT}${saltHex}`, 32);
}

/** gzip + AES-256-GCM: 'WADAT1' | IV(12) | tag(16) | ciphertext. */
export function seal(plain, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(zlib.gzipSync(plain)), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

/** The reverse of seal(). Throws on a wrong key or a damaged file. */
export function open(sealed, key) {
  const buf = Buffer.from(sealed);
  if (buf.length < MAGIC.length + IV_LEN + TAG_LEN || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a sealed archive file');
  }
  let o = MAGIC.length;
  const iv = buf.subarray(o, o += IV_LEN);
  const tag = buf.subarray(o, o += TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return zlib.gunzipSync(Buffer.concat([decipher.update(buf.subarray(o)), decipher.final()]));
  } catch {
    throw new Error('cannot open archive file: wrong passphrase or damaged file');
  }
}

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) { err.message = `git ${args[0]}: ${(stderr || err.message).trim()}`; reject(err); }
        else resolve(stdout);
      });
  });
}

/** Milliseconds from `now` until the next :05 past the hour. */
export function msUntilNextPass(now) {
  const d = new Date(now);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 5, 0, 0));
  if (next.getTime() <= now) next.setUTCHours(next.getUTCHours() + 1);
  return next.getTime() - now;
}

export class DataArchiveBackup {
  /**
   * @param archive     the DataArchive whose hours are sealed
   * @param dataDir     the clone lives in dataDir/data-archive-backup
   * @param appRoot     the bot's checkout; its `origin` is the default remote
   * @param remote      override the remote (a path or URL), mainly for tests
   * @param passphrase  defaults to process.env.BACKUP_PASSPHRASE, read per pass
   */
  constructor({ archive, dataDir, appRoot = null, remote = null, passphrase, now = Date.now, maxPerPush = MAX_HOURS_PER_PUSH } = {}) {
    this.archive = archive;
    this.dir = path.join(dataDir, 'data-archive-backup');
    this.appRoot = appRoot;
    this.remote = remote;
    this._passphrase = passphrase;
    this.now = now;
    this.maxPerPush = maxPerPush;
    this.timer = null;
    this.running = false;
    this.busy = null;
    this._key = null;
    this.state = { lastRunAt: null, lastOkAt: null, lastError: null, sealed: 0, restored: 0, pending: 0, onBranch: 0, nextRunAt: null };
  }

  get passphrase() {
    return this._passphrase !== undefined ? this._passphrase : (process.env.BACKUP_PASSPHRASE ?? '');
  }

  async _remoteUrl() {
    if (this.remote) return this.remote;
    if (!this.appRoot) throw new Error('no git remote to back up to');
    return (await git(['remote', 'get-url', 'origin'], this.appRoot)).trim();
  }

  /** Make dataDir/data-archive-backup a clone of the branch (or a fresh orphan of it). */
  async _prepare() {
    const url = await this._remoteUrl();
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      await git(['init', '-q'], this.dir);
      await git(['remote', 'add', 'origin', url], this.dir);
    } else {
      await git(['remote', 'set-url', 'origin', url], this.dir);
    }
    let fetched = false;
    try { await git(['fetch', '-q', 'origin', BRANCH], this.dir); fetched = true; } catch { /* branch not there yet */ }
    if (fetched) {
      // The branch is the record. Anything local that never got pushed is
      // rebuilt from the archive itself on this same pass.
      await git(['checkout', '-q', '-B', BRANCH, 'FETCH_HEAD'], this.dir);
      await git(['reset', '-q', '--hard', 'FETCH_HEAD'], this.dir);
    } else {
      let hasHead = true;
      try { await git(['rev-parse', '--verify', '-q', 'HEAD'], this.dir); } catch { hasHead = false; }
      if (!hasHead) await git(['checkout', '-q', '--orphan', BRANCH], this.dir);
    }
  }

  _keyFor() {
    const saltFile = path.join(this.dir, 'KEY-SALT');
    let salt = '';
    try { salt = fs.readFileSync(saltFile, 'utf8').trim(); } catch { /* new branch */ }
    if (!/^[0-9a-f]{32,}$/.test(salt)) {
      salt = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(saltFile, `${salt}\n`);
    }
    // scrypt is deliberately slow: derive once per run, not once per file.
    if (!this._key || this._key.salt !== salt || this._key.pass !== this.passphrase) {
      this._key = { salt, pass: this.passphrase, key: deriveKey(this.passphrase, salt) };
    }
    return this._key.key;
  }

  _branchHours() {
    const base = path.join(this.dir, 'archive');
    const out = [];
    let days = [];
    try { days = fs.readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); } catch { return out; }
    for (const day of days) {
      for (const f of fs.readdirSync(path.join(base, day))) {
        const m = /^(\d{2})\.jsonl\.gz\.enc$/.exec(f);
        if (m) out.push({ day, hour: m[1], file: path.join(base, day, f) });
      }
    }
    return out;
  }

  /** One full pass: seal finished hours, restore missing ones, commit, push. */
  async runOnce() {
    if (this.busy) return this.busy;
    this.busy = this._run().finally(() => { this.busy = null; });
    return this.busy;
  }

  async _run() {
    this.state.lastRunAt = this.now();
    try {
      if (!this.passphrase) throw new Error(NO_PASSPHRASE);
      await this._prepare();
      const key = this._keyFor();
      if (!fs.existsSync(path.join(this.dir, 'README.md'))) fs.writeFileSync(path.join(this.dir, 'README.md'), README);

      // Restore what the branch has and this box lacks.
      const local = new Set(this.archive.files().map((f) => `${f.day}/${f.hour}`));
      let restored = 0;
      for (const b of this._branchHours()) {
        if (local.has(`${b.day}/${b.hour}`)) continue;
        const plain = open(fs.readFileSync(b.file), key);
        const dest = path.join(this.archive.dir, b.day, `${b.hour}.jsonl`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(`${dest}.tmp`, plain);
        fs.renameSync(`${dest}.tmp`, dest);
        local.add(`${b.day}/${b.hour}`);
        restored++;
      }

      // Seal each finished hour the branch does not have yet. Never rewrite one.
      const onBranch = new Set(this._branchHours().map((b) => `${b.day}/${b.hour}`));
      const now = this.now();
      const todo = this.archive.files()
        .filter((f) => hourEnd(f.day, f.hour) <= now && !onBranch.has(`${f.day}/${f.hour}`));
      const batch = todo.slice(0, this.maxPerPush);
      for (const f of batch) {
        const dest = path.join(this.dir, 'archive', f.day, `${f.hour}.jsonl.gz.enc`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, seal(fs.readFileSync(f.file), key));
      }

      // Commit whatever is there - including files a previous pass wrote and
      // then failed to commit.
      await git(['add', '-A', '.'], this.dir);
      const dirty = (await git(['status', '--porcelain'], this.dir)).trim();
      if (dirty) {
        await git(['-c', 'user.name=whatsapp-bot', '-c', 'user.email=whatsapp-bot@localhost', 'commit', '-q',
          '-m', `Seal ${batch.length} archive hour${batch.length === 1 ? '' : 's'}`], this.dir);
        await git(['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], this.dir);
      }

      this.state.sealed += batch.length;
      this.state.restored += restored;
      this.state.pending = todo.length - batch.length;
      this.state.onBranch = this._branchHours().length;
      this.state.lastOkAt = this.now();
      this.state.lastError = null;
      if (batch.length || restored) logger.info(`archive backup: sealed ${batch.length}, restored ${restored}, ${this.state.pending} still to go`);
      return { ok: true, sealed: batch.length, restored, pending: this.state.pending, pushed: !!dirty };
    } catch (err) {
      this.state.lastError = err.message;
      logger.warn(`archive backup failed: ${err.message}`);
      throw err;
    }
  }

  _schedule(ms) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.state.nextRunAt = this.now() + ms;
    this.timer = setTimeout(() => this._tick(), ms);
    this.timer.unref?.();
  }

  async _tick() {
    try {
      const r = await this.runOnce();
      this._schedule(r.pending > 0 ? MORE_MS : msUntilNextPass(this.now()));
    } catch (err) {
      // No passphrase is not going to fix itself in 15 minutes, but checking
      // costs nothing and picks it up if .env is edited and reloaded.
      this._schedule(RETRY_MS);
    }
  }

  start() {
    this.stop();
    this.running = true;
    if (!this.passphrase) logger.warn(NO_PASSPHRASE);
    this._schedule(FIRST_PASS_MS);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.state.nextRunAt = null;
  }

  status() {
    return { enabled: !!this.passphrase, branch: BRANCH, running: this.running, busy: !!this.busy, ...this.state };
  }
}
