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
 *      /agents/state   — whether the agent is working, for the other agents
 *
 * Webhook ingestion (POST /agents/webhooks/:name) has a listener of its own on
 * `WEBHOOK_PORT`, so a deployment can expose it to senders and keep the port
 * above private. Messages from the other agents of the project
 * (POST /agents/agent-messages) have one too, on `AGENT_MESSAGES_PORT`
 * (`createAgentMessagesApp`), so a deployment can route them apart from the API.
 *
 * Auth is handled by the routing in front of the runtime; the container itself
 * trusts every incoming connection, with two exceptions. `originGuard` answers
 * 403 to a browser request that comes from another site, unless
 * `PRISM_ALLOWED_ORIGINS` lists that site (see `lib/origin-guard.ts`), and a
 * webhook subscription can require a signed or token-bearing request from its
 * sender (see `lib/webhook-signature.ts`).
 */

import express from 'express';
import { computerRouter } from './routes/computer';
import { computersRouter } from './routes/computers';
import path from 'path';
import fs from 'fs';
import type { Server } from 'http';
import { config } from './config';
import { logger } from './logger';
import { managementRouter } from './routes/management';
import { threadsRouter } from './routes/threads';
import { messagesRouter } from './routes/messages';
import { slackRouter } from './routes/slack';
import { teamsRouter } from './routes/teams';
import { lockedInRouter } from './routes/locked-in';
import { agentGuideRouter } from './routes/agent-guide';
import { modelSelectionRouter } from './routes/model-selection';
import { heartbeatDeliveryRouter } from './routes/heartbeat-delivery';
import { documentRevisionsRouter } from './routes/document-revisions';
import { updateRouter } from './routes/update';
import { originGuard } from './lib/origin-guard';
import { activityRouter } from './routes/activity';
import { cronTasksRouter } from './routes/cron-tasks';
import { agentMessagesRouter } from './routes/agent-messages';
import { agentStateRouter } from './routes/agent-state';

export function createApp() {
  const app = express();

  // Ahead of the body parser: a refused request costs nothing to read, and the
  // CORS headers of a listed origin are on every response, errors included.
  app.use(originGuard);

  app.use(express.json({ limit: '5mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'agent-runtime', timestamp: new Date().toISOString() });
  });

  // Management routes (heartbeat, cron lifecycle)
  app.use('/agents', managementRouter);
  app.use('/agents', slackRouter);
  app.use('/agents', teamsRouter);
  app.use('/agents', computerRouter);

  // The agent's computers, its own and remote ones (/agents/computers)
  app.use('/agents', computersRouter);

  // Locked-in mode (PATCH /agents/locked-in)
  app.use('/agents', lockedInRouter);

  // Agent guide editing (PATCH /agents/agent-guide)
  app.use('/agents', agentGuideRouter);

  // Fixed or Auto model selection (/agents/model-selection)
  app.use('/agents', modelSelectionRouter);

  // Where a heartbeat run may post (/agents/heartbeat/delivery)
  app.use('/agents', heartbeatDeliveryRouter);

  // Identity-document history and restore (/agents/documents/:field/revisions)
  app.use('/agents', documentRevisionsRouter);

  // Self-update (GET /agents/update/status, POST /agents/update)
  app.use('/agents', updateRouter);

  // GET /agents/activity/*
  app.use('/agents', activityRouter);

  // Scheduled tasks (/agents/cron-tasks)
  app.use('/agents', cronTasksRouter);

  // Whether this agent is working, for the other agents of the project
  // (GET /agents/state). Their messages arrive on `AGENT_MESSAGES_PORT`.
  app.use('/agents', agentStateRouter);

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

/**
 * The agent-messages listener: `POST /agents/agent-messages` alone, on
 * `AGENT_MESSAGES_PORT`. No browser calls it, so it has no origin guard and no
 * CORS; the route checks who posted (`routes/agent-messages.ts`). The body
 * limit fits the largest message the route takes.
 */
export function createAgentMessagesApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/agents', agentMessagesRouter);
  return app;
}

/**
 * Opens the agent-messages listener on `config.host`, as the API. A port that
 * cannot be opened is logged and leaves the rest of the runtime running:
 * deliveries then fail, and the sender tries again later.
 */
export function listenForAgentMessages(server: Pick<Server, 'listen' | 'on'>): void {
  server.on('error', (error: NodeJS.ErrnoException) => {
    const reason = error.code === 'EADDRINUSE' ? 'The port is already in use. Choose a free AGENT_MESSAGES_PORT and restart.' : error.message;
    logger.error(`[AgentMessages] Cannot listen on port ${config.agentMessagesPort}. ${reason}`);
  });
  server.listen(config.agentMessagesPort, config.host, () => {
    logger.info({ port: config.agentMessagesPort, host: config.host }, '[AgentMessages] Listening');
  });
}

/**
 * Bind the server to `config.host`, which `PRISM_HOST` sets and which defaults
 * to loopback.
 */
export function listenOn(server: Pick<Server, 'listen'>): void {
  server.listen(config.port, config.host, () => {
    // A wildcard bind is not an address a browser can open, so name the
    // interface separately from the URL. An IPv6 literal needs brackets.
    const wildcard = ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0'].includes(config.host);
    const address = config.host.includes(':') ? `[${config.host}]` : config.host;
    const url = `http://${wildcard ? 'localhost' : address}:${config.port}`;
    logger.info(`Running on ${url} (interface ${config.host})`);
    logger.info(`Health: ${url}/health`);
  });
}
