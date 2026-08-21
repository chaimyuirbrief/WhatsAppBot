/* The audit endpoints as the portal actually calls them: filters on
   /audit, and one admin's own trail on /admins/:username/audit.
   Runs the real router over a real HTTP server. Run: node test/audit-api.test.mjs */
import express from 'express';
import { createApiRouter } from '../src/web/api.js';
import { hashPassword } from '../src/util/crypto.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const T = 1_700_000_000_000;
const EVENTS = [
  { ts: T + 900, user: 'superadmin', role: 'superadmin', action: 'login', detail: 'POST /auth/login' },
  { ts: T + 800, user: 'alice', role: 'admin', action: 'banned +15551112222 from all groups', detail: 'POST /members/ban-all' },
  { ts: T + 700, user: 'alice', role: 'admin', action: 'locked all groups (manual)', detail: 'POST /lockdown/lock' },
  { ts: T + 600, user: 'alice', role: 'admin', action: 'login', detail: 'POST /auth/login' },
  { ts: T + 500, user: 'bob', role: 'admin', action: 'saved settings', detail: 'PUT /config' },
  { ts: T + 400, user: 'lockdown:schedule', role: 'system', action: 'locked 12 groups' },
];

/** Mount the real router with a fixed signed-in user and a seeded audit log. */
function serve(sessionUser) {
  const cfg = {
    web: {
      admins: [
        { username: 'superadmin', passwordHash: hashPassword('averylongpassword'), role: 'superadmin', createdAt: T, lastLogin: T + 900 },
        { username: 'alice', passwordHash: hashPassword('averylongpassword'), role: 'admin', createdAt: T, lastLogin: T + 600 },
        { username: 'bob', passwordHash: hashPassword('averylongpassword'), role: 'admin', createdAt: T, lastLogin: null },
        { username: 'quiet', passwordHash: hashPassword('averylongpassword'), role: 'admin', createdAt: T, lastLogin: null },
      ],
      adminPasswordHash: '',
    },
    whatsapp: {}, lockdown: {}, logging: {}, email: {}, announce: {}, moderation: {},
  };
  const data = { audit: { events: [...EVENTS] } };
  const stateStore = {
    namespace: (ns) => ({
      get: (k, fb = null) => (data[ns]?.[k] ?? fb),
      set: (k, v) => { (data[ns] ??= {})[k] = v; },
      push: (k, v, cap = 200) => { const a = data[ns]?.[k] ?? []; a.unshift(v); a.length = Math.min(a.length, cap); (data[ns] ??= {})[k] = a; },
      all: () => ({ ...data[ns] }),
      delete: (k) => { delete data[ns]?.[k]; },
    }),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = sessionUser ? { user: sessionUser, destroy: (cb) => cb() } : {}; next(); });
  app.use('/api', createApiRouter({
    configStore: { get: () => cfg, update: (patch) => { for (const k of Object.keys(patch)) Object.assign(cfg[k] ??= {}, patch[k]); return cfg; } },
    bot: { groups: () => [], status: () => ({}), isConnected: () => false, groupCacheAge: () => 0 },
    queue: { snapshot: () => ({}), pause() {}, resume() {}, clearPending: () => 0, cancel: () => true, skip: () => true, move: () => true },
    pluginManager: { list: () => [] },
    stateStore,
    fileLogger: { tail: () => [], files: () => [] },
    alerts: {},
    lockScheduler: { status: () => ({ enabled: false }) },
  }));
  return { app, data };
}

const listen = (app) => new Promise((res) => { const s = app.listen(0, () => res(s)); });
const get = async (srv, path) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${path}`);
  return { status: r.status, body: await r.json().catch(() => null) };
};

const { app } = serve({ username: 'superadmin', role: 'superadmin' });
const srv = await listen(app);

console.log('=== GET /audit returns the shape the portal renders ===');
{
  const { status, body } = await get(srv, '/audit');
  ok(status === 200, 'responds 200');
  ok(Array.isArray(body.events), 'events is an array');
  ok(body.total === EVENTS.length, `total is every event (${body.total})`);
  ok(body.shown === body.events.length, 'shown matches what was actually sent');
  ok(body.events.every((e) => typeof e.category === 'string'), 'every event carries its category');
  ok(body.summary && Array.isArray(body.summary.categories) && Array.isArray(body.summary.users),
     'a summary with categories and users rides along, so the chips need no second request');
  const cats = Object.fromEntries(body.summary.categories.map((c) => [c.key, c.count]));
  ok(cats.auth === 2 && cats.members === 1 && cats.lockdown === 2 && cats.settings === 1,
     'the summary counts each kind of action');
  ok(body.events[0].ts === T + 900, 'newest first by default');
}

console.log('=== the filters the Logs tab drives ===');
{
  const byCat = await get(srv, '/audit?category=lockdown');
  ok(byCat.body.total === 2, 'category filter narrows to lock/unlock (including the scheduler’s own)');
  ok(byCat.body.events.every((e) => e.category === 'lockdown'), 'and only returns that category');

  const byUser = await get(srv, '/audit?user=alice');
  ok(byUser.body.total === 3, 'user filter narrows to one admin');
  ok(byUser.body.events.every((e) => e.user === 'alice'), 'and only returns their actions');

  const both = await get(srv, '/audit?user=alice&category=auth');
  ok(both.body.total === 1, 'filters combine');

  ok((await get(srv, '/audit?search=banned')).body.total === 1, 'free-text search works');
  ok((await get(srv, '/audit?order=oldest')).body.events[0].ts === T + 400, 'oldest-first flips the order');
  ok((await get(srv, '/audit?limit=2')).body.events.length === 2, 'limit caps the page');
  ok((await get(srv, '/audit?limit=2')).body.total === EVENTS.length, 'but total still reports every match');

  // The counts must describe the WHOLE log, not the filtered slice - otherwise
  // every chip would read 0 the moment you clicked a different one.
  const cats = Object.fromEntries(byCat.body.summary.categories.map((c) => [c.key, c.count]));
  ok(cats.auth === 2, 'the chip counts stay whole-log while a filter is applied');

  ok((await get(srv, '/audit?user=nobody')).body.total === 0, 'an unknown user matches nothing, not everything');
  ok((await get(srv, '/audit?category=nonsense')).body.total === 0, 'an unknown category matches nothing, not everything');
  ok((await get(srv, '/audit?limit=3')).body.events.length === 3, 'a small page is honoured exactly');
  ok((await get(srv, '/audit?limit=2.7')).body.events.length === 2, 'a fractional limit floors');
}

console.log('=== paging over a log larger than one page ===');
{
  // 6 events cannot distinguish "the default page of 200" from "no limit at
  // all" - both return everything. A junk ?limit collapsing to 0, which reads
  // downstream as unlimited, only shows up against a log bigger than a page.
  const BIG = Array.from({ length: 260 }, (_, i) => ({
    ts: T + 10_000 + i, user: i % 2 ? 'alice' : 'bob', role: 'admin',
    action: `did thing ${i}`, detail: 'POST /queue/pause',
  }));
  const { app: bigApp, data } = serve({ username: 'superadmin', role: 'superadmin' });
  data.audit.events = BIG;
  const big = await listen(bigApp);

  ok((await get(big, '/audit')).body.total === 260, 'total reports every event');
  ok((await get(big, '/audit')).body.events.length === 200, 'the default page is 200, not the whole log');
  ok((await get(big, '/audit')).body.shown === 200, 'and shown says so');
  ok((await get(big, '/audit?limit=1000')).body.events.length === 260, 'a bigger limit returns more');
  ok((await get(big, '/audit?limit=999999')).body.events.length === 260, 'an absurd limit is clamped, not an error');

  // Each of these coerces to 0 under `Math.max(0, Number(x) || d)`, and 0 means
  // "no limit" downstream. They must fall back to the default page instead.
  for (const bad of ['-5', '0', 'abc', '-999999', '']) {
    const r = await get(big, `/audit?limit=${bad}`);
    ok(r.body.events.length === 200, `limit="${bad}" falls back to the default page, not the whole log`);
  }

  const p1 = await get(big, '/audit?limit=50');
  const p2 = await get(big, '/audit?limit=50&offset=50');
  ok(p1.body.events.length === 50 && p2.body.events.length === 50, 'pages are the size asked for');
  ok(p1.body.events.at(-1).ts !== p2.body.events[0].ts, 'consecutive pages do not overlap');
  ok(p2.body.events[0].ts === p1.body.events[49].ts - 1, 'and they are contiguous');
  ok((await get(big, '/audit?offset=999999')).body.events.length === 0, 'an offset past the end is empty, not an error');
  ok((await get(big, '/audit?limit=50')).body.total === 260, 'total still counts every match while paging');

  // The per-admin trail has its own, smaller default page (50) and needs the
  // same guard - alice owns 130 of these events, so unlimited and default differ.
  ok((await get(big, '/admins/alice/audit')).body.summary.total === 130, 'the trail sees all of their events');
  ok((await get(big, '/admins/alice/audit')).body.events.length === 50, 'but pages at 50 by default');
  for (const bad of ['-1', '0', 'abc']) {
    ok((await get(big, `/admins/alice/audit?limit=${bad}`)).body.events.length === 50,
       `trail limit="${bad}" falls back to the default page, not the whole trail`);
  }
  ok((await get(big, '/admins/alice/audit?limit=5')).body.events.length === 5, 'and honours a real one');
  big.close();
}

console.log('=== GET /admins/:username/audit is one admin’s own trail ===');
{
  const { status, body } = await get(srv, '/admins/alice/audit');
  ok(status === 200, 'responds 200 for a real account');
  ok(body.user === 'alice' && body.role === 'admin', 'names the account it belongs to');
  ok(body.lastLogin === T + 600, 'reports their last sign-in');
  ok(body.events.length === 3 && body.events.every((e) => e.user === 'alice'), 'returns only their actions');
  ok(body.summary.total === 3, 'the summary is scoped to this admin, not the whole log');
  const cats = Object.fromEntries(body.summary.categories.map((c) => [c.key, c.count]));
  ok(cats.members === 1 && cats.lockdown === 1 && cats.auth === 1, 'broken down by what they did');
  ok(cats.settings === 0, "another admin's actions do not leak into this trail");

  const quiet = await get(srv, '/admins/quiet/audit');
  ok(quiet.status === 200 && quiet.body.events.length === 0 && quiet.body.user === 'quiet',
     'an admin who has done nothing returns an empty trail, not a 404');

  const missing = await get(srv, '/admins/nosuchperson/audit');
  ok(missing.status === 404, 'a username that is not an account is a 404, so the UI can tell the two apart');

  ok((await get(srv, '/admins/ALICE/audit')).body.events.length === 3,
     'the lookup is case-insensitive, matching how sign-in treats usernames');
  ok((await get(srv, '/admins/alice/audit?category=auth')).body.events.length === 1,
     'the trail can be narrowed by category too');
  ok((await get(srv, '/admins/alice/audit?limit=-1')).body.events.length === 3,
     'a junk limit on the trail falls back to the default too');
  ok((await get(srv, '/admins/alice/audit?limit=1')).body.events.length === 1,
     'and a real one is honoured');
}

console.log('=== one action is recorded once ===');
{
  // The catch-all middleware and an explicit audit() call used to BOTH fire,
  // filing "POST /admins" beside "add admin \"x\"". Every count, every chip and
  // every admin's trail was therefore roughly doubled.
  const { app: a2, data } = serve({ username: 'superadmin', role: 'superadmin' });
  data.audit.events = [];
  const s2 = await listen(a2);
  const post = (p, b) => fetch(`http://127.0.0.1:${s2.address().port}/api${p}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) })
    .then((r) => r.json().catch(() => null));

  await post('/admins', { username: 'newperson', password: 'averylongpassword', role: 'admin' });
  await new Promise((r) => setTimeout(r, 150));
  ok(data.audit.events.length === 1, `one action -> one entry (got ${data.audit.events.length})`);
  ok(/add admin/.test(data.audit.events[0].action), 'and it is the descriptive one, not "POST /admins"');
  ok(data.audit.events[0].detail === 'POST /admins', 'with the path kept as the detail');

  // A route with no explicit audit() call must still be recorded.
  data.audit.events = [];
  await post('/queue/pause');
  await new Promise((r) => setTimeout(r, 150));
  ok(data.audit.events.length === 1, 'a route that does not describe itself is still recorded once');
  ok(data.audit.events[0].action === 'POST /queue/pause', 'by method and path');

  // A failed request is not recorded at all.
  data.audit.events = [];
  await post('/admins', { username: '!!bad!!', password: 'x' });
  await new Promise((r) => setTimeout(r, 150));
  ok(data.audit.events.length === 0, 'a rejected action leaves no entry');
  s2.close();
}

console.log('=== signed out gets nothing ===');
{
  const { app: anonApp } = serve(null);
  const anon = await listen(anonApp);
  ok((await get(anon, '/audit')).status === 401, '/audit requires a session');
  ok((await get(anon, '/admins/alice/audit')).status === 401, "and so does an admin's trail");
  anon.close();
}

srv.close();
console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
