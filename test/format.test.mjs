/* One format for a phone number, one format for a time, everywhere.
   Covers the rules themselves, that the control panel's copy of them cannot
   drift from the server's, and a repo-wide scan so neither can be
   reintroduced by the next thing anyone writes.
   Run: node test/format.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from '../src/util/format.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const appJs = fs.readFileSync(path.join(root, 'src', 'web', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'web', 'public', 'index.html'), 'utf8');

console.log('=== a phone number has exactly one shape ===');
{
  // The same person, typed in every way somebody might type them.
  const SAME = ['+1 (732) 352-3090', '+1-732-352-3090', '1 732 352 3090', '17323523090',
                '+17323523090', '001 732 352 3090', '0017323523090', ' +1.732.352.3090 '];
  for (const v of SAME) {
    ok(F.fmtNumber(v) === '+17323523090', `${JSON.stringify(v)} -> +17323523090`);
  }
  ok(F.fmtNumber('+44 7360 595428') === '+447360595428', 'a UK number keeps its country code');
  ok(F.fmtNumber('+972-2-123-4567') === '+97221234567', 'so does an Israeli one');
  ok(new Set(SAME.map(F.fmtNumber)).size === 1, 'every spelling collapses to the one string');

  // Nothing but digits comes out the other side.
  for (const v of SAME.concat(['+44 7360 595428', '+972-2-123-4567'])) {
    ok(/^\+[0-9]+$/.test(F.fmtNumber(v)), `${JSON.stringify(v)} renders with no spaces, dashes or brackets`);
  }
  ok(F.fmtNumber('') === '' && F.fmtNumber(null) === '' && F.fmtNumber(undefined) === '' && F.fmtNumber('abc') === '',
     'nothing in, nothing out — never a bare "+"');
  ok(F.numberDigits('+17323523090') === '17323523090', 'what is stored has no + on it');
}

console.log('=== a number without a country code is refused, not guessed at ===');
{
  ok(F.numberProblem('+17323523090') === null, 'a full number is fine');
  ok(F.numberProblem('17323523090') === null, 'with or without the +');
  ok(F.numberProblem('+447360595428') === null, 'and outside North America');

  const country = F.numberProblem('07360595428');
  ok(typeof country === 'string' && /country code/i.test(country),
     `a national-format number is refused and says why — "${country}"`);
  // THE POINT: it must not silently become +7360595428, which is a real
  // number in Russia.
  ok(F.numberProblem('07360595428') !== null, 'rather than being turned into somebody else');

  ok(F.numberProblem('3523090') === null, 'a short international number is still allowed');
  ok(/country code/i.test(F.numberProblem('35230') ?? ''), 'but one too short to be a number at all is refused');
  ok(F.numberProblem('1234567890123456') !== null, 'and one longer than E.164 allows');
  ok(F.numberProblem('') !== null && F.numberProblem(null) !== null, 'and nothing at all');
  ok(F.numberProblem('abc') !== null, 'and letters');
  ok(F.numberProblem('0017323523090') === null, 'while 00 is just the dialling prefix and is accepted');
  for (const v of ['+17323523090', '0017323523090', '+1 (732) 352-3090']) {
    ok(F.numberProblem(v) === null && F.fmtNumber(v) === '+17323523090',
       `${JSON.stringify(v)} is accepted AND canonicalised`);
  }
}

console.log('=== every time is 24-hour ===');
{
  const t = Date.UTC(2026, 0, 16, 16, 36, 24);
  ok(F.fmtTime(t, 'UTC') === '16:36', 'afternoon is 16:36, not 4:36');
  ok(F.fmtDate(t, 'UTC') === '2026-01-16', 'dates are year-first so they read the same to everybody');
  ok(F.fmtDateTime(t, 'UTC') === '2026-01-16 16:36', 'and together');
  ok(F.fmtDateTimeSec(t, 'UTC') === '2026-01-16 16:36:24', 'with seconds where they matter');
  ok(F.fmtDayTime(t, 'UTC') === 'Fri 2026-01-16 16:36', 'and a weekday where that matters');

  // Midnight and noon are where 12-hour formatting goes wrong.
  const mid = Date.UTC(2026, 0, 16, 0, 5, 0);
  const noon = Date.UTC(2026, 0, 16, 12, 0, 0);
  ok(F.fmtTime(mid, 'UTC') === '00:05', 'midnight is 00:05, not 12:05 and not 24:05');
  ok(F.fmtTime(noon, 'UTC') === '12:00', 'noon is 12:00');
  ok(F.fmtTime(Date.UTC(2026, 0, 16, 23, 59), 'UTC') === '23:59', 'and the last minute of the day is 23:59');

  for (const fn of ['fmtTime', 'fmtDate', 'fmtDateTime', 'fmtDateTimeSec', 'fmtDayTime']) {
    for (const when of [t, mid, noon]) {
      ok(!/[ap]\.?m\.?/i.test(F[fn](when, 'UTC')), `${fn} never prints am or pm`);
    }
  }

  // Same instant, two clocks.
  ok(F.fmtTime(t, 'America/New_York') === '11:36' && F.fmtTime(t, 'Asia/Jerusalem') === '18:36',
     'a zone is honoured when one is given');
  ok(F.fmtDateTime(t) !== '', 'and the machine\'s own zone when one is not');

  // Nothing is invented out of nothing.
  for (const bad of [null, undefined, '', 'tomorrow', NaN, {}]) {
    ok(F.fmtDateTime(bad) === '', `${JSON.stringify(bad) ?? 'undefined'} renders as nothing, not as 1970`);
  }
  ok(F.fmtTime(t, 'Mars/Olympus') === '', 'an unusable zone renders nothing rather than throwing');
  ok(F.fmtDateTime(0, 'UTC') === '1970-01-01 00:00', 'but a real timestamp of 0 is still a real time');
}

console.log('=== a time typed into a form is read as 24-hour, or not at all ===');
{
  const cases = [
    ['18:00', '18:00'], ['18.00', '18:00'], ['1800', '18:00'], ['18', '18:00'],
    ['9:5', '09:05'], ['930', '09:30'], ['9', '09:00'], ['0', '00:00'], ['00:00', '00:00'],
    ['23:59', '23:59'], [' 7:30 ', '07:30'],
  ];
  for (const [input, want] of cases) ok(F.parseClock(input) === want, `${JSON.stringify(input)} -> ${want}`);

  // Anything with am/pm in it is refused rather than guessed at: "7pm" read
  // as 07:00 would unlock the groups twelve hours early.
  for (const bad of ['7pm', '7 PM', '7:30pm', '12am', '7 a.m.', '24:00', '25:00', '7:60', '', 'noon', 'abc', null]) {
    ok(F.parseClock(bad) === '', `${JSON.stringify(bad)} is refused`);
  }
}

console.log('=== the panel\'s copy cannot drift from the server\'s ===');
{
  // The control panel is plain browser JavaScript with no build step, so it
  // carries its own copy. Run the SAME inputs through both.
  const block = appJs.match(/\/\* -+ numbers and times -+ \*\/[\s\S]*?\n\/\* -+ toast/);
  ok(!!block, 'the mirrored block is where it says it is in app.js');
  const browser = new Function(`${block[0].replace(/\n\/\* -+ toast$/, '')}
    return { numberDigits, fmtNumber, numberProblem, fmtTime, fmtDate, fmtDateTime, fmtDateTimeSec, fmtDayTime, parseClock,
             MIN_NUMBER_DIGITS, MAX_NUMBER_DIGITS };`)();

  const NUMBERS = ['+1 (732) 352-3090', '17323523090', '+447360595428', '0044 7360 595428',
                   '07360595428', '3523090', '', null, undefined, 'abc', '  ', '+972-2-123-4567',
                   '1234567890123456', '0017323523090', 0, 17323523090];
  for (const fn of ['numberDigits', 'fmtNumber', 'numberProblem']) {
    const mismatch = NUMBERS.filter((v) => browser[fn](v) !== F[fn](v));
    ok(mismatch.length === 0,
       `${fn} agrees on all ${NUMBERS.length} inputs${mismatch.length ? ` — differs on ${JSON.stringify(mismatch)}` : ''}`);
  }

  const WHENS = [Date.UTC(2026, 0, 16, 16, 36, 24), Date.UTC(2026, 0, 16, 0, 5), Date.UTC(2026, 6, 4, 12, 0),
                 0, null, undefined, '', 'nope', new Date('2026-12-31T23:59:59Z')];
  const ZONES = [undefined, 'UTC', 'America/New_York', 'Asia/Jerusalem', 'Mars/Olympus'];
  for (const fn of ['fmtTime', 'fmtDate', 'fmtDateTime', 'fmtDateTimeSec', 'fmtDayTime']) {
    const bad = [];
    for (const w of WHENS) for (const z of ZONES) if (browser[fn](w, z) !== F[fn](w, z)) bad.push([w, z]);
    ok(bad.length === 0, `${fn} agrees on all ${WHENS.length * ZONES.length} combinations${bad.length ? ` — differs on ${JSON.stringify(bad)}` : ''}`);
  }

  // searchDigits only exists in the panel: it decides whether a search box
  // holds a number at all.
  const sd = new Function(`${block[0].replace(/\n\/\* -+ toast$/, '')}
    return searchDigits;`)()
  ok(sd('+1 (732) 352-3090') === '17323523090', 'a pasted number searches as a number');
  ok(sd('17323523090') === '17323523090' && sd('732-352') === '732352', 'with or without punctuation');
  ok(sd('shiur 2') === '' && sd('minyan 3') === '' && sd('Rabbi 5') === '',
     'a group name with a digit in it is NOT a number search — matching every member whose number contains that digit buries the real hit');
  // And with enough digits to get past a length check on its own: "Daf 127"
  // would otherwise search for 127 and hit most of the roster.
  ok(sd('Daf 127') === '' && sd('Shiur 2024') === '' && sd('minyan 5:30') === '' && sd('zoom 8080') === '',
     'including names with three or more digits in them');
  ok(sd('2') === '' && sd('12') === '', 'nor are one or two stray digits');
  ok(sd('') === '' && sd(null) === '', 'nor nothing');
  ok(sd('123') === '123', 'but three digits is a deliberate enough search to honour');

  const CLOCKS = ['18:00', '18', '930', '9:5', '7pm', '24:00', '', null, '0', '1800', 'abc'];
  const clockBad = CLOCKS.filter((c) => browser.parseClock(c) !== F.parseClock(c));
  ok(clockBad.length === 0, `parseClock agrees on all ${CLOCKS.length} inputs${clockBad.length ? ` — differs on ${JSON.stringify(clockBad)}` : ''}`);
  ok(browser.MIN_NUMBER_DIGITS === F.MIN_NUMBER_DIGITS && browser.MAX_NUMBER_DIGITS === F.MAX_NUMBER_DIGITS,
     'and on the length limits');
}

console.log('=== nothing in the repo can reintroduce either format ===');
{
  // Walk the shipped source. These are the ways 12-hour time and ad-hoc
  // number formatting got in before, so they are the ways that are banned.
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|mjs|html)$/.test(e.name)) files.push(full);
    }
  };
  walk(path.join(root, 'src'));
  walk(path.join(root, 'bin'));

  const rel = (f) => path.relative(root, f);
  const hits = (re, skip = () => false) => files
    .filter((f) => !skip(rel(f)))
    .flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(re)].map((m) => `${rel(f)}: ${m[0].trim().slice(0, 60)}`));

  // `toLocale*Time/String` follows the reader's locale, which in most of the
  // world's English means AM/PM.
  const locale = hits(/\.toLocale(?:Time|Date)?String\s*\(/g);
  ok(locale.length === 0, `no locale-dependent date or time rendering${locale.length ? ` — ${locale.join('; ')}` : ''}`);

  // Only format.js may say hour12/h12, and only to explain why it does not.
  const twelve = hits(/hour12|['"]h12['"]|hourCycle:\s*['"]h11['"]/g, (f) => f === 'src/util/format.js');
  ok(twelve.length === 0, `no 12-hour clock anywhere${twelve.length ? ` — ${twelve.join('; ')}` : ''}`);

  // A bare 'AM'/'PM' literal, or the modulo that always precedes one.
  const ampm = hits(/(?:['"`]\s*(?:AM|PM|am|pm)\s*['"`])|(?:%\s*12\b)/g);
  ok(ampm.length === 0, `nothing builds a 12-hour clock by hand${ampm.length ? ` — ${ampm.join('; ')}` : ''}`);

  // A native time picker renders 12-hour wherever the browser's locale says so.
  ok(!/type=["']time["']|type=["']datetime-local["']/.test(appJs + html),
     'no native time picker, which would render 12-hour on a US-locale browser');
  ok(/<html lang="en-GB">/.test(html), 'and the page declares en-GB so any native widget is 24-hour too');

  // Phone numbers: a '+' glued onto an interpolation is the old habit.
  const adhoc = hits(/\+\$\{[^}]*(?:number|Number|num|digits|phone|Phone)[^}]*\}/g, (f) => f === 'src/util/format.js');
  ok(adhoc.length === 0, `no hand-rolled "+number" interpolation${adhoc.length ? ` — ${adhoc.join('; ')}` : ''}`);

  // Ad-hoc digit stripping: everything must go through numberDigits so a
  // leading 00 is handled the same way in every one of them.
  const strip = hits(/replace\(\/\[\^0-9\]\/g/g, (f) => f === 'src/util/format.js' || f === 'src/web/public/app.js');
  ok(strip.length === 0, `every number is normalised by the shared helper${strip.length ? ` — ${strip.join('; ')}` : ''}`);
  const appStrip = [...appJs.matchAll(/replace\(\/\[\^0-9\]\/g/g)];
  ok(appStrip.length === 1, `including in the panel, where the only one left is inside numberDigits (${appStrip.length})`);

  ok(files.length > 20, `scanned ${files.length} shipped files`);
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
