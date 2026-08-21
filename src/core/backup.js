/**
 * Backup and restore: everything needed to stand this bot up again on a new
 * machine, in one encrypted file.
 *
 * What has to travel is not obvious, and getting it wrong is only discovered
 * later, on the new box, when it is too late:
 *
 *  - `data/config.json` holds the settings, the admin accounts and the
 *    encrypted secrets.
 *  - `.env` holds MASTER_KEY, which is what those secrets are encrypted WITH.
 *    A copy of the data directory alone restores to settings nobody can read,
 *    which looks like a successful restore right up until the email password
 *    and session secret come back blank. So the key travels too.
 *  - `data/session/` is the WhatsApp link. Without it the phone has to be
 *    re-paired, which is the one step a rebuild cannot do unattended.
 *  - `data/state.json` is the audit log, lockdown state, member activity and
 *    the banned list.
 *
 * Logs are deliberately left out: they are large, they regenerate, and nothing
 * about a rebuild needs them.
 *
 * Because the file therefore contains a working WhatsApp session and the key
 * to every stored secret, it is ALWAYS encrypted with a passphrase. There is
 * no plaintext option - an unencrypted copy of this is a total compromise of
 * the account it came from, and it would inevitably end up in a Downloads
 * folder or an email attachment.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

/** First line of the file: identifies it to humans and to `file`. */
export const MAGIC = 'WABAK1';

/** Bumped only when an older reader could not understand a newer file. */
export const FORMAT_VERSION = 1;

const CIPHER = 'aes-256-gcm';

/**
 * Ceiling on the decompressed payload. The service runs under a 700M memory
 * cap (see whatsapp-bot.service.template), and gunzip of a hostile file would
 * otherwise be bounded only by that. Real backups are a few MB: session files
 * and state, with logs excluded.
 */
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const KDF = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };   // ~100ms, sized against offline guessing

/** Shortest passphrase accepted. This guards a WhatsApp session; 12 is the floor. */
export const MIN_PASSPHRASE = 12;

/**
 * What goes in, by section. `config` is not optional - a backup without it
 * cannot rebuild anything, and it is also the smallest part.
 */
export const SECTIONS = {
  config: {
    label: 'Settings and admin accounts',
    always: true,
    files: ['config.json'],
  },
  session: {
    label: 'WhatsApp link (avoids re-pairing the phone)',
    dirs: ['session'],
    sensitive: true,
  },
  state: {
    label: 'Audit log, lockdown state, member activity, banned numbers',
    files: ['state.json'],
  },
  backups: {
    label: 'Saved original group descriptions',
    dirs: ['backups'],
  },
};

/** Never captured, whatever section they fall under. */
const EXCLUDE = [
  /^logs\//,             // large, regenerated, never needed to rebuild
  /^extra-ca\.pem$/,     // rebuilt from certs/ by start.sh on every launch
  /\.tmp$/,              // half-written files
  /^bot-cmd(\.result)?\.json$/,
  /\.corrupt-\d+$/,
];

const excluded = (rel) => EXCLUDE.some((re) => re.test(rel));

/** Every file under `dir`, as paths relative to `base`. */
function walk(dir, base, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (excluded(rel)) continue;
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** MASTER_KEY as index.js mints it: a hex token, nothing else. */
export function isMasterKey(v) {
  return typeof v === 'string' && /^[A-Za-z0-9+/=_-]{16,512}$/.test(v);
}

/** Pull MASTER_KEY out of an .env file without disturbing anything else in it. */
export function readMasterKey(envPath) {
  try {
    return fs.readFileSync(envPath, 'utf8').match(/^MASTER_KEY=(.+)$/m)?.[1]?.trim() || null;
  } catch { return null; }
}

/**
 * Write MASTER_KEY into an .env file, replacing an existing line and leaving
 * every other variable alone. A restore must not silently drop a DATA_DIR or
 * PORT someone set on this machine.
 */
export function writeMasterKey(envPath, key) {
  // A newline here would inject extra variables into .env; `$&` and friends
  // would be expanded by String.replace. The key is a hex token, so anything
  // that is not one is refused rather than sanitised.
  if (!isMasterKey(key)) throw new Error('Refusing to write a malformed MASTER_KEY');

  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch { /* new file */ }
  const line = `MASTER_KEY=${key}`;
  const next = /^MASTER_KEY=.*$/m.test(text)
    ? text.replace(/^MASTER_KEY=.*$/m, () => line)   // function form: no $-expansion
    : (text && !text.endsWith('\n') ? `${text}\n` : text) + `${line}\n`;
  fs.writeFileSync(envPath, next, { mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch { /* best effort on odd filesystems */ }
}

/**
 * Gather everything a rebuild needs.
 *
 * @param {{dataDir: string, root: string, sections?: string[], now?: number}} opts
 *   `sections` defaults to all of them; `config` is added whether asked for or not.
 * @returns {{manifest: object, masterKey: string|null, files: Record<string,string>}}
 */
export function collectBackup({ dataDir, root, sections = null, now = Date.now() }) {
  const want = new Set(sections ?? Object.keys(SECTIONS));
  want.add('config');

  const files = {};
  const counts = {};

  for (const [name, spec] of Object.entries(SECTIONS)) {
    if (!want.has(name)) continue;
    let n = 0;
    for (const f of spec.files ?? []) {
      const full = path.join(dataDir, f);
      if (!fs.existsSync(full) || excluded(f)) continue;
      files[f] = fs.readFileSync(full).toString('base64');
      n += 1;
    }
    for (const d of spec.dirs ?? []) {
      for (const rel of walk(path.join(dataDir, d), dataDir)) {
        files[rel] = fs.readFileSync(path.join(dataDir, rel)).toString('base64');
        n += 1;
      }
    }
    counts[name] = n;
  }

  // The key travels with the config it decrypts; without it the restore is
  // settings nobody can read.
  const masterKey = want.has('config') ? readMasterKey(path.join(root, '.env')) : null;

  const bytes = Object.values(files).reduce((t, b64) => t + Buffer.byteLength(b64, 'base64'), 0);

  return {
    manifest: {
      createdAt: now,
      sections: [...want],
      counts,
      fileCount: Object.keys(files).length,
      bytes,
      hasMasterKey: !!masterKey,
      app: readAppVersion(root),
      node: process.version,
    },
    masterKey,
    files,
  };
}

function readAppVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? null;
  } catch { return null; }
}

/**
 * Serialise, compress and encrypt.
 *
 * The header stays readable so a file can be identified and inspected without
 * the passphrase, and it is fed to the cipher as additional authenticated data
 * so it cannot be edited without the decrypt failing.
 */
export function packBackup({ manifest, masterKey, files }, passphrase) {
  assertPassphrase(passphrase);

  const body = zlib.gzipSync(Buffer.from(JSON.stringify({ masterKey, files }), 'utf8'), { level: 6 });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, KDF.keylen, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 256 * 1024 * 1024 });

  const header = {
    format: FORMAT_VERSION,
    cipher: CIPHER,
    kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    manifest,
  };
  const headerJson = JSON.stringify(header);

  const c = crypto.createCipheriv(CIPHER, key, iv);
  c.setAAD(Buffer.from(headerJson, 'utf8'));
  const enc = Buffer.concat([c.update(body), c.final()]);

  return Buffer.concat([
    Buffer.from(`${MAGIC}\n${headerJson}\n`, 'utf8'),
    c.getAuthTag(),
    enc,
  ]);
}

/**
 * Read the header without decrypting anything. Lets the portal show what a
 * file contains, and when it was made, before asking for the passphrase.
 */
export function inspectBackup(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const firstNl = b.indexOf(0x0a);
  if (firstNl === -1 || b.subarray(0, firstNl).toString('utf8') !== MAGIC) {
    throw new Error('Not a bot backup file');
  }
  const secondNl = b.indexOf(0x0a, firstNl + 1);
  if (secondNl === -1) throw new Error('Backup file is truncated');

  let header;
  try {
    header = JSON.parse(b.subarray(firstNl + 1, secondNl).toString('utf8'));
  } catch {
    throw new Error('Backup header is unreadable');
  }
  if (header.format > FORMAT_VERSION) {
    throw new Error(`This backup was written by a newer version (format ${header.format}); upgrade the bot before restoring`);
  }
  return { header, bodyAt: secondNl + 1 };
}

/** Decrypt and decompress. Throws a plain "wrong passphrase" when it is wrong. */
export function unpackBackup(buf, passphrase) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const { header, bodyAt } = inspectBackup(b);
  if (!passphrase) throw new Error('A passphrase is required to read this backup');

  const tag = b.subarray(bodyAt, bodyAt + 16);
  const enc = b.subarray(bodyAt + 16);
  if (tag.length < 16) throw new Error('Backup file is truncated');

  const kdf = header.kdf ?? {};
  const key = crypto.scryptSync(
    passphrase, Buffer.from(kdf.salt ?? '', 'base64'), KDF.keylen,
    { N: kdf.N ?? KDF.N, r: kdf.r ?? KDF.r, p: kdf.p ?? KDF.p, maxmem: 256 * 1024 * 1024 },
  );

  let plain;
  try {
    const d = crypto.createDecipheriv(header.cipher ?? CIPHER, key, Buffer.from(header.iv ?? '', 'base64'));
    d.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
    d.setAuthTag(tag);
    plain = Buffer.concat([d.update(enc), d.final()]);
  } catch {
    // GCM cannot tell a wrong key from a tampered file, and the honest reading
    // for someone restoring their own backup is the first one.
    throw new Error('Wrong passphrase, or the backup file is damaged');
  }

  let payload;
  try {
    payload = JSON.parse(zlib.gunzipSync(plain, { maxOutputLength: MAX_UNPACKED_BYTES }).toString('utf8'));
  } catch (err) {
    if (/maxOutputLength|buffer/i.test(err?.message ?? '')) {
      throw new Error('Backup is too large to unpack safely');
    }
    throw new Error('Backup contents are unreadable');
  }
  return { header, manifest: header.manifest ?? {}, ...payload };
}

/**
 * The only relative paths a restore will write.
 *
 * "Anywhere under data/" is too generous. A hostile archive - and the whole
 * point of a backup is that it gets carried between machines and handed to
 * people - could drop `pwn/index.js` there, then point `plugins.enabled` in
 * the config it also restores at `../../data/pwn`, and index.js would import
 * it on the next start. So a restore may only write the paths a backup is
 * actually MADE of, and never anything the runtime would execute.
 */
export function isRestorablePath(rel) {
  const norm = String(rel ?? '').split(path.sep).join('/');
  if (!norm || norm.split('/').includes('..')) return false;
  if (/\.(js|mjs|cjs|node|so|sh|bash|py)$/i.test(norm)) return false;
  for (const spec of Object.values(SECTIONS)) {
    if ((spec.files ?? []).includes(norm)) return true;
    if ((spec.dirs ?? []).some((d) => norm.startsWith(`${d}/`) && norm.length > d.length + 1)) return true;
  }
  return false;
}

/**
 * Where a file from the archive may be written, or null if it may not be.
 *
 * An archive is untrusted input even when it is your own: one carrying
 * `../../etc/cron.d/run-me` must land nowhere. Resolved and re-checked against
 * the target rather than pattern-matched, so `a/../../b` and absolute paths are
 * both caught.
 */
export function safeTarget(dataDir, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  // Our own archives only ever use '/'. A backslash is a legal filename
  // character on Linux, so `..\x` is not traversal HERE - but it is on
  // Windows, and nothing we write ever contains one, so it is refused rather
  // than reasoned about per-platform.
  if (rel.includes('\\')) return null;
  const base = path.resolve(dataDir);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  if (excluded(rel.split(path.sep).join('/'))) return null;
  if (!isRestorablePath(rel)) return null;
  return full;
}

/**
 * Where `target` really lands once the filesystem has had its say, or null if
 * that is outside `dataDirReal`.
 *
 * safeTarget() checks the path STRING; this checks the disk. They are not the
 * same question: a symlink sitting at `data/config.json`, or a symlinked
 * directory component, passes every string test and still writes wherever it
 * points. Resolving the deepest ancestor that actually exists is what catches
 * both, and it has to happen before any mkdir, or the directories themselves
 * get created on the far side of the link.
 *
 * Reaching this needs write access to a 0700 data directory, so it is not a
 * remote hole - but a restore run under sudo would turn it into one, and the
 * check is two syscalls.
 */
function resolveInside(dataDirReal, rel) {
  const parts = String(rel).split('/').filter(Boolean);
  if (!parts.length || parts.includes('..') || parts.includes('.')) return null;

  let cur = dataDirReal;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(cur, parts[i]);
    let st = null;
    // lstat, NOT exists: existsSync follows the link, so a symlink whose
    // target does not exist yet reads as "nothing here" and the write sails
    // straight through it to wherever it points.
    try { st = fs.lstatSync(next); } catch { st = null; }
    if (st?.isSymbolicLink()) return null;
    if (st && i < parts.length - 1 && !st.isDirectory()) return null;
    cur = next;
  }
  return cur;
}

/**
 * Apply a backup to a data directory.
 *
 * Everything is validated before anything is written, and whatever is already
 * there is moved aside rather than overwritten, so a restore that turns out to
 * be the wrong file is recoverable by hand.
 *
 * @returns {{restored: string[], skipped: string[], movedAside: string|null, masterKey: boolean}}
 */
export function restoreBackup({ payload, dataDir, root, dryRun = false, now = Date.now() }) {
  const files = payload?.files ?? {};
  const restored = [];
  const skipped = [];
  const planned = [];

  for (const [rel, b64] of Object.entries(files)) {
    const target = safeTarget(dataDir, rel);
    if (!target) { skipped.push(rel); continue; }
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { skipped.push(rel); continue; }
    planned.push({ rel, target, buf });
  }

  if (!planned.length) throw new Error('This backup contains no files that can be restored');
  if (dryRun) {
    return { restored: planned.map((p) => p.rel), skipped, movedAside: null, masterKey: !!payload?.masterKey };
  }

  // Keep what is being replaced. A restore is destructive and irreversible
  // otherwise, and the moment anyone notices it was the wrong file is after.
  let movedAside = null;
  if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length) {
    movedAside = `${dataDir}.pre-restore-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
    fs.cpSync(dataDir, movedAside, { recursive: true });
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const dataDirReal = fs.realpathSync(dataDir);

  for (const { rel, buf } of planned) {
    // Walked component by component against the real directory, so no mkdir
    // ever happens through a link either.
    const safe = resolveInside(dataDirReal, rel);
    if (!safe) { skipped.push(rel); continue; }
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, buf, { mode: 0o600 });
    restored.push(rel);
  }
  try { fs.chmodSync(dataDir, 0o700); } catch { /* best effort */ }

  let wroteKey = false;
  if (payload?.masterKey && root) {
    if (!isMasterKey(payload.masterKey)) {
      throw new Error('This backup carries a malformed MASTER_KEY and was not applied');
    }
    writeMasterKey(path.join(root, '.env'), payload.masterKey);
    wroteKey = true;
  }

  return { restored, skipped, movedAside, masterKey: wroteKey };
}

function assertPassphrase(p) {
  if (typeof p !== 'string' || p.length < MIN_PASSPHRASE) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
}

/**
 * A manifest reduced to known fields of known types.
 *
 * The header of a .wabak is PLAINTEXT and unauthenticated - `inspectBackup`
 * deliberately reads it without a passphrase so a file can be identified. That
 * makes every value in it attacker-controlled for any file someone hands you,
 * so nothing from it should reach a UI, a terminal or a log unfiltered.
 */
export function safeManifest(m) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const str = (v, max = 64) => (typeof v === 'string' ? v.slice(0, max).replace(/[^\w .:+-]/g, '') : null);
  const known = Object.keys(SECTIONS);
  return {
    createdAt: num(m?.createdAt),
    fileCount: num(m?.fileCount),
    bytes: num(m?.bytes),
    hasMasterKey: m?.hasMasterKey === true,
    app: str(m?.app, 32),
    node: str(m?.node, 32),
    // Only section names this build actually knows; anything else is dropped
    // rather than echoed back.
    sections: Array.isArray(m?.sections) ? m.sections.filter((x) => known.includes(x)) : [],
    counts: Object.fromEntries(known.map((k) => [k, num(m?.counts?.[k]) ?? 0])),
  };
}

/** A filename that sorts by date and says what it is. */
export function backupFilename(now = Date.now()) {
  const d = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `whatsapp-bot-backup-${d}.wabak`;
}
