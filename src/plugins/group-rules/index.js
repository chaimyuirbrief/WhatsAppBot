import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesReplyFor } from './rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serves the group rules on demand.
 *
 * Anyone can send `#rules` — in a group, or as a DM to the bot — and get the
 * rules back. Groups can be assigned their own rule set so one bot can serve
 * different rules to different groups, each also reachable directly by its own
 * `#rules-<name>` command.
 */
export default {
  name: 'group-rules',
  description: 'Answers #rules (and per-group #rules-<name> commands) with the group rules.',
  configKey: 'groupRules',

  async setup(ctx) {
    // First run: seed the master rules from the shipped template so the
    // command answers with something sensible before anyone edits it.
    const cfg = ctx.config.groupRules ?? {};
    if (!(cfg.rules ?? '').trim()) {
      try {
        const seed = fs.readFileSync(path.join(HERE, 'default-rules.txt'), 'utf8').trim();
        if (seed) {
          ctx.configStore.update({ groupRules: { rules: seed } });
          ctx.log.info('seeded the default rules text - edit it in Settings → Group rules');
        }
      } catch (err) {
        ctx.log.warn(`could not seed default rules: ${err.message}`);
      }
    }
    ctx.log.info(`ready - send "${cfg.rulesCommand || '#rules'}" in any chat the bot can see`);
  },

  async onMessage(msg, ctx) {
    if (msg.fromMe || !msg.text) return;

    const cfg = ctx.config.groupRules ?? {};
    const reply = rulesReplyFor(cfg, msg);
    if (!reply) return;

    try {
      await ctx.bot.sendText(msg.chatJid, reply.text, { quoted: msg });
      ctx.log.info(`sent rules (${reply.command}) to ${msg.senderJid}`);

      // Keep the bot's chat list tidy: delete the PM after answering.
      // DMs only — never a group. The recipient keeps their copy.
      if (cfg.deleteChatAfterRules !== false && !msg.isGroup) {
        try {
          await ctx.bot.deleteChat(msg.chatJid, { key: msg.key, messageTimestamp: msg.raw?.messageTimestamp });
          ctx.log.info(`cleared PM chat with ${msg.senderJid} after rules`);
        } catch (err) {
          ctx.log.warn(`could not clear chat: ${err.message}`);
        }
      }
    } catch (err) {
      ctx.log.warn(`could not send rules: ${err.message}`);
    }
  },

  async teardown() {},
};
