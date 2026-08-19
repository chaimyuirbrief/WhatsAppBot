import log from '../util/logger.js';
import { sendLog } from '../util/mailer.js';

const logger = log.scope('alerts');

/**
 * Watches the log stream and emails when things go wrong.
 *
 * Throttled hard: a failing loop can produce thousands of errors a minute,
 * and the point of an alert is to tell you once, not to fill your inbox.
 * Errors that arrive during the quiet period are counted and summarised in
 * the next message rather than dropped silently.
 */
export class AlertWatcher {
  constructor({ configStore, fileLogger }) {
    this.configStore = configStore;
    this.fileLogger = fileLogger;
    this.lastSent = 0;
    this.suppressed = [];
    this.attached = false;
  }

  get cfg() { return this.configStore.get().email; }

  attach() {
    if (this.attached) return;
    this.attached = true;
    log.on('line', (entry) => {
      if (entry.level !== 'error') return;
      // Never alert about the alerting itself - that is how loops start.
      if (entry.scope === 'alerts' || entry.scope === 'mail') return;
      this.onError(entry);
    });
    logger.info('error alerting armed');
  }

  onError(entry) {
    const cfg = this.cfg;
    if (!cfg?.enabled || !cfg.onError) return;

    const throttleMs = Math.max(1, cfg.errorThrottleMinutes ?? 30) * 60_000;
    const since = Date.now() - this.lastSent;

    if (since < throttleMs) {
      this.suppressed.push(entry);
      return;
    }

    this.lastSent = Date.now();
    const held = this.suppressed.splice(0, this.suppressed.length);

    const note = [
      `An error was logged by the WhatsApp bot.`,
      '',
      `  ${entry.ts}`,
      `  (${entry.scope}) ${entry.msg}`,
      '',
      held.length
        ? `${held.length} further error(s) were suppressed during the previous ${cfg.errorThrottleMinutes} minute quiet period.`
        : '',
      `Further alerts are paused for ${cfg.errorThrottleMinutes} minutes.`,
    ].filter(Boolean).join('\n');

    sendLog(cfg, {
      logText: this.fileLogger.today(),
      label: 'error alert',
      note,
    }).catch((err) => {
      // Log at warn, not error - an error here would re-enter this handler.
      logger.warn(`could not send error alert: ${err.message}`);
    });
  }

  /** Manually trigger a summary, used by the "email me the log" button. */
  async sendNow({ label = 'debug log', note = '' } = {}) {
    const cfg = this.cfg;
    if (!cfg?.enabled) throw new Error('Email is not enabled in Settings');
    return sendLog(cfg, { logText: this.fileLogger.today(), label, note });
  }
}
