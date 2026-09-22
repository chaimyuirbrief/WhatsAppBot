import { hashPassword, verifyPassword } from '../util/crypto.js';
import log from '../util/logger.js';

const logger = log.scope('auth');

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

const clientKey = (req) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

export function isRateLimited(req) {
  const rec = attempts.get(clientKey(req));
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(clientKey(req)); return false; }
  return rec.count >= MAX_ATTEMPTS;
}
export function recordFailure(req) {
  const key = clientKey(req);
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
  logger.warn(`failed login from ${key} (${attempts.get(key).count}/${MAX_ATTEMPTS})`);
}
export function clearFailures(req) { attempts.delete(clientKey(req)); }

const SUPER = 'superadmin';   // fixed username for the shared super-admin

/**
 * How long an account may stay signed in to the panel, in minutes.
 *
 * 0 means "never expires", and only a super-admin account may have it. An
 * ordinary admin with an unlimited session is the thing this exists to
 * prevent: the panel holds a live WhatsApp session on a LAN, and a browser
 * left open on someone's desk is the realistic way that gets used by someone
 * it was not issued to.
 */
export const DEFAULT_ADMIN_SESSION_MINUTES = 240;      // 4 hours
export const MAX_SESSION_MINUTES = 60 * 24 * 30;       // a month, as a sanity ceiling
export const NO_TIMEOUT = 0;

/**
 * The cap actually in force for an account.
 *
 * Resolved from the CURRENT role every time, not from whatever was stored: if
 * a super-admin with an unlimited session is demoted to admin, that stored 0
 * must stop meaning unlimited immediately, not at their next sign-in.
 *
 * An account with nothing stored (one that predates this setting) keeps the
 * old behaviour if it is a super-admin, and gets the default if it is not —
 * upgrading should not silently leave ordinary admins unlimited.
 */
export function sessionMinutesFor(admin) {
  const isSuper = admin?.role === 'superadmin';
  const raw = admin?.sessionMinutes;
  const stored = Number.isInteger(raw) && raw >= 0 && raw <= MAX_SESSION_MINUTES ? raw : null;

  if (stored === null) return isSuper ? NO_TIMEOUT : DEFAULT_ADMIN_SESSION_MINUTES;
  if (stored === NO_TIMEOUT && !isSuper) return DEFAULT_ADMIN_SESSION_MINUTES;
  return stored;
}

/** When a session that started at `loginAt` must end, or null if never. */
export function sessionExpiresAt(admin, loginAt) {
  const mins = sessionMinutesFor(admin);
  if (!mins || !loginAt) return null;
  return loginAt + mins * 60_000;
}

/**
 * Set an account's session cap. Super-admin only (the caller enforces that);
 * 0 is refused for anyone who is not a super-admin.
 */
export function setSessionMinutes(cs, username, minutes) {
  const target = findAdmin(cs, username);
  if (!target) throw new Error('no such account');

  const n = Number(minutes);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SESSION_MINUTES) {
    throw new Error(`Minutes must be a whole number between 0 and ${MAX_SESSION_MINUTES}`);
  }
  if (n === NO_TIMEOUT && target.role !== 'superadmin') {
    throw new Error('Only a super-admin account can have no timeout. Set at least 1 minute.');
  }

  const list = admins(cs).map((a) => (norm(a.username) === norm(username) ? { ...a, sessionMinutes: n } : a));
  cs.update({ web: { admins: list } });
  logger.info(`session cap for "${target.username}" set to ${n === 0 ? 'no timeout' : `${n} min`}`);
  return n;
}

function admins(cs) { return cs.get().web.admins ?? []; }
const norm = (u) => String(u ?? '').trim().toLowerCase();

/**
 * One-time upgrade: fold the legacy single password into a super-admin account
 * so nobody is locked out after the multi-account change.
 */
export function migrateIfNeeded(cs) {
  const web = cs.get().web;
  if ((web.admins?.length ?? 0) === 0 && web.adminPasswordHash) {
    cs.update({ web: {
      admins: [{ username: SUPER, passwordHash: web.adminPasswordHash, role: 'superadmin', createdAt: Date.now(), lastLogin: null }],
      adminPasswordHash: '',
    } });
    logger.warn(`migrated legacy password into the "${SUPER}" super-admin account`);
  }
}

/** No accounts and no legacy password -> first-run setup screen. */
export function needsSetup(cs) {
  const web = cs.get().web;
  return (web.admins?.length ?? 0) === 0 && !web.adminPasswordHash;
}

export function setupSuperAdmin(cs, password) {
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  cs.update({ web: {
    admins: [{ username: SUPER, passwordHash: hashPassword(password), role: 'superadmin', createdAt: Date.now(), lastLogin: null }],
    adminPasswordHash: '',
  } });
  logger.info('super-admin account created');
}

export function findAdmin(cs, username) {
  return admins(cs).find((a) => norm(a.username) === norm(username)) ?? null;
}

/** Returns { username, role } on success, else null. Records lastLogin. */
export function authenticate(cs, username, password) {
  migrateIfNeeded(cs);
  const user = norm(username) || SUPER;     // blank username defaults to the super-admin
  const admin = findAdmin(cs, user);
  if (!admin || !verifyPassword(password, admin.passwordHash)) return null;
  const list = admins(cs).map((a) => (norm(a.username) === norm(user) ? { ...a, lastLogin: Date.now() } : a));
  cs.update({ web: { admins: list } });
  return { username: admin.username, role: admin.role };
}

export function listAdmins(cs) {
  return admins(cs).map((a) => ({
    username: a.username,
    role: a.role,
    createdAt: a.createdAt,
    lastLogin: a.lastLogin,
    // The effective cap, not the stored one: what the portal shows must be
    // what is actually enforced.
    sessionMinutes: sessionMinutesFor(a),
    sessionMinutesSet: Number.isInteger(a.sessionMinutes),
  }));
}

export function addAdmin(cs, username, password, role = 'admin', sessionMinutes = null) {
  const u = String(username ?? '').trim();
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(u)) throw new Error('Username must be 2-32 chars: letters, numbers, . _ -');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  if (!['admin', 'superadmin'].includes(role)) throw new Error('invalid role');
  if (findAdmin(cs, u)) throw new Error(`"${u}" already exists`);

  let mins = null;
  if (sessionMinutes !== null && sessionMinutes !== undefined && sessionMinutes !== '') {
    const n = Number(sessionMinutes);
    if (!Number.isInteger(n) || n < 0 || n > MAX_SESSION_MINUTES) {
      throw new Error(`Minutes must be a whole number between 0 and ${MAX_SESSION_MINUTES}`);
    }
    if (n === NO_TIMEOUT && role !== 'superadmin') {
      throw new Error('Only a super-admin account can have no timeout. Set at least 1 minute.');
    }
    mins = n;
  }

  const record = { username: u, passwordHash: hashPassword(password), role, createdAt: Date.now(), lastLogin: null };
  if (mins !== null) record.sessionMinutes = mins;
  cs.update({ web: { admins: [...admins(cs), record] } });
  logger.info(`added ${role} "${u}"${mins !== null ? ` (session ${mins === 0 ? 'unlimited' : `${mins} min`})` : ''}`);
}

export function removeAdmin(cs, username) {
  const target = findAdmin(cs, username);
  if (!target) throw new Error('no such account');
  const supers = admins(cs).filter((a) => a.role === 'superadmin');
  if (target.role === 'superadmin' && supers.length <= 1) throw new Error('cannot remove the last super-admin');
  cs.update({ web: { admins: admins(cs).filter((a) => norm(a.username) !== norm(username)) } });
  logger.info(`removed account "${target.username}"`);
}

export function resetPassword(cs, username, newPassword) {
  if (!findAdmin(cs, username)) throw new Error('no such account');
  if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters');
  const list = admins(cs).map((a) => (norm(a.username) === norm(username) ? { ...a, passwordHash: hashPassword(newPassword) } : a));
  cs.update({ web: { admins: list } });
  logger.info(`reset password for "${username}"`);
}

/**
 * Stamp the clock on a session that has just signed in, and match the cookie
 * to it so the browser forgets at roughly the same time the server does.
 */
export function startSession(cs, req, user) {
  req.session.user = user;
  req.session.loginAt = Date.now();
  const mins = sessionMinutesFor(findAdmin(cs, user.username) ?? user);
  if (mins > 0) req.session.cookie.maxAge = mins * 60_000;
  return req.session.loginAt;
}

/**
 * The gate on every API call.
 *
 * Checked against the CURRENT config on every request rather than trusting
 * what was put in the session at sign-in, so shortening someone's cap — or
 * removing their account outright — takes effect on the session they already
 * have, not at some future login that may never come. The cookie's own maxAge
 * is a convenience for the browser; this is the part that is enforced.
 */
export function requireAuth(cs) {
  return (req, res, next) => {
    if (needsSetup(cs)) return res.status(428).json({ error: 'setup-required' });
    const user = req.session?.user;
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const admin = findAdmin(cs, user.username);
    if (!admin) {
      logger.warn(`session for removed account "${user.username}" rejected`);
      return endSession(req, res, 'Your account no longer exists');
    }

    // A role change since sign-in applies now, in both directions.
    if (admin.role !== user.role) {
      req.session.user = { username: admin.username, role: admin.role };
      logger.info(`session role for "${admin.username}" updated to ${admin.role}`);
    }

    const mins = sessionMinutesFor(admin);
    if (mins > 0) {
      // Sessions issued before this setting existed carry no loginAt. Start
      // their clock now rather than logging everyone out on upgrade - they
      // were legitimately issued, and the cookie has its own cap besides.
      if (!req.session.loginAt) req.session.loginAt = Date.now();
      if (Date.now() - req.session.loginAt > mins * 60_000) {
        logger.info(`session for "${admin.username}" expired after ${mins} min`);
        return endSession(req, res, `Your session ended after ${mins} minutes. Please sign in again.`);
      }
    }
    return next();
  };
}

/** Tear the session down and answer 401 once, whatever the store does. */
function endSession(req, res, message) {
  const done = () => {
    res.clearCookie('wabot.sid');
    res.status(401).json({ error: message, expired: true });
  };
  try { req.session.destroy(done); } catch { done(); }
}

export function requireSuperAdmin(cs) {
  return (req, res, next) => {
    if (req.session?.user?.role === 'superadmin') return next();
    return res.status(403).json({ error: 'super-admin only' });
  };
}
