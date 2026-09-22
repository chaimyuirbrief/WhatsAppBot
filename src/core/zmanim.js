import { GeoLocation, ComplexZmanimCalendar, JewishCalendar, HebrewDateFormatter, Luxon } from 'kosher-zmanim';

const { DateTime } = Luxon;

/**
 * Zmanim for the automatic Shabbos / Yom Tov lock.
 *
 * Everything here is computed locally by `kosher-zmanim` (the JavaScript port
 * of KosherJava). That is a deliberate choice over calling a zmanim web API:
 * the lock has to fire on Friday afternoon whether or not the box has
 * internet, and a network hiccup must never be the reason the groups stayed
 * open into Shabbos.
 *
 * Two things this module does NOT decide: which zman you want, and where.
 * Both come from config, because "candle lighting" and "Havdalah" mean
 * different minutes to different communities, and the start and end may
 * deliberately be read in two different places.
 *
 * `kosher-zmanim` is LGPL-3.0 and used here unmodified, as an ordinary
 * dependency; none of its code is copied into this repository.
 */

const MIN = 60000;
export const DEFAULT_CANDLE_OFFSET_MINUTES = 18;
const MAX_CANDLE_OFFSET_MINUTES = 120;

/**
 * The zmanim an admin can pick from.
 *
 * `side` is only a hint for the portal about which picker to offer it in -
 * nothing refuses a choice, because someone may genuinely want to lock at
 * sunset or unlock at 120 minutes.
 *
 * `approxSunsetOffset` is the fallback: far enough north, the sun never gets
 * 8.5 degrees below the horizon in summer, so the degree-based calculations
 * have no answer at all. Rather than silently skipping Shabbos, we fall back
 * to sunset plus this many minutes and flag it, so the portal can say the
 * number is an approximation.
 */
export const ZMANIM = [
  { key: 'candleLighting', label: 'Candle lighting', side: 'start', approxSunsetOffset: -18,
    hint: "sunset minus this location's candle-lighting offset" },
  { key: 'sunset', label: 'Sunset (shkiah)', side: 'both', approxSunsetOffset: 0,
    hint: 'adjusted for the elevation you entered' },
  { key: 'seaLevelSunset', label: 'Sea-level sunset', side: 'both', approxSunsetOffset: 0,
    hint: 'ignores elevation' },
  { key: 'plagHamincha', label: 'Plag hamincha', side: 'start', approxSunsetOffset: -75,
    hint: 'for locking early on a short Friday' },

  { key: 'tzais8.5', label: 'Tzais 8.5° (Geonim)', side: 'end', approxSunsetOffset: 42 },
  { key: 'tzais7.083', label: 'Tzais 7.083° (Geonim)', side: 'end', approxSunsetOffset: 35 },
  { key: 'tzais5.95', label: 'Tzais 5.95° (Geonim)', side: 'end', approxSunsetOffset: 29 },
  { key: 'tzais3.7', label: 'Tzais 3.7° (Geonim)', side: 'end', approxSunsetOffset: 16 },
  { key: 'tzais16.1', label: 'Tzais 16.1°', side: 'end', approxSunsetOffset: 85 },
  { key: 'tzais50', label: 'Tzais 50 minutes', side: 'end', approxSunsetOffset: 50 },
  { key: 'tzais60', label: 'Tzais 60 minutes', side: 'end', approxSunsetOffset: 60 },
  { key: 'tzais72', label: 'Tzais 72 minutes (Rabbeinu Tam)', side: 'end', approxSunsetOffset: 72 },
  { key: 'tzais72Zmanis', label: 'Tzais 72 zmanis minutes', side: 'end', approxSunsetOffset: 72 },
];

/** Which `ComplexZmanimCalendar` method answers each key. */
const METHOD = {
  sunset: 'getSunset',
  seaLevelSunset: 'getSeaLevelSunset',
  plagHamincha: 'getPlagHamincha',
  'tzais8.5': 'getTzaisGeonim8Point5Degrees',
  'tzais7.083': 'getTzaisGeonim7Point083Degrees',
  'tzais5.95': 'getTzaisGeonim5Point95Degrees',
  'tzais3.7': 'getTzaisGeonim3Point7Degrees',
  'tzais16.1': 'getTzais16Point1Degrees',
  tzais50: 'getTzais50',
  tzais60: 'getTzais60',
  tzais72: 'getTzais72',
  tzais72Zmanis: 'getTzais72Zmanis',
  // candleLighting is special: it depends on the location's own offset, so it
  // is applied in `zmanAt` rather than being a plain method lookup.
};

export const ZMAN_BY_KEY = new Map(ZMANIM.map((z) => [z.key, z]));
export const DEFAULT_START_ZMAN = 'candleLighting';
export const DEFAULT_END_ZMAN = 'tzais8.5';

/** The catalogue as the portal wants it: plain data, no functions. */
export function zmanOptions() {
  return ZMANIM.map(({ key, label, side, hint }) => ({ key, label, side, hint: hint ?? '' }));
}

export function zmanLabel(key) {
  return ZMAN_BY_KEY.get(key)?.label ?? String(key ?? '');
}

/* ---------------------------- locations ---------------------------- */

/** Is `tz` a zone this platform actually knows? */
function knownTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A finite number, rejecting the values `Number()` would happily turn into 0.
 * `null`, `''`, `false` and `[]` all coerce to zero, which would silently
 * place a location on the equator at the prime meridian.
 */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Why `normalizeLocation` would reject `raw`, as a sentence for the admin, or
 * null if it is fine. Kept separate so the portal can explain the rejection
 * instead of just dropping the row.
 */
export function locationError(raw) {
  if (!raw || typeof raw !== 'object') return 'No location given.';
  if (!String(raw.name ?? '').trim()) return 'Give the location a name.';

  const lat = num(raw.latitude);
  if (lat === null) return 'Latitude must be a number.';
  if (lat < -90 || lat > 90) return 'Latitude must be between -90 and 90.';

  const lon = num(raw.longitude);
  if (lon === null) return 'Longitude must be a number.';
  if (lon < -180 || lon > 180) return 'Longitude must be between -180 and 180.';

  if (raw.elevation !== undefined && raw.elevation !== null && raw.elevation !== '') {
    const el = num(raw.elevation);
    if (el === null) return 'Elevation must be a number of metres.';
    if (el < -500 || el > 9000) return 'Elevation must be between -500 and 9000 metres.';
  }

  const tz = String(raw.timezone ?? '').trim();
  if (!tz) return 'Choose the time zone this place is in.';
  if (!knownTimezone(tz)) return `"${tz}" is not a time zone this machine knows (use an IANA name like America/New_York).`;

  if (raw.candleOffsetMinutes !== undefined && raw.candleOffsetMinutes !== null && raw.candleOffsetMinutes !== '') {
    const co = num(raw.candleOffsetMinutes);
    if (co === null) return 'Candle-lighting offset must be a number of minutes.';
    if (co < 0 || co > MAX_CANDLE_OFFSET_MINUTES) return `Candle-lighting offset must be between 0 and ${MAX_CANDLE_OFFSET_MINUTES} minutes.`;
  }
  return null;
}

let idSeq = 0;

/**
 * A location in the one shape the rest of the code uses, or null if it is not
 * usable. Anything missing gets a documented default; anything wrong is
 * refused outright rather than guessed at, because a location quietly
 * defaulted to 0,0 would lock the groups at the wrong time all year.
 */
export function normalizeLocation(raw) {
  if (locationError(raw)) return null;
  const el = num(raw.elevation);
  const co = num(raw.candleOffsetMinutes);
  return {
    id: String(raw.id ?? '').trim() || `loc${Date.now().toString(36)}${(idSeq++).toString(36)}`,
    name: String(raw.name).trim().slice(0, 80),
    latitude: num(raw.latitude),
    longitude: num(raw.longitude),
    elevation: el === null ? 0 : el,
    timezone: String(raw.timezone).trim(),
    candleOffsetMinutes: co === null ? DEFAULT_CANDLE_OFFSET_MINUTES : Math.round(co),
  };
}

/** Every usable location in a config list, bad rows dropped. */
export function usableLocations(list) {
  return (Array.isArray(list) ? list : []).map(normalizeLocation).filter(Boolean);
}

/**
 * The location an end of the schedule points at. A missing or unknown id
 * falls back to the only location there is - the overwhelmingly common setup
 * is one place used for both ends, and making that work without an explicit
 * pick removes the commonest way to misconfigure this.
 */
export function pickLocation(locations, id) {
  const list = usableLocations(locations);
  if (!list.length) return null;
  const wanted = String(id ?? '').trim();
  if (wanted) {
    const hit = list.find((l) => l.id === wanted);
    if (hit) return hit;
  }
  return list.length === 1 ? list[0] : null;
}

/* ------------------------- the calculations ------------------------- */

// One calendar per location, reused. Building a GeoLocation per call would be
// wasteful given `tick()` asks for a fortnight of zmanim every minute.
const calendars = new Map();
const CACHE_MAX = 4000;
const cache = new Map();

function calendarFor(loc) {
  const key = `${loc.latitude}|${loc.longitude}|${loc.elevation}|${loc.timezone}`;
  let cal = calendars.get(key);
  if (!cal) {
    cal = new ComplexZmanimCalendar(
      new GeoLocation(loc.name, loc.latitude, loc.longitude, loc.elevation, loc.timezone),
    );
    calendars.set(key, cal);
  }
  return cal;
}

/** Forget every cached answer. For tests, and for a config change. */
export function clearZmanimCache() {
  cache.clear();
  calendars.clear();
}

/** A luxon DateTime for a civil date in a zone, at noon so no DST edge bites. */
function civilNoon({ y, m, d }, tz) {
  return DateTime.fromObject({ year: y, month: m, day: d, hour: 12 }, { zone: tz });
}

/** `n` days after a civil date, as a civil date. No timezone involved. */
export function civilPlusDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * When a zman falls, in epoch ms.
 *
 * Returns `{ at, base, fallback, zman, location }`, or null if even sunset has
 * no answer that day (polar day or night, where none of this applies anyway).
 *
 *   - `base` is the zman itself; `at` is `base` plus the admin's own offset,
 *     which is what makes any minhag reachable ("tzais 42 minutes" is sunset
 *     with an offset of 42).
 *   - `fallback` is true when the requested calculation had no answer and
 *     sunset plus an approximation was used instead.
 */
export function zmanAt({ date, location, zman, offsetMinutes = 0 } = {}) {
  const loc = normalizeLocation(location);
  if (!loc || !date) return null;
  const key = ZMAN_BY_KEY.has(zman) ? zman : DEFAULT_END_ZMAN;
  const off = num(offsetMinutes) ?? 0;

  const ck = `${key}|${off}|${loc.latitude},${loc.longitude},${loc.elevation},${loc.timezone},${loc.candleOffsetMinutes}|${date.y}-${date.m}-${date.d}`;
  if (cache.has(ck)) return cache.get(ck);

  const cal = calendarFor(loc);
  cal.setDate(civilNoon(date, loc.timezone));

  let base = null;
  if (key === 'candleLighting') {
    cal.setCandleLightingOffset(loc.candleOffsetMinutes);
    base = cal.getCandleLighting();
  } else {
    base = cal[METHOD[key]]?.();
  }

  let fallback = false;
  if (!base) {
    // No answer at this latitude on this date. Approximate from sunset, and
    // say so rather than dropping the whole Shabbos.
    const sunset = cal.getSeaLevelSunset() ?? cal.getSunset();
    if (!sunset) {
      cache.set(ck, null);
      return null;
    }
    base = sunset.plus({ minutes: ZMAN_BY_KEY.get(key).approxSunsetOffset });
    fallback = true;
  }

  const baseMs = base.toMillis();
  const out = {
    at: baseMs + off * MIN,
    base: baseMs,
    fallback,
    zman: key,
    zmanLabel: zmanLabel(key),
    offsetMinutes: off,
    location: loc.name,
    timezone: loc.timezone,
  };
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(ck, out);
  return out;
}

/* --------------------------- the calendar --------------------------- */

const hebrewFormatter = new HebrewDateFormatter();

/**
 * Consecutive runs of days on which melacha is forbidden, within `days` civil
 * days starting at `from`.
 *
 * Runs rather than single days, because that is what a lock window actually
 * is: a three-day yom tov next to Shabbos is ONE lock that starts before the
 * first candle lighting and ends after the last Havdalah - the groups are not
 * reopened at nightfall in between. Emitting runs also keeps the window's
 * identity stable for the whole stretch, so an admin who manually unlocks
 * during yom tov is not re-locked an hour later by a window that has quietly
 * become a different window.
 *
 * Each run: `{ first, last, erev, label, shabbos, yomTov }` where the dates
 * are civil `{y,m,d}` and `erev` is the day before `first` - the day whose
 * candle lighting starts the lock.
 */
export function assurBemelachaRuns({ from, days = 18, timezone = 'UTC', inIsrael = false, includeYomTov = true } = {}) {
  if (!from) return [];
  const tz = knownTimezone(timezone) ? timezone : 'UTC';
  const runs = [];
  let open = null;

  for (let i = 0; i < Math.max(1, days); i++) {
    const date = civilPlusDays(from, i);
    const dt = civilNoon(date, tz);
    const jc = new JewishCalendar(dt);
    jc.setInIsrael(!!inIsrael);

    const shabbos = dt.weekday === 6;            // luxon: 1=Monday .. 7=Sunday
    const yomTov = includeYomTov && jc.isYomTovAssurBemelacha();
    if (!shabbos && !yomTov) { open = null; continue; }

    if (!open) {
      open = { first: date, last: date, erev: civilPlusDays(date, -1), shabbos, yomTov, names: [] };
      runs.push(open);
    } else {
      open.last = date;
      open.shabbos = open.shabbos || shabbos;
      open.yomTov = open.yomTov || yomTov;
    }
    if (yomTov) {
      const name = hebrewFormatter.formatYomTov(jc);
      if (name && !open.names.includes(name)) open.names.push(name);
    }
  }

  for (const r of runs) {
    const parts = [...r.names];
    if (r.shabbos) parts.push('Shabbos');
    r.label = parts.join(' / ') || 'Shabbos';
    delete r.names;
  }
  return runs;
}

/**
 * Everything the portal needs to show one location's Shabbos times for a
 * given civil date: the zmanim on offer, computed, so an admin can check the
 * setting against their own luach before trusting it with the groups.
 */
export function previewZmanim({ date, location, keys } = {}) {
  const loc = normalizeLocation(location);
  if (!loc || !date) return null;
  const want = Array.isArray(keys) && keys.length ? keys : ZMANIM.map((z) => z.key);
  const times = {};
  for (const key of want) {
    const z = zmanAt({ date, location: loc, zman: key });
    times[key] = z ? { at: z.at, fallback: z.fallback, label: zmanLabel(key) } : null;
  }
  return { date, location: loc.name, timezone: loc.timezone, times };
}
