/* Auto-moderation rule decisions. Run: node test/enforcement.test.mjs */
import { checkMessage, containsLink, violationNotice } from '../src/plugins/moderation/enforcement.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const cfg = {
  enabled: true,
  groups: ['g@g.us'],
  exemptAdmins: true,
  deleteMedia: true,
  deleteLinks: true,
  deleteOffFormat: true,
  requirePrefix: true,
  prefix: '!post',
  minLength: 2,
};
const mk = (text, o = {}) => ({ text, fromMe: false, messageType: 'conversation', senderJid: 'a@lid', ...o });
const check = (text, o = {}, c = cfg, opt = {}) => checkMessage(mk(text, o), c, opt);

console.log('=== everything is off until switched on ===');
ok(check('anything at all', {}, { enabled: false, deleteMedia: true }) === null, 'master switch off -> nothing is ever deleted');
ok(check('no prefix here', {}, { enabled: true }) === null, 'no rule enabled -> nothing deleted');
ok(check('http://example.com', {}, { enabled: true, deleteLinks: false }) === null, 'deleteLinks off -> links allowed');
ok(check('', { messageType: 'imageMessage' }, { enabled: true, deleteMedia: false }) === null, 'deleteMedia off -> images allowed');

console.log('=== required format ===');
ok(check('!post hello everyone') === null, 'a correctly formatted message is kept');
ok(check('!POST hello everyone') === null, 'the prefix is case-insensitive');
ok(check('  !post  hello  ') === null, 'surrounding whitespace is tolerated');
ok(check('hello everyone')?.reason === 'no-prefix', 'a message without the prefix is removed');
ok(check('!post')?.reason === 'empty', 'prefix with nothing after it is removed');
ok(check('!post a')?.reason === 'empty', 'shorter than minLength is removed');
{
  const noPrefix = { ...cfg, requirePrefix: false, minLength: 3 };
  ok(checkMessage(mk('hi'), noPrefix)?.reason === 'empty', 'minLength applies without a prefix too');
  ok(checkMessage(mk('hello'), noPrefix) === null, 'long enough is kept');
}
{
  const misconfigured = { ...cfg, prefix: '' };
  ok(check('anything', {}, misconfigured) === null, 'requirePrefix with a blank prefix deletes nothing');
}

console.log('=== links ===');
ok(check('!post see https://example.com/x')?.reason === 'link', 'an http link is removed');
ok(check('!post visit www.example.com')?.reason === 'link', 'a www. link is removed');
ok(check('!post join chat.whatsapp.com/AbCd')?.reason === 'link', 'a bare known-TLD domain is removed');
ok(check('!post meet me at 3.30 today') === null, 'a decimal is not a link');
ok(check('!post see section 3.2 of the doc') === null, 'a section number is not a link');
ok(check('!post ok...fine') === null, 'ellipsis is not a link');
ok(containsLink('http://a.b') === true && containsLink('nothing here') === false, 'containsLink helper agrees');

console.log('=== media ===');
ok(check('', { messageType: 'imageMessage' })?.reason === 'media', 'image removed');
ok(check('', { messageType: 'audioMessage' })?.reason === 'media', 'voice note removed');
ok(check('', { messageType: 'stickerMessage' })?.reason === 'media', 'sticker removed');
ok(check('!post fine', { messageType: 'extendedTextMessage' }) === null, 'a quoted text reply is plain text');

console.log('=== exemptions and safety ===');
ok(check('chatting', {}, cfg, { isAdmin: true }) === null, 'admins are exempt by default');
ok(check('chatting', { fromMe: true }) === null, "the bot's own messages are never deleted");
ok(check('#rules', {}, cfg, { isCommand: true }) === null, 'a recognised bot command is never deleted');
ok(check('', { messageType: 'imageMessage' }, cfg, { isCommand: true }) === null, 'command exemption beats the media rule');
{
  const strict = { ...cfg, exemptAdmins: false };
  ok(check('chatting', {}, strict, { isAdmin: true })?.reason === 'no-prefix', 'exemptAdmins:false moderates admins too');
}
ok(check('   ') === null, 'a whitespace-only text message is left alone rather than guessed at');

console.log('=== the warning DM explains itself ===');
{
  const n = violationNotice({ reason: 'no-prefix' }, cfg, { rulesCommand: '#rules' });
  ok(n.includes('!post'), 'names the required prefix');
  ok(n.includes('#rules'), 'points at the rules command');
  ok(violationNotice({ reason: 'link' }, cfg).includes('link'), 'link removals say so');
  ok(violationNotice({ reason: 'media' }, cfg).includes('plain-text'), 'media removals say so');
  const custom = violationNotice({ reason: 'no-prefix' }, { ...cfg, formatExample: '!post Your message here' });
  ok(custom.includes('!post Your message here'), 'a configured example is used verbatim');
  ok(!violationNotice({ reason: 'media' }, { enabled: true }).includes('undefined'), 'no example configured -> no dangling text');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
