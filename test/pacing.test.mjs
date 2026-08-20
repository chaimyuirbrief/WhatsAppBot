/* Outbound action pacing: every burst path is deliberately slow, and the gap
   is shared so concurrent jobs cannot stack up rate.
   Run: node test/pacing.test.mjs */
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const mk = (whatsapp = {}, rest = {}) =>
  new WhatsAppBot({ configStore: { get: () => ({ whatsapp, ...rest }) }, dataDir: '/tmp' });

console.log('=== defaults are human-speed, not machine-speed ===');
{
  // With nothing configured, every administrative action still gets a gap
  // measured in seconds. This is the whole point of the feature.
  const bot = mk({ pacing: { jitterMs: 0 } });
  const kinds = {
    groupSetting: 5000,   // lock / unlock a group
    description: 5000,    // rewrite a group description
    participant: 4000,    // membership change inside one group
    crossGroup: 6000,     // the same person across many groups
    revoke: 2500,         // delete-for-everyone
  };
  for (const [kind, expected] of Object.entries(kinds)) {
    ok(bot._actionGapMs(kind) === expected, `${kind} defaults to ${expected}ms`);
    ok(bot._actionGapMs(kind) >= 2000, `${kind} is never faster than 2s — a person could keep up`);
  }
  ok(bot._lockdownPaceMs() === 5000, 'lockdown defaults to 5000ms');
}

console.log('=== config supplies the gaps, junk never means "no gap" ===');
{
  const bot = mk({ pacing: { jitterMs: 0, revokeMs: 9000, crossGroupMs: 7000 } });
  ok(bot._actionGapMs('revoke') === 9000, 'a configured gap is used');
  ok(bot._actionGapMs('crossGroup') === 7000, 'each kind is configured separately');
  ok(bot._actionGapMs('participant') === 4000, 'an unconfigured kind keeps its default');

  // null / '' / false all coerce to 0 under Number(), which would silently
  // disable pacing. The type check is what stops that.
  for (const bad of [null, '', false, -1, 'fast', {}, []]) {
    const b = mk({ pacing: { jitterMs: 0, revokeMs: bad } });
    ok(b._actionGapMs('revoke') === 2500, `revokeMs ${JSON.stringify(bad)} falls back to the default, not to 0`);
  }
  // A real number is honoured, including a deliberate 0 (which warns).
  ok(mk({ pacing: { jitterMs: 0, revokeMs: 0 } })._actionGapMs('revoke') === 0,
     'a deliberate numeric 0 disables that gap');
}

console.log('=== jitter only ever adds, and is actually random ===');
{
  const bot = mk({ pacing: { jitterMs: 400, revokeMs: 1000 } });
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const g = bot._actionGapMs('revoke');
    if (g < 1000 || g > 1400) { ok(false, `jitter stayed in range (saw ${g})`); break; }
    seen.add(g);
  }
  ok(seen.size > 20, `jitter varies the gap (${seen.size} distinct values in 200 draws)`);
  ok(Math.min(...seen) >= 1000, 'jitter never takes the gap below the configured minimum');
  ok(Math.max(...seen) <= 1400, 'jitter never exceeds the configured maximum');
  ok(mk({ pacing: { jitterMs: 400, revokeMs: 0 } })._actionGapMs('revoke') === 0,
     'a disabled gap stays disabled — jitter does not resurrect it');
}

console.log('=== the gap is shared, so two jobs at once do not double the rate ===');
{
  // Two different bulk operations running concurrently must still add up to
  // one paced stream. This is what _holdOff's shared clock buys.
  const bot = mk({ pacing: { jitterMs: 0, revokeMs: 60, crossGroupMs: 60 } });
  const at = [];
  const stamp = () => at.push(Date.now());

  const jobA = (async () => { for (let i = 0; i < 4; i++) { await bot._holdOff(bot._actionGapMs('revoke')); stamp(); } })();
  const jobB = (async () => { for (let i = 0; i < 4; i++) { await bot._holdOff(bot._actionGapMs('crossGroup')); stamp(); } })();
  await Promise.all([jobA, jobB]);

  at.sort((a, b) => a - b);
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  ok(at.length === 8, 'both jobs completed every step');
  // SLOP: the gap is enforced against Date.now() inside _holdOff, and these
  // stamps are taken a microtask later at 1ms resolution, so a measured gap
  // can read 1ms short of a gap that was actually honoured. Two orders of
  // magnitude below the shortfall an unpaced run would show (~0ms).
  ok(gaps.every((g) => g >= 58), `no two actions landed closer than the gap (tightest ${Math.min(...gaps)}ms)`);
}

console.log('=== contending callers share the clock and none is starved ===');
{
  // Six callers hitting the gate at once must come out spaced, and all of
  // them must come out - a moderation delete landing mid-lockdown waits its
  // turn, it does not lose the race forever.
  const bot = mk({ pacing: { jitterMs: 0, revokeMs: 50 } });
  const done = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    bot._holdOff(bot._actionGapMs('revoke')).then(() => done.push({ i, at: Date.now() - t0 }))));

  const at = done.map((d) => d.at).sort((a, b) => a - b);
  ok(done.length === 6, 'every queued caller was released');
  ok(at.slice(1).every((t, i) => t - at[i] >= 48), `contending callers are still spaced out (tightest ${Math.min(...at.slice(1).map((t, i) => t - at[i]))}ms)`);
  // Nobody is starved: six waiters at 50ms clear in about six slots, not in
  // some unbounded number of lost races.
  ok(Math.max(...at) <= 50 * 8, `all six cleared in bounded time (worst ${Math.max(...at)}ms for 6 x 50ms)`);
}

console.log('=== every bulk path paces, one action at a time ===');
{
  const gap = 60;
  const pacing = { jitterMs: 0, groupSettingMs: gap, descriptionMs: gap, participantMs: gap, crossGroupMs: gap, revokeMs: gap };
  const bot = mk({ pacing }, { lockdown: { paceMs: gap } });
  bot.state = 'connected';

  /** Record when each outbound call fires and how many overlap. */
  const spy = () => {
    const at = []; let live = 0, maxLive = 0;
    const fn = async () => {
      maxLive = Math.max(maxLive, ++live);
      at.push(Date.now());
      await new Promise((r) => setTimeout(r, 2));
      live--;
    };
    return { at, fn, max: () => maxLive };
  };
  /** Smallest gap between consecutive calls (see SLOP note above: -2ms). */
  const tightest = (at) => (at.length < 2 ? Infinity : Math.min(...at.slice(1).map((t, i) => t - at[i])));

  const groups = [
    { jid: '1@g.us', subject: 'One' }, { jid: '2@g.us', subject: 'Two' }, { jid: '3@g.us', subject: 'Three' },
  ];
  bot.groupCache = new Map(groups.map((g) => [g.jid, { ...g, memberNumbers: new Set(['15551112222']) }]));
  bot.groups = () => groups;
  bot.refreshGroups = async () => [];

  const cases = [
    ['setAllGroupsLocked', async (s) => { bot.sock = { groupSettingUpdate: s.fn }; await bot.setAllGroupsLocked(true); }],
    ['applyDescriptions', async (s) => { bot.sock = { groupUpdateDescription: s.fn }; await bot.applyDescriptions(groups.map((g) => ({ jid: g.jid, desc: 'x' }))); }],
    ['modifyParticipants', async (s) => {
      bot.sock = { groupParticipantsUpdate: async (...a) => { await s.fn(); return []; } };
      // 15 targets -> 3 chunks of 5, paced between chunks.
      await bot.modifyParticipants('1@g.us', Array.from({ length: 15 }, (_, i) => `1555000${1000 + i}`), 'remove');
    }],
    ['participantAcrossGroups', async (s) => {
      bot.sock = { groupParticipantsUpdate: async (...a) => { await s.fn(); return [{ jid: 'x', status: '200' }]; } };
      await bot.participantAcrossGroups('15551112222', groups.map((g) => g.jid), 'promote');
    }],
    ['banFromAllGroups', async (s) => {
      bot.sock = { groupParticipantsUpdate: async (...a) => { await s.fn(); return [{ jid: 'x', status: '200' }]; } };
      await bot.banFromAllGroups('15551112222', { wipeMessages: false });
    }],
  ];

  for (const [name, run] of cases) {
    const s = spy();
    bot._lastActionAt = 0;
    const t0 = Date.now();
    await run(s);
    const elapsed = Date.now() - t0;
    ok(s.at.length === 3, `${name}: made all 3 calls`);
    ok(s.max() === 1, `${name}: strictly one action in flight at a time`);
    ok(tightest(s.at) >= gap - 2, `${name}: at least ${gap}ms between actions (tightest ${tightest(s.at)}ms)`);
    ok(elapsed < gap * 4, `${name}: no trailing wait after the last action (${elapsed}ms)`);
  }
}

console.log('=== mass revoke is the slowest path of all ===');
{
  const bot = mk({ pacing: { jitterMs: 0, revokeMs: 60 } });
  bot.state = 'connected';
  const at = [];
  bot.sock = { sendMessage: async () => { at.push(Date.now()); } };
  bot.groupCache = new Map([['g@g.us', { jid: 'g@g.us', subject: 'G' }]]);
  bot.messageIndex = {
    forSender: () => Array.from({ length: 4 }, (_, i) => ({ groupJid: 'g@g.us', key: { id: `m${i}` } })),
    forget: () => {},
  };
  bot._lastActionAt = 0;
  const res = await bot.deleteRecentMessagesFrom({ number: '15551112222' });
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  ok(res.deleted === 4, 'every message was revoked');
  ok(gaps.every((g) => g >= 58), `revokes are spaced out (tightest ${Math.min(...gaps)}ms)`);
  // The default is deliberately much slower than the 60ms used here.
  ok(mk({ pacing: { jitterMs: 0 } })._actionGapMs('revoke') === 2500, 'the shipped default is 2.5s per revoke');
}

console.log('=== reactive moderation deletes are throttled too ===');
{
  // A flood of rule-breaking posts must not become a flood of revokes.
  const bot = mk({ minActionDelayMs: 40, maxActionDelayMs: 40 });
  bot.state = 'connected';
  const at = [];
  bot.sock = { sendMessage: async () => { at.push(Date.now()); } };
  bot._lastActionAt = 0;
  for (let i = 0; i < 4; i++) {
    await bot.deleteMessage({ key: { id: `m${i}`, remoteJid: 'g@g.us', fromMe: false } });
  }
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  ok(at.length === 4, 'all four deletes went out');
  ok(gaps.every((g) => g >= 38), `deletes are spaced by the message clock (tightest ${Math.min(...gaps)}ms)`);
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
