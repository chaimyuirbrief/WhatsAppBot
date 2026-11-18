import { fmtNumber, numberDigits } from '../util/format.js';

/**
 * Who in a links group is also taking files.
 *
 * A "direct download links" group exists so people can get links themselves.
 * Someone who sits in it AND keeps having files sent to them elsewhere may be
 * using both - or may have joined once and never looked at it again. This
 * module only LISTS them, sorted by how clearly the data shows they use the
 * links group, with the reason spelled out. It never acts on anyone; an admin
 * reads the list and decides, and plenty of reasons are innocent.
 *
 * Inputs are plain data, so it can be tested without a socket:
 *   groups     [{ jid, subject, members: [{ id, number }] }]
 *   activity   { key: { lid, number, perGroup: { [jid]: { count } } } }
 *   history    request rows: [{ plugin, id, requester|requesterNumber|senderJid,
 *                               status, beta, groupJid|chatJid, ts|at }]
 *   msgIndex   [{ k, g, i, p, t, w? }]  (w = first word, when recorded)
 *   messages   archive message records: [{ chat, from, number, text, at|ts }]
 */

export const DELIVERED_STATUSES = new Set(['sent', 'resent', 'partial', 'queued']);
export const LINKS_SUBJECT_RE = /direct download links/i;
export const TIERS = ['clear', 'likely', 'weak', 'member'];

const TIER_TEXT = {
  clear: 'asked for files in the links group itself and also had files sent',
  likely: 'is active in the links group and also had files sent',
  weak: 'wrote once in the links group and also had files sent',
  member: 'is in the links group but never wrote there, and had files sent',
};

/** The links groups: the configured list, else any group whose name says so. */
export function linksGroupsOf(cfg, groups = []) {
  const chosen = (cfg?.audits?.linksGroups ?? []).filter(Boolean);
  if (chosen.length) return chosen;
  return groups.filter((g) => LINKS_SUBJECT_RE.test(g.subject ?? '')).map((g) => g.jid);
}

const isRequest = (text) => /^\s*#request\b/i.test(String(text ?? ''));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function linksAudit({ groups = [], activity = {}, history = [], msgIndex = [], messages = [], linksGroups = [] } = {}) {
  const links = new Set(linksGroups);

  // Everyone resolved to a phone number where the data allows it.
  const lidToNumber = new Map();
  for (const e of Object.values(activity ?? {})) if (e?.lid && e?.number) lidToNumber.set(e.lid, numberDigits(e.number));
  for (const g of groups) for (const m of g.members ?? []) {
    const n = numberDigits(m.number);
    if (m.id && n) lidToNumber.set(m.id, n);
    if (m.lid && n) lidToNumber.set(m.lid, n);
  }
  const who = (v) => {
    if (!v) return null;
    const s = String(v);
    if (lidToNumber.has(s)) return lidToNumber.get(s);
    if (s.endsWith('@lid')) return null;
    return numberDigits(s.split('@')[0].split(':')[0]) || null;
  };
  const whoKey = (v) => who(v) ?? (v ? `lid:${v}` : null);

  // Who is in a links group, and which.
  const subjects = new Map(groups.map((g) => [g.jid, g.subject ?? g.jid]));
  const members = new Map();   // key -> { key, number, id, groups:Set }
  for (const g of groups) {
    if (!links.has(g.jid)) continue;
    for (const m of g.members ?? []) {
      const key = whoKey(m.number || m.id);
      if (!key) continue;
      const rec = members.get(key) ?? { key, number: key.startsWith('lid:') ? null : key, id: m.id ?? null, groups: new Set() };
      rec.groups.add(g.jid);
      members.set(key, rec);
    }
  }

  // What they wrote in the links groups.
  const wrote = new Map();     // key -> { count, requests, first, ids:Set }
  const note = (key, id, ts, text) => {
    if (!key) return;
    const w = wrote.get(key) ?? { count: 0, requests: 0, first: null, ids: new Set() };
    if (id && w.ids.has(id)) return;
    if (id) w.ids.add(id);
    w.count++;
    if (isRequest(text)) w.requests++;
    if (ts && (!w.first || ts < w.first)) w.first = ts;
    wrote.set(key, w);
  };
  for (const r of messages ?? []) {
    if (!links.has(r.chat) || r.fromMe || (r.mode && r.mode !== 'm')) continue;
    note(whoKey(r.number || r.from), r.id, r.at || r.ts, r.text);
  }
  for (const e of msgIndex ?? []) {
    if (!links.has(e.g)) continue;
    const key = e.k?.startsWith('num:') ? e.k.slice(4) : whoKey(e.p ?? (e.k?.startsWith('lid:') ? e.k.slice(4) : null));
    note(key, e.i, e.t, e.w);
  }
  // Message counts the activity feed has but the archive/index no longer do.
  for (const e of Object.values(activity ?? {})) {
    const key = whoKey(e?.number || e?.lid);
    if (!key) continue;
    let total = 0;
    for (const jid of links) total += e.perGroup?.[jid]?.count ?? 0;
    const w = wrote.get(key);
    if (total > (w?.count ?? 0)) wrote.set(key, { ...(w ?? { requests: 0, first: null, ids: new Set() }), count: total });
  }

  // Files sent to them outside the links groups.
  const files = new Map();     // key -> [{ ts }]
  const seen = new Set();
  for (const row of history ?? []) {
    if (!row || row.beta) continue;
    if (!DELIVERED_STATUSES.has(String(row.status ?? '').toLowerCase())) continue;
    const chat = row.groupJid ?? row.chatJid ?? null;
    if (chat && links.has(chat)) continue;
    const key = whoKey(row.requesterNumber || row.requester || row.senderJid);
    if (!key) continue;
    const dedupe = `${row.plugin ?? ''}/${row.id ?? ''}/${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const list = files.get(key) ?? [];
    list.push({ ts: row.ts ?? row.at ?? null });
    files.set(key, list);
  }

  const people = [];
  for (const m of members.values()) {
    const f = files.get(m.key);
    if (!f?.length) continue;
    const w = wrote.get(m.key) ?? { count: 0, requests: 0, first: null };
    let tier = 'member';
    if (w.requests > 0) tier = 'clear';
    else if (w.count >= 2) tier = 'likely';
    else if (w.count === 1) tier = 'weak';
    const filesAfterFirstLink = w.first ? f.filter((x) => x.ts && x.ts > w.first).length : 0;
    const parts = [`${fmtNumber(m.number) || m.id} ${TIER_TEXT[tier]}`];
    parts.push(`${plural(f.length, 'file', 'files')} sent outside the links group`);
    if (w.count) parts.push(`${plural(w.count, 'message', 'messages')} in the links group${w.requests ? `, ${w.requests} of them #request` : ''}`);
    if (w.first) parts.push(`${filesAfterFirstLink} of the files came after their first message there`);
    people.push({
      key: m.number ? `num:${m.number}` : `lid:${m.id}`,
      number: m.number,
      id: m.id,
      groups: [...m.groups].map((jid) => ({ jid, subject: subjects.get(jid) ?? jid })),
      tier,
      files: f.length,
      linksMessages: w.count,
      linksRequests: w.requests,
      firstLinksMessageAt: w.first,
      filesAfterFirstLink,
      why: `${parts.join('; ')}.`,
    });
  }

  const rank = Object.fromEntries(TIERS.map((t, i) => [t, i]));
  people.sort((a, b) => (rank[a.tier] - rank[b.tier]) || (b.files - a.files) || String(a.key).localeCompare(String(b.key)));
  const summary = Object.fromEntries(TIERS.map((t) => [t, people.filter((p) => p.tier === t).length]));
  return { linksGroups: [...links], people, summary, total: people.length };
}
