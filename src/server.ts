/**
 * Agent Runtime HTTP Server
 *
 * GET  /health         — liveness check
 *      /agents/*       — management routes (heartbeat, chat, cron lifecycle)
 *      /single-agent/* — no-auth read endpoints for the local CLI
 *      /               — Prism Web UI (static SPA bundle from web/dist)
 *
 * Auth is handled by Nexus inbound routing in front of the runtime;
 * the container itself trusts every incoming connection.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { managementRouter } from './routes/management';
import { singleAgentRouter } from './routes/single-agent';
import { teamsAdapterService } from './services/teams-adapter.service';
import { logger } from './logger';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '5mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'agent-runtime', timestamp: new Date().toISOString() });
  });

  // Microsoft Teams bot messaging endpoint. The Bot Framework connector
  // POSTs activities here; the CloudAdapter validates the JWT and routes
  // them into the Teams adapter. (No Socket Mode equivalent exists for
  // Teams — the Azure Bot registration's messaging endpoint must point at
  // this path.)
  app.post('/api/teams/messages', (req, res) => {
    teamsAdapterService.processIncoming(req, res).catch((error) => {
      logger.error('Teams messaging endpoint error: %s', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  });

  // Management routes (heartbeat, cron lifecycle)
  app.use('/agents', managementRouter);

  // No-auth read endpoints for the local CLI (prism-cli).
  app.use('/single-agent', singleAgentRouter);

  // Prism Web UI. Skip the SPA mount silently when web/dist isn't
  // present (dev runs Vite separately on :5173). `PRISM_WEB_DIR` lets the
  // packaged binary point at its sidecar copy (the bundled `__dirname`
  // doesn't resolve to a real path inside a SEA).
  const webDist = process.env.PRISM_WEB_DIR
    ? path.resolve(process.env.PRISM_WEB_DIR)
    : path.resolve(__dirname, '../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: 'index.html' }));
    app.get(/^\/(?!agents|api|health|single-agent).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  return app;
}
