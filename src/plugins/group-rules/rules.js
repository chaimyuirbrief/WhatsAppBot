/**
 * Resolve which rules text (if any) to reply with for an inbound message.
 *
 * Commands:
 *   #rules            master command.
 *                     - inside a group that has an assigned set -> that set's text
 *                     - in a DM (or an unassigned group) -> the master `rules`
 *                       text, or a menu of the available #rules-* commands
 *   #rules-<name>     a specific rule set, answered verbatim anywhere
 *
 * Pure and side-effect free so it can be unit-tested without a socket.
 * Returns { text, command } or null when the message isn't a rules command.
 */
export function rulesReplyFor(cfg = {}, msg = {}) {
  const t = (msg.text || '').trim().toLowerCase();
  if (!t) return null;

  const master = (cfg.rulesCommand || '#rules').toLowerCase();
  const sets = Array.isArray(cfg.ruleSets) ? cfg.ruleSets : [];

  // Exact match on a specific set command (e.g. "#rules-support").
  const hit = sets.find((s) => (s.command || '').trim().toLowerCase() === t);
  if (hit && (hit.text || '').trim()) return { text: hit.text.trim(), command: hit.command };

  if (t === master) {
    // Inside a group with an assigned set, serve that set.
    if (msg.isGroup) {
      const assigned = cfg.groupRuleSet?.[msg.chatJid];
      if (assigned) {
        const s = sets.find((x) => (x.command || '').trim().toLowerCase() === String(assigned).trim().toLowerCase());
        if (s && (s.text || '').trim()) return { text: s.text.trim(), command: master };
      }
    }
    // Otherwise the master combined text.
    const base = (cfg.rules || '').trim();
    if (base) return { text: base, command: master };
    // Nothing combined set yet: offer a menu of the specific commands.
    const withText = sets.filter((s) => (s.command || '').trim() && (s.text || '').trim());
    if (withText.length) {
      const menu = 'Available rules — send any of these:\n' +
        withText.map((s) => `• ${s.command}${s.label ? ` — ${s.label}` : ''}`).join('\n');
      return { text: menu, command: master };
    }
  }

  return null;
}

/** True if the message text is any known rules command (master or a set). */
export function isRulesCommand(cfg = {}, msg = {}) {
  return rulesReplyFor(cfg, msg) != null;
}
