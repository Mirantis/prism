/**
 * Agent Runtime HTTP Server
 *
 * GET  /health         — liveness check
 *      /agents/*       — management routes (heartbeat, chat, cron lifecycle)
 *                        + self-update (/agents/update, /agents/update/status)
 *                        + activity reads (/agents/activity/*)
 *      /threads, /latest-thread — thread resolve/list/open
 *      /messages       — thread history replay
 *      /               — Prism Agent Web UI (static SPA bundle from web/dist)
 *
 * Webhook ingestion (POST /agents/webhooks/:name) has a listener of its own on
 * `WEBHOOK_PORT`, so a deployment can expose it to senders and keep the port
 * above private.
 *
 * Auth is handled by the routing in front of the runtime; the container itself
 * trusts every incoming connection, with two exceptions. `originGuard` answers
 * 403 to a browser request that comes from another site (see
 * `lib/origin-guard.ts`), and a webhook subscription can require a signed or
 * token-bearing request from its sender (see `lib/webhook-signature.ts`).
 */

import express from 'express';
import { computerRouter } from './routes/computer';
import path from 'path';
import fs from 'fs';
import type { Server } from 'http';
import { config } from './config';
import { logger } from './logger';
import { managementRouter } from './routes/management';
import { threadsRouter } from './routes/threads';
import { messagesRouter } from './routes/messages';
import { teamsRouter } from './routes/teams';
import { webhookRouter } from './routes/webhook';
import { lockedInRouter } from './routes/locked-in';
import { agentGuideRouter } from './routes/agent-guide';
import { documentRevisionsRouter } from './routes/document-revisions';
import { updateRouter } from './routes/update';
import { originGuard } from './lib/origin-guard';
import { activityRouter } from './routes/activity';
import { captureRawBody } from './lib/raw-body';

export function createApp() {
  const app = express();

  // Ahead of the body parser: a refused request costs nothing to read.
  app.use(originGuard);

  app.use(express.json({ limit: '5mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'agent-runtime', timestamp: new Date().toISOString() });
  });

  // Management routes (heartbeat, cron lifecycle)
  app.use('/agents', managementRouter);
  app.use('/agents', teamsRouter);
  app.use('/agents', computerRouter);

  // Locked-in mode (PATCH /agents/locked-in)
  app.use('/agents', lockedInRouter);

  // Agent guide editing (PATCH /agents/agent-guide)
  app.use('/agents', agentGuideRouter);

  // Identity-document history and restore (/agents/documents/:field/revisions)
  app.use('/agents', documentRevisionsRouter);

  // Self-update (GET /agents/update/status, POST /agents/update)
  app.use('/agents', updateRouter);

  // GET /agents/activity/*
  app.use('/agents', activityRouter);

  // Thread and message routes: /threads, /latest-thread and /messages.
  // Mounted at the root and registered before the SPA fallback so these
  // explicit routes win over the static catch-all.
  app.use(threadsRouter);
  app.use(messagesRouter);

  // Prism Agent Web UI. Skip the SPA mount silently when web/dist isn't
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

/** The webhook listener: POST /agents/webhooks/:name and nothing else. */
export function createWebhookApp() {
  const app = express();
  app.use(originGuard);
  // `verify` keeps the raw bytes for HMAC verification (see lib/raw-body.ts).
  app.use(express.json({ limit: '5mb', verify: captureRawBody }));
  app.use('/agents', webhookRouter);
  return app;
}

/** The URL a log line names for `port` on the bound interface. */
function localUrl(port: number): string {
  // A wildcard bind is not an address a browser can open, so name the
  // interface separately from the URL. An IPv6 literal needs brackets.
  const wildcard = ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0'].includes(config.host);
  const address = config.host.includes(':') ? `[${config.host}]` : config.host;
  return `http://${wildcard ? 'localhost' : address}:${port}`;
}

/**
 * Bind the server to `config.host`, which `PRISM_HOST` sets and which defaults
 * to loopback.
 */
export function listenOn(server: Pick<Server, 'listen'>): void {
  server.listen(config.port, config.host, () => {
    const url = localUrl(config.port);
    logger.info(`Running on ${url} (interface ${config.host})`);
    logger.info(`Health: ${url}/health`);
  });
}

/**
 * Bind the webhook listener to `config.webhookPort` on the same interface. The
 * receiver is opt-in, so a port that is taken is logged and the runtime keeps
 * running without it.
 */
export function listenForWebhooks(server: Pick<Server, 'listen' | 'on'>): void {
  server.on('error', (err) => {
    logger.error(
      { err },
      `[Webhook] Cannot listen on port ${config.webhookPort}; webhook deliveries are not received. Set WEBHOOK_PORT to a free port.`,
    );
  });
  server.listen(config.webhookPort, config.host, () => {
    logger.info(`Webhooks: ${localUrl(config.webhookPort)}/agents/webhooks/<name>`);
  });
}
