/* Zmanim for the automatic Shabbos lock: the calculations, the calendar, and
   the locations an admin types in.

   The expected times below were taken from kosher-zmanim itself and then
   sanity-checked against published luach values for those cities. They are
   here to catch a WIRING mistake - the wrong method behind a key, a timezone
   read in the wrong place, an offset applied twice - which is exactly the
   class of bug that would quietly lock the groups at the wrong minute.
   Run: node test/zmanim.test.mjs */
import {
  ZMANIM, ZMAN_BY_KEY, zmanOptions, zmanLabel, zmanAt, previewZmanim,
  assurBemelachaRuns, normalizeLocation, locationError, usableLocations, pickLocation,
  civilPlusDays, clearZmanimCache, DEFAULT_CANDLE_OFFSET_MINUTES,
} from '../src/core/zmanim.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const BROOKLYN = { id: 'bk', name: 'Brooklyn', latitude: 40.6329, longitude: -73.9949, elevation: 15, timezone: 'America/New_York' };
const JERUSALEM = { id: 'jm', name: 'Jerusalem', latitude: 31.7683, longitude: 35.2137, elevation: 754, timezone: 'Asia/Jerusalem', candleOffsetMinutes: 40 };
const LONDON = { id: 'ld', name: 'London', latitude: 51.5762, longitude: -0.1936, elevation: 60, timezone: 'Europe/London' };

/** A zman as the wall clock in its own zone shows it, e.g. "16:36". */
const clock = (z, tz) => (z == null ? 'NONE' : new Intl.DateTimeFormat('en-GB', {
  timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(typeof z === 'object' ? z.at : z)));

const at = (location, y, m, d, zman, offsetMinutes = 0) =>
  zmanAt({ date: { y, m, d }, location, zman, offsetMinutes });

console.log('=== the calculations land on the minute the luach says ===');
{
  // Friday 16 January 2026 and Friday 17 July 2026 - midwinter and midsummer,
  // either side of the DST switch.
  ok(clock(at(BROOKLYN, 2026, 1, 16, 'candleLighting'), BROOKLYN.timezone) === '16:36', 'Brooklyn candle lighting in January');
  ok(clock(at(BROOKLYN, 2026, 1, 16, 'sunset'), BROOKLYN.timezone) === '16:55', 'Brooklyn sunset in January');
  ok(clock(at(BROOKLYN, 2026, 7, 17, 'candleLighting'), BROOKLYN.timezone) === '20:06', 'Brooklyn candle lighting in July, DST included');
  ok(clock(at(BROOKLYN, 2026, 1, 17, 'tzais8.5'), BROOKLYN.timezone) === '17:39', 'Brooklyn tzais 8.5° on the Shabbos');
  ok(clock(at(BROOKLYN, 2026, 1, 17, 'tzais72'), BROOKLYN.timezone) === '18:07', 'Brooklyn tzais 72 minutes on the same day');
  ok(clock(at(LONDON, 2026, 1, 16, 'candleLighting'), LONDON.timezone) === '16:04', 'London candle lighting in January');
  ok(clock(at(LONDON, 2026, 7, 17, 'candleLighting'), LONDON.timezone) === '20:51', 'London candle lighting in July, BST included');

  // Jerusalem's 40-minute custom, and the subtlety that candle lighting is
  // measured from SEA-LEVEL sunset while `sunset` is elevation-adjusted. The
  // gap between them is therefore more than 40 minutes, which is a thing only
  // the library gets right - it is why this is not hand-rolled.
  const jmCandle = at(JERUSALEM, 2026, 1, 16, 'candleLighting');
  const jmSunset = at(JERUSALEM, 2026, 1, 16, 'sunset');
  const jmSea = at(JERUSALEM, 2026, 1, 16, 'seaLevelSunset');
  ok(clock(jmCandle, JERUSALEM.timezone) === '16:18', 'Jerusalem lights 40 minutes early');
  ok(Math.round((jmSea.at - jmCandle.at) / 60000) === 40, 'the 40 minutes is measured from sea-level sunset');
  ok(jmSunset.at > jmSea.at, 'elevation pushes the visible sunset later');
  ok(Math.round((jmSunset.at - jmCandle.at) / 60000) > 40,
     'so the gap to the elevation-adjusted sunset is more than 40 minutes, not exactly 40');
}

console.log('=== a location is read exactly as entered ===');
{
  // Elevation is not decoration: it moves sunset. Same place, no elevation.
  const flat = { ...JERUSALEM, elevation: 0 };
  ok(at(flat, 2026, 1, 16, 'sunset').at < at(JERUSALEM, 2026, 1, 16, 'sunset').at,
     'raising the elevation moves sunset later');
  ok(at(flat, 2026, 1, 16, 'seaLevelSunset').at === at(JERUSALEM, 2026, 1, 16, 'seaLevelSunset').at,
     'but sea-level sunset ignores it, as its name says');

  // The candle-lighting offset belongs to the location, not to the schedule.
  const twenty = { ...JERUSALEM, candleOffsetMinutes: 20 };
  ok(Math.round((at(twenty, 2026, 1, 16, 'candleLighting').at - at(JERUSALEM, 2026, 1, 16, 'candleLighting').at) / 60000) === 20,
     "changing the location's candle offset moves candle lighting and nothing else");
  ok(normalizeLocation({ ...JERUSALEM, candleOffsetMinutes: undefined }).candleOffsetMinutes === DEFAULT_CANDLE_OFFSET_MINUTES,
     'an unset candle offset defaults to 18 minutes');
}

console.log('=== the admin\'s own offset is what makes any minhag reachable ===');
{
  const sunset = at(BROOKLYN, 2026, 1, 17, 'sunset');
  const plus42 = at(BROOKLYN, 2026, 1, 17, 'sunset', 42);
  ok(plus42.at - sunset.at === 42 * 60000, 'tzais at 42 minutes is sunset with an offset of 42');
  ok(plus42.base === sunset.at, 'the zman itself is reported apart from the offset');
  ok(plus42.offsetMinutes === 42, 'and the offset is reported too, so the portal can explain the time');

  const earlier = at(BROOKLYN, 2026, 1, 16, 'candleLighting', -10);
  ok(at(BROOKLYN, 2026, 1, 16, 'candleLighting').at - earlier.at === 10 * 60000, 'a negative offset locks earlier');

  // The values Number() would turn into 0 must not be read as an offset of 0 -
  // they mean "not set", which is the same thing here, but must not throw.
  for (const bad of [null, undefined, '', false, [], {}, NaN, 'abc']) {
    ok(at(BROOKLYN, 2026, 1, 17, 'sunset', bad).at === sunset.at, `an offset of ${JSON.stringify(bad)} is treated as none`);
  }
}

console.log('=== an unanswerable zman falls back instead of dropping Shabbos ===');
{
  // Far enough north the sun never reaches 8.5° below the horizon in summer,
  // so the degree calculations have no answer at all. Skipping the lock would
  // be the worst outcome; an approximation from sunset, clearly flagged, is
  // the right one.
  const tromso = { name: 'Tromso', latitude: 69.65, longitude: 18.96, timezone: 'Europe/Oslo' };
  const aug = zmanAt({ date: { y: 2026, m: 8, d: 15 }, location: tromso, zman: 'tzais8.5' });
  ok(aug !== null, 'mid-August in Tromso still produces a time');
  ok(aug.fallback === true, 'and says out loud that it is an approximation');
  ok(clock(aug, tromso.timezone) !== 'NONE', `which is a real clock time (${clock(aug, tromso.timezone)})`);

  const sunset = zmanAt({ date: { y: 2026, m: 8, d: 15 }, location: tromso, zman: 'seaLevelSunset' });
  ok(Math.round((aug.at - sunset.at) / 60000) === ZMAN_BY_KEY.get('tzais8.5').approxSunsetOffset,
     'the approximation is the documented number of minutes after sunset');

  // Midsummer there is no sunset at all, and none of this applies.
  ok(zmanAt({ date: { y: 2026, m: 6, d: 20 }, location: tromso, zman: 'tzais8.5' }) === null,
     'under the midnight sun there is no answer, and none is invented');

  ok(zmanAt({ date: { y: 2026, m: 1, d: 16 }, location: BROOKLYN, zman: 'candleLighting' }).fallback === false,
     'an ordinary latitude is never flagged as approximate');
}

console.log('=== every catalogue entry actually works ===');
{
  ok(ZMANIM.length >= 12, `the catalogue offers ${ZMANIM.length} zmanim`);
  for (const z of ZMANIM) {
    const v = at(BROOKLYN, 2026, 1, 16, z.key);
    ok(v !== null && !v.fallback && Number.isFinite(v.at), `${z.key} (${z.label}) computes`);
  }
  // Order matters to an admin reading a dropdown: the start options must come
  // out before sunset and the end options after it.
  const sunset = at(BROOKLYN, 2026, 1, 16, 'sunset').at;
  for (const z of ZMANIM.filter((x) => x.side === 'start')) {
    ok(at(BROOKLYN, 2026, 1, 16, z.key).at <= sunset, `${z.key} is at or before sunset, as a lock time should be`);
  }
  for (const z of ZMANIM.filter((x) => x.side === 'end')) {
    ok(at(BROOKLYN, 2026, 1, 16, z.key).at > sunset, `${z.key} is after sunset, as an unlock time should be`);
  }
  // An unknown key must not silently become midnight.
  ok(at(BROOKLYN, 2026, 1, 16, 'notAZman').zman === 'tzais8.5', 'an unknown key falls back to a documented default');
  ok(zmanLabel('tzais8.5').includes('8.5'), 'labels describe the zman');
  ok(zmanLabel('somethingElse') === 'somethingElse', 'an unknown key is labelled as itself rather than blank');
  ok(zmanOptions().every((o) => o.key && o.label && o.side && typeof o.hint === 'string'),
     'the catalogue serialises for the portal with no functions in it');
}

console.log('=== a location is refused rather than guessed at ===');
{
  const cases = [
    [null, 'no location'],
    [{}, 'no name'],
    [{ name: 'x' }, 'no latitude'],
    [{ name: 'x', latitude: 40 }, 'no longitude'],
    [{ name: 'x', latitude: 40, longitude: -73 }, 'no timezone'],
    [{ name: 'x', latitude: 40, longitude: -73, timezone: 'Mars/Olympus' }, 'an unknown timezone'],
    [{ name: 'x', latitude: 91, longitude: 0, timezone: 'UTC' }, 'a latitude off the globe'],
    [{ name: 'x', latitude: 0, longitude: 181, timezone: 'UTC' }, 'a longitude off the globe'],
    [{ name: 'x', latitude: 40, longitude: -73, timezone: 'UTC', elevation: 99999 }, 'an impossible elevation'],
    [{ name: 'x', latitude: 40, longitude: -73, timezone: 'UTC', candleOffsetMinutes: 500 }, 'an absurd candle offset'],
    [{ name: '  ', latitude: 40, longitude: -73, timezone: 'UTC' }, 'a name that is only spaces'],
  ];
  for (const [raw, why] of cases) {
    ok(typeof locationError(raw) === 'string' && locationError(raw).length > 5, `${why} is refused, with a reason`);
    ok(normalizeLocation(raw) === null, `  ...and normalises to nothing`);
  }
  ok(locationError(BROOKLYN) === null, 'a complete location is accepted');

  // THE POINT: a blank coordinate must never become 0,0. A bot quietly reading
  // the zmanim of a spot in the Atlantic is worse than one that refuses.
  for (const blank of [null, '', false, [], undefined]) {
    ok(normalizeLocation({ name: 'x', latitude: blank, longitude: blank, timezone: 'UTC' }) === null,
       `latitude ${JSON.stringify(blank)} is refused, not read as the equator`);
  }
  ok(normalizeLocation({ name: 'x', latitude: 0, longitude: 0, timezone: 'UTC' }) !== null,
     'but a deliberate 0,0 is still allowed');
  ok(normalizeLocation({ name: 'x', latitude: '40.6', longitude: '-73.9', timezone: 'UTC' }).latitude === 40.6,
     'coordinates typed into a form arrive as strings and are accepted');
  ok(normalizeLocation({ name: 'x', latitude: 31.5, longitude: 35.4, timezone: 'Asia/Jerusalem', elevation: -400 }).elevation === -400,
     'a below-sea-level elevation is legitimate');
  ok(normalizeLocation({ latitude: 1, longitude: 1, timezone: 'UTC', name: 'a'.repeat(200) }).name.length === 80,
     'an absurdly long name is trimmed rather than refused');
  ok(normalizeLocation({ ...BROOKLYN, id: '' }).id.length > 0, 'a location with no id is given one');
}

console.log('=== which location each end of the lock is read from ===');
{
  ok(usableLocations([BROOKLYN, {}, JERUSALEM, null]).length === 2, 'unusable rows are dropped, the rest kept');
  ok(usableLocations(null).length === 0, 'a missing list is an empty one');

  // One location and no explicit pick is the overwhelmingly common setup, and
  // making it work removes the commonest way to misconfigure this.
  ok(pickLocation([BROOKLYN], '')?.id === 'bk', 'one location needs no pick');
  ok(pickLocation([BROOKLYN], 'nope')?.id === 'bk', 'and a stale id still resolves to it');
  ok(pickLocation([BROOKLYN, JERUSALEM], 'jm')?.id === 'jm', 'with several, the id chooses');
  ok(pickLocation([BROOKLYN, JERUSALEM], '') === null, 'with several and no pick, nothing is guessed');
  ok(pickLocation([BROOKLYN, JERUSALEM], 'nope') === null, 'nor for an id that is not there');
  ok(pickLocation([], 'bk') === null, 'no locations, no answer');
}

console.log('=== the calendar: which days are locked, as one stretch each ===');
{
  const runs = (from, days, opts) => assurBemelachaRuns({ from, days, timezone: 'America/New_York', ...opts });
  const span = (r) => `${r.erev.m}/${r.erev.d}->${r.last.m}/${r.last.d}`;

  // A plain week: one Shabbos, starting Friday afternoon.
  const plain = runs({ y: 2026, m: 1, d: 12 }, 7);
  ok(plain.length === 1, 'an ordinary week has one lock');
  ok(span(plain[0]) === '1/16->1/17', 'from Friday the 16th into Saturday the 17th');
  ok(plain[0].label === 'Shabbos', 'labelled Shabbos');
  ok(plain[0].shabbos === true && plain[0].yomTov === false, 'and marked as such');

  // Pesach 5786 in the diaspora: yom tov Thursday and Friday, then Shabbos.
  // Three days that must be ONE lock - the groups are not reopened at
  // nightfall on Thursday.
  const pesach = runs({ y: 2026, m: 3, d: 29 }, 16);
  ok(pesach.length === 3, `Pesach fortnight has three locks, not eight (${pesach.map(span).join(' ')})`);
  ok(span(pesach[0]) === '4/1->4/4', 'the first is one continuous stretch from erev Pesach to motzei Shabbos');
  ok(pesach[0].label.includes('Pesach') && pesach[0].label.includes('Shabbos'), `and says what it is ("${pesach[0].label}")`);
  ok(span(pesach[1]) === '4/7->4/9', 'then the last days of Pesach, two days as one lock');
  ok(span(pesach[2]) === '4/10->4/11', 'then the following ordinary Shabbos');

  // The same fortnight in Israel: one day of yom tov, so the stretches split.
  const israel = assurBemelachaRuns({ from: { y: 2026, m: 3, d: 29 }, days: 16, timezone: 'Asia/Jerusalem', inIsrael: true });
  ok(israel.length === 4, `Israel keeps one day, so the same fortnight is four locks (${israel.map(span).join(' ')})`);
  ok(span(israel[0]) === '4/1->4/2', 'first day of Pesach alone');
  ok(span(israel[1]) === '4/3->4/4', 'and the Shabbos after it separately');

  // Shabbos only.
  const shabbosOnly = runs({ y: 2026, m: 3, d: 29 }, 16, { includeYomTov: false });
  ok(shabbosOnly.length === 2 && shabbosOnly.every((r) => r.label === 'Shabbos'),
     'with Yom Tov switched off, only the two Shabbosos are locked');

  // Shemini Atzeres / Simchas Torah straight after Shabbos.
  const tishrei = runs({ y: 2026, m: 9, d: 24 }, 14);
  ok(tishrei.length === 2, 'Sukkos fortnight: two stretches');
  ok(tishrei[1].label.includes('Shemini Atzeres') && tishrei[1].label.includes('Simchas Torah'),
     `both days of the end of Sukkos are named ("${tishrei[1].label}")`);

  // Chol hamoed is not locked - it is not assur bemelacha.
  ok(!runs({ y: 2026, m: 4, d: 5 }, 3).length, 'chol hamoed on a weekday is not locked');

  ok(assurBemelachaRuns({ from: null }).length === 0, 'no start date, no runs');
  ok(assurBemelachaRuns({ from: { y: 2026, m: 1, d: 12 }, days: 7, timezone: 'Not/AZone' }).length === 1,
     'an unusable timezone falls back to UTC rather than throwing');
}

console.log('=== civil date arithmetic crosses months and years ===');
{
  ok(JSON.stringify(civilPlusDays({ y: 2026, m: 1, d: 31 }, 1)) === '{"y":2026,"m":2,"d":1}', 'end of January');
  ok(JSON.stringify(civilPlusDays({ y: 2026, m: 12, d: 31 }, 1)) === '{"y":2027,"m":1,"d":1}', 'end of the year');
  ok(JSON.stringify(civilPlusDays({ y: 2026, m: 1, d: 1 }, -1)) === '{"y":2025,"m":12,"d":31}', 'and backwards over it');
  ok(JSON.stringify(civilPlusDays({ y: 2028, m: 2, d: 28 }, 1)) === '{"y":2028,"m":2,"d":29}', 'a leap day');
}

console.log('=== the preview the portal shows ===');
{
  const p = previewZmanim({ date: { y: 2026, m: 1, d: 16 }, location: BROOKLYN });
  ok(p.location === 'Brooklyn' && p.timezone === 'America/New_York', 'says where it is for');
  ok(Object.keys(p.times).length === ZMANIM.length, 'covers the whole catalogue');
  ok(p.times.candleLighting.at === at(BROOKLYN, 2026, 1, 16, 'candleLighting').at,
     'and matches what the scheduler will use - the same code path, not a second one');
  ok(previewZmanim({ date: { y: 2026, m: 1, d: 16 }, location: { name: 'x' } }) === null, 'an unusable location previews nothing');
  ok(previewZmanim({ location: BROOKLYN }) === null, 'so does a missing date');
  ok(previewZmanim({ date: { y: 2026, m: 1, d: 16 }, location: BROOKLYN, keys: ['sunset'] }).times.sunset !== null,
     'a narrowed preview still answers');
}

console.log('=== caching cannot change an answer ===');
{
  const first = at(BROOKLYN, 2026, 1, 16, 'candleLighting').at;
  const cached = at(BROOKLYN, 2026, 1, 16, 'candleLighting').at;
  clearZmanimCache();
  const fresh = at(BROOKLYN, 2026, 1, 16, 'candleLighting').at;
  ok(first === cached && cached === fresh, 'the same question gives the same answer, cached or not');
  // Two locations that differ only in one field must not share a cache entry.
  ok(at({ ...BROOKLYN, id: 'a', elevation: 0 }, 2026, 1, 16, 'sunset').at
     !== at({ ...BROOKLYN, id: 'b', elevation: 400 }, 2026, 1, 16, 'sunset').at,
     'elevation is part of the cache key');
  ok(at({ ...BROOKLYN, id: 'c', candleOffsetMinutes: 18 }, 2026, 1, 16, 'candleLighting').at
     !== at({ ...BROOKLYN, id: 'd', candleOffsetMinutes: 40 }, 2026, 1, 16, 'candleLighting').at,
     'so is the candle-lighting offset');
  // Worth pinning down because it is surprising: for an EXPLICIT civil date
  // the zone does not move the answer. The zone decides which civil date a
  // given instant falls on, and which clock the time is shown against - not
  // where the sun is. Sunset at these coordinates on the 16th is the same
  // instant however the wall clock there is labelled.
  ok(at({ ...BROOKLYN, timezone: 'America/Chicago' }, 2026, 1, 16, 'sunset').at
     === at(BROOKLYN, 2026, 1, 16, 'sunset').at,
     'relabelling the zone does not move the sun');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
