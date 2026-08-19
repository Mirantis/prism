/**
 * Agent Runtime HTTP Server
 *
 * GET  /health         — liveness check
 *      /agents/*       — management routes (heartbeat, chat, cron lifecycle)
 *                        + inbound webhook ingestion (/agents/webhooks/:name)
 *      /threads, /latest-thread — thread resolve/list/open
 *      /messages       — thread history replay
 *      /               — Prism Web UI (static SPA bundle from web/dist)
 *
 * Auth is handled by Lens Agents inbound routing in front of the runtime;
 * the container itself trusts every incoming connection.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { managementRouter } from './routes/management';
import { threadsRouter } from './routes/threads';
import { messagesRouter } from './routes/messages';
import { webhookRouter } from './routes/webhook';
import { lockedInRouter } from './routes/locked-in';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '5mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'agent-runtime', timestamp: new Date().toISOString() });
  });

  // Management routes (heartbeat, cron lifecycle)
  app.use('/agents', managementRouter);

  // Inbound webhook ingestion (POST /agents/webhooks/:name)
  app.use('/agents', webhookRouter);

  // Locked-in mode (PATCH /agents/locked-in)
  app.use('/agents', lockedInRouter);

  // Thread and message routes: /threads, /latest-thread and /messages.
  // Mounted at the root and registered before the SPA fallback so these
  // explicit routes win over the static catch-all.
  app.use(threadsRouter);
  app.use(messagesRouter);

  // Prism Web UI. Skip the SPA mount silently when web/dist isn't
  // present (dev runs Vite separately on :5173). `PRISM_WEB_DIR` lets the
  // packaged binary point at its sidecar copy (the bundled `__dirname`
  // doesn't resolve to a real path inside a SEA).
  const webDist = process.env.PRISM_WEB_DIR
    ? path.resolve(process.env.PRISM_WEB_DIR)
    : path.resolve(__dirname, '../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: 'index.html' }));
    app.get(/^\/(?!agents|api|health|threads|messages|latest-thread).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  return app;
}
