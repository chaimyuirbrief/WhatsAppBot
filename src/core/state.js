import fs from 'node:fs';
import path from 'node:path';
import log from '../util/logger.js';

const logger = log.scope('state');

/**
 * Dead-simple persistent key/value store (one JSON file, debounced writes).
 * Used for request history, per-user cooldowns, and anything a plugin
 * wants to remember across restarts. Deliberately not a database - this
 * box has 900MB of RAM and the data is small.
 */
export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    this._timer = null;
    this.load();
  }

  load() {
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (err) {
        logger.error(`state file unreadable, starting fresh: ${err.message}`);
        this.data = {};
      }
    }
  }

  _scheduleSave() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        logger.error(`state save failed: ${err.message}`);
      }
    }, 500);
    this._timer.unref?.();
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch (err) {
      logger.error(`state flush failed: ${err.message}`);
    }
  }

  namespace(ns) {
    if (!this.data[ns]) this.data[ns] = {};
    const self = this;
    return {
      get(key, fallback = null) {
        const v = self.data[ns][key];
        return v === undefined ? fallback : v;
      },
      set(key, value) {
        self.data[ns][key] = value;
        self._scheduleSave();
        return value;
      },
      delete(key) {
        delete self.data[ns][key];
        self._scheduleSave();
      },
      all() { return { ...self.data[ns] }; },
      /** Append to a capped array - handy for history logs. */
      push(key, value, cap = 200) {
        const arr = self.data[ns][key] ?? [];
        arr.unshift(value);
        if (arr.length > cap) arr.length = cap;
        self.data[ns][key] = arr;
        self._scheduleSave();
        return arr;
      },
    };
  }
}
