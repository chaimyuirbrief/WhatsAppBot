/* Group membership + @mention resolution (LID-aware). Run: node test/notify.test.mjs */
import { WhatsAppBot } from '../src/core/bot.js';
let pass=0,fail=0;
const ok=(c,m)=>{c?(pass++,console.log(`  ok   ${m}`)):(fail++,console.log(`  FAIL ${m}`));};

const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp:{} }) }, dataDir: '/tmp' });
// Seed a group cache like refreshGroups would build it.
bot.groupCache.set('notify@g.us', {
  jid:'notify@g.us', subject:'Notifications',
  memberIds: new Set(['111222333@lid', '17185551234@s.whatsapp.net']),
  memberNumbers: new Set(['17185551234', '19995550000']),
});

console.log('=== membership by phone number ===');
{
  const r = bot.groupMemberInfo('notify@g.us', { number:'17185551234', jid:'999@lid' });
  ok(r.isMember,'member matched by phone number');
  ok(r.mentionJid==='17185551234@s.whatsapp.net','mentions the phone JID for a clean @number tag');
  ok(r.mentionText==='17185551234','mention text is the bare number');
}

console.log('=== membership by LID (number not in the roster) ===');
{
  const r = bot.groupMemberInfo('notify@g.us', { number:'15550009999', jid:'111222333@lid' });
  ok(r.isMember,'member matched by LID even when the number is not listed');
}

console.log('=== membership by phoneNumber-derived roster entry ===');
{
  const r = bot.groupMemberInfo('notify@g.us', { number:'19995550000', jid:'abc@lid' });
  ok(r.isMember,'member matched by a number derived from participant metadata');
}

console.log('=== non-member -> no tag ===');
{
  const r = bot.groupMemberInfo('notify@g.us', { number:'14045551111', jid:'nomatch@lid' });
  ok(!r.isMember,'not a member');
  ok(r.mentionJid==='14045551111@s.whatsapp.net','still returns a mention JID (unused when not a member)');
}

console.log('=== unknown group -> not a member ===');
ok(bot.groupMemberInfo('missing@g.us',{number:'17185551234'}).isMember===false,'unknown group is never a member');

console.log('=== groups() does not leak internal Sets to the UI ===');
{
  const g = bot.groups().find((x)=>x.jid==='notify@g.us');
  ok(g && !('memberIds' in g) && !('memberNumbers' in g),'memberIds/memberNumbers stripped from public view');
}

console.log('=== the announcer honors the no-tag opt-out ===');
{
  const { Announcer } = await import('../src/core/announce.js');
  function announcerWith(noTag) {
    const sent = [];
    const cfg = { group: 'n@g.us', tagActor: true, events: {}, noTag };
    const bot = {
      isConnected: () => true,
      groupMemberInfo: () => ({ isMember: true, mentionJid: '15551234567@s.whatsapp.net', mentionText: '15551234567' }),
      sendText: async (jid, body, opts) => sent.push({ body, mentions: opts?.mentions ?? null }),
    };
    return { sent, announcer: new Announcer({ bot, getConfig: () => cfg, log: { info(){}, warn(){} } }) };
  }
  const who = { number: '15551234567', jid: 'x@lid' };

  let w = announcerWith([]);
  await w.announcer.post('remove', 'was removed', who);
  ok(w.sent[0].mentions && w.sent[0].body.startsWith('@15551234567'), 'member with empty no-tag list IS tagged');

  w = announcerWith(['15551234567']);
  await w.announcer.post('remove', 'was removed', who);
  ok(!w.sent[0].mentions && !w.sent[0].body.startsWith('@'), 'muted number is NOT tagged (plain message)');
  ok(w.sent[0].body === 'was removed', 'muted still receives the update, just no ping');

  w = announcerWith(['+1 (555) 123-4567']);   // formatted entry still matches
  await w.announcer.post('remove', 'was removed', who);
  ok(!w.sent[0].mentions, 'formatted no-tag entry normalizes and matches');

  w = announcerWith(['19998887777']);          // different number not muted
  await w.announcer.post('remove', 'was removed', who);
  ok(!!w.sent[0].mentions, 'a different muted number does not affect this person');

  // An event switched off in config must not post at all.
  const sent = [];
  const off = new Announcer({
    bot: { isConnected: () => true, groupMemberInfo: () => ({}), sendText: async (j, b) => sent.push(b) },
    getConfig: () => ({ group: 'n@g.us', events: { remove: false } }),
    log: { info(){}, warn(){} },
  });
  await off.post('remove', 'was removed', who);
  ok(sent.length === 0, 'an event disabled in config posts nothing');

  // No announcements group configured -> silent.
  const sent2 = [];
  const nogroup = new Announcer({
    bot: { isConnected: () => true, groupMemberInfo: () => ({}), sendText: async (j, b) => sent2.push(b) },
    getConfig: () => ({ group: '' }),
    log: { info(){}, warn(){} },
  });
  await nogroup.post('remove', 'was removed', who);
  ok(sent2.length === 0, 'no announcements group configured -> nothing sent');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
