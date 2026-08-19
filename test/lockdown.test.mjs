/* Scheduled lockdown window + scheduler decision. Run: node test/lockdown.test.mjs */
import { lockWindow, isWithin, decide, LockScheduler, zonedToUtc } from '../src/core/lockdown.js';
let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  ok   '+m)):(fail++,console.log('  FAIL '+m));};

// Friday 18:00 New York for 17.5h -> Saturday 11:30.
const cfg = {
  enabled: true,
  timezone: 'America/New_York',
  windows: [{ id: 'w1', label: 'Weekend', day: 5, start: '18:00', durationMinutes: 1050 }],
  alwaysLocked: [],
};
const nyHour = (d) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(d));
const nyDow = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);

console.log('=== window ===');
{
  const win = lockWindow(new Date('2026-08-19T12:00:00Z'), cfg);
  ok(nyDow(win.lockAt) === 'Fri', 'locks Friday in the configured zone');
  ok(nyHour(win.lockAt) === 18, 'locks at the configured hour');
  ok(nyDow(win.unlockAt) === 'Sat', 'unlocks Saturday');
  ok((win.unlockAt - win.lockAt) === 1050 * 60000, 'window lasts exactly durationMinutes');
  ok(win.label === 'Weekend', 'window carries its label');
}
const mid = new Date('2026-08-21T23:40:00Z');   // Friday 19:40 NY
ok(isWithin(mid, lockWindow(mid, cfg)), 'Friday evening is inside the window');
ok(lockWindow(new Date(), { timezone: 'UTC', windows: [] }) === null, 'no windows configured -> null');
ok(lockWindow(new Date(), { timezone: 'UTC', windows: [{ day: 1, start: '09:00', durationMinutes: 60, enabled: false }] }) === null, 'a disabled window is ignored');

console.log('=== DST is handled in civil time, not by adding hours ===');
{
  // The clock jumps 02:00 -> 03:00 on 2026-03-08 in New York, so 02:30 never
  // happens that day. It must resolve forward, never backward into 01:30.
  const gap = { enabled: true, timezone: 'America/New_York', windows: [{ day: 0, start: '02:30', durationMinutes: 60 }] };
  const w = lockWindow(new Date('2026-03-08T05:00:00Z'), gap);
  ok(nyHour(w.lockAt) === 3, 'a start time inside a spring-forward gap shifts forward');

  // 01:30 happens twice on 2026-11-01; take the first (daylight-time) one.
  const dup = { enabled: true, timezone: 'America/New_York', windows: [{ day: 0, start: '01:30', durationMinutes: 60 }] };
  const w2 = lockWindow(new Date('2026-11-01T00:00:00Z'), dup);
  ok(w2.lockAt.toISOString() === '2026-11-01T05:30:00.000Z', 'a repeated hour resolves to the first occurrence');

  // The same wall-clock Friday lock is 22:00Z in summer and 23:00Z in winter.
  const summer = zonedToUtc({ y: 2026, m: 7, d: 3 }, '18:00', 'America/New_York');
  const winter = zonedToUtc({ y: 2026, m: 1, d: 2 }, '18:00', 'America/New_York');
  ok(new Date(summer).getUTCHours() === 22 && new Date(winter).getUTCHours() === 23, 'the same civil time maps to different UTC across DST');
}

console.log('=== overlapping windows merge into one lock ===');
{
  const ov = { enabled: true, timezone: 'UTC', windows: [
    { day: 5, start: '18:00', durationMinutes: 600 },   // Fri 18:00 -> Sat 04:00
    { day: 6, start: '02:00', durationMinutes: 600 },   // Sat 02:00 -> Sat 12:00
  ] };
  const w = lockWindow(new Date('2026-08-21T19:00:00Z'), ov);
  ok(w.lockAt.toISOString() === '2026-08-21T18:00:00.000Z', 'merged window starts at the earlier lock');
  ok(w.unlockAt.toISOString() === '2026-08-22T12:00:00.000Z', 'merged window ends at the later unlock');
  ok(w.key === w.lockAt.toISOString(), 'one key for the merged window, so an override covers all of it');
}

console.log('=== decide ===');
ok(decide(mid,cfg,{locked:false})==='lock','in-window unlocked -> lock');
ok(decide(mid,cfg,{locked:true,source:'schedule'})===null,'already locked -> nothing');
ok(decide(mid,cfg,{locked:false,overriddenWindowKey:lockWindow(mid,cfg).key})===null,'overridden window -> no re-lock');
const wd=new Date('2026-08-19T12:00:00Z');
ok(decide(wd,cfg,{locked:true,source:'schedule'})==='unlock','outside the window, schedule-lock -> unlock');
ok(decide(wd,cfg,{locked:true,source:'manual'})===null,'outside the window, manual lock -> leave it');
ok(decide(mid,{...cfg,enabled:false},{locked:false})===null,'disabled -> never acts');
ok(decide(mid,{...cfg,windows:[]},{locked:false})===null,'no windows -> never locks');

console.log('=== scheduler applies + persists ===');
{
  let state={locked:false,source:null,overriddenWindowKey:null};
  const acts=[];
  const sch=new LockScheduler({
    getConfig:()=>cfg, getState:()=>state, persist:(s)=>{state=s;},
    applyLock:async(src)=>{acts.push('lock:'+src);state={...state,locked:true,source:src};},
    applyUnlock:async(src,key)=>{acts.push('unlock:'+src);state={...state,locked:false,source:src,overriddenWindowKey:key??state.overriddenWindowKey};},
  });
  await sch.manualLock();
  ok(state.locked && state.source==='manual','manualLock locks with manual source');
  await sch.manualUnlock();
  ok(!state.locked && state.overriddenWindowKey!==null,'manualUnlock records the overridden window');

  const st = sch.status();
  ok(st.enabled===true && st.timezone==='America/New_York' && st.nextLockAt instanceof Date,'status reports the schedule');
}

console.log('\n'+'='.repeat(46)+'\n  '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
