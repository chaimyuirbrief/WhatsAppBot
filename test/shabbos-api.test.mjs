/* The Shabbos-lock endpoints as the portal calls them: the zmanim catalogue,
   the worked-out dates, and checking a location that is still being typed.
   Runs the real router over a real HTTP server.
   Run: node test/shabbos-api.test.mjs */
import express from 'express';
import { createApiRouter } from '../src/web/api.js';
import { hashPassword } from '../src/util/crypto.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const GROUPS = Array.from({ length: 40 }, (_, i) => ({ jid: `g${i}@g.us`, subject: `Group ${i + 1}`, size: 20 }));
const BROOKLYN = { id: 'bk', name: 'Brooklyn', latitude: 40.6329, longitude: -73.9949, elevation: 15, timezone: 'America/New_York' };

function serve(sessionUser) {
  const cfg = {
    web: {
      admins: [{ username: 'alice', passwordHash: hashPassword('averylongpassword'), role: 'superadmin', createdAt: 1, lastLogin: 1 }],
      adminPasswordHash: '',
    },
    whatsapp: {}, logging: {}, email: {}, announce: {}, moderation: {},
    lockdown: {
      enabled: false, timezone: 'America/New_York', windows: [], paceMs: 5000, alwaysLocked: [],
      shabbos: {
        enabled: true, includeYomTov: true, inIsrael: false,
        locations: [BROOKLYN],
        start: { locationId: 'bk', zman: 'candleLighting', offsetMinutes: 0 },
        end: { locationId: 'bk', zman: 'tzais8.5', offsetMinutes: 0 },
        leadMinutes: null,
      },
    },
  };
  const data = {};
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
    configStore: {
      get: () => cfg,
      update: (patch) => { for (const k of Object.keys(patch)) Object.assign(cfg[k] ??= {}, patch[k]); return cfg; },
      redacted: () => JSON.parse(JSON.stringify(cfg)),
    },
    // 40 groups at the configured 5s pace is what the head-start before candle
    // lighting is worked out from.
    bot: { groups: () => GROUPS, status: () => ({}), isConnected: () => false, groupCacheAge: () => 0 },
    queue: { snapshot: () => ({}), pause() {}, resume() {}, clearPending: () => 0, cancel: () => true, skip: () => true, move: () => true },
    pluginManager: { list: () => [], notifyConfigChange() {} },
    stateStore,
    fileLogger: { tail: () => [], files: () => [] },
    alerts: {},
    lockScheduler: { status: () => ({ enabled: false }) },
  }));
  return { app, cfg, data };
}

const listen = (app) => new Promise((res) => { const s = app.listen(0, () => res(s)); });
/** The preview endpoint takes the location as query parameters, exactly as the
    panel builds it from the row being typed. */
const previewQuery = (loc, date) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(loc ?? {})) if (v !== undefined && v !== null) q.set(k, String(v));
  if (date !== undefined && date !== null) q.set('date', String(date));
  return `/lockdown/zmanim/preview?${q}`;
};
const call = async (srv, method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const { app, cfg, data } = serve({ username: 'alice', role: 'superadmin' });
const srv = await listen(app);

console.log('=== GET /lockdown/zmanim ===');
{
  const { status, body } = await call(srv, 'GET', '/lockdown/zmanim');
  ok(status === 200, 'responds 200');
  ok(Array.isArray(body.options) && body.options.length > 10, `the catalogue has ${body.options?.length} zmanim`);
  ok(body.options.every((o) => o.key && o.label && o.side), 'each with a key, a label and which end it belongs to');
  ok(body.options.some((o) => o.key === 'candleLighting') && body.options.some((o) => o.key === 'tzais8.5'),
     'including the two defaults the panel starts on');
  ok(Array.isArray(body.upcoming) && body.upcoming.length >= 3, `and ${body.upcoming?.length} worked-out locks`);
  const w = body.upcoming[0];
  ok(typeof w.label === 'string' && w.label.length > 0, 'each lock is labelled');
  ok(!Number.isNaN(Date.parse(w.lockAt)) && !Number.isNaN(Date.parse(w.unlockAt)), 'with real instants');
  ok(w.start.location === 'Brooklyn' && w.end.location === 'Brooklyn', 'and both ends named');
  ok(typeof w.start.zmanLabel === 'string' && typeof w.end.zmanLabel === 'string', 'in words, not just keys');
  ok(w.leadMinutes === 5,
     `plus how many minutes early the walk starts — 40 groups at 5s each needs 5 (${w.leadMinutes})`);
  ok(Date.parse(w.lockAt) === Date.parse(w.start.at) - w.leadMinutes * 60000,
     'the lock time is the zman minus the lead, which is what the panel explains');

  const short = await call(srv, 'GET', '/lockdown/zmanim?days=7');
  ok(short.body.upcoming.length < body.upcoming.length, 'a shorter span returns fewer');
  const silly = await call(srv, 'GET', '/lockdown/zmanim?days=99999');
  ok(silly.status === 200 && silly.body.upcoming.length > 0, 'an absurd span is clamped rather than refused');
  const negative = await call(srv, 'GET', '/lockdown/zmanim?days=-5');
  ok(negative.status === 200 && negative.body.upcoming.length > 0, 'so is a negative one');
}

console.log('=== GET /lockdown/zmanim/preview ===');
{
  const { status, body } = await call(srv, 'GET', previewQuery(BROOKLYN));
  ok(status === 200 && body.ok, 'a complete location previews');
  ok(body.timezone === 'America/New_York' && body.location === 'Brooklyn', 'says where it is for');
  ok(body.date && body.date.y > 2000, 'and for which day');
  ok(body.times.candleLighting && body.times['tzais8.5'], 'keys are returned exactly as the catalogue names them');
  ok(Object.keys(body.times).length > 10, `covering the whole catalogue (${Object.keys(body.times).length})`);
  ok(body.times.candleLighting.at < body.times.sunset.at, 'candle lighting is before sunset');
  ok(body.times['tzais8.5'].at > body.times.sunset.at, 'and tzais after it');
  ok(body.times.candleLighting.fallback === false, 'nothing is flagged as approximate at this latitude');

  const dated = await call(srv, 'GET', previewQuery(BROOKLYN, '2026-01-16'));
  ok(dated.body.date.y === 2026 && dated.body.date.m === 1 && dated.body.date.d === 16, 'an explicit date is honoured');
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(dated.body.times.candleLighting.at));
  ok(hhmm === '16:36', `and gives the published time for that Friday (${hhmm})`);

  // The value of this endpoint is the sentence, not the status code.
  for (const [loc, why] of [
    [{ name: 'x', longitude: -73, timezone: 'UTC' }, 'a missing latitude'],
    [{ name: 'x', latitude: 40, longitude: -73, timezone: 'Mars/Olympus' }, 'an unknown timezone'],
    [{ latitude: 40, longitude: -73, timezone: 'UTC' }, 'a missing name'],
    [undefined, 'no location at all'],
  ]) {
    const r = await call(srv, 'GET', previewQuery(loc));
    ok(r.status === 400 && typeof r.body.error === 'string' && r.body.error.length > 10,
       `${why} comes back as a sentence an admin can act on — "${r.body.error}"`);
  }

  // A date that matches the shape but is not a real day must not reach the
  // calendar and come back as a page of nulls.
  const bogus = await call(srv, 'GET', previewQuery(BROOKLYN, '2026-13-45'));
  ok(bogus.status === 200 && bogus.body.times.candleLighting, 'an impossible date falls back to the coming Friday');
  ok(bogus.body.date.m >= 1 && bogus.body.date.m <= 12, 'with a real month');
  for (const junk of ['', 'tomorrow', '16/01/2026', null, 12345, {}]) {
    const r = await call(srv, 'GET', previewQuery(BROOKLYN, junk));
    ok(r.status === 200 && r.body.times.candleLighting, `a date of ${JSON.stringify(junk)} falls back rather than failing`);
  }

  // Coordinates arrive from a form as strings.
  const typed = await call(srv, 'GET', previewQuery({ name: 'Typed', latitude: '40.6329', longitude: '-73.9949', elevation: '15', timezone: 'America/New_York' }));
  ok(typed.status === 200 && typed.body.times.candleLighting.at === body.times.candleLighting.at,
     'and give the same answer as the numbers would');
}

console.log('=== looking is not an action ===');
{
  // The catch-all audit middleware records every POST, so a read like this
  // has to be a GET or an admin typing a latitude fills their own trail with
  // half a dozen identical entries.
  const before = (data.audit?.events ?? []).length;
  for (let i = 0; i < 5; i++) await call(srv, 'GET', previewQuery(BROOKLYN));
  await call(srv, 'GET', '/lockdown/zmanim');
  ok((data.audit?.events ?? []).length === before, 'checking the times is not recorded in the audit trail');
}

console.log('=== the schedule saves and comes back ===');
{
  const saved = await call(srv, 'PUT', '/config', {
    lockdown: {
      ...cfg.lockdown,
      shabbos: {
        ...cfg.lockdown.shabbos,
        locations: [BROOKLYN, { id: 'jm', name: 'Jerusalem', latitude: 31.7683, longitude: 35.2137, elevation: 754, timezone: 'Asia/Jerusalem', candleOffsetMinutes: 40 }],
        end: { locationId: 'jm', zman: 'tzais72', offsetMinutes: 5 },
        leadMinutes: 12,
      },
    },
  });
  ok(saved.status === 200, 'a two-location schedule saves');
  ok(cfg.lockdown.shabbos.locations.length === 2, 'both locations are stored');
  ok(cfg.lockdown.shabbos.end.locationId === 'jm' && cfg.lockdown.shabbos.end.offsetMinutes === 5,
     'and the unlock end keeps its own place and offset');

  const after = await call(srv, 'GET', '/lockdown/zmanim');
  const w = after.body.upcoming[0];
  ok(w.start.location === 'Brooklyn' && w.end.location === 'Jerusalem',
     'the worked-out dates immediately reflect the two-location setup');
  ok(w.leadMinutes === 12, 'and the saved lead time');
  ok((data.audit?.events ?? []).some((e) => /config/i.test(e.action ?? '')),
     'while actually changing the schedule IS recorded');
}

console.log('=== signed out ===');
{
  const anon = await listen(serve(null).app);
  const a = await call(anon, 'GET', '/lockdown/zmanim');
  ok(a.status === 401, 'the catalogue needs a session');
  const b = await call(anon, 'GET', previewQuery(BROOKLYN));
  ok(b.status === 401, 'so does a preview — it is not an open geolocation service');
  anon.close();
}

srv.close();
console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
