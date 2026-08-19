import log from './logger.js';

const logger = log.scope('mail');

// Lazy import: the app must still boot if the dependency is missing.
let nodemailer = null;
async function loadNodemailer() {
  if (!nodemailer) {
    const mod = await import('nodemailer');
    nodemailer = mod.default ?? mod;
  }
  return nodemailer;
}

/**
 * Common providers. Gmail and Outlook both require an *app password* rather
 * than the account password once two-factor is on, which is what the settings
 * page asks for.
 */
export const PRESETS = {
  gmail:   { host: 'smtp.gmail.com',       port: 465, secure: true },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  yahoo:   { host: 'smtp.mail.yahoo.com',  port: 465, secure: true },
  custom:  null,
};

function resolveSettings(cfg) {
  const preset = PRESETS[cfg.provider] ?? null;
  return {
    host: preset?.host ?? cfg.host,
    port: preset?.port ?? Number(cfg.port),
    secure: preset ? preset.secure : !!cfg.secure,
    user: cfg.user,
    pass: cfg.appPassword,
    from: cfg.from || cfg.user,
    to: cfg.to || cfg.user,
  };
}

async function makeTransport(cfg) {
  const s = resolveSettings(cfg);
  if (!s.host) throw new Error('No SMTP host set');
  if (!s.user) throw new Error('No email address set');
  if (!s.pass) throw new Error('No app password set');

  const nm = await loadNodemailer();
  return {
    transport: nm.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: { user: s.user, pass: s.pass },
      // A dead SMTP server must not wedge the queue.
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    }),
    settings: s,
  };
}

/** Turn SMTP's terse failures into something actionable. */
function describe(err) {
  const m = String(err?.message ?? err);
  if (/Invalid login|535|BadCredentials/i.test(m)) {
    return 'Rejected the login. With Gmail or Outlook you need an app password, '
         + 'not your normal account password - and two-factor must be on to create one.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'Could not resolve the SMTP host - check the hostname.';
  if (/ECONNREFUSED/i.test(m)) return 'Nothing is listening on that SMTP host and port.';
  if (/ETIMEDOUT|timeout/i.test(m)) return 'Timed out reaching the SMTP server. Port 465 or 587 may be blocked outbound.';
  if (/self.signed|unable to verify/i.test(m)) return 'The SMTP server presented an untrusted certificate.';
  return m;
}

export async function verifyEmail(cfg) {
  try {
    const { transport, settings } = await makeTransport(cfg);
    await transport.verify();
    transport.close();
    return { ok: true, detail: `${settings.host}:${settings.port} as ${settings.user}` };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

export async function sendMail(cfg, { subject, text, attachments = [] }) {
  const { transport, settings } = await makeTransport(cfg);
  try {
    const info = await transport.sendMail({
      from: settings.from,
      to: settings.to,
      subject,
      text,
      attachments,
    });
    logger.info(`sent "${subject}" to ${settings.to}`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    const detail = describe(err);
    logger.error(`could not send mail: ${detail}`);
    throw new Error(detail);
  } finally {
    transport.close();
  }
}

export async function sendTestEmail(cfg) {
  try {
    const r = await sendMail(cfg, {
      subject: 'WhatsApp Bot — test email',
      text: [
        'This is a test from your WhatsApp bot control panel.',
        '',
        'If you are reading this, email delivery works and the bot can send',
        'you debug logs and error alerts.',
        '',
        `Sent: ${new Date().toISOString()}`,
        `Host: ${resolveSettings(cfg).host}`,
      ].join('\n'),
    });
    return { ok: true, messageId: r.messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Email the debug log as a gzipped attachment. */
export async function sendLog(cfg, { logText, label = 'debug log', note = '' }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zlib = await import('node:zlib');
  const gz = zlib.gzipSync(Buffer.from(logText || '(log is empty)', 'utf8'));

  const lines = logText ? logText.split('\n').length : 0;
  const errors = (logText.match(/\[ERROR\]/g) || []).length;
  const warns = (logText.match(/\[WARN /g) || []).length;

  return sendMail(cfg, {
    subject: `WhatsApp Bot — ${label} (${errors} errors, ${warns} warnings)`,
    text: [
      note || `Attached is the ${label} from your WhatsApp bot.`,
      '',
      `Lines    : ${lines}`,
      `Errors   : ${errors}`,
      `Warnings : ${warns}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      errors ? 'Most recent errors:' : '',
      ...(errors
        ? logText.split('\n').filter((l) => l.includes('[ERROR]')).slice(-15)
        : []),
    ].filter(Boolean).join('\n'),
    attachments: [{ filename: `whatsapp-bot-${stamp}.log.gz`, content: gz }],
  });
}
