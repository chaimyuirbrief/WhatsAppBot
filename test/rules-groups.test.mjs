/* Per-group rule commands. Run: node test/rules-groups.test.mjs */
import { rulesReplyFor, isRulesCommand } from '../src/plugins/group-rules/rules.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const cfg = {
  rulesCommand: '#rules',
  rules: 'MASTER combined rules',
  ruleSets: [
    { command: '#rules-support', label: 'Support groups', text: 'SUPPORT rules here' },
    { command: '#rules-announce', label: 'Announcement groups', text: 'ANNOUNCE rules here' },
    { command: '#rules-empty', label: 'Not written yet', text: '   ' },
  ],
  groupRuleSet: {
    'support@g.us': '#rules-support',
    'announce@g.us': '#rules-announce',
  },
};

console.log('=== specific set commands ===');
ok(rulesReplyFor(cfg, { text: '#rules-support', isGroup: true, chatJid: 'x@g.us' })?.text === 'SUPPORT rules here', '#rules-support -> support text anywhere');
ok(rulesReplyFor(cfg, { text: '#RULES-ANNOUNCE', isGroup: false })?.text === 'ANNOUNCE rules here', 'case-insensitive, works in DM');
ok(rulesReplyFor(cfg, { text: ' #rules-support ', isGroup: false })?.text === 'SUPPORT rules here', 'trims surrounding whitespace');
ok(rulesReplyFor(cfg, { text: '#rules-empty', isGroup: false }) === null, 'a set with blank text is not served');

console.log('=== master #rules routing ===');
ok(rulesReplyFor(cfg, { text: '#rules', isGroup: true, chatJid: 'support@g.us' })?.text === 'SUPPORT rules here', 'bare #rules in the support group -> support set');
ok(rulesReplyFor(cfg, { text: '#rules', isGroup: true, chatJid: 'announce@g.us' })?.text === 'ANNOUNCE rules here', 'bare #rules in the announcements group -> announce set');
ok(rulesReplyFor(cfg, { text: '#rules', isGroup: true, chatJid: 'other@g.us' })?.text === 'MASTER combined rules', 'unassigned group -> master text');
ok(rulesReplyFor(cfg, { text: '#rules', isGroup: false })?.text === 'MASTER combined rules', 'DM -> master text');

console.log('=== menu fallback when no master text ===');
{
  const noMaster = { ...cfg, rules: '' };
  const r = rulesReplyFor(noMaster, { text: '#rules', isGroup: false });
  ok(r && r.text.includes('#rules-support') && r.text.includes('#rules-announce'), 'DM #rules with no master text -> menu of commands');
  ok(!r.text.includes('#rules-empty'), 'menu omits sets that have no text');
  // an assigned group still resolves its own set even without master text
  ok(rulesReplyFor(noMaster, { text: '#rules', isGroup: true, chatJid: 'announce@g.us' })?.text === 'ANNOUNCE rules here', 'assigned group works without master text');
}

console.log('=== non-commands ===');
ok(rulesReplyFor(cfg, { text: 'good morning everyone', isGroup: true, chatJid: 'support@g.us' }) === null, 'ordinary chatter is not a rules command');
ok(rulesReplyFor(cfg, { text: '', isGroup: false }) === null, 'empty text -> null');
ok(rulesReplyFor(cfg, { text: '#rules please', isGroup: false }) === null, 'extra words -> not matched (exact only)');
ok(isRulesCommand(cfg, { text: '#rules-announce', isGroup: false }) === true, 'isRulesCommand true for a set');
ok(isRulesCommand(cfg, { text: 'hello', isGroup: false }) === false, 'isRulesCommand false for chatter');

console.log('=== defaults / missing config ===');
ok(rulesReplyFor({}, { text: '#rules', isGroup: false }) === null, 'no rules configured -> null');
ok(rulesReplyFor({ ruleSets: [{ command: '#r', text: 'x' }] }, { text: '#r', isGroup: false })?.text === 'x', 'works with only ruleSets, default master');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
