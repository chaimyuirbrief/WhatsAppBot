/* #rules command handling. Run: node test/rules.test.mjs */
import plugin from '../src/plugins/group-rules/index.js';
let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  ok   '+m)):(fail++,console.log('  FAIL '+m));};

function mock(rules='*RULES* text', cmd='#rules', extra={}) {
  const sent=[]; const deleted=[];
  const ctx={
    config:{ groupRules:{ rules, rulesCommand:cmd, ...extra } },
    bot:{ sendText: async(jid,text,opts)=>sent.push({jid,text}), react:async()=>{}, deleteChat: async(jid)=>deleted.push(jid) },
    log:{ info(){}, warn(){} }, store:{ get:()=>0, set(){}, push(){} },
  };
  return { ctx, sent, deleted };
}

console.log('=== #rules in a PM ===');
{
  const {ctx,sent}=mock();
  await plugin.onMessage({ text:'#rules', isGroup:false, chatJid:'u@s.whatsapp.net', senderJid:'u@s.whatsapp.net', fromMe:false, key:{} }, ctx);
  ok(sent.length===1 && sent[0].text==='*RULES* text','PM #rules sends the rules');
}
console.log('=== case-insensitive + trims ===');
{
  const {ctx,sent}=mock();
  await plugin.onMessage({ text:'  #RULES  ', isGroup:false, chatJid:'u', senderJid:'u', fromMe:false, key:{} }, ctx);
  ok(sent.length===1,'" #RULES " (caps/space) still triggers');
}
console.log('=== custom command ===');
{
  const {ctx,sent}=mock('r', '!rules');
  await plugin.onMessage({ text:'!rules', isGroup:false, chatJid:'u', senderJid:'u', fromMe:false, key:{} }, ctx);
  ok(sent.length===1,'honors a custom rulesCommand');
}
console.log('=== does NOT fire on other text / from the bot ===');
{
  const {ctx,sent}=mock();
  await plugin.onMessage({ text:'hello', isGroup:false, chatJid:'u', senderJid:'u', fromMe:false, key:{} }, ctx);
  ok(sent.length===0,'ordinary DM text does nothing');
  await plugin.onMessage({ text:'#rules', isGroup:false, chatJid:'u', senderJid:'u', fromMe:true, key:{} }, ctx);
  ok(sent.length===0,"ignores messages from the bot itself");
}
console.log('=== empty rules -> nothing sent ===');
{
  const {ctx,sent}=mock('');
  await plugin.onMessage({ text:'#rules', isGroup:false, chatJid:'u', senderJid:'u', fromMe:false, key:{} }, ctx);
  ok(sent.length===0,'no rules configured -> silent');
}
console.log('=== deletes the PM chat after sending (housekeeping) ===');
{
  const {ctx,sent,deleted}=mock();
  await plugin.onMessage({ text:'#rules', isGroup:false, chatJid:'u@s.whatsapp.net', senderJid:'u', fromMe:false, key:{id:'k'}, raw:{messageTimestamp:123} }, ctx);
  ok(sent.length===1 && deleted.length===1 && deleted[0]==='u@s.whatsapp.net','PM chat deleted after rules');
}
console.log('=== does NOT delete a GROUP chat ===');
{
  const {ctx,sent,deleted}=mock();
  await plugin.onMessage({ text:'#rules', isGroup:true, chatJid:'g@g.us', senderJid:'u', fromMe:false, key:{id:'k'}, raw:{} }, ctx);
  ok(sent.length===1 && deleted.length===0,'group #rules sends but does not delete the group');
}
console.log('=== respects the deleteChatAfterRules=false toggle ===');
{
  const {ctx,sent,deleted}=mock('*RULES*', '#rules', { deleteChatAfterRules:false });
  await plugin.onMessage({ text:'#rules', isGroup:false, chatJid:'u', senderJid:'u', fromMe:false, key:{id:'k'}, raw:{} }, ctx);
  ok(sent.length===1 && deleted.length===0,'toggle off -> chat kept');
}

console.log('\n'+'='.repeat(46)+'\n  '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
