/* Browser load-lint: catches runtime ReferenceErrors in app.js that `node --check`
   cannot see (a deleted-but-still-called function blanks the whole panel).
   Also verifies every id app.js touches exists in index.html. Run: node test/webui-lint.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'src', 'web', 'public');
const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

console.log('=== app.js executes top-level in a stubbed DOM ===');
{
  // Minimal DOM good enough to run app.js's top level: every element lookup
  // returns a chainable stub, so we surface *code* errors, not missing markup.
  const el = new Proxy(function () {}, {
    get: (t, k) => {
      if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (k === 'style') return {};
      if (k === 'dataset') return {};
      if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
      if (k === 'checked') return false;
      if (k === Symbol.toPrimitive) return () => '';
      return typeof k === 'string' ? el : undefined;
    },
    apply: () => el,
    set: () => true,
  });
  const doc = {
    getElementById: () => el, querySelector: () => el, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => el, body: el, documentElement: el,
    cookie: '', readyState: 'complete',
  };
  const win = {
    document: doc, addEventListener() {}, location: { reload() {}, href: '', origin: 'http://x' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
    EventSource: function () { return { addEventListener() {}, close() {} }; },
    scrollTo() {}, confirm: () => false, alert() {}, navigator: { clipboard: { writeText: async () => {} } },
    console,
  };
  win.window = win; win.self = win; win.globalThis = win;

  let err = null;
  try {
    const fn = new Function('window', 'document', 'globalThis', 'self', 'localStorage', 'fetch',
      'EventSource', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'confirm', 'alert',
      'navigator', 'location',
      `"use strict";${appJs}`);
    fn(win, doc, win, win, win.localStorage, win.fetch, win.EventSource,
      win.setTimeout, win.setInterval, win.clearTimeout, win.clearInterval,
      win.confirm, win.alert, win.navigator, win.location);
  } catch (e) {
    err = e;
  }
  ok(!err, `app.js top level runs clean${err ? ` — ${err.constructor.name}: ${err.message}` : ''}`);
  if (err) console.log(`       ${err.stack?.split('\n').slice(0, 3).join('\n       ')}`);
}

console.log('=== every $("id") referenced by app.js exists in index.html (or is created by app.js) ===');
{
  const ids = new Set([...appJs.matchAll(/\$\(['"]([\w-]+)['"]\)/g)].map((m) => m[1]));
  const htmlIds = new Set([...html.matchAll(/\bid=["']([\w-]+)["']/g)].map((m) => m[1]));
  // app.js also injects markup, so ids it writes itself are legitimate too.
  for (const m of appJs.matchAll(/\bid=\\?["']([\w-]+)\\?["']/g)) htmlIds.add(m[1]);
  const missing = [...ids].filter((i) => !htmlIds.has(i));
  ok(missing.length === 0, `all ${ids.size} referenced ids resolve${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
}

console.log('=== no function is called but never defined ===');
{
  // Collect declared/assigned names, then check each locally-called name resolves.
  const declared = new Set([
    ...[...appJs.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...appJs.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
    ...[...appJs.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
    ...[...appJs.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)].map((m) => m[1]),
    ...[...appJs.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g)].map((m) => m[1]),
  ]);
  const builtins = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
    'async', 'await', 'of', 'in', 'delete', 'void', 'yield', 'isFinite', 'prompt', 'EventSource',
    'URLSearchParams', 'FormData', 'Intl', 'AbortController', 'structuredClone', 'queueMicrotask',
    'fetch', 'confirm', 'alert', 'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array',
    'Object', 'JSON', 'Math', 'Date', 'Set', 'Map', 'Promise', 'RegExp', 'Error', 'console',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'encodeURIComponent',
    'decodeURIComponent', 'isNaN', 'require', 'super', 'this', 'await', 'new', 'else', 'do']);
  // Strip comments and string/template literals first - prose like "it (usually)"
  // otherwise looks exactly like a call site.
  const code = appJs
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""');
  const called = new Set([...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  const undef = [...called].filter((n) => !declared.has(n) && !builtins.has(n));
  ok(undef.length === 0, `every called function is defined${undef.length ? ` — undefined: ${undef.join(', ')}` : ''}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
