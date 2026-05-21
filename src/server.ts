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

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '5mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'agent-runtime', timestamp: new Date().toISOString() });
  });

  // Management routes (heartbeat, cron lifecycle)
  app.use('/agents', managementRouter);

  // No-auth read endpoints for the local CLI (prism-cli).
  app.use('/single-agent', singleAgentRouter);

  // Prism Web UI. Skip the SPA mount silently when web/dist isn't
  // present (dev runs Vite separately on :5173).
  const webDist = path.resolve(__dirname, '../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: 'index.html' }));
    app.get(/^\/(?!agents|api|health|single-agent).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  return app;
}
