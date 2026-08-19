import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import log from './util/logger.js';
import { ConfigStore } from './config/store.js';
import { StateStore } from './core/state.js';
import { WhatsAppBot } from './core/bot.js';
import { JobQueue } from './core/queue.js';
import { PluginManager } from './core/plugin-manager.js';
import { createServer, startServer } from './web/server.js';
import { FileLogger } from './util/filelog.js';
import { LockScheduler } from './core/lockdown.js';
import { AlertWatcher } from './core/alerts.js';
import { runAdminCommand, backupOriginalDescriptions } from './core/admin-commands.js';
import { MessageIndex } from './core/message-index.js';
import { MemberActivity } from './core/member-activity.js';
import { Announcer, EVENT_KEYS, describeEvent } from './core/announce.js';

const logger = log.scope('main');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

/**
 * MASTER_KEY encrypts secrets in config.json. Generated once, kept in .env.
 *
 * The file is the authority, not the environment. Reading it directly means
 * that if dotenv ever fails to load (different working directory, a stray
 * .env elsewhere), we still use the key that actually encrypted the stored
 * data rather than silently generating a fresh one and leaving every saved
 * secret undecryptable.
 */
function ensureMasterKey() {
  const envPath = path.join(ROOT, '.env');

  let existing = '';
  if (fs.existsSync(envPath)) existing = fs.readFileSync(envPath, 'utf8');

  const onDisk = existing.match(/^MASTER_KEY=(.+)$/m)?.[1]?.trim();
  if (onDisk) {
    if (process.env.MASTER_KEY && process.env.MASTER_KEY !== onDisk) {
      logger.warn('MASTER_KEY in the environment differs from .env - using .env, which is what encrypted your settings');
    }
    process.env.MASTER_KEY = onDisk;
    return onDisk;
  }

  // Nothing on disk. Adopt an environment-supplied key if there is one
  // (useful for container deployments), otherwise mint a fresh one.
  const key = process.env.MASTER_KEY || crypto.randomBytes(32).toString('hex');
  fs.appendFileSync(envPath, (existing && !existing.endsWith('\n') ? '\n' : '') + `MASTER_KEY=${key}\n`, { mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch {}
  logger.warn(`wrote MASTER_KEY to ${envPath} - back this file up, it decrypts your saved settings`);

  process.env.MASTER_KEY = key;
  return key;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const masterKey = ensureMasterKey();

  const configStore = new ConfigStore({ dataDir: DATA_DIR, masterKey });
  const config = configStore.load();
  log.level = { debug: 10, info: 20, warn: 30, error: 40 }[config.logging.level] ?? 20;

  logger.info('----------------------------------------------------------');
  logger.info(' WhatsApp Group Bot');
  logger.info(`  data dir : ${DATA_DIR}`);
  logger.info('----------------------------------------------------------');

  // Persistent debug log. Attached before anything else so startup problems
  // are captured too.
  const fileLogger = new FileLogger({
    dir: path.join(DATA_DIR, 'logs'),
    retentionDays: config.logging.retentionDays,
    maxBytes: config.logging.maxFileBytes,
  });
  log.setSink(fileLogger);
  logger.info(`debug log -> ${path.join(DATA_DIR, 'logs')}`);

  const alerts = new AlertWatcher({ configStore, fileLogger });
  alerts.attach();

  const stateStore = new StateStore(path.join(DATA_DIR, 'state.json'));
  const bot = new WhatsAppBot({ configStore, dataDir: DATA_DIR });
  const queue = new JobQueue({
    concurrency: config.queue.concurrency,
    maxLength: config.queue.maxLength,
  });
  const pluginManager = new PluginManager({ bot, configStore, queue, stateStore });

  // Remember recent group message keys so a ban can also wipe what they posted
  // (WhatsApp only allows delete-for-everyone for about two days).
  bot.messageIndex = new MessageIndex({ store: stateStore.namespace('msg-index') });
  // Per-member activity counts powering the Members roster.
  bot.memberActivity = new MemberActivity({ store: stateStore.namespace('member-activity') });
  // Optional running commentary of group admin activity in one nominated group.
  const announcer = new Announcer({ bot, getConfig: () => configStore.get().announce });

  // Route every inbound message through the plugins.
  bot.on('message', (msg) => {
    try { bot.messageIndex.record(msg); } catch (err) { logger.debug(`msg-index: ${err.message}`); }
    try { bot.memberActivity.record(msg); } catch (err) { logger.debug(`member-activity: ${err.message}`); }
    pluginManager.dispatchMessage(msg).catch((err) => logger.error(`dispatch: ${err.message}`));
  });

  // Persist the group admin activity feed (joins/leaves/removals/promotions).
  const activity = stateStore.namespace('group-activity');
  bot.on('group-event', (ev) => {
    activity.push('events', ev, 500);
    const who = ev.actorNumber ? `+${ev.actorNumber}` : (ev.actor ?? 'someone');
    const tgt = ev.targets?.map((t) => t.number ? `+${t.number}` : t.jid).filter(Boolean).join(', ');
    logger.info(`👥 ${ev.groupName}: ${ev.action}${tgt ? ` ${tgt}` : ''}${ev.actor ? ` (by ${who})` : ''}`);

    const key = EVENT_KEYS[ev.action];
    if (!key || !announcer.enabled(key)) return;
    // Announce about the member the event happened to, not the admin who did it.
    const subject = ev.targets?.[0] ?? {};
    announcer
      .post(key, describeEvent(ev), { jid: subject.jid, number: subject.number }, { tagGroup: ev.groupJid })
      .catch((err) => logger.debug(`announce: ${err.message}`));
  });

  // Load whatever plugins are enabled in config.
  for (const name of config.plugins.enabled) {
    const entry = path.join(__dirname, 'plugins', name, 'index.js');
    if (!fs.existsSync(entry)) {
      logger.error(`plugin "${name}" not found at ${entry}`);
      continue;
    }
    try {
      await pluginManager.load(name, await import(`file://${entry}`));
    } catch (err) {
      logger.error(`could not load plugin "${name}": ${err.message}`);
    }
  }

  // Web control panel first, so a misconfigured bot is still fixable in the UI.
  // Scheduled lockdown: locks/unlocks all groups on the configured recurring windows.
  const lockState = stateStore.namespace('lockdown');
  const lockScheduler = new LockScheduler({
    getConfig: () => configStore.get().lockdown,
    getState: () => lockState.get('state', { locked: false, source: null, overriddenWindowKey: null }),
    persist: (st) => lockState.set('state', st),
    applyLock: async (source) => {
      logger.warn(`🔒 locking all groups (${source})`);
      const results = await bot.setAllGroupsLocked(true);
      lockState.set('state', { ...lockState.get('state', {}), locked: true, source, at: Date.now() });
      const lockedCount = results.filter((r) => r.ok).length;
      stateStore.namespace('audit').push('events', { ts: Date.now(), user: `lockdown:${source}`, role: 'system', action: `locked ${lockedCount} groups` }, 2000);
      announcer.post('lock', `🔒 ${lockedCount} group(s) locked — admins only (${source})`).catch(() => {});
    },
    applyUnlock: async (source, overriddenWindowKey = null) => {
      logger.warn(`🔓 unlocking all groups (${source})`);
      const results = await bot.setAllGroupsLocked(false);
      const prev = lockState.get('state', {});
      lockState.set('state', { ...prev, locked: false, source, overriddenWindowKey: overriddenWindowKey ?? prev.overriddenWindowKey ?? null, at: Date.now() });
      const unlockedCount = results.filter((r) => r.ok).length;
      stateStore.namespace('audit').push('events', { ts: Date.now(), user: `lockdown:${source}`, role: 'system', action: `unlocked ${unlockedCount} groups` }, 2000);
      announcer.post('unlock', `🔓 ${unlockedCount} group(s) unlocked (${source})`).catch(() => {});
    },
  });

  const app = createServer({ configStore, bot, queue, pluginManager, stateStore, fileLogger, alerts, lockScheduler });
  await startServer(app, configStore);
  bot.on('state', (st) => {
    if (st.state !== 'connected') return;
    lockScheduler.start();
    // Preserve original group descriptions the first time we see them, so a
    // later bulk rewrite never destroys the pre-edit text. Delay a little so
    // the first group refresh (which populates descriptions) has landed.
    setTimeout(() => {
      try {
        const r = backupOriginalDescriptions(bot, DATA_DIR);
        if (r.newlyBackedUp) logger.info(`backed up ${r.newlyBackedUp} original group description(s)`);
      } catch (err) { logger.warn(`description backup failed: ${err.message}`); }
    }, 10_000);
  });

  // --- local admin command channel -----------------------------------------
  // An operator on the box drops data/bot-cmd.json ({ op, ... }); we run it and
  // write data/bot-cmd.result.json. Local files only, whitelisted ops only.
  const CMD_FILE = path.join(DATA_DIR, 'bot-cmd.json');
  const CMD_RESULT = path.join(DATA_DIR, 'bot-cmd.result.json');
  let cmdBusy = false;
  const cmdPoll = setInterval(async () => {
    if (cmdBusy || !fs.existsSync(CMD_FILE)) return;
    cmdBusy = true;
    let cmd = null;
    try {
      cmd = JSON.parse(fs.readFileSync(CMD_FILE, 'utf8'));
      try { fs.unlinkSync(CMD_FILE); } catch {}
      const result = await runAdminCommand(cmd, { bot, dataDir: DATA_DIR, stateStore, configStore });
      fs.writeFileSync(CMD_RESULT, JSON.stringify({ op: cmd.op, at: Date.now(), ...result }, null, 2));
      logger.info(`admin-cmd ${cmd.op}: ok`);
    } catch (err) {
      try { fs.writeFileSync(CMD_RESULT, JSON.stringify({ op: cmd?.op ?? null, at: Date.now(), ok: false, error: err.message }, null, 2)); } catch {}
      logger.error(`admin-cmd ${cmd?.op ?? '(unparsed)'}: ${err.message}`);
    } finally { cmdBusy = false; }
  }, 3000);
  cmdPoll.unref();

  // Re-apply settings that changed in the UI without a restart.
  configStore.onChange((cfg) => {
    queue.concurrency = cfg.queue.concurrency;
    queue.maxLength = cfg.queue.maxLength;
    log.level = { debug: 10, info: 20, warn: 30, error: 40 }[cfg.logging.level] ?? 20;
  });

  // Auto-connect only if a session already exists; a fresh install waits for
  // the operator to press Link in the UI.
  const sessionDir = path.join(DATA_DIR, 'session');
  const hasSession = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;
  if (hasSession) {
    logger.info('existing session found, connecting');
    bot.start().catch((err) => logger.error(`auto-connect failed: ${err.message}`));
  } else {
    logger.info('no session yet - open the control panel and link your number');
  }

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    try { await pluginManager.unloadAll(); } catch {}
    try { await bot.stop(); } catch {}
    stateStore.flush();
    fileLogger.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (err) => {
    logger.error(`unhandled rejection: ${err?.message ?? err}`, { stack: err?.stack });
  });
  process.on('uncaughtException', (err) => {
    logger.error(`uncaught exception: ${err?.message ?? err}`, { stack: err?.stack });
  });
}

main().catch((err) => {
  console.error('fatal startup error:', err);
  process.exit(1);
});
