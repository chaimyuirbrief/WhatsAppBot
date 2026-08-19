/* App-state key handling for chat deletion. Run: node test/appstate.test.mjs
   Regression: every #rules PM delete failed in production with
   "App state key not present!" — chatModify is encrypted with a key the phone
   shares during app-state sync, which never arrived (syncFullHistory: false). */
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const mkBot = ({ keyId = null, resync = null } = {}) => {
  const b = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  b.state = 'connected';
  b.calls = { chatModify: [], resync: 0 };
  b.sock = {
    authState: { creds: { myAppStateKeyId: keyId } },
    chatModify: async (mod, jid) => { b.calls.chatModify.push({ mod, jid }); },
    resyncAppState: async (collections, initial) => {
      b.calls.resync++;
      b.calls.lastResync = { collections, initial };
      if (resync === 'grant') b.sock.authState.creds.myAppStateKeyId = 'KEY123';
      if (resync === 'throw') throw new Error('sync failed');
    },
  };
  return b;
};

console.log('=== the happy path is unchanged ===');
{
  const bot = mkBot({ keyId: 'KEY123' });
  await bot.deleteChat('user@s.whatsapp.net', { key: { id: 'M1' }, messageTimestamp: 1700 });
  ok(bot.calls.chatModify.length === 1, 'chat deleted when the key is present');
  ok(bot.calls.chatModify[0].mod.delete === true, 'sends a delete modification');
  ok(bot.calls.chatModify[0].mod.lastMessages[0].key.id === 'M1', 'passes the last message key');
  ok(bot.calls.resync === 0, 'no resync needed when the key already exists');
}

console.log('=== missing key triggers a sync, then succeeds ===');
{
  const bot = mkBot({ keyId: null, resync: 'grant' });
  await bot.deleteChat('user@s.whatsapp.net');
  ok(bot.calls.resync === 1, 'asked the phone to sync app state');
  ok(bot.calls.lastResync.initial === true, 'requested an initial sync');
  ok(bot.calls.lastResync.collections.includes('regular_high'), 'covers the regular_high collection');
  ok(bot.calls.chatModify.length === 1, 'delete proceeds once the key arrives');
}

console.log('=== missing key that stays missing fails clearly ===');
{
  const bot = mkBot({ keyId: null });
  let err = null;
  try { await bot.deleteChat('user@s.whatsapp.net'); } catch (e) { err = e; }
  ok(!!err, 'throws rather than silently doing nothing');
  ok(/app-state key/i.test(err.message), `message names the real cause: "${err.message}"`);
  ok(bot.calls.chatModify.length === 0, 'never calls chatModify without the key');
}

console.log('=== a failing resync is not fatal ===');
{
  const bot = mkBot({ keyId: null, resync: 'throw' });
  let err = null;
  try { await bot.deleteChat('user@s.whatsapp.net'); } catch (e) { err = e; }
  ok(!!err && /app-state key/i.test(err.message), 'reports the key problem, not the raw sync error');
  ok(bot.calls.resync === 1, 'the sync was attempted');
}

console.log('=== the sync is attempted only once per connection ===');
{
  const bot = mkBot({ keyId: null });
  for (const _ of [1, 2, 3]) { try { await bot.deleteChat('u@s.whatsapp.net'); } catch {} }
  ok(bot.calls.resync === 1, 'three deletes -> a single resync, not one per attempt');
  // reconnecting resets it so a new session can try again
  bot._appStateSyncTried = false;
  try { await bot.deleteChat('u@s.whatsapp.net'); } catch {}
  ok(bot.calls.resync === 2, 'a fresh connection retries the sync');
}

console.log('=== rules replies still work when the delete fails ===');
{
  // The plugin must send the rules first and treat the cleanup as best-effort.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/plugins/group-rules/index.js', import.meta.url), 'utf8'));
  const block = src.match(/const reply = rulesReplyFor[\s\S]*?\n      \}/)[0];
  ok(block.indexOf('sendText') < block.indexOf('deleteChat'), 'rules are sent before the chat is deleted');
  ok(/catch \(err\) \{\s*ctx\.log\.warn\(`could not clear chat/.test(src), 'a failed delete is caught, never breaking the reply');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
