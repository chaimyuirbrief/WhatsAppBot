/**
 * Audit log: classifying and querying "who did what in the portal".
 *
 * Every mutating request is recorded by the API as
 * `{ ts, user, role, ip, action, detail }`, where `detail` is the raw
 * `METHOD /path`. That is enough to answer "what happened" but not "show me
 * every ban" or "what has this admin been doing" - both of which need the
 * events bucketed into the handful of things admins actually do.
 *
 * Classification happens on READ rather than being stamped on write, which
 * means history recorded before this existed is categorised too, and a fix to
 * the rules applies retroactively instead of only to events from now on.
 *
 * Pure and side-effect free, so every rule is unit-tested without a portal.
 */

/**
 * The bucket for a request path is simply its FIRST SEGMENT: `/lockdown/lock`
 * is lockdown, `/members/ban-all` is members. That is generic on purpose - a
 * route added next year is bucketed the day it ships, with no table to
 * remember to update, instead of quietly piling into "Other".
 *
 * Two small tables shape the result, and neither is load-bearing:
 *  - ALIASES fold segments that are really the same thing (`/banned` is a
 *    members action, `/wa` is the connection).
 *  - LABELS give the buckets worth naming a human label and an icon. A bucket
 *    with no entry still works; it gets its segment title-cased.
 */
const ALIASES = {
  banned: 'members',
  config: 'settings',
  notify: 'settings',
  wa: 'connection',
  admins: 'accounts',
  'group-activity': 'maintenance',
  audit: 'maintenance',
  logs: 'maintenance',
};

/**
 * Paths that do not belong to their own first segment. Changing your password
 * is account management, not a sign-in, and that is where someone auditing
 * account changes will look for it.
 */
const PATH_OVERRIDES = [
  [/^\/auth\/password\b/, 'accounts'],
];

const LABELS = {
  auth: { label: 'Sign-ins', icon: '\u{1F511}' },
  accounts: { label: 'Admin accounts', icon: '\u{1F464}' },
  lockdown: { label: 'Lock / unlock', icon: '\u{1F512}' },
  members: { label: 'Bans & members', icon: '\u{1F6AB}' },
  groups: { label: 'Group edits', icon: '\u{1F4AC}' },
  settings: { label: 'Settings', icon: '\u2699\uFE0F' },
  connection: { label: 'Connection', icon: '\u{1F50C}' },
  queue: { label: 'Job queue', icon: '\u{1F4CB}' },
  email: { label: 'Email', icon: '\u2709\uFE0F' },
  maintenance: { label: 'Log maintenance', icon: '\u{1F9F9}' },
  test: { label: 'Diagnostics', icon: '\u{1F9EA}' },
};

/**
 * For events that carry no path at all - the lockdown scheduler pushes its own
 * - the wording is all there is to go on. Deliberately short: guessing from
 * prose is worse than saying "Other", so these only cover phrases the code
 * itself emits.
 */
const WORD_RULES = [
  [/\b(locked|unlocked|lockdown)\b/i, 'lockdown'],
  [/\b(logged? in|log(ged)? out|sign(ed)? in)\b/i, 'auth'],
  [/\b(banned|unbanned)\b/i, 'members'],
];

/** The order buckets are offered in the UI; anything discovered follows. */
const PREFERRED_ORDER = [
  'auth', 'accounts', 'lockdown', 'members', 'groups',
  'settings', 'connection', 'queue', 'email', 'maintenance', 'test',
];

/** Title-case a bare segment so an unlabelled bucket still reads as English. */
function labelForKey(key) {
  if (LABELS[key]) return LABELS[key];
  const words = String(key).replace(/[-_]+/g, ' ').trim();
  return { label: words.charAt(0).toUpperCase() + words.slice(1), icon: '\u2022' };
}

/** Every bucket the UI knows about up front, in display order. */
export const AUDIT_CATEGORIES = PREFERRED_ORDER.map((key) => ({ key, ...labelForKey(key) }));

/** Fallback bucket for anything the rules above do not claim. */
export const OTHER_CATEGORY = { key: 'other', label: 'Other', icon: '•' };

/**
 * A renderable descriptor for any bucket key, including one derived from a
 * route nobody has labelled yet. Never returns undefined - the UI always has
 * something to draw.
 */
export function categoryFor(key) {
  if (!key) return OTHER_CATEGORY;
  if (key === OTHER_CATEGORY.key) return OTHER_CATEGORY;
  return { key, ...labelForKey(key) };
}

/**
 * The request path an event came from, or '' when it carries none.
 * `detail` is `METHOD /path`; anything else (a hand-written detail, or the
 * scheduler's own events) yields ''.
 */
export function pathOf(event) {
  const m = /^[A-Z]+\s+(\/\S*)$/.exec(String(event?.detail ?? '').trim());
  return m ? m[1] : '';
}

/** The bucket key for a request path, derived from its first segment. */
export function categoryForPath(path) {
  const p = String(path || '');
  if (!p.startsWith('/')) return OTHER_CATEGORY.key;
  for (const [re, key] of PATH_OVERRIDES) if (re.test(p.toLowerCase())) return key;
  // Lower-cased because Express routes case-insensitively by default: a
  // request to /Members/ban-all is handled and audited exactly like
  // /members/ban-all, and must not end up in a bucket of its own.
  const seg = (p.split('/')[1] ?? '').split('?')[0].toLowerCase();
  if (!seg) return OTHER_CATEGORY.key;
  return ALIASES[seg] ?? seg;
}

/** Which bucket an event belongs to. Always returns a key, never null. */
export function classify(event) {
  const path = pathOf(event);
  if (path) return categoryForPath(path);
  // No path: fall back to the wording. The lockdown scheduler's own entries
  // ("locked 12 groups") arrive this way, as do any future system events.
  const text = `${event?.action ?? ''} ${event?.detail ?? ''}`;
  for (const [re, key] of WORD_RULES) if (re.test(text)) return key;
  return OTHER_CATEGORY.key;
}

/** Was this event recorded by the system rather than a signed-in person? */
export function isSystem(event) {
  return event?.role === 'system' || /^[a-z]+:/i.test(String(event?.user ?? ''));
}

const normUser = (u) => String(u ?? '').trim().toLowerCase();

/**
 * Query the log. Every filter is optional and they combine with AND.
 *
 * @param {object[]} events  newest first, as stored
 * @param {object} q
 * @param {string} [q.user]      exact username (case-insensitive)
 * @param {string} [q.category]  one category key, or 'all'
 * @param {string} [q.search]    free text over user / action / detail
 * @param {number} [q.since]     only events at or after this ms timestamp
 * @param {'newest'|'oldest'} [q.order]
 * @param {number} [q.limit]
 * @param {number} [q.offset]
 * @returns {{events: object[], total: number}} `total` is the match count
 *          BEFORE limit/offset, so the UI can say "showing 50 of 300".
 */
export function queryAudit(events = [], {
  user = '', category = 'all', search = '', since = null,
  order = 'newest', limit = 0, offset = 0,
} = {}) {
  const wantUser = normUser(user);
  const wantCat = String(category || 'all');
  const needle = String(search || '').trim().toLowerCase();

  let out = (Array.isArray(events) ? events : []).filter((e) => {
    if (wantUser && normUser(e?.user) !== wantUser) return false;
    if (wantCat !== 'all' && classify(e) !== wantCat) return false;
    if (since != null && !(Number(e?.ts) >= since)) return false;
    if (needle) {
      const hay = `${e?.user ?? ''} ${e?.action ?? ''} ${e?.detail ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  // Stored newest-first; sort explicitly rather than trusting insertion order,
  // since a restored or merged state file may not be ordered.
  out.sort((a, b) => (order === 'oldest' ? Number(a?.ts) - Number(b?.ts) : Number(b?.ts) - Number(a?.ts)));

  const total = out.length;
  const from = Math.max(0, Number(offset) || 0);
  if (from) out = out.slice(from);
  if (limit > 0) out = out.slice(0, limit);
  return { events: out, total };
}

/**
 * Counts for the filter chips and the per-admin summary. Counted over the
 * events passed in, so a caller can summarise the whole log or one admin's
 * slice of it.
 */
export function summarize(events = []) {
  const byCategory = new Map();
  const byUser = new Map();
  const systemUsers = new Set();
  let first = null, last = null;

  for (const e of Array.isArray(events) ? events : []) {
    const key = classify(e);
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
    const u = String(e?.user ?? '?');
    byUser.set(u, (byUser.get(u) ?? 0) + 1);
    if (isSystem(e)) systemUsers.add(u);
    const ts = Number(e?.ts);
    if (Number.isFinite(ts)) {
      if (first == null || ts < first) first = ts;
      if (last == null || ts > last) last = ts;
    }
  }

  return {
    total: Array.isArray(events) ? events.length : 0,
    firstAt: first,
    lastAt: last,
    // Known buckets first, in display order, then any the data turned up that
    // no one has labelled - a route added since this shipped still gets a chip
    // instead of disappearing into "Other". Empty known buckets stay listed so
    // the chips do not jump around as the filter changes.
    categories: [
      ...AUDIT_CATEGORIES.map((c) => c.key),
      ...[...byCategory.keys()].filter((k) => k !== OTHER_CATEGORY.key && !PREFERRED_ORDER.includes(k)).sort(),
      OTHER_CATEGORY.key,
    ].map((key) => ({ ...categoryFor(key), count: byCategory.get(key) ?? 0 })),
    // `system` marks the scheduler's own pseudo-accounts, so the UI can keep
    // them out of a list captioned "admins".
    users: [...byUser.entries()]
      .map(([name, count]) => ({ user: name, count, system: systemUsers.has(name) }))
      .sort((a, b) => b.count - a.count || a.user.localeCompare(b.user)),
  };
}
