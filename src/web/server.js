import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import log from '../util/logger.js';
import { createApiRouter } from './api.js';
import { FileSessionStore } from './session-store.js';

const logger = log.scope('web');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer({ configStore, bot, queue, pluginManager, stateStore, fileLogger, alerts, lockScheduler }) {
  const cfg = configStore.get();
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  app.use(session({
    name: 'wabot.sid',
    secret: cfg.web.sessionSecret,
    // Persisted, so a restart does not log the operator out and leave the
    // UI reporting "unauthorized" against whatever they were doing.
    store: new FileSessionStore({
      file: path.join(configStore.dataDir, 'sessions.json'),
    }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000,
      // secure:true would break plain-http access on the LAN, which is the
      // documented deployment. Put a TLS proxy in front for anything public.
      secure: false,
    },
  }));

  app.use('/api', createApiRouter({ configStore, bot, queue, pluginManager, stateStore, fileLogger, alerts, lockScheduler }));

  /* Server-sent events: live status, queue, and log lines for the dashboard. */
  app.get('/events', (req, res) => {
    if (!req.session?.user) return res.status(401).end();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { /* client vanished */ }
    };

    send('status', bot.status());
    send('queue', queue.snapshot());

    const onState = (s) => send('status', s);
    const onGroups = (g) => send('groups', g);
    const onGroupEvent = (ev) => send('groupevent', ev);
    const onQueue = () => send('queue', queue.snapshot());
    const onLog = (line) => send('log', line);

    bot.on('state', onState);
    bot.on('groups', onGroups);
    bot.on('group-event', onGroupEvent);
    queue.on('added', onQueue);
    queue.on('updated', onQueue);
    queue.on('progress', onQueue);
    queue.on('state', onQueue);
    log.on('line', onLog);

    const ping = setInterval(() => send('ping', Date.now()), 25_000);

    req.on('close', () => {
      clearInterval(ping);
      bot.off('state', onState);
      bot.off('groups', onGroups);
      bot.off('group-event', onGroupEvent);
      queue.off('added', onQueue);
      queue.off('updated', onQueue);
      queue.off('progress', onQueue);
      queue.off('state', onQueue);
      log.off('line', onLog);
    });
  });

  // Revalidate assets on every load. During rapid iteration a cached broken
  // app.js would otherwise blank the page until a manual hard-refresh; ETags
  // make the browser check freshness each time (a 304 when unchanged is cheap).
  app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    etag: true,
    lastModified: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // SPA fallback so a refresh on any path still loads the UI.
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.use((err, req, res, next) => {
    logger.error(`unhandled: ${err.message}`);
    res.status(500).json({ error: err.message });
  });

  return app;
}

export function startServer(app, configStore) {
  const { port, bindAddress } = configStore.get().web;
  return new Promise((resolve, reject) => {
    const server = app.listen(port, bindAddress, () => {
      logger.info(`control panel listening on http://${bindAddress}:${port}`);
      if (bindAddress === '0.0.0.0') {
        logger.warn('bound to all interfaces - reachable from your LAN. Do not port-forward this without HTTPS in front.');
      }
      resolve(server);
    });
    server.on('error', reject);
  });
}
