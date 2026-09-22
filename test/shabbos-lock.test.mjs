/* The automatic Shabbos / Yom Tov lock as the scheduler sees it: where the
   window falls, how early the walk has to start, the two-location setup, and
   what happens when it is only half configured.
   Run: node test/shabbos-lock.test.mjs */
import {
  lockWindow, isWithin, decide, shabbosLeadMs, shabbosStatus,
  upcomingShabbosWindows, nextFridayIn, LockScheduler,
} from '../src/core/lockdown.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const BROOKLYN = { id: 'bk', name: 'Brooklyn', latitude: 40.6329, longitude: -73.9949, elevation: 15, timezone: 'America/New_York' };
const JERUSALEM = { id: 'jm', name: 'Jerusalem', latitude: 31.7683, longitude: 35.2137, elevation: 754, timezone: 'Asia/Jerusalem', candleOffsetMinutes: 40 };

/** A wall clock reading in a named zone: "Fri 16:36". */
const clock = (d, tz) => new Intl.DateTimeFormat('en-GB', {
  timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(d));

/** The schedule as an admin would set it up: one place, both ends. */
const cfgFor = (shabbos = {}, rest = {}) => ({
  enabled: false,                 // the weekly windows are off; this is the Shabbos lock alone
  timezone: 'America/New_York',
  windows: [],
  paceMs: 5000,
  alwaysLocked: [],
  shabbos: {
    enabled: true,
    includeYomTov: true,
    inIsrael: false,
    locations: [BROOKLYN],
    start: { locationId: 'bk', zman: 'candleLighting', offsetMinutes: 0 },
    end: { locationId: 'bk', zman: 'tzais8.5', offsetMinutes: 0 },
    leadMinutes: 0,
    ...shabbos,
  },
  ...rest,
});

const FRI_EVENING = new Date('2026-01-16T22:00:00Z');   // Friday 17:00 New York
const WEDNESDAY = new Date('2026-01-14T17:00:00Z');     // Wednesday noon New York

console.log('=== the window sits between candle lighting and tzais ===');
{
  const w = lockWindow(WEDNESDAY, cfgFor());
  ok(clock(w.lockAt, 'America/New_York') === 'Fri 16:36', `locks at Friday candle lighting (${clock(w.lockAt, 'America/New_York')})`);
  ok(clock(w.unlockAt, 'America/New_York') === 'Sat 17:39', `unlocks at Saturday tzais 8.5° (${clock(w.unlockAt, 'America/New_York')})`);
  ok(w.label === 'Shabbos', 'and says what it is');
  ok(!isWithin(WEDNESDAY, w), 'Wednesday is outside it');
  ok(isWithin(FRI_EVENING, lockWindow(FRI_EVENING, cfgFor())), 'Friday evening is inside it');
  ok(!isWithin(new Date('2026-01-17T23:30:00Z'), lockWindow(new Date('2026-01-17T23:30:00Z'), cfgFor())),
     'Saturday 18:30, after tzais, is outside it again');

  // The window reports the zmanim behind it, so the portal explains itself.
  ok(w.zmanim.start.location === 'Brooklyn' && w.zmanim.start.zman === 'candleLighting', 'the window carries where and what it locked on');
  ok(w.zmanim.end.zman === 'tzais8.5', 'and what it will unlock on');
}

console.log('=== the walk starts early enough to FINISH by candle lighting ===');
{
  // Locking is deliberately slow - one group every 5 seconds - so a lock that
  // begins at candle lighting ends minutes after it. This is the whole reason
  // the lead time exists.
  const w0 = lockWindow(WEDNESDAY, cfgFor({ leadMinutes: 0 }));
  const w10 = lockWindow(WEDNESDAY, cfgFor({ leadMinutes: 10 }));
  ok(w10.lockAt.getTime() === w0.lockAt.getTime() - 10 * 60000, 'a 10-minute lead opens the window 10 minutes earlier');
  ok(w10.unlockAt.getTime() === w0.unlockAt.getTime(), 'and leaves the unlock exactly where the zman is');
  ok(clock(w10.zmanim.start.at, 'America/New_York') === 'Fri 16:36', 'candle lighting itself is still reported unshifted');
  ok(w10.zmanim.leadMs === 10 * 60000, 'the lead is reported so the portal can explain the early start');

  // Left unset it is worked out from how many groups there are.
  ok(shabbosLeadMs({ paceMs: 5000, groupCount: 60, shabbos: {} }) === 6 * 60000,
     '60 groups at 5s each needs 6 minutes (5 minutes of walking plus slack)');
  ok(shabbosLeadMs({ paceMs: 5000, groupCount: 200, shabbos: {} }) === 18 * 60000, '200 groups needs 18');
  ok(shabbosLeadMs({ paceMs: 5000, groupCount: 0, shabbos: {} }) === 60000, 'with no groups it is still a minute, not zero');
  ok(shabbosLeadMs({ groupCount: 60, shabbos: {} }) === 6 * 60000, 'a missing pace falls back to the documented 5s');
  ok(shabbosLeadMs({}) === 60000, 'and an empty config does not throw');

  const auto = lockWindow(WEDNESDAY, cfgFor({ leadMinutes: null }, { groupCount: 60 }));
  ok(auto.lockAt.getTime() === w0.lockAt.getTime() - 6 * 60000, 'the automatic lead is applied to the window');
  ok(clock(auto.lockAt, 'America/New_York') === 'Fri 16:30', `so 60 groups start locking at 16:30 (${clock(auto.lockAt, 'America/New_York')})`);

  // A lead of 0 must be the admin's explicit choice, never the result of a
  // blank field or a bad value coercing to zero.
  for (const blank of [null, undefined, '', false, [], 'abc', NaN, -5]) {
    const got = shabbosLeadMs({ paceMs: 5000, groupCount: 60, shabbos: { leadMinutes: blank } });
    ok(got === 6 * 60000, `leadMinutes ${JSON.stringify(blank)} means "work it out", not zero`);
  }
  ok(shabbosLeadMs({ paceMs: 5000, groupCount: 60, shabbos: { leadMinutes: 0 } }) === 0,
     'but a deliberate 0 is honoured');
}

console.log('=== lock on one city, unlock on another ===');
{
  // The asked-for setup: candle lighting where the groups are, Havdalah on a
  // stricter clock somewhere else.
  const cfg = cfgFor({
    locations: [BROOKLYN, JERUSALEM],
    start: { locationId: 'bk', zman: 'candleLighting', offsetMinutes: 0 },
    end: { locationId: 'jm', zman: 'tzais72', offsetMinutes: 0 },
  });
  const w = lockWindow(WEDNESDAY, cfg);
  ok(clock(w.lockAt, 'America/New_York') === 'Fri 16:36', 'still locks on Brooklyn candle lighting');
  ok(clock(w.unlockAt, 'Asia/Jerusalem') === 'Sat 18:11',
     `and unlocks on Jerusalem's tzais 72 (${clock(w.unlockAt, 'Asia/Jerusalem')} there)`);
  ok(w.zmanim.start.location === 'Brooklyn' && w.zmanim.end.location === 'Jerusalem', 'both ends name their own place');
  ok(w.zmanim.start.timezone === 'America/New_York' && w.zmanim.end.timezone === 'Asia/Jerusalem',
     'and their own zone, so the portal shows each on the right clock');

  // Jerusalem is seven hours ahead, so its Havdalah is in the middle of
  // Brooklyn's Shabbos afternoon - the groups reopen while it is still
  // Shabbos there. Odd, but it is what was asked for, and it is honoured.
  ok(w.unlockAt.getTime() < lockWindow(WEDNESDAY, cfgFor()).unlockAt.getTime(),
     'an eastward unlock genuinely comes earlier, and is not quietly corrected');

  // Honoured, but said out loud: nobody should find this out by discovering
  // the groups open on Shabbos afternoon.
  const warn = shabbosStatus(cfg, w).problems;
  ok(warn.some((p) => /still Shabbos there/.test(p)),
     'the panel warns that an eastward unlock reopens the groups mid-Shabbos');
  ok(warn.some((p) => /hours before/.test(p)), `and says by how much ("${warn.find((p) => /hours before/.test(p))?.slice(0, 90)}…")`);
  ok(w.zmanim.endAtStartLocation > w.zmanim.end.at, 'because the same zman is also measured where the groups are');

  // One place for both ends is the ordinary setup and is never warned about.
  ok(shabbosStatus(cfgFor(), lockWindow(WEDNESDAY, cfgFor())).problems.length === 0,
     'a single-location schedule is not nagged about');
  ok(lockWindow(WEDNESDAY, cfgFor()).zmanim.endAtStartLocation === null,
     'and does not bother measuring a second time');

  // Westward is the conservative direction and needs no warning.
  const westward = cfgFor({
    locations: [JERUSALEM, BROOKLYN],
    start: { locationId: 'jm', zman: 'candleLighting', offsetMinutes: 0 },
    end: { locationId: 'bk', zman: 'tzais8.5', offsetMinutes: 0 },
  });
  ok(shabbosStatus(westward, lockWindow(WEDNESDAY, westward)).problems.length === 0,
     'unlocking on a WESTWARD city keeps the groups shut longer, which needs no warning');

  // An offset on either end moves only that end.
  const shifted = lockWindow(WEDNESDAY, cfgFor({
    locations: [BROOKLYN, JERUSALEM],
    start: { locationId: 'bk', zman: 'candleLighting', offsetMinutes: -5 },
    end: { locationId: 'jm', zman: 'tzais72', offsetMinutes: 15 },
  }));
  ok(shifted.lockAt.getTime() === w.lockAt.getTime() - 5 * 60000, 'the start offset moves the lock');
  ok(shifted.unlockAt.getTime() === w.unlockAt.getTime() + 15 * 60000, 'the end offset moves the unlock');
}

console.log('=== yom tov running into Shabbos is ONE lock ===');
{
  // Pesach 5786 in the diaspora: yom tov Thursday 2 April and Friday the 3rd,
  // then Shabbos the 4th. The groups must NOT reopen at nightfall in between.
  const erev = new Date('2026-04-01T12:00:00Z');   // Wednesday, erev Pesach
  const w = lockWindow(erev, cfgFor());
  ok(clock(w.lockAt, 'America/New_York') === 'Wed 19:02',
     `locks on Wednesday, erev Pesach (${clock(w.lockAt, 'America/New_York')})`);
  ok(clock(w.unlockAt, 'America/New_York') === 'Sat 20:05',
     `and does not reopen until Saturday night (${clock(w.unlockAt, 'America/New_York')})`);
  ok(w.label.includes('Pesach') && w.label.includes('Shabbos'), `labelled for both (\"${w.label}\")`);
  ok((w.unlockAt - w.lockAt) / 3600000 > 70, 'which is one continuous lock of more than 70 hours');

  // Nightfall on the first day of yom tov is still inside it.
  const thursdayNight = new Date('2026-04-03T01:00:00Z');   // Thursday 21:00 New York
  ok(isWithin(thursdayNight, lockWindow(thursdayNight, cfgFor())), 'Thursday night, between the two days, stays locked');
  ok(lockWindow(thursdayNight, cfgFor()).key === w.key,
     'and it is the SAME window - so an admin who unlocked it by hand is not re-locked an hour later');

  // In Israel the same days are three separate locks.
  const israel = cfgFor({ inIsrael: true, locations: [JERUSALEM], start: { locationId: 'jm', zman: 'candleLighting' }, end: { locationId: 'jm', zman: 'tzais8.5' } });
  const iw = lockWindow(erev, israel);
  ok((iw.unlockAt - iw.lockAt) / 3600000 < 30, 'in Israel the first day of Pesach is a single lock, not three days');
  ok(iw.label === 'Pesach', 'labelled just Pesach');

  // With yom tov switched off, Pesach is ignored and only the Shabbos locks.
  const noYT = lockWindow(erev, cfgFor({ includeYomTov: false }));
  ok(noYT.label === 'Shabbos', 'with Yom Tov off, the next lock is the Shabbos');
  ok(clock(noYT.lockAt, 'America/New_York') === 'Fri 19:04', `starting Friday afternoon (${clock(noYT.lockAt, 'America/New_York')})`);
}

console.log('=== two switches, neither of which is a trap ===');
{
  const shabbosOnly = cfgFor();                         // enabled:false, shabbos on
  const state = { locked: false, source: null, overriddenWindowKey: null };
  ok(decide(FRI_EVENING, shabbosOnly, state) === 'lock',
     'the Shabbos lock works on its own, without the weekly schedule being on too');
  ok(decide(WEDNESDAY, shabbosOnly, { ...state, locked: true, source: 'schedule' }) === 'unlock',
     'and unlocks outside the window like any other schedule-driven lock');

  const bothOff = cfgFor({ enabled: false });
  ok(decide(FRI_EVENING, bothOff, state) === null, 'with both switches off, nothing happens');
  ok(lockWindow(FRI_EVENING, bothOff) === null, 'and no window is even offered');

  // The weekly windows must stay gated on their own switch.
  const weeklyOff = cfgFor({ enabled: false }, {
    enabled: false,
    windows: [{ id: 'w', label: 'Quiet hours', day: 3, start: '09:00', durationMinutes: 600 }],
  });
  ok(lockWindow(new Date('2026-01-14T13:00:00Z'), weeklyOff) === null,
     'a weekly window is ignored while the weekly schedule is off');
  const weeklyOn = { ...weeklyOff, enabled: true };
  ok(lockWindow(new Date('2026-01-14T13:00:00Z'), weeklyOn)?.label === 'Quiet hours',
     'and honoured once it is on');
}

console.log('=== a weekly window overlapping Shabbos is merged, not fought over ===');
{
  // Friday 16:00 New York for four hours - it starts before candle lighting
  // and ends during Shabbos.
  const cfg = cfgFor({}, {
    enabled: true,
    windows: [{ id: 'w', label: 'Friday early', day: 5, start: '16:00', durationMinutes: 240 }],
  });
  const w = lockWindow(WEDNESDAY, cfg);
  ok(clock(w.lockAt, 'America/New_York') === 'Fri 16:00', 'the lock starts at the earlier of the two');
  ok(clock(w.unlockAt, 'America/New_York') === 'Sat 17:39', 'and runs through to tzais, not to 20:00');
  ok(w.label.includes('Friday early') && w.label.includes('Shabbos'), `the merged window names both (\"${w.label}\")`);
  ok(w.zmanim?.end?.zman === 'tzais8.5', 'and the unlock is still the zman, so the portal explains it correctly');
}

console.log('=== half-configured does nothing, and says why ===');
{
  const none = cfgFor({ locations: [] });
  ok(lockWindow(FRI_EVENING, none) === null, 'no locations, no window');
  ok(decide(FRI_EVENING, none, { locked: false }) === null, 'and nothing is locked');
  ok(shabbosStatus(none).problems.some((p) => /no usable location/i.test(p)),
     'the panel is told, in those words, that no location has been entered');

  const bad = cfgFor({ locations: [{ name: 'Somewhere' }] });
  ok(lockWindow(FRI_EVENING, bad) === null, 'an unusable location is not read as 0,0');
  ok(shabbosStatus(bad).problems.length > 0, 'and is reported');

  const ambiguous = cfgFor({ locations: [BROOKLYN, JERUSALEM], start: { locationId: '' }, end: { locationId: '' } });
  ok(lockWindow(FRI_EVENING, ambiguous) === null, 'two locations and no pick is not guessed at');
  ok(shabbosStatus(ambiguous).problems.some((p) => /more than one location/i.test(p) && /pick/i.test(p)),
     'and, when there are two, told to pick which end reads which — a different message, because it is a different mistake');
  ok(!shabbosStatus(ambiguous).problems.some((p) => /no usable location/i.test(p)),
     'not the "nothing entered" one');

  // An end that lands before its own start would be a lock with no way out of
  // it. Reaching that takes an absurd offset - the two zmanim are a day apart
  // - but an offset box an admin can type into is exactly where absurd values
  // come from, so the guard is real.
  const inverted = cfgFor({
    start: { locationId: 'bk', zman: 'candleLighting', offsetMinutes: 2000 },
    end: { locationId: 'bk', zman: 'tzais8.5', offsetMinutes: 0 },
  });
  ok(lockWindow(FRI_EVENING, inverted) === null, 'an unlock earlier than its own lock is skipped, not applied');
  ok(decide(FRI_EVENING, inverted, { locked: false }) === null, 'so nothing is locked with no unlock in sight');

  // Far north in summer the sun never gets 8.5° below the horizon, so the
  // chosen zman has no answer and an approximation from sunset is used. The
  // lock still happens - dropping it would be the worse failure - but the
  // panel has to say the minute is approximate.
  const TROMSO = { id: 'tr', name: 'Tromso', latitude: 69.65, longitude: 18.96, elevation: 0, timezone: 'Europe/Oslo' };
  const arctic = cfgFor({
    locations: [TROMSO],
    start: { locationId: 'tr', zman: 'candleLighting', offsetMinutes: 0 },
    end: { locationId: 'tr', zman: 'tzais8.5', offsetMinutes: 0 },
  });
  const arcticWin = lockWindow(new Date('2026-08-12T12:00:00Z'), arctic);
  ok(arcticWin !== null, 'a Shabbos in the Arctic summer is still locked');
  ok(arcticWin.zmanim.end.fallback === true, 'with the unlock marked as an approximation');
  ok(shabbosStatus(arctic, arcticWin).problems.some((p) => /approximation|approximate/i.test(p)),
     'and the panel is told so, rather than showing a confident wrong minute');
  ok(shabbosStatus(cfgFor(), lockWindow(WEDNESDAY, cfgFor())).problems.length === 0,
     'while an ordinary latitude is not warned about');

  // Switched off, nothing is reported as a problem and nothing is scheduled.
  const off = cfgFor({ enabled: false, locations: [] });
  ok(shabbosStatus(off).problems.length === 0, 'a switched-off Shabbos lock is not nagged about');
  ok(shabbosStatus(off).enabled === false, 'and reports itself off');
}

console.log('=== what the portal is told ===');
{
  const cfg = cfgFor({ locations: [BROOKLYN, JERUSALEM], end: { locationId: 'jm', zman: 'tzais72', offsetMinutes: 5 } }, { groupCount: 40 });
  const st = shabbosStatus(cfg, lockWindow(WEDNESDAY, cfg));
  ok(st.enabled === true && st.includeYomTov === true && st.inIsrael === false, 'the switches come through');
  ok(st.start.location === 'Brooklyn' && st.start.zmanLabel.includes('Candle'), 'the start end is described in words');
  ok(st.end.location === 'Jerusalem' && st.end.offsetMinutes === 5, 'so is the other end, with its offset');
  ok(st.start.candleOffsetMinutes === 18 && st.end.candleOffsetMinutes === 40, "each place's own candle-lighting custom is reported");
  ok(st.leadMinutes === 0, 'an explicit lead of 0 is reported as 0');
  ok(shabbosStatus(cfgFor({ leadMinutes: null }, { groupCount: 40 })).leadMinutes === 5, 'an automatic lead is reported as the minutes it works out to');
  ok(st.lockBy instanceof Date && st.reopenAt instanceof Date, 'and the two minutes it is aiming at');
  ok(st.locationCount === 2, 'the number of usable locations is reported');

  // The scheduler's own status carries all of it.
  const sch = new LockScheduler({
    getConfig: () => cfg, getState: () => ({ locked: false }), persist: () => {},
    applyLock: async () => {}, applyUnlock: async () => {},
  });
  const full = sch.status();
  ok(full.shabbos?.enabled === true, 'status() includes the Shabbos block');
  ok(full.windowLabel === 'Shabbos' || full.windowLabel?.includes('Shabbos'), 'and the window label the panel shows');
}

console.log('=== the preview the portal lists ===');
{
  // The preview works while the feature is still off, which is the whole
  // point - nobody should have to switch it on to see what it would do.
  const off = cfgFor({ enabled: false });
  const list = upcomingShabbosWindows(WEDNESDAY, off, 28);
  ok(list.length >= 4, `four weeks ahead lists ${list.length} locks even though the feature is off`);
  ok(list[0].label === 'Shabbos' && list[0].lockAt instanceof Date, 'each entry is a labelled window');
  ok(list[0].start.location === 'Brooklyn' && typeof list[0].start.zmanLabel === 'string', 'with both ends described');
  ok(list.every((w, i) => i === 0 || w.lockAt >= list[i - 1].lockAt), 'in order');
  ok(list.every((w) => w.unlockAt > WEDNESDAY), 'and none already finished');
  ok(upcomingShabbosWindows(WEDNESDAY, off, 7).length <= 2, 'a shorter span lists fewer');
  ok(upcomingShabbosWindows(WEDNESDAY, cfgFor({ locations: [] }), 28).length === 0, 'nothing to preview without a location');
  ok(upcomingShabbosWindows(WEDNESDAY, {}, 28).length === 0, 'nor with no Shabbos config at all');

  // A stretch already under way is listed from its real beginning.
  const duringPesach = new Date('2026-04-03T01:00:00Z');
  const first = upcomingShabbosWindows(duringPesach, cfgFor(), 28)[0];
  ok(clock(first.lockAt, 'America/New_York') === 'Wed 19:02',
     `mid-yom-tov, the current lock is still shown from erev Pesach (${clock(first.lockAt, 'America/New_York')})`);
}

console.log('=== the default date for a "what are the times here?" check ===');
{
  const fri = nextFridayIn('America/New_York', new Date('2026-01-14T17:00:00Z'));   // a Wednesday
  ok(JSON.stringify(fri) === '{"y":2026,"m":1,"d":16}', 'from Wednesday, the coming Friday');
  const onFriday = nextFridayIn('America/New_York', new Date('2026-01-16T17:00:00Z'));
  ok(JSON.stringify(onFriday) === '{"y":2026,"m":1,"d":16}', 'on a Friday, today');
  const sat = nextFridayIn('America/New_York', new Date('2026-01-17T17:00:00Z'));
  ok(JSON.stringify(sat) === '{"y":2026,"m":1,"d":23}', 'on Saturday, the following Friday');
  // Late Friday night in New York is already Saturday in Jerusalem.
  ok(JSON.stringify(nextFridayIn('Asia/Jerusalem', new Date('2026-01-17T03:00:00Z'))) === '{"y":2026,"m":1,"d":23}',
     'read in the zone asked for, not the server\'s');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
