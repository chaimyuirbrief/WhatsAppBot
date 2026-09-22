import log from '../util/logger.js';
import {
  assurBemelachaRuns, civilPlusDays, pickLocation, usableLocations, zmanAt, zmanLabel,
  DEFAULT_START_ZMAN, DEFAULT_END_ZMAN,
} from './zmanim.js';

const logger = log.scope('lockdown');

/**
 * Scheduled lockdown: lock every group (admins-only messaging) during one or
 * more recurring weekly windows, then unlock when the window ends.
 *
 * A window is `{ day, start, durationMinutes }` read in the configured IANA
 * timezone, so the schedule follows civil time across DST rather than drifting
 * by an hour twice a year. Windows may cross midnight and the week boundary,
 * and overlapping windows are merged into one continuous lock.
 *
 * On top of that fixed-clock schedule sits the automatic Shabbos / Yom Tov
 * lock, whose windows are computed from zmanim (see ./zmanim.js) instead of
 * from a wall-clock time, and which therefore moves with the sunset every
 * week. It is merged into the same window list, so a Shabbos lock and a
 * weekly window that overlap are one lock, not two fighting each other.
 */

const DAY_MS = 86400000;

/**
 * Offset of `tz` from UTC at a given instant, in ms (positive east of
 * Greenwich). Derived from Intl rather than a table, so it is DST-correct for
 * every zone the platform knows about.
 */
function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));

  const p = {};
  for (const { type, value } of parts) p[type] = value;
  const asUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  );
  return asUTC - utcMs;
}

/** The civil date and weekday `tz` is showing at `utcMs`. */
export function civilParts(utcMs, tz) {
  const local = new Date(utcMs + tzOffsetMs(utcMs, tz));
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth() + 1,
    d: local.getUTCDate(),
    dow: local.getUTCDay(),
  };
}

/**
 * The UTC instant at which `tz` shows the given civil wall-clock time.
 *
 * Two offset lookups give two candidates, which disagree only across a DST
 * transition. Each is checked by converting back:
 *   - both valid  -> the clock repeated that hour (autumn); take the first.
 *   - one valid   -> ordinary case, take it.
 *   - neither     -> the clock skipped that hour (spring), so the time never
 *                    happened; shift forward, the sane reading of "start at
 *                    02:30" on a day with no 02:30.
 */
export function zonedToUtc({ y, m, d }, hhmm, tz) {
  const [hh, mi] = String(hhmm).split(':').map(Number);
  const want = { y, m, d, hh: hh || 0, mi: mi || 0 };
  const naive = Date.UTC(y, m - 1, d, want.hh, want.mi, 0);

  const t1 = naive - tzOffsetMs(naive, tz);
  const t2 = naive - tzOffsetMs(t1, tz);
  if (t1 === t2) return t1;

  const shows = (ts) => {
    const c = civilParts(ts, tz);
    const local = new Date(ts + tzOffsetMs(ts, tz));
    return c.y === want.y && c.m === want.m && c.d === want.d
      && local.getUTCHours() === want.hh && local.getUTCMinutes() === want.mi;
  };

  const ok1 = shows(t1);
  const ok2 = shows(t2);
  if (ok1 && ok2) return Math.min(t1, t2);
  if (ok1) return t1;
  if (ok2) return t2;
  return Math.max(t1, t2);
}

/** Civil-date arithmetic: `n` days after {y,m,d}, no timezone involved. */
function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

/** Every configured weekly window, whether or not it has finished. */
function weeklyCandidates(now, cfg) {
  const tz = cfg.timezone || 'UTC';
  const windows = (Array.isArray(cfg.windows) ? cfg.windows : []).filter((w) => w?.enabled !== false);
  if (!windows.length) return [];

  const today = civilParts(now.getTime(), tz);
  const out = [];

  for (const w of windows) {
    const dur = Math.max(1, Number(w.durationMinutes) || 0) * 60000;
    // ±8 days covers a window that started before `now` and one that starts
    // next week, whichever weekday it falls on.
    for (let off = -8; off <= 8; off++) {
      const day = addDays(today, off);
      if (day.dow !== Number(w.day)) continue;
      const lockAt = zonedToUtc(day, w.start || '00:00', w.timezone || tz);
      out.push({ lockAt, unlockAt: lockAt + dur, id: w.id ?? null, label: w.label ?? '' });
    }
  }
  return out;
}

/**
 * How far back and forward the Shabbos scan looks, in civil days. The longest
 * unbroken stretch is a two-day yom tov next to Shabbos, so looking ten days
 * back is already generous - it only has to catch a stretch that began before
 * now and has not ended yet.
 */
const SHABBOS_LOOKBACK_DAYS = 10;
const SHABBOS_SCAN_DAYS = 21;
const FALLBACK_PACE_MS = 5000;

/**
 * How long before the chosen zman the walk has to start.
 *
 * Locking is deliberately slow - one group every `paceMs` - so a lock that
 * *begins* at candle lighting *finishes* minutes after it, which is the wrong
 * side of the line. The window therefore opens early enough for the last
 * group to be locked by the zman itself.
 *
 * `shabbos.leadMinutes` overrides the arithmetic. Left null it is worked out
 * from the group count and the pace plus a minute of slack, rounded up to the
 * whole minute the scheduler ticks on. The type check matters: `null`, `''`
 * and `false` all become 0 through `Number()`, and a lead of zero silently
 * means "finish late".
 */
export function shabbosLeadMs(cfg = {}) {
  const raw = cfg.shabbos?.leadMinutes;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.round(raw) * 60000;
  const pace = typeof cfg.paceMs === 'number' && cfg.paceMs > 0 ? cfg.paceMs : FALLBACK_PACE_MS;
  const groups = typeof cfg.groupCount === 'number' && cfg.groupCount > 0 ? cfg.groupCount : 0;
  return Math.ceil((groups * pace + 60000) / 60000) * 60000;
}

/** An offset in minutes from config, rejecting everything `Number()` would
 *  quietly turn into zero. */
function offsetMinutes(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

/**
 * What the portal needs to show about the automatic Shabbos lock: whether it
 * is on, which place and zman each end is read from, and - for the window in
 * hand - the exact minute the lock aims to be finished by and to reopen at.
 *
 * `problems` is the honest part. A half-configured Shabbos lock silently does
 * nothing, which is the worst possible failure for this feature, so anything
 * that would stop it firing is said out loud in the panel.
 */
export function shabbosStatus(cfg = {}, win = null) {
  const s = cfg.shabbos ?? {};
  const locs = usableLocations(s.locations);
  const startLoc = pickLocation(locs, s.start?.locationId);
  const endLoc = pickLocation(locs, s.end?.locationId);
  const z = win?.zmanim ?? null;

  const side = (which, loc, def) => (loc ? {
    location: loc.name,
    timezone: loc.timezone,
    zman: which?.zman ?? def,
    zmanLabel: zmanLabel(which?.zman ?? def),
    offsetMinutes: offsetMinutes(which?.offsetMinutes),
    candleOffsetMinutes: loc.candleOffsetMinutes,
  } : null);

  const problems = [];
  if (s.enabled) {
    if (!locs.length) problems.push('No usable location entered yet, so nothing is scheduled.');
    else if (!startLoc || !endLoc) problems.push('There is more than one location — pick which one each end of the lock is read from.');
    if (z?.start?.fallback || z?.end?.fallback) {
      problems.push('At this latitude the chosen zman has no answer on that date, so an approximation from sunset was used.');
    }
    // Reopening the groups while it is still Shabbos where they are is a
    // legitimate setup, but never an accident anyone wants.
    if (z?.end && z.endAtStartLocation && z.end.at < z.endAtStartLocation - 60000) {
      const early = Math.round((z.endAtStartLocation - z.end.at) / 60000);
      const hours = early >= 120 ? `${(early / 60).toFixed(1)} hours` : `${early} minutes`;
      problems.push(`The unlock is read at ${z.end.location}, which is ${hours} before the same zman at ${z.start?.location ?? 'the lock location'}`
        + ' — the groups will reopen while it is still Shabbos there. Deliberate? Then ignore this.');
    }
  }

  return {
    enabled: !!s.enabled,
    includeYomTov: s.includeYomTov !== false,
    inIsrael: !!s.inIsrael,
    leadMinutes: Math.round(shabbosLeadMs(cfg) / 60000),
    locationCount: locs.length,
    start: side(s.start, startLoc, DEFAULT_START_ZMAN),
    end: side(s.end, endLoc, DEFAULT_END_ZMAN),
    // Only set when the window in hand is a zmanim one: the zman the lock is
    // racing to finish by, and the zman it reopens at.
    lockBy: z?.start ? new Date(z.start.at) : null,
    reopenAt: z?.end ? new Date(z.end.at) : null,
    problems,
  };
}

/**
 * Windows for the automatic Shabbos / Yom Tov lock: one per unbroken stretch
 * of days on which melacha is forbidden, so a two-day yom tov running into
 * Shabbos is one continuous lock rather than three that reopen the groups at
 * nightfall in between.
 *
 * The two ends are read independently on purpose. Locking on one city's
 * candle lighting and unlocking on another city's Havdalah is a supported
 * setup, so each end carries its own place, its own zman and its own offset.
 */
function shabbosCandidates(now, cfg, { lookbackDays = SHABBOS_LOOKBACK_DAYS, scanDays = SHABBOS_SCAN_DAYS, force = false } = {}) {
  const s = cfg.shabbos ?? {};
  if (!s.enabled && !force) return [];

  const startLoc = pickLocation(s.locations, s.start?.locationId);
  const endLoc = pickLocation(s.locations, s.end?.locationId);
  if (!startLoc || !endLoc) return [];        // nothing usable configured yet

  const tz = startLoc.timezone;
  const today = civilParts(now.getTime(), tz);
  const lead = shabbosLeadMs(cfg);
  const out = [];

  for (const run of assurBemelachaRuns({
    from: civilPlusDays(today, -lookbackDays),
    days: scanDays,
    timezone: tz,
    inIsrael: !!s.inIsrael,
    includeYomTov: s.includeYomTov !== false,
  })) {
    const start = zmanAt({
      date: run.erev, location: startLoc,
      zman: s.start?.zman ?? DEFAULT_START_ZMAN, offsetMinutes: s.start?.offsetMinutes,
    });
    const end = zmanAt({
      date: run.last, location: endLoc,
      zman: s.end?.zman ?? DEFAULT_END_ZMAN, offsetMinutes: s.end?.offsetMinutes,
    });
    // An end that lands before its own start is a misconfiguration, not a
    // lock. Skipping the stretch leaves the groups as they are, which is far
    // better than locking them with no unlock in sight.
    if (!start || !end || end.at <= start.at) continue;

    // With two different places, the same zman read where the GROUPS are.
    // Unlocking on an eastward city's Havdalah reopens them while it is still
    // Shabbos locally, which is a legitimate thing to ask for but not
    // something anyone should discover by accident - so it is measured here
    // and reported in the panel.
    const endHere = startLoc.id === endLoc.id ? null : zmanAt({
      date: run.last, location: startLoc,
      zman: s.end?.zman ?? DEFAULT_END_ZMAN, offsetMinutes: s.end?.offsetMinutes,
    });

    out.push({
      lockAt: start.at - lead,
      unlockAt: end.at,
      id: `shabbos:${run.first.y}-${run.first.m}-${run.first.d}`,
      label: run.label,
      zmanim: { start, end, leadMs: lead, endAtStartLocation: endHere?.at ?? null },
    });
  }
  return out;
}

/**
 * The next few weeks of Shabbos / Yom Tov locks, computed but not acted on:
 * what the portal shows so an admin can check the schedule against their own
 * luach before trusting it with the groups. `force` so the preview works
 * while the feature is still switched off.
 */
export function upcomingShabbosWindows(now = new Date(), cfg = {}, days = 28) {
  const span = Math.max(1, Math.min(365, Math.round(Number(days) || 28)));
  const nowMs = now.getTime();
  // Three days back so a stretch already in progress is shown as one window
  // from its real beginning rather than from tonight.
  return shabbosCandidates(now, cfg, { lookbackDays: 3, scanDays: span + 4, force: true })
    .filter((w) => w.unlockAt > nowMs && w.lockAt < nowMs + span * DAY_MS)
    .sort((a, b) => a.lockAt - b.lockAt)
    .map((w) => ({
      label: w.label,
      lockAt: new Date(w.lockAt),
      unlockAt: new Date(w.unlockAt),
      leadMinutes: Math.round(w.zmanim.leadMs / 60000),
      start: { ...w.zmanim.start, at: new Date(w.zmanim.start.at) },
      end: { ...w.zmanim.end, at: new Date(w.zmanim.end.at) },
    }));
}

/** The civil date of the coming Friday in `tz` (today, if today is Friday).
 *  The sensible default date for a "what are the zmanim here?" preview. */
export function nextFridayIn(tz = 'UTC', now = new Date()) {
  const today = civilParts(now.getTime(), tz);
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    if (d.dow === 5) return { y: d.y, m: d.m, d: d.d };
  }
  return { y: today.y, m: today.m, d: today.d };
}

/** Every window that has not finished yet, earliest first. */
function candidates(now, cfg) {
  const nowMs = now.getTime();
  const out = [];
  // `enabled` gates the weekly windows. The Shabbos lock has its own switch,
  // so switching it on is one tick rather than two.
  if (cfg.enabled !== false) out.push(...weeklyCandidates(now, cfg));
  try {
    out.push(...shabbosCandidates(now, cfg));
  } catch (err) {
    // A bad location must not take the ordinary weekly schedule down with it.
    logger.warn(`shabbos windows skipped: ${err.message}`);
  }
  return out.filter((w) => w.unlockAt > nowMs).sort((a, b) => a.lockAt - b.lockAt);
}

/** Merging two windows: the start is the first one's, the end belongs to
 *  whichever of them now finishes last. */
function mergeZmanim(a, b) {
  if (!a && !b) return null;
  const ending = b?.end ? b : a;
  return {
    start: a?.start ?? b?.start ?? null,
    end: ending?.end ?? null,
    endAtStartLocation: ending?.endAtStartLocation ?? null,
    leadMs: a?.leadMs ?? b?.leadMs ?? 0,
  };
}

/**
 * The lock window currently in progress or next upcoming, relative to `now`.
 * Overlapping windows are merged so a lock spanning two of them is one window
 * with one key, not two that fight each other.
 *
 * Returns { lockAt, unlockAt, key, label, zmanim } or null.
 */
export function lockWindow(now = new Date(), cfg = {}) {
  const list = candidates(now, cfg);
  if (!list.length) return null;

  let cur = { ...list[0] };
  for (const next of list.slice(1)) {
    if (next.lockAt <= cur.unlockAt) {
      // Overlaps or touches: extend rather than starting a second window.
      if (next.unlockAt > cur.unlockAt) {
        cur.unlockAt = next.unlockAt;
        cur.zmanim = mergeZmanim(cur.zmanim, next.zmanim);
        if (next.label && next.label !== cur.label) {
          cur.label = [cur.label, next.label].filter(Boolean).join(' + ');
        }
      }
    } else if (cur.unlockAt > now.getTime()) {
      break;
    } else {
      cur = { ...next };
    }
  }

  return {
    lockAt: new Date(cur.lockAt),
    unlockAt: new Date(cur.unlockAt),
    key: new Date(cur.lockAt).toISOString(),
    label: cur.label || '',
    zmanim: cur.zmanim ?? null,
  };
}

/** Is `now` inside the given window? */
export function isWithin(now, win) {
  return !!win && now.getTime() >= win.lockAt.getTime() && now.getTime() < win.unlockAt.getTime();
}

/**
 * Pure decision: given the current lock state and time, what should happen?
 * Returns 'lock' | 'unlock' | null. Respects a per-window manual override so
 * the schedule never fights an admin who deliberately unlocked this window.
 */
export function decide(now, cfg, state) {
  // Two independent switches: the weekly windows, and the automatic Shabbos
  // lock. Either one being on is reason enough to act.
  if (!cfg.enabled && !cfg.shabbos?.enabled) return null;
  const win = lockWindow(now, cfg);
  const inWindow = isWithin(now, win);

  if (inWindow) {
    if (state.overriddenWindowKey === win.key) return null;   // admin unlocked this one
    if (!state.locked) return 'lock';
    return null;
  }
  // Outside any window: undo only schedule-driven locks, leave manual ones.
  if (state.locked && state.source === 'schedule') return 'unlock';
  return null;
}

/**
 * Drives lock/unlock on a timer. `applyLock`/`applyUnlock` do the WhatsApp work;
 * `persist` saves state so a restart resumes correctly.
 *
 * Applying a lock is slow by design - the groups are walked one at a time,
 * seconds apart, so WhatsApp is never handed a burst of setting changes. A run
 * therefore outlives the request that asked for it: `manualLock`/`manualUnlock`
 * return as soon as it has *started*, and `status().run` reports how far along
 * it is. Only one run walks the groups at a time; anything asked for while one
 * is in flight is refused rather than stacked on top of it.
 */
export class LockScheduler {
  constructor({ getConfig, getState, persist, applyLock, applyUnlock }) {
    this.getConfig = getConfig;
    this.getState = getState;
    this.persist = persist;
    this.applyLock = applyLock;
    this.applyUnlock = applyUnlock;
    this.timer = null;
    this.run = null;        // the paced run currently walking the groups
    this.lastRun = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => logger.warn(`tick: ${e.message}`)), 60_000);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  status() {
    const cfg = this.getConfig();
    const win = lockWindow(new Date(), cfg);
    const st = this.getState();
    return {
      enabled: !!cfg.enabled,
      locked: !!st.locked,
      source: st.source ?? null,
      timezone: cfg.timezone ?? null,
      windowLabel: win?.label ?? null,
      nextLockAt: win?.lockAt ?? null,
      nextUnlockAt: win?.unlockAt ?? null,
      inWindow: isWithin(new Date(), win),
      // The automatic Shabbos / Yom Tov lock, and anything wrong with it.
      shabbos: shabbosStatus(cfg, win),
      // How the groups are being walked right now, and how the last walk went.
      paceMs: Number.isFinite(Number(cfg.paceMs)) ? Number(cfg.paceMs) : null,
      run: runView(this.run),
      lastRun: runView(this.lastRun),
    };
  }

  async tick() {
    if (this.run) return;             // still walking the groups from last time
    const cfg = this.getConfig();
    const state = this.getState();
    const action = decide(new Date(), cfg, state);
    if (!action) return;
    const { started, run } = this._begin(action, 'schedule');
    // Only ever wait on a run this tick started - never park the interval
    // callback on somebody else's multi-minute walk.
    if (started) await run.promise;
  }

  /**
   * Start a paced run, unless one is already going. Returns
   * `{ started, run }` immediately - `run.promise` settles when every group
   * has been walked, which for a large account is minutes away.
   */
  _begin(action, source, overriddenWindowKey = null) {
    if (this.run) {
      logger.warn(`${action} (${source}) ignored: a ${this.run.action} run is already walking the groups`);
      return { started: false, run: this.run };
    }

    const run = {
      action, source,
      startedAt: Date.now(), finishedAt: null,
      done: 0, total: null, current: null, error: null,
    };
    const onProgress = (p) => {
      if (Number.isFinite(p?.done)) run.done = p.done;
      if (Number.isFinite(p?.total)) run.total = p.total;
      run.current = p?.subject || p?.jid || null;
    };

    this.run = run;
    run.promise = Promise.resolve()
      .then(() => (action === 'lock'
        ? this.applyLock(source, { onProgress })
        : this.applyUnlock(source, overriddenWindowKey, { onProgress })))
      .catch((err) => {
        run.error = err?.message ?? String(err);
        logger.error(`${action} (${source}) failed: ${run.error}`);
      })
      .finally(() => {
        run.finishedAt = Date.now();
        this.lastRun = run;
        this.run = null;
      });
    return { started: true, run };
  }

  /**
   * Admin actions from the portal. Both return once the run has started, not
   * once it has finished - holding an HTTP request open for the minutes a
   * paced walk takes would only time out in the browser.
   */
  manualLock() { return this._begin('lock', 'manual'); }
  manualUnlock() {
    // Remember which window was overridden so the scheduler won't re-lock it.
    const win = lockWindow(new Date(), this.getConfig());
    return this._begin('unlock', 'manual', win?.key ?? null);
  }
}

/** Serializable view of a run, for the portal. */
function runView(r) {
  if (!r) return null;
  return {
    action: r.action,
    source: r.source,
    done: r.done,
    total: r.total,
    current: r.current,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}
