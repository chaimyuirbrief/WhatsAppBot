/* The lockdown card, run against the real markup: what is loaded into the
   form must come back out of it unchanged, and a time the bot cannot read
   must stop the save rather than being quietly replaced. Both are failures
   nobody would notice until the groups locked at the wrong hour.
   Run: node test/shabbos-ui.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0, skipped = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'src', 'web', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');

// linkedom is a devDependency and `./install.sh` installs with --omit=dev, so
// `npm test` on a production box says what is missing rather than crashing.
let parseHTML = null;
try { ({ parseHTML } = await import('linkedom')); } catch { /* not installed */ }
if (!parseHTML) {
  skipped += 1;
  console.log('  skip  linkedom not installed (production install) — `npm install` to run this file');
  console.log(`\n  ${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

const BROOKLYN = { id: 'bk', name: 'Brooklyn', latitude: 40.6329, longitude: -73.9949, elevation: 15, timezone: 'America/New_York', candleOffsetMinutes: 18 };
const JERUSALEM = { id: 'jm', name: 'Jerusalem', latitude: 31.7683, longitude: 35.2137, elevation: 754, timezone: 'Asia/Jerusalem', candleOffsetMinutes: 40 };

/** Load the real Shabbos block out of app.js and run it over the real page. */
function mount() {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const block = appJs.match(/\/\* -+ automatic Shabbos \/ Yom Tov lock -+ \*\/[\s\S]*?\nfunction collectForm\(/);
  if (!block) throw new Error('could not find the Shabbos block in app.js');
  const escSrc = appJs.match(/function esc\(s\) \{[\s\S]*?\n\}/)[0];
  // The shared number/time helpers the panel is built on, so this runs the
  // real ones rather than a stand-in.
  const fmtSrc = appJs.match(/\/\* -+ numbers and times -+ \*\/[\s\S]*?\n\/\* -+ toast/)[0]
    .replace(/\n\/\* -+ toast$/, '');
  // The weekly-window half of the same card: normalizeWindow, the clock-box
  // guard, and the collector that feeds both save buttons.
  const winBlock = appJs.match(/\/\* -+ lockdown windows -+ \*\/[\s\S]*?\n\/\* -+ automatic Shabbos/)[0]
    .replace(/\n\/\* -+ automatic Shabbos$/, '');
  const src = block[0].replace(/\nfunction collectForm\($/, '');
  const make = new Function('document', 'window', 'api', `
    "use strict";
    const $ = (id) => document.getElementById(id);
    let LOCK_WINDOWS = [];                 // declared above the block in app.js
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    ${escSrc}
    ${fmtSrc}
    ${winBlock}
    ${src}
    return {
      fillShabbosForm, collectShabbos, collectShLocations, renderShLocations,
      renderShPickers, numOrBlank, fmtTime, fmtDayTime, lockZone, shortZone, SH_PRESETS,
      normalizeWindow, collectLockWindows, badClockBoxes, clockRefusal, renderLockWindows,
      setWindows: (w) => { LOCK_WINDOWS = w; },
      setZmanOptions: (o) => { ZMAN_OPTIONS = o; },
      $,
    };
  `);
  return { document, ui: make(document, window, async () => ({})) };
}

console.log('=== the form round-trips what was saved ===');
{
  const { ui } = mount();
  const saved = {
    enabled: true,
    includeYomTov: false,
    inIsrael: true,
    locations: [BROOKLYN, JERUSALEM],
    start: { locationId: 'bk', zman: 'plagHamincha', offsetMinutes: -7 },
    end: { locationId: 'jm', zman: 'tzais72', offsetMinutes: 13 },
    leadMinutes: 12,
  };
  ui.fillShabbosForm(saved);
  const got = ui.collectShabbos();

  ok(got.enabled === true, 'the switch survives');
  ok(got.includeYomTov === false, 'Yom Tov switched OFF stays off — the box is not just left ticked');
  ok(got.inIsrael === true, 'the Israel setting survives');
  ok(got.leadMinutes === 12, 'the lead time survives');
  ok(got.locations.length === 2, 'both locations come back');

  for (const [i, want] of [[0, BROOKLYN], [1, JERUSALEM]]) {
    const g = got.locations[i];
    ok(g.id === want.id, `${want.name}: the id survives, so the pickers keep pointing at it`);
    ok(g.name === want.name, `${want.name}: the name survives`);
    ok(g.latitude === want.latitude && g.longitude === want.longitude, `${want.name}: the coordinates survive to four decimals`);
    ok(g.elevation === want.elevation, `${want.name}: the elevation survives`);
    ok(g.timezone === want.timezone, `${want.name}: the time zone survives`);
    ok(g.candleOffsetMinutes === want.candleOffsetMinutes, `${want.name}: its own candle-lighting custom survives`);
  }

  ok(got.start.locationId === 'bk' && got.end.locationId === 'jm',
     'the two ends still point at their own separate places — the whole point of the feature');
  ok(got.start.zman === 'plagHamincha' && got.end.zman === 'tzais72',
     'and at their own zmanim, even though the catalogue has not loaded yet');
  ok(got.start.offsetMinutes === -7 && got.end.offsetMinutes === 13, 'with their own offsets, sign included');
}

console.log('=== a blank lead time is not zero ===');
{
  const { ui } = mount();
  ui.fillShabbosForm({ enabled: true, locations: [BROOKLYN], leadMinutes: null });
  ok(ui.collectShabbos().leadMinutes === null, 'left blank it stays blank, meaning "work it out"');
  ui.fillShabbosForm({ enabled: true, locations: [BROOKLYN], leadMinutes: 0 });
  ok(ui.collectShabbos().leadMinutes === 0, 'a deliberate 0 is kept as 0');
  ui.fillShabbosForm({ enabled: true, locations: [BROOKLYN], leadMinutes: -30 });
  ok(ui.collectShabbos().leadMinutes === 0, 'a negative lead is clamped rather than shifting the lock later');
}

console.log('=== an empty form never blanks a saved schedule ===');
{
  // The card renders before the config has arrived. Collecting then must not
  // report "no locations", which would wipe them on the next save.
  const { ui } = mount();
  ok(ui.collectShabbos().locations === undefined,
     'before the rows are drawn, the locations key is absent, so a save leaves them alone');
  ui.fillShabbosForm({ enabled: false, locations: [] });
  ok(Array.isArray(ui.collectShabbos().locations) && ui.collectShabbos().locations.length === 0,
     'once drawn, genuinely removing every location is honoured');
}

console.log('=== defaults for a location typed from scratch ===');
{
  const { ui } = mount();
  ui.fillShabbosForm({ enabled: true, locations: [{ id: 'new', name: 'Somewhere', timezone: 'UTC' }] });
  const l = ui.collectShabbos().locations[0];
  ok(l.latitude === '' && l.longitude === '',
     'a coordinate nobody has typed stays blank — it does not become 0, which is a real place in the Atlantic');
  ok(l.elevation === 0, 'elevation defaults to sea level');
  ok(l.candleOffsetMinutes === 18, 'and candle lighting to the usual 18 minutes');
  ok(ui.numOrBlank('') === '' && ui.numOrBlank(null) === '' && ui.numOrBlank('abc') === '' && ui.numOrBlank(false) === '',
     'nothing that is not a number is read as one');
  ok(ui.numOrBlank('0') === 0 && ui.numOrBlank(0) === 0 && ui.numOrBlank('-73.9') === -73.9,
     'while real numbers, including 0 and negatives, come through');

  // A brand-new install has no shabbos config at all.
  ui.fillShabbosForm({});
  const fresh = ui.collectShabbos();
  ok(fresh.enabled === false, 'a fresh install starts switched off');
  ok(fresh.includeYomTov === true, 'but with Yom Tov already ticked, which is what almost everyone wants');
  ok(fresh.inIsrael === false, 'and the diaspora calendar');
  ok(fresh.leadMinutes === null, 'and the lead time worked out automatically');
  ok(fresh.start.zman === 'candleLighting' && fresh.end.zman === 'tzais8.5', 'on the two usual zmanim');
  ok(fresh.start.offsetMinutes === 0 && fresh.end.offsetMinutes === 0, 'with no offsets');
}

console.log('=== the zman pickers ===');
{
  const { ui } = mount();
  const OPTIONS = [
    { key: 'candleLighting', label: 'Candle lighting', side: 'start', hint: '' },
    { key: 'sunset', label: 'Sunset', side: 'both', hint: '' },
    { key: 'tzais8.5', label: 'Tzais 8.5°', side: 'end', hint: '' },
    { key: 'tzais72', label: 'Tzais 72 minutes', side: 'end', hint: '' },
  ];
  ui.fillShabbosForm({ enabled: true, locations: [BROOKLYN, JERUSALEM], start: { locationId: 'jm', zman: 'sunset' }, end: { locationId: 'bk', zman: 'tzais72' } });
  ui.setZmanOptions(OPTIONS);
  ui.renderShPickers();
  const got = ui.collectShabbos();
  ok(got.start.zman === 'sunset' && got.end.zman === 'tzais72',
     'the catalogue arriving later does not reset a saved choice');
  ok(got.start.locationId === 'jm' && got.end.locationId === 'bk',
     'nor which place each end reads');

  // Every zman is reachable from both ends, but the relevant ones come first.
  const startOpts = [...ui.$('f-sh-start-zman').querySelectorAll('option')].map((o) => o.value);
  ok(startOpts.length === OPTIONS.length, `the lock picker offers all ${OPTIONS.length} zmanim, so nothing is unreachable`);
  ok(startOpts[0] === 'candleLighting', 'with candle lighting first');
  ok(startOpts.indexOf('tzais8.5') > startOpts.indexOf('sunset'), 'and the unlock-side ones pushed below');
  const endOpts = [...ui.$('f-sh-end-zman').querySelectorAll('option')].map((o) => o.value);
  ok(endOpts[0] === 'sunset' || endOpts.includes('tzais8.5'), 'the unlock picker leads with the tzais options');
  ok(endOpts.includes('candleLighting'), 'while still offering the rest');
}

console.log('=== a start time the bot cannot read stops the save ===');
{
  const { ui, document } = mount();
  // An existing window, retyped as "6pm" - the single most likely mistake
  // now that the box takes free text.
  ui.setWindows([ui.normalizeWindow({ id: 'w1', label: 'Shabbos', day: 5, start: '18:00', durationMinutes: 1500 })]);
  ui.renderLockWindows();
  const box = document.querySelector('#lock-windows .w-start');
  ok(box && box.value === '18:00', 'the saved window is drawn');

  box.value = '6pm';
  const bad = ui.badClockBoxes();
  ok(bad.length === 1 && bad[0] === '6pm', `the unreadable box is found (${JSON.stringify(bad)})`);
  ok(/6pm/.test(ui.clockRefusal(bad)) && /18:00/.test(ui.clockRefusal(bad)),
     `and the refusal says what is wrong and what to type instead ("${ui.clockRefusal(bad)}")`);

  // THE POINT: it must NOT silently become 09:00 and report itself saved.
  // 18:00 for 1500 minutes is the Shabbos lock; 09:00 would open the groups
  // for the whole of Friday night.
  const collected = ui.collectLockWindows();
  ok(collected[0].start === '6pm',
     `what was typed is kept, not rewritten to 09:00 (${JSON.stringify(collected[0].start)})`);
  ok(collected[0].durationMinutes === 1500, 'and the rest of the row is untouched');

  // Every value the format rules refuse must be caught here too, rather than
  // landing on some other hour.
  for (const typo of ['7pm', '7 PM', '7:30pm', '12am', '7 a.m.', '24:00', '7:60', 'noon', '']) {
    box.value = typo;
    ok(ui.badClockBoxes().length === 1, `${JSON.stringify(typo)} stops the save`);
    ok(ui.collectLockWindows()[0].start !== '09:00', `  ...and is not turned into 09:00`);
  }

  // A readable time clears the flag and collects canonically.
  for (const [typed, want] of [['18:00', '18:00'], ['6:30', '06:30'], ['930', '09:30'], ['18', '18:00']]) {
    box.value = typed;
    ok(ui.badClockBoxes().length === 0, `${JSON.stringify(typed)} is accepted`);
    ok(ui.collectLockWindows()[0].start === want, `  ...and collects as ${want}`);
  }

  // A brand-new row, with nothing typed in it at all, still gets a sane start.
  ok(ui.normalizeWindow({}).start === '09:00', 'a new window starts at 09:00');
  ok(ui.badClockBoxes().length === 0, 'and an empty card has nothing to complain about');
}

console.log('=== the known-places list ===');
{
  const { ui } = mount();
  ok(ui.SH_PRESETS.length > 15, `${ui.SH_PRESETS.length} places are offered, so nobody has to look up a latitude`);
  for (const p of ui.SH_PRESETS) {
    const bad = !p.name || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || !p.timezone;
    ok(!bad, `${p.name || '(unnamed)'} is complete`);
    if (bad) continue;
    let zoneOk = true;
    try { new Intl.DateTimeFormat('en-US', { timeZone: p.timezone }); } catch { zoneOk = false; }
    ok(zoneOk, `  ...and ${p.timezone} is a real zone`);
  }
  ok(ui.SH_PRESETS.find((p) => p.name === 'Jerusalem')?.candleOffsetMinutes === 40,
     'Jerusalem is pre-set to its 40-minute custom rather than the generic 18');
  ok(new Set(ui.SH_PRESETS.map((p) => p.name)).size === ui.SH_PRESETS.length, 'no place is listed twice');
}

console.log('=== times are shown on the clock they belong to ===');
{
  const { ui } = mount();
  // A Jerusalem Havdalah read by an admin in New York must show Jerusalem's
  // clock, not the browser's.
  const t = Date.UTC(2026, 0, 17, 16, 10, 0);
  ok(ui.fmtTime(t, 'Asia/Jerusalem') === '18:10', `Jerusalem shows 18:10 (${ui.fmtTime(t, 'Asia/Jerusalem')})`);
  ok(ui.fmtTime(t, 'America/New_York') === '11:10', `New York shows 11:10 (${ui.fmtTime(t, 'America/New_York')})`);
  ok(ui.fmtDayTime(t, 'Asia/Jerusalem') === 'Sat 2026-01-17 18:10',
     `the dated form is 24-hour and unambiguous (${ui.fmtDayTime(t, 'Asia/Jerusalem')})`);
  ok(!/[ap]m/i.test(ui.fmtDayTime(t, 'Asia/Jerusalem')), 'with no am or pm anywhere in it');
  ok(ui.fmtTime(t, 'Mars/Olympus') === '', 'an unusable zone renders nothing rather than throwing');

  // Which clock a lock time is shown on.
  const shabbosWin = { timezone: 'America/New_York', shabbos: { lockBy: 1, start: { timezone: 'America/Chicago' }, end: { timezone: 'Asia/Jerusalem' } } };
  ok(ui.lockZone(shabbosWin, 'start') === 'America/Chicago' && ui.lockZone(shabbosWin, 'end') === 'Asia/Jerusalem',
     "a zmanim window is shown on each end's own clock");
  const weeklyWin = { timezone: 'America/New_York', shabbos: { lockBy: null, start: { timezone: 'Asia/Jerusalem' }, end: { timezone: 'Asia/Jerusalem' } } };
  ok(ui.lockZone(weeklyWin, 'start') === 'America/New_York',
     'a weekly window is shown on the configured zone, not on a Shabbos location that has nothing to do with it');
  ok(ui.lockZone({}, 'start') === 'UTC' && ui.lockZone(null, 'end') === 'UTC', 'and there is always some answer');
  ok(ui.shortZone('America/New_York') === 'New York' && ui.shortZone('Asia/Jerusalem') === 'Jerusalem',
     'and is labelled readably, so a two-city lock cannot be misread as one clock');
  ok(ui.shortZone('UTC') === 'UTC' && ui.shortZone(null) === '', 'including the odd ones');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
