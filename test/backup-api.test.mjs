/* The backup endpoints as the portal calls them, over a real HTTP server.
   Run: node test/backup-api.test.mjs */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiRouter } from '../src/web/api.js';
import { hashPassword } from '../src/util/crypto.js';
import { inspectBackup, unpackBackup } from '../src/core/backup.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const PASS = 'a passphrase long enough';
const KEY = 'feedface'.repeat(8);
const tmps = [];

function install() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wabak-api-'));
  tmps.push(root);
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'session'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), `MASTER_KEY=${KEY}\n`);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(data, 'config.json'), '{"web":{"admins":[]}}');
  fs.writeFileSync(path.join(data, 'state.json'), '{"audit":{"events":[]}}');
  fs.writeFileSync(path.join(data, 'session', 'creds.json'), '{"me":"15551112222"}');
  return { root, data };
}

/** Mount the real router with a signed-in user and a controllable bot. */
function serve({ user = { username: 'superadmin', role: 'superadmin' }, connected = false } = {}) {
  const { root, data } = install();
  const cfg = {
    web: { admins: [{ username: 'superadmin', passwordHash: hashPassword('averylongpassword'), role: 'superadmin' }], adminPasswordHash: '' },
    whatsapp: {}, lockdown: {}, logging: {}, email: {}, announce: {}, moderation: {},
  };
  const store = { audit: { events: [] } };
  const ns = (n) => ({
    get: (k, fb = null) => store[n]?.[k] ?? fb,
    set: (k, v) => { (store[n] ??= {})[k] = v; },
    push: (k, v) => { const a = store[n]?.[k] ?? []; a.unshift(v); (store[n] ??= {})[k] = a; },
    all: () => ({}), delete: () => {},
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = user ? { user, destroy: (cb) => cb() } : {}; next(); });
  app.use('/api', createApiRouter({
    configStore: { get: () => cfg, update: () => cfg, redacted: () => cfg },
    bot: { groups: () => [], status: () => ({}), isConnected: () => connected, groupCacheAge: () => 0 },
    queue: { snapshot: () => ({}) },
    pluginManager: { list: () => [] },
    stateStore: { namespace: ns },
    fileLogger: { tail: () => [], files: () => [], list: () => [] },
    alerts: {},
    lockScheduler: { status: () => ({}) },
    dataDir: data, appRoot: root,
  }));
  return { app, root, data, store };
}

const listen = (app) => new Promise((r) => { const s = app.listen(0, () => r(s)); });
const url = (srv, p) => `http://127.0.0.1:${srv.address().port}/api${p}`;
const postJson = (srv, p, body) => fetch(url(srv, p), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const postRaw = (srv, p, buf, headers = {}) => fetch(url(srv, p), {
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: buf,
});

console.log('=== GET /backup/preview says what a backup would contain ===');
{
  const { app } = serve();
  const srv = await listen(app);
  const r = await fetch(url(srv, '/backup/preview'));
  const b = await r.json();
  ok(r.status === 200, 'responds 200');
  ok(Array.isArray(b.sections) && b.sections.length === 4, 'lists every section');
  ok(b.sections.find((s) => s.key === 'config').always === true, 'marks the one that is always included');
  ok(b.sections.find((s) => s.key === 'session').sensitive === true, 'flags the sensitive one for the UI');
  ok(b.sections.find((s) => s.key === 'session').files === 1, 'counts the files it would take');
  ok(b.hasMasterKey === true, 'reports that the master key is present');
  ok(b.minPassphrase >= 12, 'tells the UI the minimum passphrase length');
  srv.close();
}

console.log('=== POST /backup returns a real, openable file ===');
{
  const { app, store } = serve();
  const srv = await listen(app);
  const r = await postJson(srv, '/backup', { passphrase: PASS });
  ok(r.status === 200, 'responds 200');
  ok(/attachment; filename=".*\.wabak"/.test(r.headers.get('content-disposition') ?? ''),
     'as a download with a .wabak filename');
  const buf = Buffer.from(await r.arrayBuffer());
  ok(buf.length > 0, 'with a body');

  const { header } = inspectBackup(buf);
  ok(header.manifest.fileCount === 3, 'containing the expected files');
  const payload = unpackBackup(buf, PASS);
  ok(payload.masterKey === KEY, 'and the master key of THIS install, not a fallback');
  ok(JSON.parse(Buffer.from(payload.files['session/creds.json'], 'base64')).me === '15551112222',
     'and the real session from this data directory');

  // Taking a copy of the account is worth recording.
  ok(store.audit.events.some((e) => /downloaded a backup/.test(e.action)), 'the download is audited');
  srv.close();
}

console.log('=== a weak or missing passphrase is refused ===');
{
  const { app } = serve();
  const srv = await listen(app);
  for (const p of [undefined, '', 'short', 'elevenchars']) {
    const r = await postJson(srv, '/backup', { passphrase: p });
    ok(r.status === 400, `passphrase ${JSON.stringify(p)} is refused with 400`);
  }
  ok((await (await postJson(srv, '/backup', { passphrase: 'short' })).json()).error.includes('12'),
     'and the error says how long it must be');
  srv.close();
}

console.log('=== only a super-admin may take or restore one ===');
{
  // A backup is a working copy of the WhatsApp account plus every stored
  // secret; an ordinary admin must not be able to walk off with it.
  const { app } = serve({ user: { username: 'alice', role: 'admin' } });
  const srv = await listen(app);
  ok((await postJson(srv, '/backup', { passphrase: PASS })).status === 403, 'a plain admin cannot download one');
  ok((await fetch(url(srv, '/backup/preview'))).status === 403, 'nor preview what one would hold');
  ok((await postRaw(srv, '/backup/restore', Buffer.from('x'))).status === 403, 'nor restore one');
  ok((await postRaw(srv, '/backup/inspect', Buffer.from('x'))).status === 403, 'nor inspect one');
  srv.close();

  const anon = serve({ user: null });
  const s2 = await listen(anon.app);
  ok((await postJson(s2, '/backup', { passphrase: PASS })).status === 401, 'and signed out gets nothing');
  s2.close();
}

console.log('=== restore is refused while WhatsApp is connected ===');
{
  // Writing over session files Baileys has open corrupts the very link the
  // backup exists to preserve.
  const live = serve({ connected: true });
  const srv = await listen(live.app);
  const made = await postJson(srv, '/backup', { passphrase: PASS });
  const buf = Buffer.from(await made.arrayBuffer());

  const r = await postRaw(srv, '/backup/restore', buf, { 'x-backup-passphrase': PASS });
  ok(r.status === 409, 'refused with 409 while connected');
  ok(/[Dd]isconnect/.test((await r.json()).error), 'and says to disconnect first');
  srv.close();
}

console.log('=== restore round-trip through the API ===');
{
  const a = serve();
  const srvA = await listen(a.app);
  const buf = Buffer.from(await (await postJson(srvA, '/backup', { passphrase: PASS })).arrayBuffer());
  srvA.close();

  const b = serve();                       // a different "machine"
  const srvB = await listen(b.app);
  fs.writeFileSync(path.join(b.data, 'config.json'), '{"different":true}');

  // Wrong passphrase first.
  const bad = await postRaw(srvB, '/backup/restore', buf, { 'x-backup-passphrase': 'wrong passphrase!!' });
  ok(bad.status === 400, 'a wrong passphrase is refused');
  ok(JSON.parse(fs.readFileSync(path.join(b.data, 'config.json'), 'utf8')).different === true,
     'and nothing was written');

  // Dry run.
  const dry = await (await postRaw(srvB, '/backup/restore', buf,
    { 'x-backup-passphrase': PASS, 'x-backup-dry-run': '1' })).json();
  ok(dry.ok && dry.dryRun === true && dry.restored.length === 3, 'a dry run reports the plan');
  ok(dry.restartRequired === false, 'and does not claim a restart is needed');
  ok(JSON.parse(fs.readFileSync(path.join(b.data, 'config.json'), 'utf8')).different === true,
     'while still writing nothing');

  // For real.
  const res = await (await postRaw(srvB, '/backup/restore', buf, { 'x-backup-passphrase': PASS })).json();
  ok(res.ok && res.restored.length === 3, 'the real restore writes the files');
  ok(res.restartRequired === true, 'and says a restart is required — config was read at boot');
  ok(res.movedAside && fs.existsSync(res.movedAside), 'the previous data is copied aside');
  ok(JSON.parse(fs.readFileSync(path.join(res.movedAside, 'config.json'), 'utf8')).different === true,
     'with the replaced file recoverable');
  ok(fs.readFileSync(path.join(b.data, 'session', 'creds.json'), 'utf8').includes('15551112222'),
     'the session from the backup is in place');
  ok(b.store.audit.events.some((e) => /restored a backup/.test(e.action)), 'the restore is audited');
  srvB.close();
}

console.log('=== inspect works without a passphrase, and rejects junk ===');
{
  const { app } = serve();
  const srv = await listen(app);
  const buf = Buffer.from(await (await postJson(srv, '/backup', { passphrase: PASS })).arrayBuffer());

  const good = await (await postRaw(srv, '/backup/inspect', buf)).json();
  ok(good.ok && good.fileCount === 3, 'a real backup is described without the passphrase');
  ok(good.hasMasterKey === true, 'including whether the master key is in it');
  ok(!JSON.stringify(good).includes(KEY), 'without ever revealing the key itself');

  const junk = await postRaw(srv, '/backup/inspect', Buffer.from('not a backup at all'));
  ok(junk.status === 400, 'junk is refused');
  ok(/not a bot backup/i.test((await junk.json()).error), 'with a plain explanation');
  srv.close();
}

for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
