/* Backup and restore: what travels, what is refused, and whether a rebuild on
   a different machine actually comes back. Run: node test/backup.test.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectBackup, packBackup, unpackBackup, inspectBackup, restoreBackup,
  safeTarget, readMasterKey, writeMasterKey, backupFilename,
  isRestorablePath, safeManifest, isMasterKey,
  SECTIONS, MAGIC, FORMAT_VERSION, MIN_PASSPHRASE,
} from '../src/core/backup.js';
import { encrypt, decrypt } from '../src/util/crypto.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const PASS = 'a passphrase long enough';
const KEY = 'deadbeef'.repeat(8);
const tmps = [];

/** A believable install: config, session, state, backups, plus noise. */
function makeInstall({ withKey = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wabak-'));
  tmps.push(root);
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'session'), { recursive: true });
  fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(data, 'backups'), { recursive: true });

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  if (withKey) fs.writeFileSync(path.join(root, '.env'), `MASTER_KEY=${KEY}\nOTHER_SETTING=keep-me\n`);

  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    web: { admins: [{ username: 'superadmin', passwordHash: 'scrypt:aa:bb' }], sessionSecret: encrypt('s3cret', KEY) },
    email: { appPassword: encrypt('smtp-password', KEY) },
  }));
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ audit: { events: [{ ts: 1 }] } }));
  fs.writeFileSync(path.join(data, 'session', 'creds.json'), '{"me":"15551112222"}');
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(data, 'session', `pre-key-${i}.json`), `{"k":${i}}`);
  fs.writeFileSync(path.join(data, 'backups', 'original-descriptions.json'), '{"g@g.us":{"desc":"before"}}');

  // Noise that must NOT travel.
  fs.writeFileSync(path.join(data, 'logs', 'debug-2026-08-21.log'), 'x'.repeat(50_000));
  fs.writeFileSync(path.join(data, 'extra-ca.pem'), 'cert');
  fs.writeFileSync(path.join(data, 'bot-cmd.json'), '{}');
  fs.writeFileSync(path.join(data, 'config.json.tmp'), 'half-written');
  return { root, data };
}

console.log('=== what travels, and what deliberately does not ===');
{
  const { root, data } = makeInstall();
  const b = collectBackup({ dataDir: data, root });
  const names = Object.keys(b.files).sort();

  ok(names.includes('config.json'), 'settings travel');
  ok(names.includes('state.json'), 'the audit log and lockdown state travel');
  ok(names.includes('session/creds.json'), 'the WhatsApp link travels');
  ok(names.filter((n) => n.startsWith('session/')).length === 4, 'every session file, not just creds');
  ok(names.includes('backups/original-descriptions.json'), 'saved group descriptions travel');

  // The master key is the whole reason a data-directory copy is not enough.
  ok(b.masterKey === KEY, 'MASTER_KEY travels, or the restored secrets are unreadable');
  ok(b.manifest.hasMasterKey === true, 'and the manifest says so');

  ok(!names.some((n) => n.startsWith('logs/')), 'logs do NOT travel — large and regenerated');
  ok(!names.includes('extra-ca.pem'), 'the generated CA bundle does not travel');
  ok(!names.includes('bot-cmd.json'), 'the local command channel does not travel');
  ok(!names.some((n) => n.endsWith('.tmp')), 'half-written files do not travel');

  ok(b.manifest.fileCount === names.length, 'the manifest counts what is actually there');
  ok(b.manifest.counts.session === 4 && b.manifest.counts.config === 1, 'counted per section');
  ok(b.manifest.app === '1.0.0', 'the app version is recorded');
}

console.log('=== sections can be left out, except the one that matters ===');
{
  const { root, data } = makeInstall();
  const noSession = collectBackup({ dataDir: data, root, sections: ['config', 'state'] });
  ok(!Object.keys(noSession.files).some((n) => n.startsWith('session/')),
     'a settings-only backup leaves the WhatsApp link out');
  ok(Object.keys(noSession.files).includes('config.json'), 'but still has the settings');

  // config is what makes a backup a backup; asking for a backup without it is
  // asking for nothing.
  const noConfig = collectBackup({ dataDir: data, root, sections: ['state'] });
  ok(Object.keys(noConfig.files).includes('config.json'), 'config is included even when not asked for');
  ok(SECTIONS.config.always === true, 'and is marked as always-included for the UI');
}

console.log('=== the file is always encrypted, and says what it is ===');
{
  const { root, data } = makeInstall();
  const payload = collectBackup({ dataDir: data, root });
  const buf = packBackup(payload, PASS);

  ok(buf.subarray(0, MAGIC.length).toString() === MAGIC, 'starts with a recognisable magic line');
  const asText = buf.toString('latin1');
  ok(!asText.includes(KEY), 'the master key is NOT readable in the file');
  ok(!asText.includes('smtp-password'), 'nor is anything else from the config');
  ok(!asText.includes('15551112222'), 'nor the phone number in the session');

  for (const weak of ['', 'short', 'elevenchars', null, undefined, 12345]) {
    let threw = false;
    try { packBackup(payload, weak); } catch { threw = true; }
    ok(threw, `a ${JSON.stringify(weak)} passphrase is refused`);
  }
  ok(MIN_PASSPHRASE >= 12, 'the minimum is at least 12 characters');
}

console.log('=== a backup can be identified without the passphrase ===');
{
  const { root, data } = makeInstall();
  const buf = packBackup(collectBackup({ dataDir: data, root }), PASS);
  const { header } = inspectBackup(buf);
  ok(header.format === FORMAT_VERSION, 'the format version is readable');
  ok(header.manifest.fileCount === 7, 'so is what it contains');
  ok(header.manifest.createdAt > 0, 'and when it was made');
  ok(!JSON.stringify(header).includes(KEY), 'without exposing anything secret');

  for (const junk of [Buffer.from('hello'), Buffer.alloc(0), Buffer.from(`${MAGIC}\nnot json\n`)]) {
    let threw = false;
    try { inspectBackup(junk); } catch { threw = true; }
    ok(threw, 'a file that is not a backup is rejected rather than half-read');
  }

  // A newer file must be refused loudly, not silently misread.
  const newer = Buffer.from(buf.toString('latin1').replace('"format":1', '"format":9'), 'latin1');
  let msg = '';
  try { inspectBackup(newer); } catch (e) { msg = e.message; }
  ok(/newer version/.test(msg), 'a future format is refused with an explanation');
}

console.log('=== wrong passphrase and tampering are caught ===');
{
  const { root, data } = makeInstall();
  const buf = packBackup(collectBackup({ dataDir: data, root }), PASS);

  ok(!!unpackBackup(buf, PASS).files, 'the right passphrase opens it');

  for (const wrong of [`${PASS} `, PASS.toUpperCase(), 'another long passphrase']) {
    let msg = '';
    try { unpackBackup(buf, wrong); } catch (e) { msg = e.message; }
    ok(/passphrase/i.test(msg), `a wrong passphrase is refused (${JSON.stringify(wrong.slice(0, 12))}…)`);
  }
  let noPass = '';
  try { unpackBackup(buf, ''); } catch (e) { noPass = e.message; }
  ok(/passphrase is required/i.test(noPass), 'no passphrase at all is refused');

  // GCM must notice a flipped bit in the ciphertext...
  const bitFlipped = Buffer.from(buf);
  bitFlipped[bitFlipped.length - 3] ^= 0xff;
  let t1 = false;
  try { unpackBackup(bitFlipped, PASS); } catch { t1 = true; }
  ok(t1, 'a modified payload fails to open, rather than restoring garbage');

  // ...and in the header, which is authenticated as AAD.
  const headerEdited = Buffer.from(buf.toString('latin1').replace('"fileCount":7', '"fileCount":1'), 'latin1');
  let t2 = false;
  try { unpackBackup(headerEdited, PASS); } catch { t2 = true; }
  ok(t2, 'an edited header fails to open — the manifest cannot be forged');
}

console.log('=== a rebuild on a different machine actually comes back ===');
{
  // The scenario the feature exists for: back up here, restore into a bare
  // clone with no data and no .env, and check the secrets are readable again.
  const old = makeInstall();
  const buf = packBackup(collectBackup({ dataDir: old.data, root: old.root }), PASS);

  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'wabak-new-'));
  tmps.push(fresh);
  const freshData = path.join(fresh, 'data');
  ok(!fs.existsSync(freshData), 'the new machine starts with no data directory');
  ok(!fs.existsSync(path.join(fresh, '.env')), 'and no master key');

  const payload = unpackBackup(buf, PASS);
  const res = restoreBackup({ payload, dataDir: freshData, root: fresh });

  ok(res.restored.length === 7, 'every file is restored');
  ok(res.skipped.length === 0, 'nothing is skipped');
  ok(res.movedAside === null, 'nothing to move aside on a fresh machine');
  ok(res.masterKey === true, 'the master key is written');

  for (const f of ['config.json', 'state.json', 'session/creds.json', 'backups/original-descriptions.json']) {
    ok(fs.readFileSync(path.join(freshData, f), 'utf8') === fs.readFileSync(path.join(old.data, f), 'utf8'),
       `${f} is byte-for-byte what it was`);
  }

  // The real proof: the restored key decrypts the restored config.
  const restoredKey = readMasterKey(path.join(fresh, '.env'));
  const cfg = JSON.parse(fs.readFileSync(path.join(freshData, 'config.json'), 'utf8'));
  ok(decrypt(cfg.email.appPassword, restoredKey) === 'smtp-password',
     'the SMTP password decrypts on the new machine — the whole point');
  ok(decrypt(cfg.web.sessionSecret, restoredKey) === 's3cret', 'and so does the session secret');

  const mode = fs.statSync(path.join(freshData, 'config.json')).mode & 0o777;
  ok(mode === 0o600, `restored files are not world-readable (${mode.toString(8)})`);
}

console.log('=== an existing install is copied aside, never just overwritten ===');
{
  const { root, data } = makeInstall();
  const buf = packBackup(collectBackup({ dataDir: data, root }), PASS);

  fs.writeFileSync(path.join(data, 'config.json'), '{"do":"not lose me"}');
  const res = restoreBackup({ payload: unpackBackup(buf, PASS), dataDir: data, root });

  ok(res.movedAside, 'the previous contents are kept somewhere');
  ok(fs.existsSync(res.movedAside), 'and that somewhere exists');
  ok(JSON.parse(fs.readFileSync(path.join(res.movedAside, 'config.json'), 'utf8')).do === 'not lose me',
     'the file that was replaced is recoverable by hand');
  ok(!JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).do, 'while the restore did take effect');

  // .env keeps everything that is not the master key.
  const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
  ok(/OTHER_SETTING=keep-me/.test(env), 'other variables in .env survive the restore');
  ok((env.match(/^MASTER_KEY=/gm) ?? []).length === 1, 'and MASTER_KEY is replaced, not appended twice');
}

console.log('=== a dry run writes nothing ===');
{
  const { root, data } = makeInstall();
  const buf = packBackup(collectBackup({ dataDir: data, root }), PASS);
  fs.writeFileSync(path.join(data, 'config.json'), '{"untouched":true}');
  const before = fs.readdirSync(data).sort().join();

  const res = restoreBackup({ payload: unpackBackup(buf, PASS), dataDir: data, root, dryRun: true });
  ok(res.restored.length === 7, 'a dry run reports what it would do');
  ok(res.movedAside === null, 'without copying anything aside');
  ok(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).untouched === true,
     'and without touching a single file');
  ok(fs.readdirSync(data).sort().join() === before, 'the directory is unchanged');
}

console.log('=== a hostile archive cannot write outside the data directory ===');
{
  // An archive is untrusted input even when it is your own.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wabak-evil-'));
  tmps.push(base);
  const data = path.join(base, 'data');

  const evil = [
    '../escaped.json', '../../etc/cron.d/pwn', '/etc/passwd', 'session/../../out.json',
    'a/../../b.json', 'C:/windows/system32/x', '', 'logs/debug.log',
    // Backslashes never appear in our archives and are traversal on Windows.
    '..\\windows.json', 'session\\..\\..\\out.json', 'a\\b.json',
  ];
  for (const rel of evil) {
    ok(safeTarget(data, rel) === null, `refuses ${JSON.stringify(rel)}`);
  }
  ok(safeTarget(data, 'session/creds.json') !== null, 'while ordinary paths are allowed');
  ok(safeTarget(data, 'config.json') !== null, 'including files at the top level');

  const res = restoreBackup({
    payload: { files: { 'config.json': Buffer.from('{"ok":1}').toString('base64'), '../escaped.json': Buffer.from('x').toString('base64') } },
    dataDir: data, root: base,
  });
  ok(res.restored.includes('config.json') && res.skipped.includes('../escaped.json'),
     'a mixed archive restores the safe file and skips the traversal');
  ok(!fs.existsSync(path.join(base, 'escaped.json')), 'and nothing lands outside the data directory');
}

console.log('=== a symlink already on disk cannot redirect a write ===');
{
  // safeTarget() checks the path string. The filesystem has its own opinion: a
  // symlink sitting at data/config.json, or a symlinked directory component,
  // passes every string test and still writes wherever it points. Reaching
  // this needs write access to a 0700 directory, but a restore run under sudo
  // would make it a privilege escalation.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wabak-sym-'));
  tmps.push(base);
  const data = path.join(base, 'data');
  const outsideFile = path.join(base, 'OUTSIDE.txt');
  const outsideDir = path.join(base, 'OUTDIR');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(outsideFile, 'original');

  fs.symlinkSync(outsideFile, path.join(data, 'config.json'));      // symlinked file
  fs.symlinkSync(outsideDir, path.join(data, 'session'));           // symlinked directory

  const res = restoreBackup({
    payload: { files: {
      'config.json': Buffer.from('PWNED').toString('base64'),
      'session/creds.json': Buffer.from('PWNED').toString('base64'),
      'state.json': Buffer.from('{"fine":true}').toString('base64'),
    } },
    dataDir: data, root: base,
  });

  ok(fs.readFileSync(outsideFile, 'utf8') === 'original',
     'a symlinked FILE in the data dir does not redirect the write');
  ok(fs.readdirSync(outsideDir).length === 0,
     'a symlinked DIRECTORY does not either — not even the mkdir');
  ok(res.skipped.includes('config.json') && res.skipped.includes('session/creds.json'),
     'both are reported as skipped rather than silently dropped');
  ok(res.restored.includes('state.json'), 'while the safe file in the same archive still restores');
  ok(fs.readFileSync(path.join(data, 'state.json'), 'utf8') === '{"fine":true}', 'and has the right contents');
}

console.log('=== a hostile archive cannot smuggle in code to execute ===');
{
  // The backup format is carried between machines and handed to people, so an
  // archive is untrusted even when the passphrase came with it. "Anywhere
  // under data/" was too generous: dropping pwn/index.js there and pointing
  // plugins.enabled at ../../data/pwn in the config it also restores is
  // remote code execution on the next start.
  ok(isRestorablePath('config.json'), 'the files a backup is made of are restorable');
  ok(isRestorablePath('state.json') && isRestorablePath('session/creds.json')
     && isRestorablePath('backups/original-descriptions.json'), 'all of them');

  for (const bad of [
    'pwn/index.js', 'index.js', 'plugins/evil/index.js', 'session/x.js',
    'session/hook.mjs', 'a.cjs', 'lib.node', 'run.sh', 'x.py',
  ]) {
    ok(!isRestorablePath(bad), `refuses executable payload ${JSON.stringify(bad)}`);
  }
  for (const bad of ['random.json', 'notasection/x.json', 'session', 'backups', '', '../x.json']) {
    ok(!isRestorablePath(bad), `refuses out-of-section path ${JSON.stringify(bad)}`);
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wabak-rce-'));
  tmps.push(base);
  const data = path.join(base, 'data');
  const res = restoreBackup({
    payload: { files: {
      'config.json': Buffer.from('{"plugins":{"enabled":["../../data/pwn"]}}').toString('base64'),
      'pwn/index.js': Buffer.from('require("child_process").exec("id")').toString('base64'),
    } },
    dataDir: data, root: base,
  });
  ok(res.skipped.includes('pwn/index.js'), 'a code file in an archive is skipped');
  ok(!fs.existsSync(path.join(data, 'pwn', 'index.js')), 'and never written');
  ok(res.restored.includes('config.json'), 'while the legitimate file still restores');
}

console.log('=== a dangling symlink cannot redirect a write either ===');
{
  // existsSync FOLLOWS a symlink, so one whose target does not exist yet reads
  // as "nothing here" - and the write sails through it to wherever it points.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wabak-dangle-'));
  tmps.push(base);
  const data = path.join(base, 'data');
  const outside = path.join(base, 'OUT');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(outside);

  fs.symlinkSync(path.join(outside, 'not-yet.txt'), path.join(data, 'config.json'));
  fs.symlinkSync(path.join(outside, 'nodir'), path.join(data, 'session'));

  const res = restoreBackup({
    payload: { files: {
      'config.json': Buffer.from('PWNED').toString('base64'),
      'session/creds.json': Buffer.from('PWNED').toString('base64'),
      'state.json': Buffer.from('{"fine":true}').toString('base64'),
    } },
    dataDir: data, root: base,
  });
  ok(!fs.existsSync(path.join(outside, 'not-yet.txt')), 'a dangling symlinked FILE does not redirect the write');
  ok(!fs.existsSync(path.join(outside, 'nodir')), 'nor a dangling symlinked DIRECTORY');
  ok(res.skipped.includes('config.json') && res.skipped.includes('session/creds.json'), 'both are skipped');
  ok(res.restored.includes('state.json'), 'while the safe file still restores');
}

console.log('=== an unauthenticated header cannot inject into the UI ===');
{
  // inspectBackup reads the header WITHOUT a passphrase, by design, so anyone
  // handing over a file controls every value in it. It reaches innerHTML in
  // the portal and a terminal in the CLI.
  const hostile = {
    createdAt: '<img src=x onerror=alert(1)>',
    fileCount: '<script>steal()</script>',
    sections: ['<img src=x onerror=fetch("//evil")>', 'config', 'also-not-real'],
    app: 'x'.repeat(500) + '<b>',
    node: 'v1\u001b[2J',
    hasMasterKey: 'yes',
    counts: { config: '<b>' },
    extraFieldNobodyExpects: '<script>x</script>',
  };
  const safe = safeManifest(hostile);
  const asText = JSON.stringify(safe);
  ok(!/[<>]/.test(asText), `no angle brackets survive: ${asText.slice(0, 80)}`);
  ok(!/script|onerror/i.test(asText), 'no script or handler text survives');
  ok(!('extraFieldNobodyExpects' in safe), 'unknown fields are dropped, not echoed back');
  ok(safe.sections.length === 1 && safe.sections[0] === 'config', 'only real section names survive');
  ok(safe.createdAt === null && safe.fileCount === null, 'non-numeric numbers become null');
  ok(safe.hasMasterKey === false, 'a truthy string is not treated as true');
  ok(!safe.node.includes('\u001b'), 'terminal escape sequences are stripped for the CLI');
  ok(safe.app.length <= 32, 'strings are length-capped');

  // A real manifest passes through intact.
  const { root, data } = makeInstall();
  const real = safeManifest(collectBackup({ dataDir: data, root }).manifest);
  ok(real.fileCount === 7 && real.hasMasterKey === true, 'a genuine manifest is unharmed');
  ok(real.sections.length === 4, 'with its sections intact');
}

console.log('=== a malformed master key is refused, not written ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabak-key-'));
  tmps.push(dir);
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'EXISTING=value\n');

  // A newline would inject extra variables; $-sequences would be expanded by
  // String.replace.
  for (const bad of ['abc\nEVIL=1', 'x'.repeat(600), '', 'has spaces', '$&', null, 42, 'semi;colon']) {
    let threw = false;
    try { writeMasterKey(env, bad); } catch { threw = true; }
    ok(threw, `refuses master key ${JSON.stringify(String(bad).slice(0, 16))}`);
  }
  ok(fs.readFileSync(env, 'utf8') === 'EXISTING=value\n', 'and .env is untouched by any of them');

  let threw = false;
  try {
    restoreBackup({
      payload: { masterKey: 'abc\nEVIL=1', files: { 'config.json': Buffer.from('{}').toString('base64') } },
      dataDir: path.join(dir, 'data'), root: dir,
    });
  } catch { threw = true; }
  ok(threw, 'and a restore carrying one is refused outright');
}

console.log('=== small things ===');
{
  ok(/^whatsapp-bot-backup-.*\.wabak$/.test(backupFilename()), 'the filename says what it is');
  ok(backupFilename(1700000000000).includes('2023-11'), 'and sorts by date');

  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wabak-env-')), '.env');
  tmps.push(path.dirname(p));
  const k1 = 'aa'.repeat(32), k2 = 'bb'.repeat(32);   // real keys are hex tokens
  ok(readMasterKey(p) === null, 'a missing .env yields no key rather than throwing');
  writeMasterKey(p, k1);
  ok(readMasterKey(p) === k1, 'a key can be written and read back');
  writeMasterKey(p, k2);
  ok(readMasterKey(p) === k2 && fs.readFileSync(p, 'utf8').match(/MASTER_KEY/g).length === 1,
     'and replaced in place');
  ok(isMasterKey(k1) && !isMasterKey('abc'), 'a key must look like the token index.js mints');
  ok((fs.statSync(p).mode & 0o777) === 0o600, '.env is written 0600');

  const { root, data } = makeInstall({ withKey: false });
  ok(collectBackup({ dataDir: data, root }).manifest.hasMasterKey === false,
     'a machine with no .env is reported honestly, not silently');
}

for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
