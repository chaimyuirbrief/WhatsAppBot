import log from '../util/logger.js';

const logger = log.scope('lockdown');

/**
 * Scheduled lockdown: lock every group (admins-only messaging) during one or
 * more recurring weekly windows, then unlock when the window ends.
 *
 * A window is `{ day, start, durationMinutes }` read in the configured IANA
 * timezone, so the schedule follows civil time across DST rather than drifting
 * by an hour twice a year. Windows may cross midnight and the week boundary,
 * and overlapping windows are merged into one continuous lock.
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

/** Every configured window that has not finished yet, earliest first. */
function candidates(now, cfg) {
  const tz = cfg.timezone || 'UTC';
  const windows = (Array.isArray(cfg.windows) ? cfg.windows : []).filter((w) => w?.enabled !== false);
  if (!windows.length) return [];

  const nowMs = now.getTime();
  const today = civilParts(nowMs, tz);
  const out = [];

  for (const w of windows) {
    const dur = Math.max(1, Number(w.durationMinutes) || 0) * 60000;
    // ±8 days covers a window that started before `now` and one that starts
    // next week, whichever weekday it falls on.
    for (let off = -8; off <= 8; off++) {
      const day = addDays(today, off);
      if (day.dow !== Number(w.day)) continue;
      const lockAt = zonedToUtc(day, w.start || '00:00', w.timezone || tz);
      const unlockAt = lockAt + dur;
      if (unlockAt > nowMs) out.push({ lockAt, unlockAt, id: w.id ?? null, label: w.label ?? '' });
    }
  }
  return out.sort((a, b) => a.lockAt - b.lockAt);
}

/**
 * The lock window currently in progress or next upcoming, relative to `now`.
 * Overlapping windows are merged so a lock spanning two of them is one window
 * with one key, not two that fight each other.
 *
 * Returns { lockAt, unlockAt, key, label } or null.
 */
export function lockWindow(now = new Date(), cfg = {}) {
  const list = candidates(now, cfg);
  if (!list.length) return null;

  let cur = { ...list[0] };
  for (const next of list.slice(1)) {
    if (next.lockAt <= cur.unlockAt) {
      // Overlaps or touches: extend rather than starting a second window.
      if (next.unlockAt > cur.unlockAt) cur.unlockAt = next.unlockAt;
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
  if (!cfg.enabled) return null;
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
