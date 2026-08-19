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
  return admins(cs).map(({ username, role, createdAt, lastLogin }) => ({ username, role, createdAt, lastLogin }));
}

export function addAdmin(cs, username, password, role = 'admin') {
  const u = String(username ?? '').trim();
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(u)) throw new Error('Username must be 2-32 chars: letters, numbers, . _ -');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  if (!['admin', 'superadmin'].includes(role)) throw new Error('invalid role');
  if (findAdmin(cs, u)) throw new Error(`"${u}" already exists`);
  const list = [...admins(cs), { username: u, passwordHash: hashPassword(password), role, createdAt: Date.now(), lastLogin: null }];
  cs.update({ web: { admins: list } });
  logger.info(`added ${role} "${u}"`);
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

export function requireAuth(cs) {
  return (req, res, next) => {
    if (needsSetup(cs)) return res.status(428).json({ error: 'setup-required' });
    if (req.session?.user) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };
}

export function requireSuperAdmin(cs) {
  return (req, res, next) => {
    if (req.session?.user?.role === 'superadmin') return next();
    return res.status(403).json({ error: 'super-admin only' });
  };
}
