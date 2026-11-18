/* The data archive, its sealed off-box backup, and the links-group check.
   The backup runs real git against a local bare repository.
   Run: node test/data-archive.test.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { DataArchive, trimRaw, hourParts, hourEnd } from '../src/core/data-archive.js';
import {
  DataArchiveBackup, seal, open, deriveKey, MAGIC, NO_PASSPHRASE, BRANCH, msUntilNextPass,
} from '../src/core/data-archive-backup.js';
import { linksAudit, linksGroupsOf } from '../src/core/links-audit.js';
import { WhatsAppBot } from '../src/core/bot.js';
import { createApiRouter } from '../src/web/api.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { hashPassword } from '../src/util/crypto.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-archive-'));
const readAll = (a) => a.search({ limit: 100_000, oldestFirst: true });

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 5, 10, 15, 0);     // 10:15 UTC
const G = '120363000000000001@g.us';
const LINKS = '120363000000000002@g.us';
const A = '15550000001@s.whatsapp.net';

const msg = (id, text, extra = {}) => ({
  key: { remoteJid: G, id, participant: A, fromMe: false },
  pushName: 'alice',
  messageTimestamp: Math.floor(T0 / 1000),
  message: { conversation: text },
  ...extra,
});

console.log('=== messages are archived, deduped and sorted by kind ===');
{
  const dir = tmp();
  let now = T0;
  const a = new DataArchive({ dataDir: dir, now: () => now });
  ok(a.recordMessage(msg('M1', 'hello there')), 'a live group message is written');
  ok(!a.recordMessage(msg('M1', 'hello there'), { source: 'backfill' }), 'the same message from the backfill is not written twice');
  ok(a.recordMessage({ key: { remoteJid: G, id: 'R1', participant: A }, message: { reactionMessage: { text: '👍', key: { id: 'M1' } } } }),
    'a reaction is written');
  ok(a.recordMessage({ key: { remoteJid: G, id: 'M1', participant: A }, message: { protocolMessage: { type: 14, key: { id: 'M1' }, editedMessage: { conversation: 'hello again' } } } }),
    'an edit with the same id as the message is still written (its own kind of record)');
  ok(a.recordMessage({ key: { remoteJid: G, id: 'D1', participant: A }, message: { protocolMessage: { type: 0, key: { id: 'M1' } } } }),
    'a revoke is written');
  ok(!a.recordMessage({ key: { remoteJid: G, id: 'K1' }, message: { protocolMessage: { type: 3 } } }), 'other protocol traffic is not a message');
  ok(!a.recordMessage({ key: { remoteJid: 'status@broadcast', id: 'S1' }, message: { conversation: 'x' } }), 'status broadcasts are skipped');
  ok(a.recordMessage({
    key: { remoteJid: '15550000009@s.whatsapp.net', id: 'DM1', fromMe: false },
    message: { extendedTextMessage: { text: 'a dm', contextInfo: { stanzaId: 'Q1', participant: A, mentionedJid: [A] } } },
  }, { source: 'history' }), 'a direct message from a history sync is written');

  const recs = readAll(a);
  const m = recs.find((r) => r.kind === 'message' && r.id === 'M1' && r.mode === 'm');
  ok(m && m.text === 'hello there' && m.from === A && m.pushName === 'alice' && m.source === 'live', 'text, sender, name and source are kept');
  ok(m && m.raw && m.raw.key.id === 'M1', 'the raw message is kept');
  ok(recs.some((r) => r.mode === 'r' && r.reaction === '👍' && r.target === 'M1'), 'reaction keeps its emoji and target');
  ok(recs.some((r) => r.mode === 'e' && r.edit === 'hello again'), 'edit keeps the new text');
  ok(recs.some((r) => r.kind === 'deleted' && r.target === 'M1'), 'revoke becomes a deleted record naming its target');
  const dm = recs.find((r) => r.id === 'DM1');
  ok(dm && dm.replyTo?.id === 'Q1' && dm.mentions?.[0] === A && dm.from === '15550000009@s.whatsapp.net', 'reply-to and mentions are kept, DM sender is the chat');

  const { day, hour } = hourParts(now);
  ok(fs.existsSync(path.join(dir, 'archive', day, `${hour}.jsonl`)), `filed under archive/${day}/${hour}.jsonl (UTC)`);
  now += H;
  a.record('test', {});
  ok(a.files().length === 2, 'the next hour gets its own file');

  // Bounded id memory.
  const small = new DataArchive({ dataDir: tmp(), now: () => now, maxIds: 3 });
  for (const id of ['a', 'b', 'c', 'd']) small.recordMessage(msg(id, id));
  ok(small.seen.size === 3, 'at most maxIds ids are remembered');
  ok(small.recordMessage(msg('a', 'a')), 'the oldest id is forgotten first');

  // normalize() from the bot wins for the sender.
  const n = new DataArchive({ dataDir: tmp(), now: () => now });
  n.recordMessage(msg('N1', 'x', { key: { remoteJid: G, id: 'N1', participant: '999@lid' } }), { normalize: () => ({ senderJid: '999@lid', senderNumber: '15550000001' }) });
  ok(readAll(n)[0]?.number === '15550000001', "the bot's own normalize() supplies the number for @lid senders");

  // record() never throws.
  const file = path.join(tmp(), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const broken = new DataArchive({ dataDir: file, now: () => now });
  let threw = false;
  let r;
  try { r = broken.record('message', { text: 'x' }); broken.recordMessage(msg('X', 'x')); } catch { threw = true; }
  ok(!threw && r === false && broken.stats.errors >= 1, 'a write that cannot happen returns false and never throws');
}

console.log('=== trimRaw ===');
{
  const out = trimRaw({ big: Buffer.alloc(100, 1), small: Buffer.from('abc'), u8: new Uint8Array([1, 2]), ser: { type: 'Buffer', data: [1, 2, 3] }, long: { low: 5, high: 0, unsigned: true }, fn: () => 1, nested: [Buffer.alloc(65)] });
  ok(out.big.bytes === 100 && !('b64' in out.big), 'a buffer over 64 bytes becomes {bytes}');
  ok(out.small.b64 === Buffer.from('abc').toString('base64'), 'a short buffer is kept as base64');
  ok(out.u8.b64 === Buffer.from([1, 2]).toString('base64'), 'a Uint8Array is treated the same');
  ok(out.ser.b64 === Buffer.from([1, 2, 3]).toString('base64'), 'a JSON-serialised Buffer is treated the same');
  ok(out.long === 5, 'a Long becomes a number');
  ok(!('fn' in out), 'functions are dropped');
  ok(out.nested[0].bytes === 65, 'nested buffers are trimmed too');
  ok(trimRaw(Buffer.alloc(64)).b64 !== undefined, 'exactly 64 bytes is still kept');
}

console.log('=== bot sends, reactions, edits and failures ===');
{
  const a = new DataArchive({ dataDir: tmp(), now: () => T0 });
  const fake = {
    ev: {},
    sendMessage: async (jid, content) => {
      if (content.text === 'boom') throw new Error('send failed');
      return { key: { id: 'SENT1' } };
    },
  };
  const sock = WhatsAppBot.prototype._recordingSocket.call({ archive: a }, fake);
  ok(sock.ev === fake.ev, 'everything else on the socket passes straight through');
  const res = await sock.sendMessage(G, { text: 'hi' });
  ok(res.key.id === 'SENT1', 'the send result is returned unchanged');
  await sock.sendMessage(G, { react: { text: '✅', key: { id: 'M1' } } });
  await sock.sendMessage(G, { delete: { id: 'M1' } });
  await sock.sendMessage(G, { text: 'fixed', edit: { id: 'SENT1' } });
  let err = null;
  try { await sock.sendMessage(G, { text: 'boom' }); } catch (e) { err = e; }
  ok(err?.message === 'send failed', 'a failed send still throws to the caller');
  const ops = readAll(a).filter((r) => r.kind === 'bot');
  ok(ops.map((r) => r.op).join() === 'send,react,delete,edit,send', `sends, reacts, deletes and edits are recorded (${ops.map((r) => r.op)})`);
  ok(ops[0].id === 'SENT1' && ops[0].text === 'hi' && ops[0].ok, 'a send keeps its id and text');
  ok(ops[4].ok === false && ops[4].error === 'send failed', 'a failed send is recorded with its error');
  const none = WhatsAppBot.prototype._recordingSocket.call({ archive: null }, fake);
  ok((await none.sendMessage(G, { text: 'x' })).key.id === 'SENT1', 'with no archive attached sends work as before');
}

console.log('=== request versions ===');
{
  const dir = tmp();
  const rows = [{ id: 'r1', status: 'queued' }, { id: 'r2', status: 'sent' }];
  const a = new DataArchive({ dataDir: dir, now: () => T0 });
  a.requestStores = [{ name: 'files', rows: () => rows }, { name: 'broken', rows: () => { throw new Error('x'); } }];
  ok(a.scanRequests() === 2, 'every row is written the first time');
  ok(a.scanRequests() === 0, 'an unchanged row is not written again');
  rows[0].status = 'sent';
  ok(a.scanRequests() === 1, 'a changed row is written as a new version');
  const b = new DataArchive({ dataDir: dir, now: () => T0 });
  b.requestStores = a.requestStores;
  ok(b.scanRequests() === 0, 'after a restart the hashes are remembered');
  const versions = readAll(a).filter((r) => r.kind === 'request' && r.rowId === 'r1');
  ok(versions.length === 2 && versions[1].row.status === 'sent', 'both versions of the changed row are kept');
}

console.log('=== snapshots only when changed ===');
{
  const dir = tmp();
  let roster = [{ jid: G, members: [{ id: A }] }];
  const a = new DataArchive({ dataDir: dir, now: () => T0 });
  a.snapshots = { rosters: () => roster, empty: () => undefined };
  ok(a.checkSnapshots() === 1, 'the first snapshot is written');
  ok(a.checkSnapshots() === 0, 'an identical snapshot is not');
  roster = [...roster, { jid: LINKS, members: [] }];
  ok(a.checkSnapshots() === 1, 'a changed snapshot is');
  const b = new DataArchive({ dataDir: dir, now: () => T0 });
  b.snapshots = a.snapshots;
  ok(b.checkSnapshots() === 0, 'after a restart an unchanged snapshot is still not rewritten');
}

console.log('=== seed once per box ===');
{
  const dir = tmp();
  const a = new DataArchive({ dataDir: dir, now: () => T0 });
  a.seed = { activity: () => ({ x: 1 }), nothing: () => null };
  ok(a.seedOnce() === 1, 'existing data is written as seed:* records');
  ok(fs.existsSync(path.join(dir, 'archive', '.seeded')), 'a .seeded marker is left');
  ok(a.seedOnce() === 0, 'it does not seed twice');
  const b = new DataArchive({ dataDir: dir, now: () => T0 });
  b.seed = a.seed;
  ok(b.seedOnce() === 0, 'not even after a restart');
  ok(readAll(a).filter((r) => r.kind === 'seed:activity').length === 1, 'one seed record in the archive');
}

console.log('=== search, status, start/stop ===');
{
  let now = T0;
  const a = new DataArchive({ dataDir: tmp(), now: () => now });
  a.record('message', { text: 'one' });
  now += H;
  a.record('message', { text: 'two' });
  a.record('bot', { text: 'three' });
  ok(a.search({ limit: 1 })[0].text === 'three', 'newest first by default');
  ok(a.search({ limit: 1, oldestFirst: true })[0].text === 'one', 'oldestFirst reverses it');
  ok(a.search({ keep: (r) => r.kind === 'message', pick: (r) => r.text }).join() === 'two,one', 'keep and pick');
  ok(a.search({ since: T0 + 30 * 60_000 }).length === 2, 'since skips older records');
  const st = a.status();
  ok(st.files === 2 && st.written === 3 && st.byKind.message === 2, 'status counts files and records');
  a.start({ snapshots: {}, seed: {} });
  ok(a.status().running, 'start() runs the routine');
  a.stop();
  ok(!a.status().running, 'stop() stops it');
}

console.log('=== seal / open ===');
{
  const key = deriveKey('correct horse', 'ab'.repeat(16));
  const plain = Buffer.from('{"kind":"message"}\n'.repeat(50));
  const sealed = seal(plain, key);
  ok(sealed.subarray(0, 6).equals(MAGIC) && MAGIC.toString() === 'WADAT1', "starts with 'WADAT1'");
  ok(sealed.length < plain.length, 'it is gzipped before sealing');
  ok(!sealed.includes(Buffer.from('message')), 'the plaintext is not visible');
  ok(open(sealed, key).equals(plain), 'round trip');
  let e1 = null;
  try { open(sealed, deriveKey('wrong', 'ab'.repeat(16))); } catch (e) { e1 = e; }
  ok(/wrong passphrase/.test(e1?.message ?? ''), 'a wrong passphrase fails clearly');
  let e2 = null;
  try { open(Buffer.from('nope'), key); } catch (e) { e2 = e; }
  ok(/not a sealed/.test(e2?.message ?? ''), 'a non-archive file is refused');
  const d = new Date(Date.UTC(2026, 0, 1, 10, 3));
  ok(msUntilNextPass(d.getTime()) === 2 * 60_000, 'next pass at :05 this hour');
  ok(msUntilNextPass(Date.UTC(2026, 0, 1, 10, 5)) === H, 'exactly :05 waits for the next hour');
}

console.log('=== backup to a real git remote ===');
{
  const gitOut = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const bare = path.join(tmp(), 'remote.git');
  gitOut(['init', '-q', '--bare', bare]);
  const onBranch = () => {
    try { return gitOut(['ls-tree', '-r', '--name-only', BRANCH], bare).trim().split('\n').filter(Boolean); } catch { return []; }
  };

  // No passphrase: refuses, pushes nothing.
  {
    const dir = tmp();
    const a = new DataArchive({ dataDir: dir, now: () => T0 });
    a.record('message', { text: 'x' });
    const b = new DataArchiveBackup({ archive: a, dataDir: dir, remote: bare, passphrase: '', now: () => T0 + 3 * H });
    let e = null;
    try { await b.runOnce(); } catch (err) { e = err; }
    ok(e?.message === NO_PASSPHRASE && /BACKUP_PASSPHRASE/.test(e.message), 'no passphrase: a clear error naming BACKUP_PASSPHRASE');
    ok(onBranch().length === 0, 'and nothing was pushed');
    ok(b.status().enabled === false && b.status().lastError, 'status shows it is not backed up');
  }

  // First pass before any hour has ended.
  const dir = tmp();
  let now = T0;
  const a = new DataArchive({ dataDir: dir, now: () => now });
  a.record('message', { text: 'first hour' });
  const pass1 = new DataArchiveBackup({ archive: a, dataDir: dir, remote: bare, passphrase: 'pw-one', now: () => now });
  const r0 = await pass1.runOnce();
  ok(r0.sealed === 0, 'the current hour is never sealed');
  ok(onBranch().includes('README.md') && onBranch().includes('KEY-SALT'), 'the branch is created with its README and key salt');
  ok(/written by the bot/i.test(gitOut(['show', `${BRANCH}:README.md`], bare)), 'README says the files are bot-written');
  ok(!onBranch().some((f) => f.startsWith('archive/')), 'no hour on the branch yet');

  // Hours finish.
  now += H; a.record('message', { text: 'second hour' });
  now += H; a.record('message', { text: 'third hour (current)' });
  const r1 = await pass1.runOnce();
  const hours = onBranch().filter((f) => f.startsWith('archive/'));
  ok(r1.sealed === 2 && hours.length === 2, `only the two finished hours are sealed (${hours})`);
  ok(hours.every((f) => /^archive\/\d{4}-\d{2}-\d{2}\/\d{2}\.jsonl\.gz\.enc$/.test(f)), 'named archive/<day>/<HH>.jsonl.gz.enc');
  const firstBlob = gitOut(['rev-parse', `${BRANCH}:${hours[0]}`], bare).trim();
  const r2 = await pass1.runOnce();
  ok(r2.sealed === 0 && r2.pushed === false, 'a pass with nothing new commits nothing');
  now += H;
  await pass1.runOnce();
  ok(gitOut(['rev-parse', `${BRANCH}:${hours[0]}`], bare).trim() === firstBlob, 'a sealed hour is never rewritten');
  ok(onBranch().filter((f) => f.startsWith('archive/')).length === 3, 'the next finished hour is added');

  // Leftovers from a pass that wrote but never committed.
  const stray = path.join(dir, 'data-archive-backup', 'archive', '2025-12-31', '23.jsonl.gz.enc');
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  const salt = fs.readFileSync(path.join(dir, 'data-archive-backup', 'KEY-SALT'), 'utf8').trim();
  fs.writeFileSync(stray, seal(Buffer.from('{"kind":"old"}\n'), deriveKey('pw-one', salt)));
  const r3 = await pass1.runOnce();
  ok(r3.pushed && onBranch().includes('archive/2025-12-31/23.jsonl.gz.enc'), 'files left uncommitted by an earlier pass are committed');

  // At most N hours a push.
  {
    const bare2 = path.join(tmp(), 'r2.git');
    gitOut(['init', '-q', '--bare', bare2]);
    const d2 = tmp();
    let t = T0;
    const a2 = new DataArchive({ dataDir: d2, now: () => t });
    for (let i = 0; i < 3; i++) { a2.record('x', {}); t += H; }
    const b2 = new DataArchiveBackup({ archive: a2, dataDir: d2, remote: bare2, passphrase: 'pw', now: () => t, maxPerPush: 2 });
    const x = await b2.runOnce();
    ok(x.sealed === 2 && x.pending === 1, 'a capped pass leaves the rest pending for the next run');
    const y = await b2.runOnce();
    ok(y.sealed === 1 && y.pending === 0, 'and the next run finishes it');
  }

  // Restore on a fresh box.
  const fresh = tmp();
  const a3 = new DataArchive({ dataDir: fresh, now: () => now });
  const wrong = new DataArchiveBackup({ archive: a3, dataDir: fresh, remote: bare, passphrase: 'not-it', now: () => now });
  let we = null;
  try { await wrong.runOnce(); } catch (e) { we = e; }
  ok(/wrong passphrase/.test(we?.message ?? ''), 'restoring with the wrong passphrase fails clearly');
  ok(a3.files().length === 0, 'and writes nothing into the archive');
  const right = new DataArchiveBackup({ archive: a3, dataDir: fresh, remote: bare, passphrase: 'pw-one', now: () => now });
  const rr = await right.runOnce();
  ok(rr.restored === 4, `every hour on the branch is restored (${rr.restored})`);
  const orig = a.files().filter((f) => hourEnd(f.day, f.hour) <= now);
  ok(orig.every((f) => fs.readFileSync(f.file, 'utf8') === fs.readFileSync(path.join(fresh, 'archive', f.day, `${f.hour}.jsonl`), 'utf8')),
    'restored hours match the originals byte for byte');
  ok(rr.sealed === 0, 'restored hours are not sealed again');
}

console.log('=== links-group check ===');
{
  const num = (n) => `1555000010${n}`;
  const groups = [
    { jid: LINKS, subject: 'Direct Download Links', members: [
      { id: `${num(1)}@s.whatsapp.net`, number: num(1) },
      { id: `${num(2)}@s.whatsapp.net`, number: num(2) },
      { id: `${num(3)}@s.whatsapp.net`, number: num(3) },
      { id: '777@lid', number: null },            // number 4, known only through activity
      { id: `${num(5)}@s.whatsapp.net`, number: num(5) },
    ] },
    { jid: G, subject: 'Main chat', members: [] },
  ];
  const activity = { [`num:${num(4)}`]: { lid: '777@lid', number: num(4), perGroup: {} } };
  const messages = [
    { kind: 'message', chat: LINKS, id: 'a1', number: num(1), text: '#request something', at: 1000 },
    { kind: 'message', chat: LINKS, id: 'b1', number: num(2), text: 'hi', at: 1000 },
    { kind: 'message', chat: LINKS, id: 'b2', number: num(2), text: 'thanks', at: 2000 },
    { kind: 'message', chat: LINKS, id: 'c1', number: num(3), text: 'hello', at: 5000 },
    { kind: 'message', chat: G, id: 'x1', number: num(4), text: '#request elsewhere', at: 1000 },
  ];
  const row = (n, id, extra = {}) => ({ plugin: 'files', id, requesterNumber: num(n), status: 'sent', groupJid: G, ts: 3000, ...extra });
  const history = [
    row(1, 'f1'), row(2, 'f2'), row(2, 'f3', { status: 'resent' }), row(3, 'f4'),
    row(4, 'f5', { requesterNumber: null, requester: '777@lid', status: 'partial' }),
    row(4, 'f5', { requesterNumber: null, requester: '777@lid', status: 'partial' }),   // same row twice
    row(5, 'f6', { beta: true }), row(5, 'f7', { groupJid: LINKS }), row(5, 'f8', { status: 'failed' }),
  ];
  const r = linksAudit({ groups, activity, history, messages, linksGroups: [LINKS] });
  const by = Object.fromEntries(r.people.map((p) => [p.number, p]));
  ok(by[num(1)]?.tier === 'clear', '#request in the links group plus files is clear');
  ok(by[num(2)]?.tier === 'likely' && by[num(2)].files === 2, 'two messages there is likely');
  ok(by[num(3)]?.tier === 'weak', 'exactly one message is weak');
  ok(by[num(4)]?.tier === 'member' && by[num(4)].files === 1, 'never wrote there is member; a @lid is matched to its number; duplicate rows count once');
  ok(!by[num(5)], 'beta rows, rows from the links group and undelivered rows do not count');
  ok(r.people[0].tier === 'clear' && r.people.at(-1).tier === 'member', 'sorted clearest first');
  ok(r.summary.clear === 1 && r.summary.likely === 1 && r.summary.weak === 1 && r.summary.member === 1, 'summary counts each tier');
  ok(by[num(3)].filesAfterFirstLink === 0 && by[num(2)].filesAfterFirstLink === 2, 'filesAfterFirstLink compares to their first links message');
  ok(r.people.every((p) => typeof p.why === 'string' && p.why.includes('+1555')), 'every person has a why sentence with their number');
  ok(by[num(1)].why.includes('#request'), 'the why mentions #request when that is the reason');

  const idx = linksAudit({ groups, activity, history, msgIndex: [{ k: `num:${num(3)}`, g: LINKS, i: 'c1', t: 5000 }, { k: `num:${num(3)}`, g: LINKS, i: 'c9', t: 6000, w: '#request' }], messages: messages.slice(0, 3), linksGroups: [LINKS] });
  ok(idx.people.find((p) => p.number === num(3))?.tier === 'clear', 'the message index counts too, including its first word');

  ok(linksGroupsOf({ audits: { linksGroups: [] } }, groups).join() === LINKS, 'with nothing chosen, groups are picked by name');
  ok(linksGroupsOf({ audits: { linksGroups: [G] } }, groups).join() === G, 'a chosen list wins');
  ok(linksGroupsOf({}, [{ jid: G, subject: 'Main' }]).length === 0, 'no match, no links groups');
  ok(linksAudit({ groups, history, linksGroups: [] }).people.length === 0, 'with no links group nobody is listed');
}

console.log('=== wiring ===');
{
  const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const bot = src('core/bot.js');
  const upsert = bot.slice(bot.indexOf("'messages.upsert'"));
  ok(upsert.indexOf('archive?.recordMessages') > 0 && upsert.indexOf('archive?.recordMessages') < upsert.indexOf("type !== 'notify'"),
    'messages.upsert archives before the notify filter');
  ok(/'messaging-history\.set'[\s\S]{0,200}archive\?\.recordMessages/.test(bot), 'history sync is archived');
  ok(/_recordingSocket\(pacedSocket\(/.test(bot), 'every socket the bot holds records its sends');
  const idx = src('index.js');
  ok(/new DataArchive\(/.test(idx) && /new DataArchiveBackup\(/.test(idx), 'index.js creates the archive and its backup');
  ok(/bot\.archive\.start\(/.test(idx) && /bot\.archiveBackup\.start\(/.test(idx), 'and starts both');
  ok(/archiveBackup\.stop\(\)[\s\S]{0,40}archive\.stop\(\)/.test(idx), 'and stops both on shutdown');
  ok(/archive\.recordGroupEvent\(ev\)/.test(idx), 'group events are archived');
  ok(Array.isArray(DEFAULT_CONFIG.audits?.linksGroups) && DEFAULT_CONFIG.audits.linksGroups.length === 0, 'config default audits.linksGroups is []');
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  ok(/data-tab="audits"/.test(html) && /id="tab-audits"/.test(html), 'the panel has an Audits tab');
  ok(/innocent/.test(html.slice(html.indexOf('id="card-links"'))), 'the links card says reasons can be innocent');
  const gi = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  ok(/^data\/?$/m.test(gi), 'data/ (archive and backup clone) is git-ignored');
}

console.log('=== API ===');
{
  const dir = tmp();
  const a = new DataArchive({ dataDir: dir, now: () => T0 });
  const num1 = '15550000101';
  a.recordMessage({ key: { remoteJid: LINKS, id: 'L1', participant: `${num1}@s.whatsapp.net` }, message: { conversation: '#request a thing' } });
  a.recordMessage({ key: { remoteJid: G, id: 'L2', participant: `${num1}@s.whatsapp.net` }, message: { conversation: 'hello main' } });
  a.requestStores = [{ name: 'files', rows: () => [{ id: 'f1', requesterNumber: num1, status: 'sent', groupJid: G, ts: T0 }] }];
  const groups = [
    { jid: LINKS, subject: 'Direct download links', members: [{ id: `${num1}@s.whatsapp.net`, number: num1, admin: null }] },
    { jid: G, subject: 'Main', members: [{ id: `${num1}@s.whatsapp.net`, number: num1, admin: null }] },
  ];
  const cfg = { web: { admins: [{ username: 'alice', passwordHash: hashPassword('averylongpassword'), role: 'admin', createdAt: T0 }], adminPasswordHash: '' }, whatsapp: {}, lockdown: {}, logging: {}, email: {}, announce: {}, moderation: {}, audits: { linksGroups: [] }, bannedNumbers: [] };
  const data = {};
  const stateStore = {
    namespace: (ns) => ({
      get: (k, fb = null) => (data[ns]?.[k] ?? fb),
      set: (k, v) => { (data[ns] ??= {})[k] = v; },
      push: (k, v) => { ((data[ns] ??= {})[k] ??= []).unshift(v); },
      all: () => ({ ...data[ns] }),
      delete: (k) => { delete data[ns]?.[k]; },
    }),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'alice', role: 'admin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore: { get: () => cfg, update: (p) => { for (const k of Object.keys(p)) Object.assign(cfg[k] ??= {}, p[k]); return cfg; } },
    bot: {
      archive: a, archiveBackup: { status: () => ({ enabled: false, branch: BRANCH }) },
      groups: () => groups.map(({ members, ...g }) => g), groupsWithMembers: () => groups,
      memberActivity: { all: () => ({}) }, messageIndex: { entries: [] },
      status: () => ({}), isConnected: () => true, groupCacheAge: () => 0,
    },
    queue: { snapshot: () => ({}) }, pluginManager: { list: () => [] }, stateStore,
    fileLogger: { tail: () => [], files: () => [] }, alerts: {}, lockScheduler: { status: () => ({}) },
  }));
  const srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const links = await call('GET', '/audits/links');
  ok(links.status === 200 && links.body.chosen.join() === LINKS && !links.body.configured, 'GET /audits/links picks the group by name');
  ok(links.body.people[0]?.tier === 'clear', 'and lists the member as clear');
  ok(links.body.groups.length === 2, 'and returns every group for the picker');
  const save = await call('PUT', '/audits/links/groups', { groups: [G] });
  ok(save.status === 200 && cfg.audits.linksGroups.join() === G, 'PUT /audits/links/groups saves audits.linksGroups');
  ok((await call('PUT', '/audits/links/groups', { groups: ['nope'] })).status === 400, 'non-group ids are refused');
  ok(data.audit?.events?.[0]?.action === 'set links groups', 'saving the groups is in the portal log');
  cfg.audits.linksGroups = [];

  const st = await call('GET', '/archive/status');
  ok(st.status === 200 && st.body.archive.written === 2 && st.body.backup.enabled === false, 'GET /archive/status');
  const s1 = await call('GET', '/archive/search?q=hello');
  ok(s1.body.results.length === 1 && s1.body.results[0].text === 'hello main', 'search by text');
  ok(!('raw' in s1.body.results[0]), 'raw payloads are not sent to the browser');
  const s2 = await call('GET', `/archive/search?who=%2B${num1}&chat=${encodeURIComponent(LINKS)}`);
  ok(s2.body.results.length === 1 && s2.body.results[0].id === 'L1', 'search by number and chat');
  ok((await call('GET', '/archive/search?kind=deleted')).body.results.length === 0, 'search by kind');

  const det = await call('GET', `/members/${encodeURIComponent(`num:${num1}`)}/detail`);
  ok(det.status === 200 && det.body.audit?.tier === 'clear', 'member detail carries their links-group result');
  ok(det.body.archive?.length === 2 && det.body.archive.every((m) => !('raw' in m)), 'and their recent archived messages, without raw');
  srv.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
