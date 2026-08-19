import { EventEmitter } from 'node:events';
import { randomToken } from '../util/crypto.js';
import log from '../util/logger.js';

const logger = log.scope('queue');

/**
 * Serial job queue shared by every plugin as `ctx.queue`.
 *
 * Slow work belongs here rather than inline in a message handler: jobs are
 * serialized, visible in the control panel, cancellable, and re-orderable.
 * Keeping concurrency low is deliberate - firing many outbound WhatsApp
 * actions at once is a good way to get the connection dropped.
 */
export class JobQueue extends EventEmitter {
  constructor({ concurrency = 1, maxLength = 50 } = {}) {
    super();
    this.concurrency = Math.max(1, concurrency);
    this.maxLength = maxLength;
    this.pending = [];
    this.active = new Map();
    this.history = [];
    this.paused = false;
    this.draining = false;
  }

  get size() {
    return this.pending.length + this.active.size;
  }

  /** @param {{label:string, meta?:object, run:(ctx)=>Promise<any>}} job */
  add(job) {
    if (this.pending.length >= this.maxLength) {
      const err = new Error(`Queue is full (${this.maxLength} waiting)`);
      err.code = 'QUEUE_FULL';
      throw err;
    }
    const entry = {
      id: randomToken(6),
      label: job.label ?? 'job',
      meta: job.meta ?? {},
      run: job.run,
      state: 'pending',
      progress: null,
      addedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelled: false,
    };
    this.pending.push(entry);
    this.emit('added', this.publicView(entry));
    this._drain();
    return entry.id;
  }

  cancel(id, reason = 'cancelled') {
    const idx = this.pending.findIndex((e) => e.id === id);
    if (idx !== -1) {
      const [entry] = this.pending.splice(idx, 1);
      entry.state = reason === 'skipped' ? 'skipped' : 'cancelled';
      entry.finishedAt = Date.now();
      this._archive(entry);
      this.emit('updated', this.publicView(entry));
      return true;
    }
    const running = this.active.get(id);
    if (running) {
      running.cancelled = true;
      running.cancelReason = reason;
      running.abort?.abort();
      return true;
    }
    return false;
  }

  /** Skip = abandon this job and move to the next. Distinct from cancel so
   *  the requester can be told it was skipped, not silently dropped. */
  skip(id) {
    return this.cancel(id, 'skipped');
  }

  /** Reorder a waiting job. dir is 'up' (sooner) or 'down' (later). */
  move(id, dir) {
    const i = this.pending.findIndex((e) => e.id === id);
    if (i === -1) return false;
    const j = dir === 'down' ? i + 1 : i - 1;
    if (j < 0 || j >= this.pending.length) return false;
    [this.pending[i], this.pending[j]] = [this.pending[j], this.pending[i]];
    this.emit('state', this.snapshot());
    return true;
  }

  /** Send a waiting job to the very front, next to run. */
  moveTop(id) {
    const i = this.pending.findIndex((e) => e.id === id);
    if (i <= 0) return i === 0;
    const [e] = this.pending.splice(i, 1);
    this.pending.unshift(e);
    this.emit('state', this.snapshot());
    return true;
  }

  pause() { this.paused = true; this.emit('state', this.snapshot()); }
  resume() { this.paused = false; this.emit('state', this.snapshot()); this._drain(); }

  clearPending() {
    const removed = this.pending.splice(0, this.pending.length);
    for (const e of removed) {
      e.state = 'cancelled';
      e.finishedAt = Date.now();
      this._archive(e);
    }
    this.emit('state', this.snapshot());
    return removed.length;
  }

  async _drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.paused && this.active.size < this.concurrency && this.pending.length) {
        const entry = this.pending.shift();
        this._start(entry);
      }
    } finally {
      this.draining = false;
    }
  }

  _start(entry) {
    entry.state = 'running';
    entry.startedAt = Date.now();
    entry.abort = new AbortController();
    this.active.set(entry.id, entry);

    // Concurrency is load-bearing: it is what keeps plugins from firing a
    // burst of outbound actions at WhatsApp. Log it so a breach is visible
    // rather than silently thrashing.
    logger.info(`▶ start ${entry.label} (${this.active.size}/${this.concurrency} active, ${this.pending.length} waiting)`);
    if (this.active.size > this.concurrency) {
      logger.error(`concurrency breached: ${this.active.size} jobs running with a limit of ${this.concurrency}`);
    }
    this.emit('updated', this.publicView(entry));

    const ctx = {
      id: entry.id,
      signal: entry.abort.signal,
      isCancelled: () => entry.cancelled,
      cancelReason: () => entry.cancelReason ?? null,
      /**
       * `info` may be a plain string or a structured object carrying stage,
       * transfer rate and ETA. Keeping the structure lets the UI render a
       * real progress panel rather than re-parsing a sentence.
       */
      progress: (info, pct) => {
        const o = typeof info === 'string' ? { text: info } : (info ?? {});
        entry.progress = {
          ...o,
          text: o.text ?? '',
          stage: o.stage ?? entry.progress?.stage ?? null,
          pct: pct ?? o.pct ?? null,
          at: Date.now(),
        };
        this.emit('progress', this.publicView(entry));
      },
    };

    Promise.resolve()
      .then(() => entry.run(ctx))
      .then((result) => {
        entry.state = entry.cancelled ? 'cancelled' : 'done';
        entry.result = result;
      })
      .catch((err) => {
        entry.state = entry.cancelled ? 'cancelled' : 'failed';
        entry.error = err?.message ?? String(err);
        logger.error(`job ${entry.label} failed: ${entry.error}`);
      })
      .finally(() => {
        entry.finishedAt = Date.now();
        this.active.delete(entry.id);
        const secs = Math.round((entry.finishedAt - entry.startedAt) / 1000);
        logger.info(`■ end   ${entry.label} → ${entry.state} after ${secs}s (${this.active.size} still active)`);
        this._archive(entry);
        this.emit('updated', this.publicView(entry));
        this._drain();
      });
  }

  _archive(entry) {
    this.history.unshift(this.publicView(entry));
    if (this.history.length > 100) this.history.pop();
  }

  publicView(e) {
    return {
      id: e.id,
      label: e.label,
      meta: e.meta,
      state: e.state,
      progress: e.progress,
      addedAt: e.addedAt,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
      error: e.error,
    };
  }

  snapshot() {
    return {
      paused: this.paused,
      concurrency: this.concurrency,
      active: [...this.active.values()].map((e) => this.publicView(e)),
      pending: this.pending.map((e) => this.publicView(e)),
      history: this.history.slice(0, 25),
    };
  }
}
