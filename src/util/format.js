/**
 * The two things this bot renders everywhere, rendered one way everywhere.
 *
 * Phone numbers are always `+<country><area><number>` with nothing else in
 * them: no spaces, no dashes, no parentheses, no leading zeros. Times are
 * always 24-hour. There is no second style and no locale-dependent fallback,
 * because "4:30" meaning either half past four in the morning or half past
 * four in the afternoon is a real way to lock the wrong groups at the wrong
 * time, and a number that reads differently in two panels is a real way to
 * ban the wrong person.
 *
 * The control panel is plain browser JavaScript with no build step, so it
 * carries its own copy of these functions (see the "numbers and times" block
 * in src/web/public/app.js). test/format.test.mjs runs the SAME table of
 * inputs through both and fails if they ever disagree, so the copy cannot
 * drift.
 */

/** Human-readable byte sizes, for the diagnostics panel. */
export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 2 : 0)} ${u[i]}`;
}

/* --------------------------- phone numbers --------------------------- */

export const MIN_NUMBER_DIGITS = 7;
export const MAX_NUMBER_DIGITS = 15;        // E.164 caps it at 15

/**
 * A number reduced to what is stored and compared: digits only, country code
 * first. Lenient on purpose - it has to recognise the same person whether
 * they were typed in as `+1 (732) 352-3090`, `001-732-352-3090` or
 * `17323523090` - so it never refuses, it just strips.
 *
 * `00` is the international dialling prefix and is dropped; a number that
 * still begins with 0 after that is in national format with no country code,
 * which this cannot fix and must not guess at. It is left alone here and
 * caught by `numberProblem`.
 */
export function numberDigits(value) {
  const d = String(value ?? '').replace(/[^0-9]/g, '');
  return d.startsWith('00') ? d.slice(2) : d;
}

/** The one way a number is ever shown: `+17323523090`. Empty if there is none. */
export function fmtNumber(value) {
  const d = numberDigits(value);
  return d ? `+${d}` : '';
}

/**
 * Why `value` is not a usable number, as a sentence for whoever typed it, or
 * null if it is fine. Separate from `numberDigits` because matching an
 * existing roster entry has to stay lenient while *accepting* a new number
 * should not: a number saved without its country code is one that quietly
 * never matches anybody.
 */
export function numberProblem(value) {
  if (!String(value ?? '').trim()) return 'Enter a phone number.';
  const d = numberDigits(value);
  if (!d) return 'That has no digits in it.';
  if (d.startsWith('0')) {
    return 'Start with the country code rather than a 0 — +1 for the US and Canada, +44 for the UK, +972 for Israel.';
  }
  if (d.length < MIN_NUMBER_DIGITS) {
    return `That is only ${d.length} digits — include the country code, like +17325551234.`;
  }
  if (d.length > MAX_NUMBER_DIGITS) {
    return `That is ${d.length} digits; a phone number is at most ${MAX_NUMBER_DIGITS}.`;
  }
  return null;
}

/* ------------------------------- times ------------------------------- */

/**
 * The pieces of an instant, in `timeZone` (the machine's own zone if none is
 * given), on a 24-hour clock.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`: the latter renders midnight
 * as 24:00 in some locales, which is the sort of detail that only shows up in
 * a screenshot from somebody else's laptop.
 */
function timeParts(when, timeZone) {
  // `new Date(null)` is the epoch, not an invalid date, so an absent
  // timestamp would otherwise render as a confident "1970-01-01 00:00".
  if (when === null || when === undefined || when === '') return null;
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      ...(timeZone ? { timeZone } : {}),
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d);
  } catch {
    return null;                              // a zone this machine does not know
  }
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return p;
}

/** `16:36`. */
export function fmtTime(when, timeZone) {
  const p = timeParts(when, timeZone);
  return p ? `${p.hour}:${p.minute}` : '';
}

/** `2026-01-16`. Year first so it reads the same to everyone and sorts. */
export function fmtDate(when, timeZone) {
  const p = timeParts(when, timeZone);
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

/** `2026-01-16 16:36`. */
export function fmtDateTime(when, timeZone) {
  const p = timeParts(when, timeZone);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : '';
}

/** `2026-01-16 16:36:24`, where the second matters (the live log). */
export function fmtDateTimeSec(when, timeZone) {
  const p = timeParts(when, timeZone);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` : '';
}

/** `Fri 2026-01-16 16:36`, where which weekday it is carries meaning. */
export function fmtDayTime(when, timeZone) {
  const p = timeParts(when, timeZone);
  return p ? `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : '';
}

/**
 * A wall-clock time typed into a form, as `HH:MM` on a 24-hour clock, or ''
 * if it cannot be read as one. Accepts `9:5`, `18.30`, a bare `0900` and a
 * bare `18`.
 *
 * Only digits and a separator, which is what refuses `7pm` - and refusing it
 * is the point. Read as 07:00 it would unlock the groups twelve hours early,
 * so an unreadable time has to stay unreadable rather than become a
 * confident wrong one.
 */
export function parseClock(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  // With a separator the minutes may be written short (9:5 is 09:05);
  // without one the whole thing has to be HMM or HHMM, so there is nothing
  // to guess at.
  const sep = /^(\d{1,2})\s*[:.]\s*(\d{1,2})$/.exec(raw);
  const bare = /^(\d{1,4})$/.exec(raw);
  if (!sep && !bare) return '';
  // A bare 1-2 digits is an hour on its own ("18" is 18:00); 3-4 digits is
  // HMM or HHMM ("930" is 09:30), so neither reading needs guessing at.
  const whole = bare ? bare[1] : '';
  const hh = Number(sep ? sep[1] : (whole.length <= 2 ? whole : whole.slice(0, -2)));
  const mi = Number(sep ? sep[2] : (whole.length <= 2 ? 0 : whole.slice(-2)));
  if (hh > 23 || mi > 59) return '';
  return `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}
