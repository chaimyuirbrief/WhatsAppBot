/* The socket wrapper that makes pacing automatic: which call gets which pace,
   what stays transparent, and what is never delayed.
   Run: node test/paced-socket.test.mjs */
import { pacedSocket, kindFor, SOCKET_PACE_KINDS, UNPACED } from '../src/core/paced-socket.js';
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== every call is classified, and the unknown ones are still paced ===');
{
  ok(kindFor('groupSettingUpdate') === 'groupSetting', 'lock/unlock is a group setting');
  ok(kindFor('groupParticipantsUpdate') === 'participant', 'membership changes are participant');
  ok(kindFor('groupUpdateDescription') === 'description', 'description edits');
  ok(kindFor('groupUpdateSubject') === 'description', 'renames share the description pace');
  ok(kindFor('groupMetadata') === 'metadata', 'reads get the lighter metadata pace');
  ok(kindFor('groupFetchAllParticipating') === 'metadata', 'so does the group list');

  // sendMessage does two very different jobs.
  ok(kindFor('sendMessage', ['g@g.us', { text: 'hi' }]) === 'message', 'a chat message is a message');
  ok(kindFor('sendMessage', ['g@g.us', { delete: { id: 'x' } }]) === 'revoke', 'a delete-for-everyone is a revoke');
  ok(kindFor('sendMessage', ['g@g.us', { document: {} }]) === 'message', 'a document is a message');
  ok(kindFor('sendMessage', ['g@g.us']) === 'message', 'a call with no content does not throw');

  // THE POINT OF THE WHOLE MODULE: a method nobody thought about is still slow.
  ok(kindFor('someMethodInventedNextYear') === 'default',
     'an unclassified call gets the default pace, not zero');
  ok(kindFor('groupSomethingBrandNew') === 'default', 'including a new group call');

  for (const m of UNPACED) ok(kindFor(m) === null, `${m} is never delayed (connection lifecycle)`);
  ok(Object.keys(SOCKET_PACE_KINDS).every((k) => !UNPACED.has(k)),
     'no method is both classified and exempt');
}

console.log('=== the wrapper waits before each call, in order ===');
{
  const calls = [];
  const held = [];
  const raw = {
    groupSettingUpdate: async (jid) => { calls.push(`set:${jid}`); return 'ok'; },
    sendMessage: async (jid, content) => { calls.push(`send:${jid}`); return { id: 1 }; },
    requestPairingCode: async () => { calls.push('pair'); return '1234'; },
  };
  const sock = pacedSocket(raw, async (kind, method) => { held.push(`${kind}:${method}`); });

  ok(await sock.groupSettingUpdate('a@g.us') === 'ok', 'the return value passes through');
  ok(held[0] === 'groupSetting:groupSettingUpdate', 'the hold happened, with the right kind');
  ok(calls[0] === 'set:a@g.us', 'and the real method ran with the real arguments');

  await sock.sendMessage('b@g.us', { delete: { id: 'x' } });
  ok(held[1] === 'revoke:sendMessage', 'the kind is chosen from the arguments');

  await sock.requestPairingCode('15551112222');
  ok(held.length === 2, 'an exempt call does not wait');
  ok(calls[2] === 'pair', 'but still runs');

  // Order matters: the wait must come BEFORE the call, not after.
  const seq = [];
  const s2 = pacedSocket(
    { act: async () => { seq.push('call'); } },
    async () => { seq.push('hold'); },
  );
  await s2.act();
  ok(seq.join() === 'hold,call', 'the gate is before the call, so nothing is left sleeping after');
}

console.log('=== transparent about everything that is not a call ===');
{
  const ev = { on() {}, off() {} };
  const raw = {
    ev,
    user: { id: '1@s.whatsapp.net' },
    authState: { creds: {} },
    get derived() { return this.user.id; },
    async act() { return 'done'; },
  };
  const sock = pacedSocket(raw, async () => {});
  ok(sock.ev === ev, 'the event emitter is the real one, not a wrapper');
  ok(sock.user.id === '1@s.whatsapp.net', 'plain properties pass through');
  ok(sock.authState === raw.authState, 'so do nested objects, by identity');
  ok(sock.derived === '1@s.whatsapp.net', 'a getter still sees the real socket as `this`');
  ok(sock.act === sock.act, 'the same wrapper is handed back each time (identity is stable)');
  ok(sock.nope === undefined, 'a missing property is still undefined');
  ok(sock.act.name === 'act', 'the wrapper keeps the method name, so stack traces read right');

  sock.replaced = async () => 'new';
  ok(await sock.replaced() === 'new', 'a method assigned later is wrapped too');
  ok(raw.replaced !== undefined, 'and lands on the real socket');
}

console.log('=== errors and edge cases ===');
{
  const sock = pacedSocket({ boom: async () => { throw new Error('nope'); } }, async () => {});
  let msg = '';
  try { await sock.boom(); } catch (e) { msg = e.message; }
  ok(msg === 'nope', 'an error from the real method reaches the caller unchanged');

  let held = 0;
  const s2 = pacedSocket({ act: async () => 'x' }, async () => { held++; throw new Error('gate failed'); });
  let gateErr = '';
  try { await s2.act(); } catch (e) { gateErr = e.message; }
  ok(gateErr === 'gate failed', 'a failing gate fails the call rather than letting it through unpaced');

  ok(pacedSocket(null, async () => {}) === null, 'no socket, no wrapper');
  const plain = { a: 1 };
  ok(pacedSocket(plain, null) === plain, 'no gate function, no wrapper');
}

console.log('=== the bot cannot hold an unpaced socket ===');
{
  // This is the whole point: assignment wraps, so pacing is not something a
  // future method - or a future assignment - has to remember.
  const cfg = { whatsapp: { pacing: { jitterMs: 0, groupSettingMs: 40, metadataMs: 40, defaultMs: 40 } } };
  const bot = new WhatsAppBot({ configStore: { get: () => cfg }, dataDir: '/tmp' });
  bot.state = 'connected';

  const at = [];
  bot.sock = { groupSettingUpdate: async () => { at.push(Date.now()); }, ev: { on() {} } };
  ok(bot.sock !== bot._rawSock, 'reading back the socket gives the paced wrapper, not what was assigned');
  ok(bot.sock.ev === bot._rawSock.ev, 'while staying transparent');

  bot._lastActionAt = 0;
  await bot.setGroupLocked('a@g.us', true);
  await bot.setGroupLocked('b@g.us', true);
  await bot.setGroupLocked('c@g.us', true);
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  ok(at.length === 3, 'all three calls went out');
  ok(gaps.every((g) => g >= 38), `and were paced without any method asking (tightest ${Math.min(...gaps)}ms)`);

  // An unclassified call must still be paced.
  const un = [];
  bot.sock = { totallyNewCall: async () => { un.push(Date.now()); } };
  bot._lastActionAt = 0;
  await bot.sock.totallyNewCall();
  await bot.sock.totallyNewCall();
  ok(un.length === 2 && un[1] - un[0] >= 38,
     `a call nobody classified is paced by the default (${un[1] - un[0]}ms)`);
}

console.log('=== a bulk job can say what its calls really are ===');
{
  const cfg = { whatsapp: { pacing: { jitterMs: 0, participantMs: 20, crossGroupMs: 80 } } };
  const bot = new WhatsAppBot({ configStore: { get: () => cfg }, dataDir: '/tmp' });
  bot.state = 'connected';
  const at = [];
  bot.sock = { groupParticipantsUpdate: async () => { at.push(Date.now()); return [{ jid: 'x', status: '200' }]; } };
  bot.scheduleGroupRefresh = () => {};
  bot.groupCache = new Map([
    ['g1@g.us', { jid: 'g1@g.us', subject: 'G1', memberNumbers: new Set(['15551112222']), members: [] }],
    ['g2@g.us', { jid: 'g2@g.us', subject: 'G2', memberNumbers: new Set(['15551112222']), members: [] }],
    ['g3@g.us', { jid: 'g3@g.us', subject: 'G3', memberNumbers: new Set(['15551112222']), members: [] }],
  ]);
  bot.groups = () => [...bot.groupCache.values()];

  bot._lastActionAt = 0;
  await bot.participantAcrossGroups('15551112222', ['g1@g.us', 'g2@g.us', 'g3@g.us'], 'promote');
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  ok(gaps.every((g) => g >= 78),
     `the same call gets the wider cross-group gap during a sweep (tightest ${Math.min(...gaps)}ms, not 20ms)`);
  ok(bot._paceScopes.length === 0, 'and the override is unwound when the sweep finishes');

  // Outside a sweep, the same call is back to the ordinary participant pace.
  at.length = 0;
  bot._lastActionAt = 0;
  await bot.modifyParticipants('g1@g.us', ['15551112222'], 'promote');
  await bot.modifyParticipants('g1@g.us', ['15551112222'], 'promote');
  ok(at[1] - at[0] >= 18 && at[1] - at[0] < 78,
     `outside a sweep it is the ordinary participant pace again (${at[1] - at[0]}ms)`);

  // A failing job must still unwind its override.
  bot.sock = { groupParticipantsUpdate: async () => { throw new Error('down'); } };
  try { await bot.participantAcrossGroups('15551112222', ['g1@g.us'], 'promote'); } catch { /* reported, not thrown */ }
  ok(bot._paceScopes.length === 0, 'an override is unwound even when the job fails');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
