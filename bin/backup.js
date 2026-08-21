#!/usr/bin/env node
/**
 * Backup / restore from the command line.
 *
 * The portal can do this too, but not in the case that matters most: a fresh
 * machine, where there is no portal yet because there is no admin account and
 * no session. That is exactly when a restore is needed, so it has to work from
 * a shell with nothing but a clone of the repo.
 *
 *   node bin/backup.js create  [-o FILE] [--no-session] [--no-state]
 *   node bin/backup.js inspect FILE
 *   node bin/backup.js restore FILE [--yes] [--dry-run]
 *
 * The passphrase is read from the terminal, or from BACKUP_PASSPHRASE for
 * unattended use (a cron job writing nightly copies).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  collectBackup, packBackup, unpackBackup, inspectBackup, restoreBackup,
  backupFilename, safeManifest, SECTIONS, MIN_PASSPHRASE,
} from '../src/core/backup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const E = '\u001b[';
const bold = (s) => `${E}1m${s}${E}0m`;
const dim = (s) => `${E}2m${s}${E}0m`;
const red = (s) => `${E}31m${s}${E}0m`;
const green = (s) => `${E}32m${s}${E}0m`;

const say = (...a) => console.log(...a);
const die = (msg) => { console.error(`\n${red('Error:')} ${msg}\n`); process.exit(1); };

const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(Math.max(n, 1)) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

/** Prompt without echoing. Falls back to a visible prompt on a dumb terminal. */
function askSecret(prompt) {
  return new Promise((resolve) => {
    const env = process.env.BACKUP_PASSPHRASE;
    if (env) return resolve(env);
    if (!process.stdin.isTTY) {
      return die('No terminal to ask for a passphrase. Set BACKUP_PASSPHRASE for unattended use.');
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (ch) => {
      // Redraw the prompt with no characters, so the passphrase is not echoed.
      if (['\n', '\r', ''].includes(String(ch))) return;
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(prompt);
    };
    process.stdin.on('data', onData);
    rl.question(prompt, (answer) => {
      process.stdin.off('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function ask(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); });
  });
}

/* ------------------------------- create -------------------------------- */

async function cmdCreate(args) {
  const out = path.resolve(argValue(args, '-o') ?? argValue(args, '--out') ?? backupFilename());
  const sections = Object.keys(SECTIONS).filter((s) => !args.includes(`--no-${s}`));

  if (!fs.existsSync(DATA_DIR)) die(`No data directory at ${DATA_DIR} - is this the right machine?`);

  const payload = collectBackup({ dataDir: DATA_DIR, root: ROOT, sections });
  const m = payload.manifest;

  say(`\n${bold('Backing up')} ${DATA_DIR}`);
  for (const [name, spec] of Object.entries(SECTIONS)) {
    const n = m.counts[name];
    say(`  ${n === undefined ? dim('skipped ') : `${String(n).padStart(4)} file(s)`}  ${name.padEnd(9)} ${dim(spec.label)}`);
  }
  if (!m.hasMasterKey) {
    say(`\n${red('!')} No MASTER_KEY found in .env. Encrypted settings (email password, session`);
    say('  secret) will NOT be recoverable from this backup.');
  }

  const pass = await askSecret(`\nPassphrase to encrypt the backup (min ${MIN_PASSPHRASE}): `);
  if (!process.env.BACKUP_PASSPHRASE) {
    const again = await askSecret('Repeat it: ');
    if (again !== pass) die('The two passphrases do not match.');
  }

  let buf;
  try { buf = packBackup(payload, pass); } catch (err) { die(err.message); }
  fs.writeFileSync(out, buf, { mode: 0o600 });

  say(`\n${green('Written')} ${out}  ${dim(`(${fmtBytes(buf.length)}, ${m.fileCount} files)`)}`);
  say(dim('\nThis file contains your WhatsApp session and the key to every stored'));
  say(dim('secret. Keep it somewhere you would keep a password, not in a shared'));
  say(dim('folder. Without the passphrase it cannot be read - including by you.\n'));
}

/* ------------------------------- inspect ------------------------------- */

function cmdInspect(args) {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) die('Usage: node bin/backup.js inspect FILE');
  let header;
  try { ({ header } = inspectBackup(fs.readFileSync(path.resolve(file)))); }
  catch (err) { die(err.message); }

  // Same untrusted header, printed to a terminal: control characters would
  // rewrite the line above, so it goes through the same filter as the portal.
  const m = safeManifest(header.manifest ?? {});
  say(`\n${bold(path.basename(file))}`);
  say(`  made         ${m.createdAt ? new Date(m.createdAt).toLocaleString() : 'unknown'}`);
  say(`  app version  ${m.app ?? 'unknown'}${m.node ? dim(`  (node ${m.node})`) : ''}`);
  say(`  contents     ${(m.sections ?? []).join(', ') || 'unknown'}`);
  say(`  files        ${m.fileCount ?? '?'} ${m.bytes ? dim(`(${fmtBytes(m.bytes)} uncompressed)`) : ''}`);
  say(`  master key   ${m.hasMasterKey ? green('included') : red('MISSING - encrypted settings will not survive')}`);
  say(`  format       v${header.format}, ${header.cipher}\n`);
}

/* ------------------------------- restore ------------------------------- */

async function cmdRestore(args) {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) die('Usage: node bin/backup.js restore FILE [--yes] [--dry-run]');
  const dryRun = args.includes('--dry-run');

  let buf;
  try { buf = fs.readFileSync(path.resolve(file)); } catch { die(`Cannot read ${file}`); }
  cmdInspect([file]);

  // Restoring over a running bot corrupts the session it is holding open.
  if (isRunning()) {
    say(`${red('!')} The bot appears to be running. Stop it first:`);
    say('    sudo systemctl stop whatsapp-bot\n');
    if (!args.includes('--yes')) die('Refusing to restore over a running bot.');
  }

  const pass = await askSecret('Passphrase: ');
  let payload;
  try { payload = unpackBackup(buf, pass); } catch (err) { die(err.message); }

  if (!dryRun && !args.includes('--yes')) {
    say(`${bold('This will replace')} ${DATA_DIR}`);
    say(dim('(the current contents are copied aside first, not deleted)'));
    const a = await ask('\nType "restore" to continue: ');
    if (a !== 'restore') die('Cancelled.');
  }

  let res;
  try {
    res = restoreBackup({ payload, dataDir: DATA_DIR, root: ROOT, dryRun });
  } catch (err) { die(err.message); }

  if (dryRun) {
    say(`\n${bold('Dry run')} - nothing was written.`);
    say(`  would restore ${res.restored.length} file(s) into ${DATA_DIR}`);
    if (res.skipped.length) say(`  ${red('would skip')} ${res.skipped.length} unsafe path(s): ${res.skipped.slice(0, 5).join(', ')}`);
    say('');
    return;
  }

  say(`\n${green('Restored')} ${res.restored.length} file(s) into ${DATA_DIR}`);
  if (res.movedAside) say(`  previous contents kept at ${dim(res.movedAside)}`);
  if (res.masterKey) say('  MASTER_KEY written to .env');
  if (res.skipped.length) say(`  ${red('skipped')} ${res.skipped.length} unsafe path(s)`);
  say(`\nStart it with:  ${bold('npm start')}\n`);
}

/** Is a bot already using this data directory? */
function isRunning() {
  try {
    // The session lock Baileys keeps open is not visible cross-platform, so go
    // by the service instead. Absence of systemd is not proof it is stopped,
    // which is why the caller still asks.
    const out = execSync('systemctl is-active whatsapp-bot 2>/dev/null || true', { encoding: 'utf8' });
    return out.trim() === 'active';
  } catch { return false; }
}

/* --------------------------------- main -------------------------------- */

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'create') await cmdCreate(rest);
else if (cmd === 'inspect') cmdInspect(rest);
else if (cmd === 'restore') await cmdRestore(rest);
else {
  say(`
${bold('Backup and restore')}

  ${bold('node bin/backup.js create')} [-o FILE] [--no-session] [--no-state] [--no-backups]
      Write an encrypted backup. Includes everything by default.

  ${bold('node bin/backup.js inspect')} FILE
      Show what a backup contains and when it was made. No passphrase needed.

  ${bold('node bin/backup.js restore')} FILE [--dry-run] [--yes]
      Restore onto this machine. Stop the bot first.

  ${dim('Set BACKUP_PASSPHRASE to run unattended, e.g. from cron.')}

${bold('Moving to a new machine')}

  On the old one:   node bin/backup.js create -o ~/wa-backup.wabak
  Copy the file across, then on the new one:
      git clone <repo> && cd WhatsAppBot && ./install.sh
      node bin/backup.js restore ~/wa-backup.wabak
      npm start
`);
  process.exit(cmd ? 1 : 0);
}
