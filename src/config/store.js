import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, SECRET_PATHS, mergeDefaults, getPath, setPath } from './schema.js';
import { encrypt, decrypt, isEncrypted, randomToken } from '../util/crypto.js';
import log from '../util/logger.js';

const logger = log.scope('config');
export const MASK = '••••••••';

/**
 * Loads/saves data/config.json, transparently encrypting secret fields.
 * In-memory the config is always plaintext; encryption happens on write.
 */
export class ConfigStore {
  constructor({ dataDir, masterKey }) {
    this.dataDir = dataDir;
    this.masterKey = masterKey;
    this.file = path.join(dataDir, 'config.json');
    this.config = null;
    this.listeners = new Set();
  }

  load() {
    let stored = {};
    if (fs.existsSync(this.file)) {
      try {
        stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (err) {
        logger.error(`config.json is not valid JSON, falling back to defaults: ${err.message}`);
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(this.file, backup); logger.warn(`saved copy to ${backup}`); } catch {}
        stored = {};
      }
    }

    const merged = mergeDefaults(stored, DEFAULT_CONFIG);
    // Decrypt secrets into memory
    for (const p of SECRET_PATHS) {
      const v = getPath(merged, p);
      if (isEncrypted(v)) setPath(merged, p, decrypt(v, this.masterKey));
    }

    this.config = merged;

    // First-run bootstrap
    let dirty = false;
    if (!this.config.web.sessionSecret) {
      this.config.web.sessionSecret = randomToken(32);
      dirty = true;
    }
    if (dirty) this.save();

    return this.config;
  }

  save() {
    const out = JSON.parse(JSON.stringify(this.config));
    for (const p of SECRET_PATHS) {
      const v = getPath(out, p);
      if (v) setPath(out, p, encrypt(v, this.masterKey));
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);   // atomic; avoids a truncated config on crash
    return this.config;
  }

  get() {
    return this.config;
  }

  /**
   * Apply a partial update (deep merge). Values equal to MASK are treated as
   * "unchanged" so the UI can round-trip a form without leaking real secrets.
   */
  update(patch) {
    const before = JSON.stringify(this.config);
    deepAssign(this.config, patch);
    for (const p of SECRET_PATHS) {
      if (getPath(this.config, p) === MASK) {
        const prev = getPath(JSON.parse(before), p);
        setPath(this.config, p, prev);
      }
    }
    this.save();
    for (const fn of this.listeners) {
      try { fn(this.config); } catch (err) { logger.error(`config listener failed: ${err.message}`); }
    }
    return this.config;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Config safe to hand to the browser: secrets replaced with a mask. */
  redacted() {
    const out = JSON.parse(JSON.stringify(this.config));
    for (const p of SECRET_PATHS) {
      if (getPath(out, p)) setPath(out, p, MASK);
    }
    // Password hashes never leave the server, masked or not.
    setPath(out, 'web.adminPasswordHash', getPath(this.config, 'web.adminPasswordHash') ? MASK : '');
    if (Array.isArray(out.web?.admins)) {
      out.web.admins = out.web.admins.map(({ passwordHash, ...a }) => a);   // strip hashes
    }
    delete out.web.sessionSecret;
    return out;
  }
}

function deepAssign(target, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (target[k] == null || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
      deepAssign(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}
