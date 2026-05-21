/**
 * Agent Runtime HTTP Server
 *
 * GET  /health    — liveness check
 *      /agents/*  — management routes (heartbeat, chat, cron lifecycle)
 *
 * In single-agent mode the Prism Web UI is also served from this app
 * (static SPA bundle from web/dist), and the management routes are
 * exposed without INTERNAL_API_SECRET because Nexus inbound routing
 * (AGENT-10) terminates auth before requests reach the container.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { managementRouter } from './routes/management';
import { singleAgentRouter } from './routes/single-agent';

/**
 * Auth middleware for internal endpoints.
 *
 * - Multi-tenant mode: validates INTERNAL_API_SECRET bearer token (backend → runtime).
 * - Single-agent mode: no-op. Inbound routing handles auth in front of the container,
 *   so requests reaching the runtime are already authenticated.
 */
export function internalAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (config.singleAgentMode) {
    next();
    return;
  }

  if (!config.internalApiSecret) {
    res.status(500).json({ error: 'INTERNAL_API_SECRET not configured for agent-runtime' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${config.internalApiSecret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '5mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'agent-runtime', timestamp: new Date().toISOString() });
  });

  // Management routes (heartbeat, cron lifecycle)
  app.use('/agents', managementRouter);

  // Single-agent mode: serve the bundled Prism Web UI AND expose the
  // no-auth read endpoints for the local CLI (prism-cli). Mounted only
  // when SINGLE_AGENT_MODE=true so multi-tenant deployments don't expose
  // either surface.
  if (config.singleAgentMode) {
    app.use('/single-agent', singleAgentRouter);

    // Skip the SPA mount silently when web/dist isn't present (dev runs
    // Vite separately on :5173).
    const webDist = path.resolve(__dirname, '../web/dist');
    if (fs.existsSync(webDist)) {
      app.use(express.static(webDist, { index: 'index.html' }));
      app.get(/^\/(?!agents|api|health|single-agent).*/, (_req, res) => {
        res.sendFile(path.join(webDist, 'index.html'));
      });
    }
  }

  return app;
}
