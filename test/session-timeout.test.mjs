/* Per-admin session caps: who may be unlimited, when a session ends, and what
   happens to one whose account changed underneath it.
   Run: node test/session-timeout.test.mjs */
import express from 'express';
import session from 'express-session';
import { createApiRouter } from '../src/web/api.js';
import {
  sessionMinutesFor, sessionExpiresAt, setSessionMinutes, listAdmins, addAdmin, requireAuth,
  DEFAULT_ADMIN_SESSION_MINUTES, MAX_SESSION_MINUTES, NO_TIMEOUT,
} from '../src/web/auth.js';
import { hashPassword } from '../src/util/crypto.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const PW = 'averylongpassword';
const mkStore = (admins) => {
  const cfg = { web: { admins, adminPasswordHash: '', sessionSecret: 'x'.repeat(32) } };
  return { get: () => cfg, update: (p) => { if (p.web) Object.assign(cfg.web, p.web); return cfg; } };
};
const admin = (username, role, extra = {}) =>
  ({ username, role, passwordHash: hashPassword(PW), createdAt: 1, lastLogin: null, ...extra });

console.log('=== only a super-admin account may be unlimited ===');
{
  // The rule that makes the setting worth having: a browser left open on
  // someone's desk is how a LAN panel gets used by the wrong person.
  ok(sessionMinutesFor(admin('s', 'superadmin', { sessionMinutes: 0 })) === NO_TIMEOUT,
     'a super-admin set to 0 has no timeout');
  ok(sessionMinutesFor(admin('a', 'admin', { sessionMinutes: 0 })) === DEFAULT_ADMIN_SESSION_MINUTES,
     'an ordinary admin set to 0 does NOT get unlimited — it resolves to the default');

  // Resolved from the CURRENT role, so a demotion takes the privilege away.
  const wasSuper = admin('s', 'admin', { sessionMinutes: 0 });
  ok(sessionMinutesFor(wasSuper) === DEFAULT_ADMIN_SESSION_MINUTES,
     'a demoted super-admin loses its unlimited session immediately');

  ok(sessionMinutesFor(admin('a', 'admin', { sessionMinutes: 45 })) === 45, 'a real value is used as-is');
  ok(sessionMinutesFor(admin('s', 'superadmin', { sessionMinutes: 45 })) === 45, 'for either role');
}

console.log('=== accounts that predate the setting ===');
{
  // Upgrading must not log the operator out, nor leave ordinary admins
  // unlimited by accident.
  ok(sessionMinutesFor(admin('s', 'superadmin')) === NO_TIMEOUT,
     'a super-admin with nothing stored keeps the old behaviour');
  ok(sessionMinutesFor(admin('a', 'admin')) === DEFAULT_ADMIN_SESSION_MINUTES,
     'an admin with nothing stored gets the default, not unlimited');

  for (const junk of [null, undefined, '', 'abc', -5, 1.5, NaN, MAX_SESSION_MINUTES + 1, {}]) {
    const v = sessionMinutesFor(admin('a', 'admin', { sessionMinutes: junk }));
    ok(v === DEFAULT_ADMIN_SESSION_MINUTES, `junk value ${JSON.stringify(junk)} falls back to the default`);
  }
  ok(sessionMinutesFor(undefined) === DEFAULT_ADMIN_SESSION_MINUTES, 'no account at all is treated as an admin');
}

console.log('=== setting a cap ===');
{
  const cs = mkStore([admin('superadmin', 'superadmin'), admin('alice', 'admin')]);
  ok(setSessionMinutes(cs, 'alice', 30) === 30, 'a cap can be set');
  ok(listAdmins(cs).find((a) => a.username === 'alice').sessionMinutes === 30, 'and is reported back');
  ok(listAdmins(cs).find((a) => a.username === 'alice').sessionMinutesSet === true, 'flagged as explicitly set');
  ok(listAdmins(cs).find((a) => a.username === 'superadmin').sessionMinutesSet === false,
     'while an untouched account is flagged as using the default');

  ok(setSessionMinutes(cs, 'ALICE', 15) === 15, 'the username match is case-insensitive');
  ok(setSessionMinutes(cs, 'superadmin', 0) === 0, 'a super-admin may be set to 0');

  let msg = '';
  try { setSessionMinutes(cs, 'alice', 0); } catch (e) { msg = e.message; }
  ok(/super-admin/i.test(msg), `0 is refused for an ordinary admin: "${msg}"`);

  for (const bad of [-1, 1.5, 'abc', null, undefined, MAX_SESSION_MINUTES + 1, Infinity]) {
    let threw = false;
    try { setSessionMinutes(cs, 'alice', bad); } catch { threw = true; }
    ok(threw, `refuses ${JSON.stringify(String(bad))}`);
  }
  ok(listAdmins(cs).find((a) => a.username === 'alice').sessionMinutes === 15,
     'and none of them changed the stored value');

  let nosuch = false;
  try { setSessionMinutes(cs, 'ghost', 10); } catch { nosuch = true; }
  ok(nosuch, 'an unknown account is refused');
}

console.log('=== a cap can be set when the account is created ===');
{
  const cs = mkStore([admin('superadmin', 'superadmin')]);
  addAdmin(cs, 'bob', PW, 'admin', 60);
  ok(listAdmins(cs).find((a) => a.username === 'bob').sessionMinutes === 60, 'the value is stored');

  addAdmin(cs, 'carol', PW, 'admin');
  ok(listAdmins(cs).find((a) => a.username === 'carol').sessionMinutes === DEFAULT_ADMIN_SESSION_MINUTES,
     'omitting it uses the default');

  let msg = '';
  try { addAdmin(cs, 'dave', PW, 'admin', 0); } catch (e) { msg = e.message; }
  ok(/super-admin/i.test(msg), 'a new ordinary admin cannot be created unlimited');
  ok(!listAdmins(cs).some((a) => a.username === 'dave'), 'and the account is not created at all');

  addAdmin(cs, 'erin', PW, 'superadmin', 0);
  ok(sessionMinutesFor(cs.get().web.admins.find((a) => a.username === 'erin')) === NO_TIMEOUT,
     'a new super-admin can be');
}

console.log('=== expiry maths ===');
{
  const t = 1_700_000_000_000;
  ok(sessionExpiresAt(admin('a', 'admin', { sessionMinutes: 30 }), t) === t + 30 * 60_000, 'expiry is loginAt + cap');
  ok(sessionExpiresAt(admin('s', 'superadmin', { sessionMinutes: 0 }), t) === null, 'no cap means no expiry');
  ok(sessionExpiresAt(admin('a', 'admin', { sessionMinutes: 30 }), null) === null, 'and no login time means none either');
}

/* ------------------------- over real HTTP ---------------------------- */

/** A real express app with real sessions, so the cookie round-trips. */
function serve(admins) {
  const cs = mkStore(admins);
  const app = express();
  app.use(express.json());
  app.use(session({
    name: 'wabot.sid', secret: 'test-secret', resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
  }));
  app.use('/api', createApiRouter({
    configStore: { ...cs, dataDir: '/tmp', redacted: () => cs.get() },
    bot: { groups: () => [], status: () => ({}), isConnected: () => false, groupCacheAge: () => 0 },
    queue: { snapshot: () => ({}) },
    pluginManager: { list: () => [] },
    stateStore: { namespace: () => ({ get: (k, fb = null) => fb, set() {}, push() {}, all: () => ({}), delete() {} }) },
    fileLogger: { tail: () => [], files: () => [], list: () => [] },
    alerts: {},
    lockScheduler: { status: () => ({}) },
    dataDir: '/tmp', appRoot: '/tmp',
  }));
  return { app, cs };
}

const listen = (app) => new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = (srv) => `http://127.0.0.1:${srv.address().port}/api`;

/** A tiny cookie-keeping client. */
function client(srv) {
  let cookie = '';
  return async (method, p, body, headers = {}) => {
    const res = await fetch(`${base(srv)}${p}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setC = res.headers.getSetCookie?.() ?? [];
    for (const c of setC) {
      const kv = c.split(';')[0];
      if (kv.startsWith('wabot.sid=')) cookie = kv.endsWith('=') ? '' : kv;
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

console.log('=== signing in reports the cap, and the cookie is sized to it ===');
{
  const { app } = serve([admin('superadmin', 'superadmin'), admin('alice', 'admin', { sessionMinutes: 30 })]);
  const srv = await listen(app);
  const c = client(srv);

  const login = await c('POST', '/auth/login', { username: 'alice', password: PW });
  ok(login.status === 200, 'alice signs in');
  ok(login.body.sessionMinutes === 30, 'and is told her cap');
  ok(login.body.sessionExpiresAt > Date.now(), 'and when it ends');

  const st = await c('GET', '/auth/status');
  ok(st.body.authed === true, 'the session works');
  ok(st.body.sessionMinutes === 30 && st.body.sessionExpiresAt > Date.now(),
     'and status reports the cap so the panel can warn first');
  srv.close();
}

console.log('=== an expired session is refused, by the server ===');
{
  // The middleware is what must say no: the cookie is still perfectly valid,
  // and a stolen one would be too. Mounted directly with a session object
  // whose clock is in the past, so this tests the control rather than the
  // arithmetic around it.
  const cs = mkStore([admin('superadmin', 'superadmin'), admin('alice', 'admin', { sessionMinutes: 30 })]);
  const guard = requireAuth(cs);

  const run = (sess) => new Promise((resolve) => {
    let destroyed = false;
    const req = { session: sess ? { ...sess, destroy: (cb) => { destroyed = true; cb(); } } : undefined };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, destroyed, req }); },
      clearCookie() {},
    };
    guard(req, res, () => resolve({ status: 200, body: null, destroyed, req }));
  });

  const fresh = await run({ user: { username: 'alice', role: 'admin' }, loginAt: Date.now() - 60_000 });
  ok(fresh.status === 200, 'a session one minute into a 30-minute cap passes');

  const old = await run({ user: { username: 'alice', role: 'admin' }, loginAt: Date.now() - 31 * 60_000 });
  ok(old.status === 401, 'a session 31 minutes into a 30-minute cap is refused');
  ok(old.destroyed === true, 'and the session is destroyed, not just answered 401');
  ok(/ended after 30 minutes/.test(old.body.error), `with a message that says why: "${old.body.error}"`);
  ok(old.body.expired === true, 'flagged as expired so the UI can say so rather than "unauthorized"');

  // The boundary itself.
  const exact = await run({ user: { username: 'alice', role: 'admin' }, loginAt: Date.now() - 30 * 60_000 + 500 });
  ok(exact.status === 200, 'half a second before the cap it still passes');

  // An unlimited super-admin never expires, however old the session.
  const forever = await run({ user: { username: 'superadmin', role: 'superadmin' }, loginAt: 1 });
  ok(forever.status === 200, 'a super-admin with no timeout is never expired, however old the session');

  // A session from before this setting existed has no loginAt: start its clock
  // rather than logging the operator out the moment they upgrade.
  const legacy = await run({ user: { username: 'alice', role: 'admin' } });
  ok(legacy.status === 200, 'a session predating the setting is not booted on upgrade');
  ok(typeof legacy.req.session.loginAt === 'number', 'its clock is started instead');

  // And the cap in force is the CURRENT one, not the one at sign-in.
  setSessionMinutes(cs, 'alice', 5);
  const tightened = await run({ user: { username: 'alice', role: 'admin' }, loginAt: Date.now() - 10 * 60_000 });
  ok(tightened.status === 401, 'shortening the cap expires a session that is already older than the new value');
}

console.log('=== shortening a cap ends a session already in progress ===');
{
  const { app, cs } = serve([admin('superadmin', 'superadmin'), admin('alice', 'admin', { sessionMinutes: 600 })]);
  const srv = await listen(app);
  const sup = client(srv);
  const alice = client(srv);

  await alice('POST', '/auth/login', { username: 'alice', password: PW });
  ok((await alice('GET', '/auth/status')).body.authed === true, 'alice is signed in with a long cap');

  await sup('POST', '/auth/login', { username: 'superadmin', password: PW });
  const set = await sup('POST', '/admins/alice/session', { minutes: 1 });
  ok(set.status === 200 && set.body.minutes === 1, 'the super-admin shortens her cap to 1 minute');

  // Her session started more than a minute ago? No - but the config change is
  // read on her NEXT request, which is the property that matters.
  ok(cs.get().web.admins.find((a) => a.username === 'alice').sessionMinutes === 1,
     'the new cap is stored');
  ok((await alice('GET', '/auth/status')).body.sessionMinutes === 1,
     'and her live session already reports the shorter cap, without re-signing in');
  srv.close();
}

console.log('=== only a super-admin can change a cap ===');
{
  const { app } = serve([admin('superadmin', 'superadmin'), admin('alice', 'admin'), admin('bob', 'admin')]);
  const srv = await listen(app);
  const alice = client(srv);
  await alice('POST', '/auth/login', { username: 'alice', password: PW });

  const r = await alice('POST', '/admins/bob/session', { minutes: 5 });
  ok(r.status === 403, 'an ordinary admin cannot set anyone else’s cap');
  const own = await alice('POST', '/admins/alice/session', { minutes: 99999 });
  ok(own.status === 403, 'nor her own — she could otherwise opt out of the limit');

  const anon = client(srv);
  ok((await anon('POST', '/admins/alice/session', { minutes: 5 })).status === 401, 'and signed out gets nothing');
  srv.close();
}

console.log('=== a session whose account changed underneath it ===');
{
  const { app, cs } = serve([admin('superadmin', 'superadmin'), admin('alice', 'admin')]);
  const srv = await listen(app);
  const sup = client(srv);
  const alice = client(srv);

  await alice('POST', '/auth/login', { username: 'alice', password: PW });
  ok((await alice('GET', '/auth/status')).body.user.role === 'admin', 'alice signs in as an admin');

  // Promotion is picked up without re-signing in...
  cs.update({ web: { admins: cs.get().web.admins.map((a) => (a.username === 'alice' ? { ...a, role: 'superadmin' } : a)) } });
  const promoted = await alice('GET', '/auth/status');
  ok(promoted.body.user.role === 'superadmin', 'a promotion applies to her existing session');

  // ...and so is removal. Before this, a deleted admin kept working forever.
  await sup('POST', '/auth/login', { username: 'superadmin', password: PW });
  await sup('DELETE', '/admins/alice');
  const gone = await alice('GET', '/audit');
  ok(gone.status === 401, 'a removed account cannot keep using the session it already had');
  ok(/no longer exists/i.test(gone.body.error ?? ''), `and is told why: "${gone.body.error}"`);
  srv.close();
}

console.log(`\n${'='.repeat(52)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
