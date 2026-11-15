/* Password managers can save and fill the panel sign-in on every browser.
   Covers the markup managers classify by, the sign-in being a real form post,
   the form-post route itself (303s, rate limit, login-CSRF check, proxies),
   password-change forms, and keeping managers out of every other secret box.
   Run: node test/login-autofill.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { createApiRouter } from '../src/web/api.js';
import { hashPassword } from '../src/util/crypto.js';

let pass = 0, fail = 0, skipped = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'src', 'web', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');

// linkedom is a devDependency; a production install omits it (see portal-search.test.mjs).
let parseHTML = null;
try { ({ parseHTML } = await import('linkedom')); } catch { /* not installed */ }
if (!parseHTML) {
  skipped += 1;
  console.log('  skip  linkedom not installed (production install) — `npm install` to run the markup checks');
}
const doc = parseHTML ? parseHTML(html).document : null;
const IGNORE = { 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' };

if (doc) {
  console.log('=== 1. the sign-in form is a real form posting to the form route ===');
  const form = doc.getElementById('gate-form');
  ok(form?.tagName === 'FORM', 'sign-in is a <form>');
  ok(form?.getAttribute('method') === 'post' && form?.getAttribute('action') === '/api/auth/signin',
     'method="post" action="/api/auth/signin"');
  ok(!form?.hasAttribute('autocomplete'), 'no autocomplete="off" on the form');
  const user = doc.getElementById('username');
  const want = { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none',
    autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Username', enterkeyhint: 'next' };
  for (const [k, v] of Object.entries(want)) ok(user?.getAttribute(k) === v, `username ${k}="${v}"`);
  ok(user?.hasAttribute('required'), 'username required');
  const pw = doc.getElementById('password');
  const wantPw = { type: 'password', name: 'password', autocomplete: 'current-password',
    'aria-label': 'Password', enterkeyhint: 'go' };
  for (const [k, v] of Object.entries(wantPw)) ok(pw?.getAttribute(k) === v, `password ${k}="${v}"`);
  ok(pw?.hasAttribute('required'), 'password required');
  const enabledPw = [...form.querySelectorAll('input[type=password]')].filter((i) => !i.hasAttribute('disabled'));
  ok(enabledPw.length === 1, `exactly one enabled password field in the sign-in form (found ${enabledPw.length})`);
  ok(form.querySelector('button[type=submit]'), 'has a submit button');

  // First run: its own form (from a <template>), with the fixed username in it.
  const tpl = doc.getElementById('tpl-setup');
  const setupHtml = tpl?.innerHTML ?? '';
  ok(/autocomplete="username"[^>]*readonly|readonly[^>]*autocomplete="username"/.test(setupHtml)
     && /value="superadmin"/.test(setupHtml), 'first-run form carries username "superadmin"');
  ok((setupHtml.match(/autocomplete="new-password"/g) ?? []).length === 2, 'first-run passwords are new-password');
}

console.log('=== 2. a fresh sign-in is not preventDefault()ed ===');
{
  const handler = appJs.match(/\$\('gate-form'\)\.addEventListener\('submit'[\s\S]*?\n\}\);/)?.[0] ?? '';
  const ret = handler.indexOf('return;');
  const prevent = handler.indexOf('e.preventDefault()');
  ok(handler && /if \(!gateShownForExpiry\)/.test(handler), 'the handler branches on a fresh sign-in');
  ok(ret > 0 && prevent > ret, 'it returns before preventDefault() for a fresh sign-in');
  ok(/sessionStorage\?\.setItem\(SIGNIN_USER_KEY/.test(handler), 'it keeps the typed username for the return trip');
  ok(/Signing in…/.test(handler), 'the button says "Signing in…"');
  ok(/replaceState/.test(appJs) && /searchParams\.get\('signin'\)/.test(appJs), '?signin= is read and then removed');
}

console.log('=== 3. the form-post route, against a running server ===');
{
  const PW = 'averylongpassword';
  const cfg = {
    web: { admins: [{ username: 'superadmin', role: 'superadmin', passwordHash: hashPassword(PW), createdAt: 1, lastLogin: null }],
      adminPasswordHash: '', sessionSecret: 'x'.repeat(32) },
    whatsapp: {}, lockdown: {}, logging: {}, email: {}, announce: {}, moderation: {},
  };
  const data = {};
  const stateStore = { namespace: (ns) => ({
    get: (k, fb = null) => (data[ns]?.[k] ?? fb), set: (k, v) => { (data[ns] ??= {})[k] = v; },
    push: (k, v) => { ((data[ns] ??= {})[k] ??= []).unshift(v); }, all: () => ({ ...data[ns] }),
    delete: (k) => { delete data[ns]?.[k]; } }) };
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(session({ secret: 'x'.repeat(32), resave: false, saveUninitialized: false }));
  app.use('/api', createApiRouter({
    configStore: { get: () => cfg, update: (p) => { for (const k of Object.keys(p)) Object.assign(cfg[k] ??= {}, p[k]); return cfg; } },
    bot: { groups: () => [], status: () => ({}), isConnected: () => false, groupCacheAge: () => 0 },
    queue: { snapshot: () => ({}) }, pluginManager: { list: () => [] }, stateStore,
    fileLogger: { tail: () => [], files: () => [], list: () => [] }, alerts: {},
    lockScheduler: { status: () => ({ enabled: false }) },
  }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const host = `127.0.0.1:${srv.address().port}`;

  const post = (fields, headers = {}) => fetch(`${base}/api/auth/signin`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
  const status = (cookie) => fetch(`${base}/api/auth/status`, { headers: cookie ? { Cookie: cookie } : {} }).then((r) => r.json());
  const cookieOf = (r) => r.headers.get('set-cookie')?.split(';')[0] ?? null;

  try {
    let r = await post({ username: 'superadmin', password: PW });
    let c = cookieOf(r);
    ok(r.status === 303 && r.headers.get('location') === '/', `right password → 303 to / (got ${r.status} ${r.headers.get('location')})`);
    ok(c && (await status(c)).authed === true, 'and that session is signed in');

    r = await post({ username: 'superadmin', password: PW }, { Origin: 'https://panel.example.org', 'X-Forwarded-Host': 'panel.example.org' });
    c = cookieOf(r);
    ok(r.headers.get('location') === '/' && c && (await status(c)).authed, 'through a proxy whose X-Forwarded-Host matches Origin → signed in');

    r = await post({ username: 'superadmin', password: PW }, { Origin: 'https://evil.example' });
    ok(r.status === 303 && r.headers.get('location') === '/?signin=refused', 'foreign Origin → /?signin=refused');
    ok(!cookieOf(r), 'and no session');

    r = await post({ username: 'superadmin', password: 'nope-nope' }, { Origin: 'https://panel.example.org', 'X-Forwarded-Host': 'panel.example.org' });
    ok(r.headers.get('location') === '/?signin=wrong', 'proxied wrong password reads as wrong, not refused');

    r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'superadmin', password: PW }) });
    const j = await r.json();
    ok(r.status === 200 && j.ok && j.user?.username === 'superadmin', 'the JSON sign-in route still answers as before');

    r = await post({ username: 'superadmin', password: 'wrong-password' });
    ok(r.status === 303 && r.headers.get('location') === '/?signin=wrong', 'wrong password → /?signin=wrong');
    ok(!cookieOf(r), 'and no session');
    ok(!/superadmin|wrong-password/.test(r.headers.get('location')), 'neither username nor password is in the URL');

    for (let i = 0; i < 10; i++) r = await post({ username: 'superadmin', password: 'wrong-password' });
    ok(r.headers.get('location') === '/?signin=limited', 'repeated wrong passwords → /?signin=limited');
    r = await post({ username: 'superadmin', password: PW });
    ok(r.headers.get('location') === '/?signin=limited' && !cookieOf(r), 'then even the right password waits');
  } finally {
    srv.close();
  }
}

if (doc) {
  console.log('=== 4. password-change forms carry the username ===');
  const forms = [...doc.querySelectorAll('form')].filter((f) => f.querySelector('input[autocomplete=new-password]')
    && f.querySelector('input[autocomplete=current-password]'));
  ok(forms.length >= 1, `found ${forms.length} password-change form(s)`);
  for (const f of forms) {
    ok(f.querySelector('input[autocomplete=username]'), `#${f.id} holds a username field`);
    ok([...f.querySelectorAll('input[type=password]')].every((i) => i.getAttribute('name')), `#${f.id} password fields are named`);
  }

  console.log('=== 5. managers stay out of every other secret field ===');
  const loginIds = new Set(['password', 'f-pw-cur', 'f-pw-new']);
  for (const i of doc.querySelectorAll('input[type=password]')) {
    ok(i.hasAttribute('autocomplete'), `password input #${i.id} has an autocomplete hint`);
    if (loginIds.has(i.id)) continue;
    const missing = Object.entries(IGNORE).filter(([k, v]) => i.getAttribute(k) !== v).map(([k]) => k);
    ok(missing.length === 0, `#${i.id} carries the manager-ignore attributes${missing.length ? ` — missing ${missing.join(', ')}` : ''}`);
  }
  for (const id of ['f-em-user', 'na-user']) {
    const i = doc.getElementById(id);
    ok(i?.getAttribute('autocomplete') === 'off' && Object.entries(IGNORE).every(([k, v]) => i.getAttribute(k) === v),
       `#${id} is off-limits to managers`);
  }
}

console.log('=== 6. background sign-ins tell the browser directly ===');
{
  ok(/async function rememberLogin\(id, password\)/.test(appJs) && /new window\.PasswordCredential\(\{ id, password, name: id \}\)/.test(appJs),
     'rememberLogin stores a PasswordCredential');
  const handler = appJs.match(/\$\('gate-form'\)\.addEventListener\('submit'[\s\S]*?\n\}\);/)?.[0] ?? '';
  ok(/await rememberLogin\(username, password\)/.test(handler), 'after re-sign-in following a timeout');
  ok(/function onSetupSubmit[\s\S]*?rememberLogin\(/.test(appJs), 'after first-run setup');
  ok(/'\/auth\/password'[\s\S]{0,120}rememberLogin\(CURRENT_USER\?\.username, next\)/.test(appJs), 'after a password change');
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
