/* Group-admin: number parsing, JID conversion, event capture. Run: node test/groupadmin.test.mjs */
import { WhatsAppBot } from '../src/core/bot.js';
let pass=0,fail=0;
const ok=(c,m)=>{c?(pass++,console.log(`  ok   ${m}`)):(fail++,console.log(`  FAIL ${m}`));};
// Pacing off by default here: these tests assert behaviour, not wall-clock.
// The blocks that DO test pacing set their own gaps explicitly.
const noPace = { jitterMs:0, groupSettingMs:0, descriptionMs:0, participantMs:0, crossGroupMs:0, revokeMs:0 };
const bot = new WhatsAppBot({ configStore:{ get:()=>({whatsapp:{pacing:noPace}}) }, dataDir:'/tmp' });

console.log('=== numberFromJid ===');
ok(bot.numberFromJid('17185551234@s.whatsapp.net')==='17185551234','phone JID -> number');
ok(bot.numberFromJid('17185551234:12@s.whatsapp.net')==='17185551234','strips device suffix');
ok(bot.numberFromJid('111222333@lid')===null,'@lid -> null (not a phone number)');
ok(bot.numberFromJid('bad')===null,'garbage -> null');

console.log('=== modifyParticipants converts + chunks + paces ===');
{
  const calls=[];
  bot.sock = { groupParticipantsUpdate: async (jid, jids, action)=>{ calls.push({jids,action}); return jids.map(j=>({jid:j,status:'200'})); } };
  bot.state='connected';
  bot.refreshGroups = async()=>[];  // stub
  // 7 numbers -> 2 chunks of 5 + 2
  const nums=['15551112222','16172223333','+1 (818) 333-4444','19994445555','12105556666','13106667777','14087778888'];
  const res = await bot.modifyParticipants('g@g.us', nums, 'remove');
  ok(calls.length===2,`chunked into ${calls.length} calls (5 + 2)`);
  ok(calls[0].jids.every(j=>j.endsWith('@s.whatsapp.net')),'plain numbers -> phone JIDs');
  ok(calls[0].jids.includes('18183334444@s.whatsapp.net'),'formatted number "+1 (818) 333-4444" normalized');
  ok(res.length===7,'returns a result per target');
  ok(calls[0].action==='remove','action passed through');

  // a full JID passes through untouched
  calls.length=0;
  await bot.modifyParticipants('g@g.us', ['999@lid'], 'promote');
  ok(calls[0].jids[0]==='999@lid','existing JID passed through unchanged');

  // invalid action rejected
  let threw=false;
  try { await bot.modifyParticipants('g@g.us',['1'],'nuke'); } catch { threw=true; }
  ok(threw,'invalid action rejected');
}

console.log('=== group-event emitted from participant updates ===');
{
  const events=[];
  bot.on('group-event', (e)=>events.push(e));
  bot.groupCache.set('g@g.us',{subject:'Test Group'});
  // simulate the handler body directly (the socket wiring is in start())
  const u={ id:'g@g.us', action:'remove', author:'17180001111@s.whatsapp.net', participants:['15559998888@s.whatsapp.net'] };
  bot.emit('group-event',{
    ts:Date.now(), groupJid:u.id, groupName:bot.groupCache.get(u.id)?.subject??u.id,
    action:u.action, actor:u.author, actorNumber:bot.numberFromJid(u.author),
    targets:u.participants.map(pj=>({jid:pj,number:bot.numberFromJid(pj)})),
  });
  const e=events[0];
  ok(e && e.action==='remove','event action');
  ok(e.groupName==='Test Group','group name resolved from cache');
  ok(e.actorNumber==='17180001111','actor number extracted');
  ok(e.targets[0].number==='15559998888','target number extracted');
}

console.log('=== setAllGroupsLocked paces + reports per group ===');
{
  const calls=[];
  bot.sock={ groupSettingUpdate: async(jid,setting)=>{ calls.push({jid,setting}); if(jid==='bad@g.us') throw new Error('not-authorized'); } };
  bot.state='connected';
  bot.groupCache=new Map([['a@g.us',{jid:'a@g.us',subject:'A'}],['bad@g.us',{jid:'bad@g.us',subject:'B'}]]);
  bot.groups=()=>[...bot.groupCache.values()];
  const res=await bot.setAllGroupsLocked(true,{paceMs:0});
  ok(calls.every(c=>c.setting==='announcement'),'lock sends announcement setting');
  ok(res.find(r=>r.jid==='a@g.us').ok,'admin group locked');
  ok(/not admin/.test(res.find(r=>r.jid==='bad@g.us').error),'non-admin group reports bot is not admin');
}

console.log('=== the default pace is 5s between groups, and it waits between them ===');
{
  ok(bot._lockdownPaceMs()===5000,'default pace is 5s per group');
  ok(bot._lockdownPaceMs(250)===250,'an explicit pace overrides the default');
  ok(bot._lockdownPaceMs(0)===0,'a caller may explicitly ask for no pacing');
  // A junk config value must never silently mean "fire everything at once" -
  // that is the flood the pacing exists to prevent. `null`, `''` and `false`
  // all coerce to 0, so the check is on the TYPE, not on Number(x).
  for (const bad of [null,'',-1,'nope',false,undefined,{},[]]) {
    bot.configStore={ get:()=>({ whatsapp:{pacing:noPace}, lockdown:{ paceMs:bad } }) };
    ok(bot._lockdownPaceMs()===5000,`config paceMs ${JSON.stringify(bad)} falls back to 5s, not to no pacing`);
  }
  // A real number is taken at face value, including a deliberate 0.
  bot.configStore={ get:()=>({ whatsapp:{pacing:noPace}, lockdown:{ paceMs:0 } }) };
  ok(bot._lockdownPaceMs()===0,'a deliberate numeric 0 in config is honoured');
  bot.configStore={ get:()=>({ whatsapp:{pacing:{...noPace,jitterMs:0}}, lockdown:{ paceMs:120 } }) };
  ok(bot._lockdownPaceMs()===120,'config paceMs is honoured');
  ok(bot._lockdownPaceMs(undefined)===120,'an absent override falls through to config');

  // Three groups, 120ms apart -> at least two gaps waited, and none after the
  // last group (which would only stall the caller).
  const at=[];
  let live=0;
  bot.sock={ groupSettingUpdate: async(jid)=>{ at.push({jid,t:Date.now(),inFlight:++live}); await new Promise(r=>setTimeout(r,5)); live--; } };
  bot.groupCache=new Map([['1@g.us',{jid:'1@g.us',subject:'One'}],['2@g.us',{jid:'2@g.us',subject:'Two'}],['3@g.us',{jid:'3@g.us',subject:'Three'}]]);
  bot.groups=()=>[...bot.groupCache.values()];
  const seen=[];
  const t0=Date.now();
  await bot.setAllGroupsLocked(true,{onProgress:(p)=>seen.push(p)});
  const elapsed=Date.now()-t0;
  const tail=Date.now()-at[2].t;    // time from the LAST group's call to returning
  ok(at.length===3,'every group was touched');
  ok(at.every(a=>a.inFlight===1),'strictly one group at a time — never two in flight');
  ok(elapsed>=240,`waited between groups (${elapsed}ms >= 2 x 120ms)`);
  // Measured off the last call rather than the total, so a reinstated trailing
  // sleep fails this outright instead of hiding inside a wall-clock budget.
  ok(tail<120,`no wait after the last group (returned ${tail}ms after its call, < the 120ms pace)`);
  ok(at[1].t-at[0].t>=120 && at[2].t-at[1].t>=120,'each gap is at least the configured pace');
  ok(seen[0].done===0 && seen[0].total===3,'progress opens with 0 of the total');
  ok(seen[seen.length-1].done===3,'progress ends on the last group');
  ok(seen[2].subject==='Two','progress names the group just done');
}

console.log('=== concurrent bulk runs are serialized, not interleaved ===');
{
  let live=0, maxLive=0;
  const order=[];
  bot.configStore={ get:()=>({ whatsapp:{pacing:noPace}, lockdown:{} }) };
  bot.sock={ groupSettingUpdate: async(jid,setting)=>{
    maxLive=Math.max(maxLive,++live);
    order.push(setting);
    await new Promise(r=>setTimeout(r,10));
    live--;
  } };
  bot.groupCache=new Map([['1@g.us',{jid:'1@g.us',subject:'One'}],['2@g.us',{jid:'2@g.us',subject:'Two'}]]);
  bot.groups=()=>[...bot.groupCache.values()];
  // A manual lock and a scheduled unlock a moment later must not interleave.
  await Promise.all([bot.setAllGroupsLocked(true,{paceMs:0}), bot.setAllGroupsLocked(false,{paceMs:0})]);
  ok(maxLive===1,'never more than one group setting change in flight');
  ok(order.join(',')==='announcement,announcement,not_announcement,not_announcement',
     'the lock run finishes every group before the unlock run starts');

  // A per-group failure is data, not an exception.
  bot.sock={ groupSettingUpdate: async()=>{ throw new Error('boom'); } };
  bot.groups=()=>[{jid:'1@g.us',subject:'One'}];
  let threw=false;
  try { await bot.setAllGroupsLocked(true,{paceMs:0}); } catch { threw=true; }
  ok(!threw,'a per-group failure is reported, not thrown');

  // A run that rejects outright must not poison the chain for the next one.
  bot.groups=()=>{ throw new Error('group cache exploded'); };
  let rejected=false;
  try { await bot.setAllGroupsLocked(true,{paceMs:0}); } catch { rejected=true; }
  ok(rejected,'a run that fails outright rejects to its caller');
  bot.sock={ groupSettingUpdate: async()=>{} };
  bot.groups=()=>[{jid:'1@g.us',subject:'One'}];
  const after=await bot.setAllGroupsLocked(true,{paceMs:0});
  ok(after.length===1 && after[0].ok,'a later run still goes through after a rejected one');
}

console.log('=== unlock skips always-locked groups ===');
{
  const calls=[];
  bot.configStore={ get:()=>({ whatsapp:{pacing:noPace}, lockdown:{ alwaysLocked:['keep@g.us'] } }) };
  bot.sock={ groupSettingUpdate: async(jid,setting)=>{ calls.push({jid,setting}); } };
  bot.state='connected';
  bot.groupCache=new Map([['open@g.us',{jid:'open@g.us',subject:'Open'}],['keep@g.us',{jid:'keep@g.us',subject:'Keep locked'}]]);
  bot.groups=()=>[...bot.groupCache.values()];
  const seen=[];
  const res=await bot.setAllGroupsLocked(false,{paceMs:0,onProgress:(p)=>seen.push(p)});   // unlock all
  ok(calls.length===1 && calls[0].jid==='open@g.us','only the normal group is unlocked');
  ok(res.find(r=>r.jid==='keep@g.us').skipped==='always locked','always-locked group is skipped on unlock');
  ok(seen[0].total===1,'a skipped group is not counted in the paced total');
  // but LOCK still touches everything
  calls.length=0;
  await bot.setAllGroupsLocked(true,{paceMs:0});
  ok(calls.length===2,'lock still applies to every group');
}

console.log('=== banFromAllGroups only touches groups the number is in ===');
{
  const removed=[];
  bot.sock={ groupParticipantsUpdate: async(jid,jids,action)=>{ removed.push({jid,action}); return jids.map(j=>({jid:j,status:'200'})); } };
  bot.refreshGroups=async()=>[];
  bot.groupCache=new Map([
    ['g1@g.us',{jid:'g1@g.us',subject:'G1',memberIds:new Set(),memberNumbers:new Set(['15551234567'])}],
    ['g2@g.us',{jid:'g2@g.us',subject:'G2',memberIds:new Set(),memberNumbers:new Set(['19998887777'])}],
  ]);
  bot.groups=()=>[...bot.groupCache.values()];
  const res=await bot.banFromAllGroups('15551234567');
  ok(res.length===1 && res[0].jid==='g1@g.us','removed only from the group they were in');
  ok(removed.length===1 && removed[0].action==='remove','one remove call, not on the other group');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
