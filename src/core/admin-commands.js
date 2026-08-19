/**
 * Local admin command channel.
 *
 * Privileged, one-off group operations (backing up descriptions, rewriting them
 * in bulk, seeding per-group rule sets) need to be driven by whoever runs the
 * box, without the web-panel password. index.js polls a single JSON file in the
 * data dir and hands each command here. Everything is local to the server, only
 * whitelisted ops run, and every execution is logged by the caller.
 */
import fs from 'node:fs';
import path from 'node:path';

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Snapshot every group's description into data/backups/. The "original" file is
 * write-once per group: a description is only recorded the first time we see it,
 * so the pre-edit text is preserved even after we rewrite descriptions later.
 * A rolling "latest" snapshot is always refreshed for convenience.
 */
export function backupOriginalDescriptions(bot, dataDir, now = Date.now()) {
  const backupsDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const originalFile = path.join(backupsDir, 'original-descriptions.json');

  let original = {};
  if (fs.existsSync(originalFile)) {
    try { original = JSON.parse(fs.readFileSync(originalFile, 'utf8')) || {}; }
    catch { original = {}; }
  }

  const snap = bot.groupDescriptionsSnapshot();
  let added = 0;
  for (const g of snap) {
    if (!(g.jid in original)) {
      original[g.jid] = { subject: g.subject, desc: g.desc, savedAt: now };
      added++;
    }
  }
  writeJson(originalFile, original);
  writeJson(path.join(backupsDir, 'descriptions-latest.json'), { at: now, groups: snap });
  return { total: snap.length, newlyBackedUp: added, originalFile };
}

/** Execute one admin command against the live bot. Throws on unknown ops. */
export async function runAdminCommand(cmd, { bot, dataDir, configStore } = {}) {
  switch (cmd?.op) {
    case 'dump-descriptions': {
      const groups = bot.groupDescriptionsSnapshot();
      return { ok: true, count: groups.length, groups };
    }

    case 'dump-groups': {
      // Includes the community each group is linked to, which decides whether
      // a group @-mention will actually render for members.
      return { ok: true, groups: bot.groups() };
    }

    case 'backup-descriptions': {
      const res = backupOriginalDescriptions(bot, dataDir);
      return { ok: true, ...res };
    }

    case 'apply-descriptions': {
      if (!Array.isArray(cmd.plan)) throw new Error('plan must be an array of { jid, desc }');
      // Snapshot originals before editing, so we never overwrite without a backup.
      backupOriginalDescriptions(bot, dataDir);
      const results = await bot.applyDescriptions(cmd.plan);
      return { ok: true, results };
    }

    case 'set-rule-sets': {
      if (!configStore) throw new Error('configStore unavailable');
      const patch = { groupRules: {} };
      if (Array.isArray(cmd.ruleSets)) patch.groupRules.ruleSets = cmd.ruleSets;
      if (cmd.groupRuleSet && typeof cmd.groupRuleSet === 'object') patch.groupRules.groupRuleSet = cmd.groupRuleSet;
      if (typeof cmd.rules === 'string') patch.groupRules.rules = cmd.rules;
      configStore.update(patch);
      const gr = configStore.get().groupRules;
      return { ok: true, ruleSets: gr.ruleSets, groupRuleSet: gr.groupRuleSet };
    }

    default:
      throw new Error(`unknown op: ${cmd?.op ?? '(none)'}`);
  }
}
