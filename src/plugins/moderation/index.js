import { checkMessage, violationNotice } from './enforcement.js';
import { isRulesCommand } from '../group-rules/rules.js';

/**
 * Auto-moderation for the groups an admin nominates.
 *
 * Every rule is off by default and each is an explicit opt-in, because the
 * action is destructive: a message that breaks a switched-on rule is deleted
 * for everyone, which is exactly what an admin would otherwise do by hand.
 *
 * The whole thing fails open — if a check or a delete throws, the message is
 * left in place and the error is logged. Silently eating people's messages is
 * a worse failure than missing one.
 */
export default {
  name: 'moderation',
  description: 'Deletes messages that break the configured posting rules, in nominated groups only.',
  configKey: 'moderation',

  async setup(ctx) {
    const cfg = ctx.config.moderation ?? {};
    if (!cfg.enabled) {
      ctx.log.info('loaded, currently off - switch it on in Members → Auto-moderation');
      return;
    }
    ctx.log.info(`active in ${cfg.groups?.length ?? 0} group(s)`);
  },

  async onMessage(msg, ctx) {
    const cfg = ctx.config.moderation ?? {};
    if (!cfg.enabled) return;
    if (msg.fromMe || !msg.isGroup) return;
    if (!cfg.groups?.includes(msg.chatJid)) return;

    // Anti-flood: once someone trips the limit, ignore them until it expires.
    const cooldown = (cfg.cooldownSecondsPerUser ?? 0) * 1000;
    if (cooldown > 0 && msg.senderJid) {
      const key = `cooldown:${msg.senderJid}`;
      const last = ctx.store.get(key, 0);
      if (Date.now() - last < cooldown) {
        ctx.log.debug(`ignoring ${msg.senderJid}: cooling down`);
        return;
      }
      ctx.store.set(key, Date.now());
    }

    try {
      const isAdmin = ctx.bot.isGroupAdmin(msg.chatJid, {
        jid: msg.senderJid,
        number: msg.senderNumber,
      });
      const isCommand = isRulesCommand(ctx.config.groupRules ?? {}, msg);
      const bad = checkMessage(msg, cfg, { isAdmin, isCommand });
      if (!bad) return;

      await ctx.bot.deleteMessage(msg);
      ctx.log.info(`🧹 deleted a message in ${msg.chatJid} from ${msg.senderNumber ?? msg.senderJid}: ${bad.reason} (${bad.detail})`);

      const rulesCommand = ctx.config.groupRules?.rulesCommand || '#rules';

      if (cfg.warnByDm && msg.senderJid) {
        try {
          await ctx.bot.sendText(msg.senderJid, violationNotice(bad, cfg, { rulesCommand }));
        } catch (err) {
          ctx.log.debug(`could not DM the rule notice: ${err.message}`);
        }
      }

      if (cfg.replyOnAction) {
        try {
          await ctx.bot.sendText(msg.chatJid, `A message was removed: ${bad.detail}. Send ${rulesCommand} for the rules.`);
        } catch (err) {
          ctx.log.debug(`could not post the removal note: ${err.message}`);
        }
      }
    } catch (err) {
      ctx.log.warn(`moderation failed (message left in place): ${err.message}`);
    }
  },

  async teardown() {},
};
