/**
 * Pure helpers for the cross-group member roster and per-member detail page.
 *
 * No WhatsApp / bot dependencies live here on purpose - everything is a plain
 * data transform so it can be unit-tested without a socket. The bot supplies
 * three raw inputs and these functions fold them together:
 *
 *   groups    [{ jid, subject, members: [{ id, number, admin }] }]  (live metadata)
 *   activity  { [key]: { key, lid, number, name, msgCount, firstSeen,
 *                        lastSeen, perGroup: { [jid]: { count, lastSeen } } } }
 *   events    [{ ts, groupJid, groupName, action, actor, actorNumber,
 *                targets: [{ jid, number }] }]  (join/leave/promote feed)
 *
 * Identity note: under WhatsApp's LID system a participant is usually an opaque
 * `…@lid` and only sometimes a phone JID. A person is keyed by phone number when
 * we know it (which also merges someone who shows as a phone JID in one group and
 * a @lid in another *if* the activity feed has linked their @lid to a number),
 * otherwise by their account-stable @lid.
 */

/** Canonical identity key: phone number wins, else the @lid. */
export function memberKey({ number, id } = {}) {
  if (number) return `num:${number}`;
  if (id) return `lid:${id}`;
  return null;
}

/** Fold every group's participant list into one deduplicated roster. */
export function aggregateMembers(groups = [], activity = {}) {
  // The activity feed is the only place a @lid gets linked to a real phone
  // number (messages carry participantPn). Use that linkage to merge a person
  // who appears under both forms across different groups.
  const lidToNumber = new Map();
  for (const e of Object.values(activity)) {
    if (e && e.lid && e.number) lidToNumber.set(e.lid, e.number);
  }

  const byKey = new Map();
  for (const g of groups) {
    for (const p of g.members ?? []) {
      const number = p.number || lidToNumber.get(p.id) || null;
      const key = number ? `num:${number}` : (p.id ? `lid:${p.id}` : null);
      if (!key) continue;
      let m = byKey.get(key);
      if (!m) {
        m = { key, id: p.id ?? null, number, name: null, groups: [], adminCount: 0 };
        byKey.set(key, m);
      }
      if (!m.number && number) m.number = number;
      if (!m.id && p.id) m.id = p.id;
      // Guard against a member being listed twice in one group's metadata.
      if (!m.groups.some((x) => x.jid === g.jid)) {
        m.groups.push({ jid: g.jid, subject: g.subject, admin: p.admin ?? null });
        if (p.admin) m.adminCount++;
      }
    }
  }

  const out = [];
  for (const m of byKey.values()) {
    const a = resolveActivity(activity, m) || {};
    out.push({
      key: m.key,
      id: m.id,
      number: m.number,
      name: a.name ?? null,
      groups: m.groups,
      groupCount: m.groups.length,
      adminCount: m.adminCount,
      msgCount: a.msgCount ?? 0,
      firstSeen: a.firstSeen ?? null,
      lastSeen: a.lastSeen ?? null,
    });
  }
  // Most active first, then broadest reach, then a stable tiebreak.
  out.sort((x, y) =>
    (y.msgCount - x.msgCount) ||
    (y.groupCount - x.groupCount) ||
    String(x.key).localeCompare(String(y.key)));
  return out;
}

/** Find the activity entry for a member regardless of which key it was stored under. */
export function resolveActivity(activity = {}, member = {}) {
  if (!member) return null;
  return (
    (member.key && activity[member.key]) ||
    (member.number && activity[`num:${member.number}`]) ||
    (member.id && activity[`lid:${member.id}`]) ||
    Object.values(activity).find((e) => e &&
      ((member.id && e.lid === member.id) ||
       (member.number && e.number === member.number))) ||
    null
  );
}

/**
 * The membership timeline for one member, oldest event first. Only events that
 * happened while the bot was watching are here - anyone already in a group when
 * the bot started has no recorded join (WhatsApp does not expose historical
 * join dates), which the UI surfaces as "joined before tracking".
 */
export function memberTimeline(events = [], member = {}) {
  const lid = member.id;
  const number = member.number;
  const hits = [];
  for (const ev of events) {
    const hit = (ev.targets ?? []).some((t) =>
      (lid && t.jid === lid) || (number && t.number === number));
    if (!hit) continue;
    hits.push({
      ts: ev.ts,
      action: ev.action,
      groupJid: ev.groupJid,
      groupName: ev.groupName,
      by: ev.actorNumber ? `+${ev.actorNumber}` : (ev.actor ?? null),
    });
  }
  hits.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return hits;
}

/** Full detail payload for one member: roster fields + timeline + per-group activity. */
export function memberDetail({ member, events = [], activity = {} } = {}) {
  const entry = resolveActivity(activity, member);
  return {
    ...member,
    timeline: memberTimeline(events, member),
    perGroup: entry?.perGroup ?? {},
  };
}
