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

  // Left unset it is worked out from how many groups there are. The gap
  // between two groups is NOT paceMs: the pacer adds up to jitterMs of
  // deliberate randomness to every one of them, so the budget has to assume
  // the worst case or the walk runs past candle lighting.
  const lead = (groups, extra = {}) => shabbosLeadMs({ paceMs: 5000, jitterMs: 2000, groupCount: groups, shabbos: {}, ...extra });
  ok(lead(60) === 8 * 60000, '60 groups at up to 7s each needs 8 minutes (7 minutes of walking plus slack)');
  ok(lead(200) === 25 * 60000, '200 groups needs 25');
  ok(lead(0) === 60000, 'with no groups it is still a minute, not zero');

  // THE POINT: the budget must cover the SLOWEST the walk can legitimately
  // run, not the average. Budgeting paceMs alone is how a large account ends
  // up with its last groups still open minutes into Shabbos.
  for (const groups of [10, 60, 150, 300, 800]) {
    const worstCaseWalk = groups * (5000 + 2000);
    ok(lead(groups) >= worstCaseWalk,
       `${groups} groups: the head start (${lead(groups) / 60000} min) covers the worst-case walk (${Math.ceil(worstCaseWalk / 60000)} min)`);
  }
  ok(lead(150, { jitterMs: 0 }) < lead(150),
     'turning the jitter off genuinely shortens the budget, so it is the jitter being accounted for and not a fudge factor');
  ok(shabbosLeadMs({ paceMs: 5000, groupCount: 60, shabbos: {} }) === 8 * 60000,
     'a missing jitter falls back to the documented 2s rather than to none');
  ok(shabbosLeadMs({ jitterMs: 2000, groupCount: 60, shabbos: {} }) === 8 * 60000,
     'and a missing pace to the documented 5s');
  ok(shabbosLeadMs({}) === 60000, 'an empty config does not throw');

  const auto = lockWindow(WEDNESDAY, cfgFor({ leadMinutes: null }, { groupCount: 60, jitterMs: 2000 }));
  ok(auto.lockAt.getTime() === w0.lockAt.getTime() - 8 * 60000, 'the automatic lead is applied to the window');
  ok(clock(auto.lockAt, 'America/New_York') === 'Fri 16:28', `so 60 groups start locking at 16:28 (${clock(auto.lockAt, 'America/New_York')})`);

  // A lead of 0 must be the admin's explicit choice, never the result of a
  // blank field or a bad value coercing to zero.
  for (const blank of [null, undefined, '', false, [], 'abc', NaN, -5]) {
    ok(lead(60, { shabbos: { leadMinutes: blank } }) === 8 * 60000,
       `leadMinutes ${JSON.stringify(blank)} means "work it out", not zero`);
  }
  ok(lead(60, { shabbos: { leadMinutes: 0 } }) === 0, 'but a deliberate 0 is honoured');
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

console.log('=== the window keeps ONE identity however the head start moves ===');
{
  // The head start is derived from the live group count, so lockAt moves
  // whenever a group is added, the process restarts before the first group
  // fetch lands, or an admin edits the pace. If the window's identity came
  // from lockAt, every one of those would mint a "new" window - and a new
  // window means the scheduler stops honouring an admin's manual unlock and
  // re-locks the groups in the middle of Shabbos.
  const at = (extra) => lockWindow(WEDNESDAY, cfgFor({ leadMinutes: null }, extra));
  const base = at({ groupCount: 60, jitterMs: 2000 });

  const moved = [
    ['no groups cached yet, as just after a restart', { groupCount: 0, jitterMs: 2000 }],
    ['one group joined', { groupCount: 61, jitterMs: 2000 }],
    ['one group left', { groupCount: 59, jitterMs: 2000 }],
    ['a much larger account', { groupCount: 400, jitterMs: 2000 }],
    ['the admin widened the pace', { groupCount: 60, jitterMs: 2000, paceMs: 9000 }],
    ['the admin changed the jitter', { groupCount: 60, jitterMs: 0 }],
  ];
  for (const [what, extra] of moved) {
    const w = at(extra);
    ok(w.key === base.key, `${what}: the key is unchanged (${w.key})`);
    ok(w.unlockAt.getTime() === base.unlockAt.getTime(), `${what}: and the unlock is untouched`);
  }
  // ...and the test is not vacuous: the lock time really does move underneath
  // that unchanged key.
  const lockTimes = new Set(moved.map(([, extra]) => at(extra).lockAt.getTime()));
  ok(lockTimes.size > 1, `the lock time itself takes ${lockTimes.size} different values across those changes`);
  ok(base.key === 'shabbos:2026-1-17', `the key names the stretch, not an instant (${base.key})`);

  // What that buys: the admin's unlock keeps applying for the whole stretch.
  const inside = new Date('2026-01-17T18:00:00Z');   // Saturday 13:00 New York
  const state = { locked: false, source: 'manual', overriddenWindowKey: base.key };
  for (const [what, extra] of moved) {
    const cfg = cfgFor({ leadMinutes: null }, extra);
    ok(decide(inside, cfg, state) === null,
       `${what}: an admin who unlocked by hand is NOT re-locked mid-Shabbos`);
  }
  // And an override from some other window still does not apply to this one.
  ok(decide(inside, cfgFor({ leadMinutes: null }, { groupCount: 60, jitterMs: 2000 }),
            { locked: false, overriddenWindowKey: 'shabbos:2026-1-10' }) === 'lock',
     'while last week\'s override does not hold this week open');

  // A weekly window keeps the identity it has always had, so an override
  // stored by an older version still matches after upgrading.
  const weekly = lockWindow(WEDNESDAY, cfgFor({ enabled: false }, {
    enabled: true,
    windows: [{ id: 'w', label: 'Quiet hours', day: 5, start: '18:00', durationMinutes: 240 }],
  }));
  ok(weekly.key === weekly.lockAt.toISOString(),
     'a weekly window is still keyed on its lock instant, which config alone decides');
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

console.log('=== a broken location stops the lock rather than moving it ===');
{
  // Clearing one digit of a latitude must not silently read the zmanim
  // somewhere else. Nothing is scheduled, and the panel says exactly why.
  const BROKEN_JM = { ...JERUSALEM, latitude: '' };
  const cfg = cfgFor({
    locations: [BROOKLYN, BROKEN_JM],
    start: { locationId: 'jm', zman: 'candleLighting', offsetMinutes: 0 },
    end: { locationId: 'jm', zman: 'tzais8.5', offsetMinutes: 0 },
  });
  ok(lockWindow(WEDNESDAY, cfg) === null, 'nothing is scheduled while the chosen place is unusable');
  ok(decide(FRI_EVENING, cfg, { locked: false }) === null, 'so nothing is locked at the wrong hour');

  const probs = shabbosStatus(cfg).problems;
  ok(probs.some((p) => /Jerusalem/.test(p) && /Latitude/i.test(p)),
     `the panel names the place and the reason ("${probs.find((p) => /Jerusalem/.test(p))}")`);
  ok(probs.some((p) => /NOT quietly read somewhere else/.test(p)),
     'and says out loud that it is not being read somewhere else instead');

  // Compare: the same config with Jerusalem intact really would lock at a
  // very different time, which is the error this prevents.
  const good = cfgFor({
    locations: [BROOKLYN, JERUSALEM],
    start: { locationId: 'jm', zman: 'candleLighting', offsetMinutes: 0 },
    end: { locationId: 'jm', zman: 'tzais8.5', offsetMinutes: 0 },
  });
  const bkOnly = cfgFor();
  const hours = Math.abs(lockWindow(WEDNESDAY, good).lockAt - lockWindow(WEDNESDAY, bkOnly).lockAt) / 3600000;
  ok(hours > 6, `falling back to the other city would have been a ${hours.toFixed(1)}-hour error`);
}

console.log('=== the preview shows the stretch the bot will actually run ===');
{
  // A stretch that begins near the far edge of the preview window used to be
  // emitted with its last day cut off, so the panel showed Pesach reopening
  // on Thursday night when the scheduler will hold it to Saturday.
  for (const today of ['2026-03-05', '2026-03-06', '2026-03-11']) {
    const now = new Date(`${today}T12:00:00Z`);
    const listed = upcomingShabbosWindows(now, cfgFor(), 28);
    const pesach = listed.find((w) => w.label.includes('Pesach'));
    ok(!!pesach, `${today}: Pesach is listed`);
    if (!pesach) continue;
    // What the scheduler itself will do for that same lock.
    const real = lockWindow(new Date(pesach.lockAt.getTime() + 60000), cfgFor());
    ok(pesach.unlockAt.getTime() === real.unlockAt.getTime(),
       `${today}: the previewed reopen matches the scheduler's (${clock(pesach.unlockAt, 'America/New_York')})`);
    ok(pesach.label === real.label, `${today}: and so does the label ("${pesach.label}")`);
  }

  // Every entry in a preview must agree with the scheduler, at any span.
  for (const span of [7, 14, 28, 60]) {
    const listed = upcomingShabbosWindows(WEDNESDAY, cfgFor(), span);
    const wrong = listed.filter((w) => {
      const real = lockWindow(new Date(w.lockAt.getTime() + 60000), cfgFor());
      return !real || real.unlockAt.getTime() !== w.unlockAt.getTime();
    });
    ok(wrong.length === 0,
       `a ${span}-day preview lists ${listed.length} locks and every reopen matches the scheduler${wrong.length ? ` — ${wrong.map((w) => w.label).join(', ')}` : ''}`);
  }
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
  ok(shabbosStatus(cfgFor({ leadMinutes: null }, { groupCount: 40, jitterMs: 2000 })).leadMinutes === 6,
     'an automatic lead is reported as the minutes it works out to');
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
