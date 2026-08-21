/* Audit log: bucketing events into the actions admins actually take, and
   querying them per admin / per category. Run: node test/audit.test.mjs */
import {
  classify, pathOf, queryAudit, summarize, categoryFor, categoryForPath, isSystem,
  AUDIT_CATEGORIES, OTHER_CATEGORY,
} from '../src/core/audit.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

/** An event exactly as the API records it: detail is always `METHOD /path`. */
const ev = (user, action, detail, extra = {}) =>
  ({ ts: Date.now(), user, role: 'admin', ip: '::1', action, detail, ...extra });

console.log('=== every real route lands in the right bucket ===');
{
  // One case per audited route in web/api.js. If a route is added and not
  // classified it falls to `other`, which this table makes obvious.
  const routes = [
    ['POST /auth/login', 'auth'],
    ['POST /auth/logout', 'auth'],
    ['POST /auth/setup', 'auth'],
    ['POST /auth/password', 'accounts'],
    ['POST /admins', 'accounts'],
    ['DELETE /admins/alice', 'accounts'],
    ['POST /admins/bob/reset', 'accounts'],
    ['POST /lockdown/lock', 'lockdown'],
    ['POST /lockdown/unlock', 'lockdown'],
    ['POST /members/ban-all', 'members'],
    ['POST /members/across', 'members'],
    ['DELETE /banned/15551112222', 'members'],
    ['PUT /groups/123@g.us/description', 'groups'],
    ['PUT /groups/123@g.us/subject', 'groups'],
    ['POST /groups/123@g.us/participants', 'groups'],
    ['PUT /config', 'settings'],
    ['POST /notify/no-tag', 'settings'],
    ['POST /wa/start', 'connection'],
    ['POST /wa/stop', 'connection'],
    ['POST /wa/logout', 'connection'],
    ['POST /queue/pause', 'queue'],
    ['POST /queue/abc/skip', 'queue'],
    ['DELETE /queue/abc', 'queue'],
    ['POST /email/test', 'email'],
    ['POST /email/send-log', 'email'],
    ['DELETE /audit', 'maintenance'],
    ['DELETE /group-activity', 'maintenance'],
  ];
  for (const [detail, want] of routes) {
    const got = classify(ev('someone', 'did a thing', detail));
    ok(got === want, `${detail} -> ${want}${got === want ? '' : ` (got ${got})`}`);
  }
  // A route nobody has classified still gets its own bucket rather than being
  // dumped in "Other" - that is the point of deriving from the path.
  ok(classify(ev('x', 'y', 'POST /something-new')) === 'something-new',
     'a route added later buckets itself, no table to update');
  ok(classify(ev('x', 'y', 'POST /plugins/echo/reload')) === 'plugins',
     'and nests under its first segment, not the whole path');
  ok(categoryFor('something-new').label === 'Something new',
     'an underived bucket still gets a readable label');
  ok(!!categoryFor('something-new').icon, 'and an icon, so the chip renders');
}

console.log('=== events with no request path fall back to their wording ===');
{
  // The lockdown scheduler pushes straight to the store: no ip, no detail.
  const scheduled = { ts: Date.now(), user: 'lockdown:schedule', role: 'system', action: 'locked 12 groups' };
  ok(classify(scheduled) === 'lockdown', 'the scheduler’s own lock entry is a lockdown action');
  ok(isSystem(scheduled), 'and is marked as a system event, not a person');
  ok(isSystem(ev('superadmin', 'login', 'POST /auth/login')) === false, 'a signed-in admin is not a system event');
  ok(classify({ ts: 1, user: 'lockdown:manual', role: 'system', action: 'unlocked 12 groups' }) === 'lockdown',
     'the matching unlock entry too');
  ok(classify({ ts: 1, user: 'sys', role: 'system', action: 'something unrecognised' }) === 'other',
     'wording that matches nothing is "other", not a wrong guess');
}

console.log('=== pathOf only trusts a real METHOD /path ===');
{
  ok(pathOf(ev('a', 'x', 'POST /auth/login')) === '/auth/login', 'extracts the path');
  ok(pathOf(ev('a', 'x', 'GET /members/abc/detail')) === '/members/abc/detail', 'keeps nested segments');
  ok(pathOf({ action: 'locked 12 groups' }) === '', 'no detail -> no path');
  ok(pathOf(ev('a', 'x', 'locked 12 groups')) === '', 'prose is not a path');
  ok(pathOf(ev('a', 'x', 'post /auth/login')) === '', 'a lowercase verb is not the recorded format');
}

console.log('=== a category key always resolves to something renderable ===');
{
  for (const c of AUDIT_CATEGORIES) {
    ok(categoryFor(c.key).label === c.label && !!categoryFor(c.key).icon, `${c.key} has a label and an icon`);
  }
  ok(categoryFor('nonsense').key === 'nonsense' && !!categoryFor('nonsense').label,
     'an unlabelled key still resolves to something renderable');
  ok(categoryFor(undefined).key === 'other', 'no key at all resolves to "other", never undefined');
  ok(categoryFor('').key === 'other', 'and neither does an empty one blow up');
  const keys = [...AUDIT_CATEGORIES.map((c) => c.key), OTHER_CATEGORY.key];
  ok(new Set(keys).size === keys.length, 'category keys are unique');
}

console.log('=== the bucket is derived from the path, generically ===');
{
  ok(categoryForPath('/lockdown/lock') === 'lockdown', 'first segment is the bucket');
  ok(categoryForPath('/banned/15551112222') === 'members', 'an alias folds a segment into its real bucket');
  ok(categoryForPath('/auth/password') === 'accounts', 'an override wins over the segment');
  ok(categoryForPath('/auth/login') === 'auth', 'without shadowing the rest of that segment');
  ok(categoryForPath('/anything/at/all') === 'anything', 'an unknown segment is its own bucket');
  ok(categoryForPath('/groups/123@g.us/subject') === 'groups', 'a JID in the path does not confuse it');
  ok(categoryForPath('/config') === 'settings', 'a single-segment path works');
  ok(categoryForPath('/config?x=1') === 'settings', 'a query string is stripped');
  ok(categoryForPath('/') === 'other', 'a bare slash has no bucket');
  ok(categoryForPath('') === 'other' && categoryForPath(null) === 'other', 'no path is "other"');
  ok(categoryForPath('not-a-path') === 'other', 'something that is not a path is "other"');
  // Express routes case-insensitively by default, so /Members/ban-all is
  // handled and audited exactly like /members/ban-all. It must not get a
  // bucket of its own and slip past the filter.
  ok(categoryForPath('/Members/ban-all') === 'members', 'an odd-cased path buckets with its route');
  ok(categoryForPath('/QUEUE/pause') === 'queue', 'however it was cased');
  ok(categoryForPath('/Auth/Password') === 'accounts', 'overrides are case-insensitive too');
  ok(categoryForPath('/BANNED/155') === 'members', 'and so are aliases');
}

console.log('=== querying: per admin, per category, per phrase ===');
{
  const t = 1_700_000_000_000;
  const log = [
    { ts: t + 500, user: 'superadmin', role: 'superadmin', action: 'login', detail: 'POST /auth/login' },
    { ts: t + 400, user: 'alice', role: 'admin', action: 'banned +15551112222 from all groups', detail: 'POST /members/ban-all' },
    { ts: t + 300, user: 'alice', role: 'admin', action: 'login', detail: 'POST /auth/login' },
    { ts: t + 200, user: 'bob', role: 'admin', action: 'locked all groups (manual)', detail: 'POST /lockdown/lock' },
    { ts: t + 100, user: 'superadmin', role: 'superadmin', action: 'reset password for "alice"', detail: 'POST /admins/alice/reset' },
  ];

  const mine = queryAudit(log, { user: 'alice' });
  ok(mine.total === 2 && mine.events.every((e) => e.user === 'alice'), 'filters to one admin');
  ok(queryAudit(log, { user: 'ALICE' }).total === 2, 'the query username is matched case-insensitively');
  // ...and so is the STORED one: usernames are compared case-insensitively at
  // sign-in (auth.js norm()), so "Alice" and "alice" are one account and must
  // not end up with two separate trails.
  const mixed = [{ ts: t, user: 'Alice', action: 'login', detail: 'POST /auth/login' }];
  ok(queryAudit(mixed, { user: 'alice' }).total === 1, 'a stored username in different case is the same admin');
  ok(queryAudit(mixed, { user: 'Alice' }).total === 1, 'either casing finds it');
  ok(queryAudit(log, { user: 'nobody' }).total === 0, 'an admin with no actions returns empty, not everything');

  ok(queryAudit(log, { category: 'auth' }).total === 2, 'filters to one category');
  ok(queryAudit(log, { category: 'lockdown' }).events[0].user === 'bob', 'and returns the right event');
  ok(queryAudit(log, { category: 'all' }).total === 5, '"all" is not a filter');
  ok(queryAudit(log, { category: 'nonsense' }).total === 0, 'an unknown category matches nothing rather than everything');

  ok(queryAudit(log, { user: 'alice', category: 'auth' }).total === 1, 'filters combine with AND');
  ok(queryAudit(log, { search: 'password' }).total === 1, 'free text searches the action');
  ok(queryAudit(log, { search: 'ALICE' }).total === 3, 'search is case-insensitive and covers the user field');
  ok(queryAudit(log, { search: '/lockdown/' }).total === 1, 'search covers the detail path too');
  ok(queryAudit(log, { since: t + 300 }).total === 3, 'since drops older events');

  const oldest = queryAudit(log, { order: 'oldest' });
  ok(oldest.events[0].ts === t + 100, 'oldest-first flips the order');
  ok(queryAudit(log, {}).events[0].ts === t + 500, 'newest-first is the default');
  // Ordering must not depend on how the array happened to be stored.
  const shuffled = [log[2], log[0], log[4], log[1], log[3]];
  ok(queryAudit(shuffled, {}).events.map((e) => e.ts).join() === [t + 500, t + 400, t + 300, t + 200, t + 100].join(),
     'a mis-ordered store is sorted, not trusted');

  const page = queryAudit(log, { limit: 2 });
  ok(page.events.length === 2 && page.total === 5, 'total counts matches before the limit, so "2 of 5" is truthful');
  ok(queryAudit(log, { limit: 2, offset: 2 }).events[0].ts === t + 300, 'offset pages through');
  ok(queryAudit([], {}).total === 0 && queryAudit(null, {}).events.length === 0, 'no log at all is handled');
}

console.log('=== summaries drive the chips and the per-admin panel ===');
{
  const t = 1_700_000_000_000;
  const log = [
    { ts: t + 300, user: 'alice', action: 'login', detail: 'POST /auth/login' },
    { ts: t + 200, user: 'alice', action: 'banned someone', detail: 'POST /members/ban-all' },
    { ts: t + 100, user: 'superadmin', action: 'login', detail: 'POST /auth/login' },
  ];
  const s = summarize(log);
  ok(s.total === 3, 'counts every event');
  ok(s.firstAt === t + 100 && s.lastAt === t + 300, 'reports the span');

  const cat = Object.fromEntries(s.categories.map((c) => [c.key, c.count]));
  ok(cat.auth === 2 && cat.members === 1, 'counts per category');
  ok(cat.queue === 0, 'a category with nothing in it is still listed, so the chips do not jump about');
  ok(s.categories.length === AUDIT_CATEGORIES.length + 1, 'every category plus "other" is present');

  ok(s.users[0].user === 'alice' && s.users[0].count === 2, 'users are ranked by how much they did');
  ok(s.users.every((u) => u.system === false), 'real accounts are not marked as system');
  // The scheduler files events under its own pseudo-account; the portal must
  // be able to keep those out of a list captioned "admins".
  const withSys = summarize([
    ...log,
    { ts: t, user: 'lockdown:schedule', role: 'system', action: 'locked 12 groups' },
  ]);
  ok(withSys.users.find((u) => u.user === 'lockdown:schedule')?.system === true,
     'the scheduler is marked as a system pseudo-account');
  ok(withSys.users.filter((u) => !u.system).length === 2, 'leaving just the real admins');
  ok(s.users.length === 2, 'one entry per user');
  ok(summarize([]).total === 0 && summarize([]).users.length === 0, 'an empty log summarises cleanly');
  ok(summarize([]).categories.length === AUDIT_CATEGORIES.length + 1, 'and still lists the categories');

  // A route added after this shipped must get a chip, not vanish into "Other".
  const withNew = summarize([{ ts: t, user: 'a', action: 'x', detail: 'POST /webhooks/stripe' }]);
  const found = withNew.categories.find((c) => c.key === 'webhooks');
  ok(!!found && found.count === 1, 'a bucket discovered in the data is listed');
  ok(found.label === 'Webhooks' && !!found.icon, 'with a readable label and an icon');
  ok(withNew.categories[withNew.categories.length - 1].key === 'other', '"Other" stays last');
  ok(withNew.categories.filter((c) => c.key === 'webhooks').length === 1, 'and is not listed twice');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
