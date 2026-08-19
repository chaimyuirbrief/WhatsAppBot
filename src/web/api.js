import express from 'express';
import fs from 'node:fs';
import log from '../util/logger.js';
import { MASK } from '../config/store.js';
import { verifyEmail, sendTestEmail, PRESETS } from '../util/mailer.js';
import {
  needsSetup, setupSuperAdmin, authenticate, requireAuth, requireSuperAdmin,
  migrateIfNeeded, listAdmins, addAdmin, removeAdmin, resetPassword, findAdmin,
  isRateLimited, recordFailure, clearFailures,
} from './auth.js';
import { verifyPassword } from '../util/crypto.js';
import { fmtBytes } from '../util/format.js';
import { aggregateMembers, memberDetail } from '../core/members.js';

const logger = log.scope('api');

export function createApiRouter({ configStore, bot, queue, pluginManager, stateStore, fileLogger, alerts, lockScheduler }) {
  const router = express.Router();
  const guard = requireAuth(configStore);
  const superGuard = requireSuperAdmin(configStore);
  migrateIfNeeded(configStore);

  // Audit trail: every successful mutating request is recorded with the acting
  // admin, so each action is attributable. Sensitive body fields are dropped.
  const auditStore = stateStore.namespace('audit');
  function audit(req, action, detail) {
    auditStore.push('events', {
      ts: Date.now(),
      user: req.session?.user?.username ?? '?',
      role: req.session?.user?.role ?? '?',
      ip: req.ip,
      action,
      detail: detail ?? `${req.method} ${req.path}`,
    }, 2000);
  }
  router.use((req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.session?.user
        && !req.path.startsWith('/auth/')) {
      res.on('finish', () => { if (res.statusCode < 400) audit(req, `${req.method} ${req.path}`); });
    }
    next();
  });

  /* ----------------------------- auth ----------------------------- */

  router.get('/auth/status', (req, res) => {
    res.json({
      setupRequired: needsSetup(configStore),
      authed: !!req.session?.user,
      user: req.session?.user ?? null,
    });
  });

  router.post('/auth/setup', (req, res) => {
    if (!needsSetup(configStore)) return res.status(409).json({ error: 'already-configured' });
    try {
      setupSuperAdmin(configStore, req.body?.password);
      req.session.user = { username: 'superadmin', role: 'superadmin' };
      audit(req, 'setup super-admin');
      res.json({ ok: true, user: req.session.user });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/auth/login', (req, res) => {
    if (isRateLimited(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
    const user = authenticate(configStore, req.body?.username, req.body?.password);
    if (user) {
      clearFailures(req);
      req.session.user = user;
      audit(req, 'login');
      return res.json({ ok: true, user });
    }
    recordFailure(req);
    res.status(401).json({ error: 'Wrong username or password' });
  });

  router.post('/auth/logout', (req, res) => {
    audit(req, 'logout');
    req.session.destroy(() => res.json({ ok: true }));
  });

  /* ---------------------- admin account management ---------------- */

  router.get('/admins', guard, (req, res) => {
    res.json({ admins: listAdmins(configStore), me: req.session.user });
  });

  router.post('/admins', guard, superGuard, (req, res) => {
    try {
      addAdmin(configStore, req.body?.username, req.body?.password, req.body?.role || 'admin');
      audit(req, `add admin "${req.body?.username}" (${req.body?.role || 'admin'})`);
      res.json({ ok: true, admins: listAdmins(configStore) });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  router.delete('/admins/:username', guard, superGuard, (req, res) => {
    try {
      removeAdmin(configStore, req.params.username);
      audit(req, `remove admin "${req.params.username}"`);
      res.json({ ok: true, admins: listAdmins(configStore) });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  router.post('/admins/:username/reset', guard, superGuard, (req, res) => {
    try {
      resetPassword(configStore, req.params.username, req.body?.password);
      audit(req, `reset password for "${req.params.username}"`);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  /** Any signed-in admin can change THEIR OWN password. */
  router.post('/auth/password', guard, (req, res) => {
    const { current, next } = req.body ?? {};
    const me = findAdmin(configStore, req.session.user.username);
    if (!me || !verifyPassword(current, me.passwordHash)) {
      return res.status(401).json({ error: 'Current password is wrong' });
    }
    try {
      resetPassword(configStore, me.username, next);
      audit(req, 'changed own password');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /* ------------------------------ audit --------------------------- */
  router.get('/audit', guard, (req, res) => {
    res.json(auditStore.get('events', []));
  });
  router.delete('/audit', guard, superGuard, (req, res) => {
    audit(req, 'cleared the audit log');
    auditStore.set('events', auditStore.get('events', []).slice(0, 1));
    res.json({ ok: true });
  });

  /* ---------------------------- config ---------------------------- */

  router.get('/config', guard, (req, res) => {
    res.json(configStore.redacted());
  });

  router.put('/config', guard, async (req, res) => {
    try {
      const patch = req.body ?? {};
      // The password hash is managed through /auth/password only.
      if (patch.web) delete patch.web.adminPasswordHash;

      // Guard against a form submitted while the group list was unavailable
      // clearing a working configuration. Clearing it deliberately is still
      // possible via ?allowEmptyGroups=1.
      const current = configStore.get();
      if (patch.moderation
          && Array.isArray(patch.moderation.groups)
          && patch.moderation.groups.length === 0
          && (current.moderation?.groups?.length ?? 0) > 0
          && req.query.allowEmptyGroups !== '1') {
        logger.warn('ignored an empty moderation.groups update - kept the existing configuration');
        delete patch.moderation.groups;
      }
      const updated = configStore.update(patch);
      await pluginManager.notifyConfigChange(updated);
      logger.info('configuration updated');
      res.json(configStore.redacted());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /* --------------------------- whatsapp --------------------------- */

  router.get('/wa/status', guard, (req, res) => {
    res.json(bot.status());
  });

  router.post('/wa/start', guard, async (req, res) => {
    try {
      bot.start().catch((err) => logger.error(`start failed: ${err.message}`));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/wa/stop', guard, async (req, res) => {
    await bot.stop();
    res.json({ ok: true });
  });

  router.post('/wa/logout', guard, async (req, res) => {
    await bot.logout({ wipe: true });
    res.json({ ok: true });
  });

  // WhatsApp throttles groupFetchAllParticipating() aggressively, so a forced
  // fetch soon after a successful one is guaranteed to be rejected. Below this
  // age, Refresh simply reports the cached list instead of making a call that
  // can only fail.
  const GROUP_REFRESH_COOLDOWN_MS = 120_000;

  router.get('/wa/groups', guard, async (req, res) => {
    const age = bot.groupCacheAge();
    const wantRefresh = req.query.refresh === '1' && bot.isConnected();

    try {
      if (wantRefresh && age >= GROUP_REFRESH_COOLDOWN_MS) {
        await bot.refreshGroups({ force: true });
        return res.json({ groups: bot.groups(), refreshed: true, ageMs: 0 });
      }
      // Either no refresh was asked for, or the list is too fresh to be
      // worth re-fetching. Both are successes, not errors.
      res.json({
        groups: bot.groups(),
        refreshed: false,
        ageMs: bot.groupCacheAge(),
        note: wantRefresh ? 'already up to date' : undefined,
      });
    } catch (err) {
      const rateLimited = /rate.?overlimit|429|too many/i.test(err.message ?? '');
      const cached = bot.groups();

      if (rateLimited) {
        logger.info(`group refresh rate-limited by WhatsApp; serving ${cached.length} cached group(s)`);
      } else {
        logger.warn(`group refresh failed: ${err.message}`);
      }

      // Having a cached list means nothing is actually broken - say so
      // rather than raising an alarm the operator cannot act on.
      if (cached.length) {
        return res.json({
          groups: cached,
          refreshed: false,
          ageMs: bot.groupCacheAge(),
          note: rateLimited
            ? 'WhatsApp declined another lookup just now — showing the list from a moment ago'
            : `could not refresh (${err.message}) — showing the last known list`,
        });
      }

      res.status(rateLimited ? 429 : 500).json({
        error: rateLimited
          ? 'WhatsApp is rate-limiting the group list. The bot keeps retrying in the background — try again shortly.'
          : err.message,
        groups: [],
      });
    }
  });

  /* -------------------------- lockdown ---------------------------- */

  router.get('/lockdown/status', guard, (req, res) => {
    res.json(lockScheduler ? lockScheduler.status() : { enabled: false });
  });
  // Lock/unlock walks the groups one at a time, seconds apart, so the run
  // outlives this request by minutes. Answer as soon as it has started and let
  // the portal follow along on /lockdown/status.
  router.post('/lockdown/lock', guard, (req, res) => {
    try {
      const { started } = lockScheduler.manualLock();
      audit(req, started ? 'locked all groups (manual)' : 'lock ignored — a lockdown run was already in progress');
      res.json({ ok: true, started, ...lockScheduler.status() });
    } catch (err) { res.status(400).json({ ok: false, error: friendlyGroupError(err) }); }
  });
  router.post('/lockdown/unlock', guard, (req, res) => {
    try {
      const { started } = lockScheduler.manualUnlock();
      audit(req, started ? 'unlocked all groups (manual)' : 'unlock ignored — a lockdown run was already in progress');
      res.json({ ok: true, started, ...lockScheduler.status() });
    } catch (err) { res.status(400).json({ ok: false, error: friendlyGroupError(err) }); }
  });

  /* ------------------------ cross-group members ------------------- */

  /** The combined roster: every member of every group, deduplicated. */
  router.get('/members', guard, (req, res) => {
    try {
      const activity = bot.memberActivity?.all() ?? {};
      const list = aggregateMembers(bot.groupsWithMembers(), activity);
      res.json({
        members: list,
        groupCount: bot.groups().length,
        trackingSince: Object.values(activity).reduce(
          (min, e) => (e.firstSeen && (!min || e.firstSeen < min) ? e.firstSeen : min), null),
      });
    } catch (err) {
      res.status(bot.isConnected() ? 400 : 503).json({ error: err.message });
    }
  });

  /** One member: their groups, where they're admin, activity and join history. */
  router.get('/members/:key/detail', guard, (req, res) => {
    try {
      const activity = bot.memberActivity?.all() ?? {};
      const list = aggregateMembers(bot.groupsWithMembers(), activity);
      const member = list.find((m) => m.key === req.params.key);
      if (!member) return res.status(404).json({ error: 'member not found' });
      const events = stateStore.namespace('group-activity').get('events', []) ?? [];
      const detail = memberDetail({ member, events, activity });
      // Decorate per-group activity with the group's name for display.
      const names = Object.fromEntries(bot.groups().map((g) => [g.jid, g.subject]));
      detail.perGroup = Object.fromEntries(Object.entries(detail.perGroup)
        .map(([jid, v]) => [jid, { ...v, subject: names[jid] ?? jid }]));
      detail.banned = (configStore.get().bannedNumbers ?? [])
        .some((n) => String(n).replace(/[^0-9]/g, '') === member.number);
      detail.noTag = (configStore.get().announce?.noTag ?? [])
        .some((n) => String(n).replace(/[^0-9]/g, '') === member.number);
      res.json(detail);
    } catch (err) {
      res.status(bot.isConnected() ? 400 : 503).json({ error: err.message });
    }
  });

  router.post('/members/ban-all', guard, async (req, res) => {
    const num = String(req.body?.number ?? '').replace(/[^0-9]/g, '');
    if (!num) return res.status(400).json({ error: 'no number' });
    try {
      const results = await bot.banFromAllGroups(num);
      const wiped = results.wiped ?? { deleted: 0, failed: 0 };
      // add to the local banned list
      const banned = new Set((configStore.get().bannedNumbers ?? []).map((x) => String(x).replace(/[^0-9]/g, '')));
      banned.add(num);
      configStore.update({ bannedNumbers: [...banned] });
      audit(req, `banned +${num} from all groups (${results.length} affected` +
        `${wiped.deleted ? `, ${wiped.deleted} message(s) deleted` : ''})`);
      res.json({ ok: true, results, wiped });
    } catch (err) { res.status(400).json({ ok: false, error: friendlyGroupError(err) }); }
  });

  /** action: add | promote | demote across selected groups */
  router.post('/members/across', guard, async (req, res) => {
    const num = String(req.body?.number ?? '').replace(/[^0-9]/g, '');
    const jids = Array.isArray(req.body?.groupJids) ? req.body.groupJids : [];
    const action = req.body?.action;
    if (!num || !jids.length) return res.status(400).json({ error: 'number and groupJids required' });
    if (!['add', 'promote', 'demote'].includes(action)) return res.status(400).json({ error: 'bad action' });
    try {
      const results = await bot.participantAcrossGroups(num, jids, action);
      audit(req, `${action} +${num} across ${jids.length} group(s)`);
      res.json({ ok: true, results });
    } catch (err) { res.status(400).json({ ok: false, error: friendlyGroupError(err) }); }
  });

  router.get('/banned', guard, (req, res) => {
    res.json(configStore.get().bannedNumbers ?? []);
  });
  router.delete('/banned/:number', guard, (req, res) => {
    const num = String(req.params.number).replace(/[^0-9]/g, '');
    configStore.update({ bannedNumbers: (configStore.get().bannedNumbers ?? []).filter((x) => String(x).replace(/[^0-9]/g, '') !== num) });
    audit(req, `removed +${num} from the banned list`);
    res.json({ ok: true });
  });

  /* ------------------------- group admin -------------------------- */

  router.get('/groups/:jid/details', guard, async (req, res) => {
    try {
      res.json(await bot.groupDetails(req.params.jid));
    } catch (err) {
      res.status(bot.isConnected() ? 400 : 503).json({ error: err.message });
    }
  });

  router.put('/groups/:jid/description', guard, async (req, res) => {
    try {
      await bot.setGroupDescription(req.params.jid, String(req.body?.description ?? ''));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: friendlyGroupError(err) });
    }
  });

  router.put('/groups/:jid/subject', guard, async (req, res) => {
    try {
      await bot.setGroupSubject(req.params.jid, String(req.body?.subject ?? ''));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: friendlyGroupError(err) });
    }
  });

  /** action: add | remove | promote | demote ; numbers: [] */
  router.post('/groups/:jid/participants', guard, async (req, res) => {
    const { action, numbers } = req.body ?? {};
    if (!Array.isArray(numbers) || !numbers.length) {
      return res.status(400).json({ error: 'no numbers given' });
    }
    try {
      const results = await bot.modifyParticipants(req.params.jid, numbers, action);
      res.json({ ok: true, results });
    } catch (err) {
      res.status(400).json({ ok: false, error: friendlyGroupError(err) });
    }
  });

  router.get('/group-activity', guard, (req, res) => {
    res.json(stateStore.namespace('group-activity').get('events', []));
  });

  router.delete('/group-activity', guard, (req, res) => {
    stateStore.namespace('group-activity').set('events', []);
    res.json({ ok: true });
  });

  function friendlyGroupError(err) {
    const m = err.message ?? String(err);
    if (/not-authorized|forbidden|403/i.test(m)) {
      return 'The bot must be an admin of that group to do this.';
    }
    if (/not connected/i.test(m)) return 'WhatsApp is not connected.';
    return m;
  }

  /* ----------------------------- queue ---------------------------- */

  router.get('/queue', guard, (req, res) => res.json(queue.snapshot()));

  router.post('/queue/pause', guard, (req, res) => { queue.pause(); res.json({ ok: true }); });
  router.post('/queue/resume', guard, (req, res) => { queue.resume(); res.json({ ok: true }); });
  router.post('/queue/clear', guard, (req, res) => {
    const n = queue.clearPending();
    res.json({ ok: true, cleared: n });
  });
  router.delete('/queue/:id', guard, (req, res) => {
    const ok = queue.cancel(req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  // Skip = abandon the current job so the queue advances. Distinct from
  // cancel so the job is reported as skipped, not silently dropped.
  router.post('/queue/:id/skip', guard, (req, res) => {
    const ok = queue.skip(req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  router.post('/queue/:id/move', guard, (req, res) => {
    const dir = req.body?.dir;
    const ok = dir === 'top' ? queue.moveTop(req.params.id)
             : queue.move(req.params.id, dir === 'down' ? 'down' : 'up');
    res.status(ok ? 200 : 404).json({ ok });
  });

  /* ------------------------- announcements ------------------------ */

  /** Mute/unmute a number from being @-tagged in the announcements group. */
  router.post('/notify/no-tag', guard, (req, res) => {
    const num = String(req.body?.number ?? '').replace(/[^0-9]/g, '');
    if (!num) return res.status(400).json({ error: 'no number' });
    const cur = new Set((configStore.get().announce?.noTag ?? [])
      .map((x) => String(x).replace(/[^0-9]/g, '')).filter(Boolean));
    if (req.body?.muted) cur.add(num); else cur.delete(num);
    configStore.update({ announce: { noTag: [...cur] } });
    audit(req, `${req.body?.muted ? 'muted' : 'unmuted'} announcement tag for +${num}`);
    res.json({ ok: true, noTag: [...cur] });
  });

  /* ----------------------------- logs ----------------------------- */

  router.get('/logs', guard, (req, res) => {
    res.json(log.recent(Number(req.query.n) || 200));
  });

  /* ----------------------------- debug log ------------------------ */

  /** Rotated log files on disk, newest first. */
  router.get('/logs/files', guard, (req, res) => {
    try {
      res.json(fileLogger.list());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Read one log file back into the viewer. */
  router.get('/logs/file/:name', guard, (req, res) => {
    try {
      res.type('text/plain').send(fileLogger.read(req.params.name));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  /** Download a log file. */
  router.get('/logs/download/:name', guard, (req, res) => {
    try {
      const body = fileLogger.read(req.params.name, { maxBytes: 64 * 1024 * 1024 });
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.name.replace(/\.gz$/, '')}"`);
      res.type('text/plain').send(body);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  /* ------------------------------- email -------------------------- */

  router.get('/email/presets', guard, (req, res) => {
    res.json(Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v ?? {}])));
  });

  /** Check the SMTP credentials without sending anything. */
  router.post('/email/verify', guard, async (req, res) => {
    const cfg = mergeEmailBody(req.body);
    res.json(await verifyEmail(cfg));
  });

  /** Send a test message. */
  router.post('/email/test', guard, async (req, res) => {
    const cfg = mergeEmailBody(req.body);
    res.json(await sendTestEmail(cfg));
  });

  /** Email the current debug log on demand. */
  router.post('/email/send-log', guard, async (req, res) => {
    try {
      const r = await alerts.sendNow({
        label: req.body?.label || 'debug log',
        note: req.body?.note || '',
      });
      res.json({ ok: true, messageId: r.messageId });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  /**
   * Let the settings form test credentials it has not saved yet, while
   * still falling back to the stored app password when the field is masked.
   */
  function mergeEmailBody(body) {
    const stored = configStore.get().email;
    const out = { ...stored, ...(body ?? {}) };
    if (!out.appPassword || out.appPassword === MASK) out.appPassword = stored.appPassword;
    return out;
  }

  /* --------------------------- diagnostics ------------------------ */

  router.get('/diagnostics', guard, async (req, res) => {
    const cfg = configStore.get();
    // Free space on the volume holding the bot's data directory - config,
    // state and the debug logs all live there.
    const dataDir = configStore.dataDir ?? process.env.DATA_DIR ?? process.cwd();
    let disk = null;
    try {
      const st = fs.statfsSync(dataDir);
      disk = {
        free: st.bavail * st.bsize,
        total: st.blocks * st.bsize,
        freeHuman: fmtBytes(st.bavail * st.bsize),
      };
    } catch { /* statfs is not critical */ }

    res.json({
      node: process.version,
      uptimeSec: Math.floor(process.uptime()),
      memory: {
        rssHuman: fmtBytes(process.memoryUsage().rss),
      },
      disk,
      dataDir,
      plugins: pluginManager.list(),
      whatsapp: bot.status(),
      logs: {
        dir: fileLogger.dir,
        files: fileLogger.list().length,
        totalBytes: fileLogger.list().reduce((n, f) => n + f.size, 0),
      },
      email: {
        enabled: !!cfg.email.enabled,
        configured: !!cfg.email.appPassword,
        onError: !!cfg.email.onError,
      },
    });
  });

  /**
   * Outbound connectivity check. This network runs a TLS-intercepting filter,
   * so the most common failure by far is an untrusted certificate rather than
   * an unreachable host - this names that explicitly instead of leaving a
   * cryptic "unable to get local issuer certificate" in the logs.
   */
  router.get('/test/connectivity', guard, async (req, res) => {
    const targets = [
      { name: 'WhatsApp', url: 'https://web.whatsapp.com/', required: true },
    ];

    const results = await Promise.all(targets.map(async (t) => {
      const started = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12_000);
        // A 401/404 still proves the TLS handshake and routing worked.
        const r = await fetch(t.url, { signal: ctrl.signal, redirect: 'manual' });
        clearTimeout(timer);
        return { ...t, ok: true, status: r.status, ms: Date.now() - started };
      } catch (err) {
        const msg = err.cause?.message ?? err.message ?? String(err);
        const isCert = /certificate|self-signed|SELF_SIGNED|UNABLE_TO_GET_ISSUER|unable to verify/i.test(msg);
        return {
          ...t,
          ok: false,
          ms: Date.now() - started,
          error: msg,
          certProblem: isCert,
          hint: isCert
            ? 'A TLS-intercepting filter is on this network. Put its root CA in the certs/ folder and restart - see certs/README.txt.'
            : undefined,
        };
      }
    }));

    const certBundle = process.env.NODE_EXTRA_CA_CERTS ?? null;
    res.json({
      results,
      extraCaLoaded: certBundle,
      anyCertProblem: results.some((r) => r.certProblem),
    });
  });

  return router;
}
