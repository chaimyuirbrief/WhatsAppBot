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
  await sch.manualLock().run.promise;
  ok(state.locked && state.source==='manual','manualLock locks with manual source');
  await sch.manualUnlock().run.promise;
  ok(!state.locked && state.overriddenWindowKey!==null,'manualUnlock records the overridden window');

  const st = sch.status();
  ok(st.enabled===true && st.timezone==='America/New_York' && st.nextLockAt instanceof Date,'status reports the schedule');
}

console.log('=== a paced run outlives the request, and only one runs at a time ===');
{
  // Applying a lock walks the groups seconds apart, so it is deliberately slow.
  let state={locked:false,source:null,overriddenWindowKey:null};
  const started=[];
  let release=null;
  // applyLock is called as (source, opts); applyUnlock as (source, key, opts).
  const slow=(src,...rest)=>new Promise((resolve)=>{
    const { onProgress } = rest[rest.length - 1] ?? {};
    started.push(src);
    onProgress?.({done:0,total:3});
    onProgress?.({done:1,total:3,subject:'One'});
    release=()=>{state={...state,locked:true,source:src};resolve();};
  });
  // No windows + enabled: `decide()` then depends only on the persisted state,
  // so the tick assertions below hold on every calendar day rather than only
  // on a Friday evening in New York.
  const tickCfg={ enabled:true, timezone:'UTC', windows:[] };
  const sch=new LockScheduler({
    getConfig:()=>tickCfg, getState:()=>state, persist:(s)=>{state=s;},
    applyLock:slow, applyUnlock:slow,
  });

  const first=sch.manualLock();
  ok(first.started===true,'the first lock starts a run');
  ok(state.locked===false,'manualLock returns before every group is done');
  await new Promise((r)=>setTimeout(r,0));   // let the run reach applyLock

  const mid=sch.status();
  ok(mid.run && mid.run.action==='lock' && mid.run.source==='manual','status reports the run in flight');
  ok(mid.run.done===1 && mid.run.total===3 && mid.run.current==='One','status reports progress through the groups');

  const second=sch.manualUnlock();
  ok(second.started===false,'a second run is refused while one is walking the groups');
  ok(started.length===1,'the refused run never touched WhatsApp');

  // The scheduled tick must not pile on top of a run either. State is set so
  // decide() definitely wants to act — outside any window and locked by the
  // schedule — which is what makes the guard, not decide(), the thing tested.
  state={...state,locked:true,source:'schedule'};
  await sch.tick();
  ok(started.length===1,'a scheduler tick is a no-op while a run is in flight');

  release();
  await first.run.promise;
  ok(sch.status().run===null,'the run clears when it finishes');
  ok(sch.status().lastRun?.action==='lock' && sch.status().lastRun.finishedAt,'the finished run is kept as lastRun');

  // ...and with the way clear, that very same tick does start a run — so the
  // assertion above is about the guard rather than about decide() being idle.
  state={locked:true,source:'schedule',overriddenWindowKey:null};
  const ticked=sch.tick();
  await new Promise((r)=>setTimeout(r,0));
  ok(started.length===2,'once the run has finished, the same tick does act');
  ok(started[1]==='schedule','the tick acts as the schedule, not as an admin');
  release();
  await ticked;

  // A fresh manual request also gets through now, with its opts intact.
  const third=sch.manualUnlock();
  ok(third.started===true,'a new run starts once the previous one finished');
  await new Promise((r)=>setTimeout(r,0));   // let it reach applyUnlock
  release();
  await third.run.promise;
  ok(third.run.error===null,'the unlock ran cleanly — applyUnlock got its progress callback');
  ok(started[2]==='manual','the unlock ran as a manual action');
}

console.log('=== a failing run is reported and does not wedge the scheduler ===');
{
  let state={locked:false,source:null,overriddenWindowKey:null};
  const sch=new LockScheduler({
    getConfig:()=>cfg, getState:()=>state, persist:(s)=>{state=s;},
    applyLock:async()=>{throw new Error('connection closed');},
    applyUnlock:async()=>{},
  });
  await sch.manualLock().run.promise;
  ok(sch.status().run===null,'a failed run clears');
  ok(sch.status().lastRun?.error==='connection closed','the failure is reported in status');
  ok(sch.manualUnlock().started===true,'the scheduler still accepts work after a failure');
}

console.log('\n'+'='.repeat(46)+'\n  '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
