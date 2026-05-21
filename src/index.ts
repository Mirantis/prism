/**
 * Agent Runtime Entry Point
 *
 * On startup:
 * 1. Start HTTP server
 * 2. Wait for backend to be available
 * 3. Load all agents and start heartbeat timers
 * 4. Load all cron tasks and schedule them
 *
 * On shutdown:
 * - Stop all heartbeats and cron jobs
 */

import { createServer } from 'http';
import { config, dotenvLoadInfo } from './config';
import { logger } from './logger';

// Pending `.prism` imports are applied by `apply-pending-import.sh`,
// invoked by both `start.sh` (prod) and the `dev:single` npm script
// (dev) BEFORE this process starts. Nothing to do in Node.

if (dotenvLoadInfo.error) {
  logger.warn({ err: dotenvLoadInfo.error, path: dotenvLoadInfo.path }, '[dotenv] failed to load .env');
} else {
  logger.info('[dotenv] injected %d env var(s) from %s', dotenvLoadInfo.loadedCount, dotenvLoadInfo.path);
}
import { createApp } from './server';
import { backendClient } from './lib/backend-client';
import { agentWorkspaceService } from './services/agent-workspace.service';
import { initLangfuse, shutdownLangfuse } from './lib/langfuse';
import { initTelemetry, shutdownTelemetry } from './lib/telemetry';
import { heartbeatService } from './services/heartbeat.service';
import { cronSchedulerService } from './services/cron-scheduler.service';
import { sessionManagerService } from './services/session-manager.service';
import { slackAdapterService } from './services/slack-adapter.service';
import { webSocketAdapterService } from './services/websocket-adapter.service';
import { webSocketGatewayService } from './services/websocket-gateway.service';
import { messageDeliveryService } from './services/message-delivery.service';
import { getSlackHeartbeatThrottleQueue } from './queues/slack-heartbeat-throttle-queue';
import { prisma } from './lib/prisma';
import { resolveOrBootstrapSingleAgent } from './lib/single-agent-bootstrap';

// Initialize Langfuse tracing before any LLM calls
initLangfuse();

// Initialize product telemetry (OTEL Logs → Collector → S3)
initTelemetry();

const app = createApp();
const httpServer = createServer(app);

// Register channel adapters for unified message delivery
// Note: Must be registered BEFORE server starts accepting connections
messageDeliveryService.register(webSocketAdapterService);
messageDeliveryService.register(slackAdapterService);

// Initialize WebSocket gateway before listening
webSocketGatewayService.initialize(httpServer);

const server = httpServer.listen(config.port, async () => {
  logger.info(`Running on http://localhost:${config.port}`);
  logger.info(`Health: http://localhost:${config.port}/health`);

  try {
    // Multi-tenant mode waits for the lens-agents/backend proxy to come up.
    // Single-agent mode has no backend dependency at startup.
    if (!config.singleAgentMode) {
      await backendClient.waitForBackend();
    } else {
      // AGENT_ID is optional — when unset, `resolveOrBootstrapSingleAgent`
      // below either picks up the existing row via findFirst() or creates
      // a fresh one with a generated UUID.
      // Auth is handled by Nexus inbound routing (AGENT-10) in front of the
      // runtime; the container itself trusts every incoming connection.
      logger.info(
        {
          agentId: config.agentId ?? '<unset, will resolve>',
        },
        '[SingleAgent] starting in single-agent mode',
      );
    }

    // Single-agent mode: resolve (or bootstrap) the one AgentWorkspace row
    // before anything else touches it, so cleanup/heartbeat/cron all see it.
    const singleAgent = config.singleAgentMode ? await resolveOrBootstrapSingleAgent() : null;

    // Clear stale RUNNING status from previous process crashes
    await prisma.agentWorkspace.updateMany({
      where: singleAgent
        ? { id: singleAgent.id, status: 'RUNNING' }
        : { status: 'RUNNING' },
      data: { status: 'IDLE' },
    });

    // Load agents and start heartbeat timers. In single-agent mode, just the
    // one we just resolved; in multi-tenant mode, every agent in the DB.
    const agents = singleAgent ? [singleAgent] : await agentWorkspaceService.getAllAgents();
    for (const agent of agents) {
      heartbeatService.startHeartbeat(agent);
    }
    logger.info(`Heartbeats started for ${agents.length} agent(s)`);

    // Load active cron tasks. In single-agent mode, only this agent's.
    const cronTasks = await cronSchedulerService.listActiveCronTasks(
      singleAgent ? singleAgent.id : undefined
    );
    for (const task of cronTasks) {
      cronSchedulerService.scheduleTask(task);
    }
    logger.info(`Cron tasks scheduled: ${cronTasks.length}`);

    // Initialize session manager (daily resets, idle timeouts)
    await sessionManagerService.initialize();
    logger.info('Session manager initialized');

    // Initialize all channel adapters (WebSocket no-op, Slack connects to workspaces)
    await messageDeliveryService.initializeAll();

    // Start the in-memory throttle queue (used identically in multi-tenant
    // and single-agent modes; see queues/slack-heartbeat-throttle-queue.ts
    // header for the design rationale).
    await getSlackHeartbeatThrottleQueue().start();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to initialize services: ${msg}`);
    if (config.singleAgentMode) {
      // Single-agent containers should fail loudly; there's nothing to fall
      // back to and lazy init would mask config errors (missing AGENT_ID,
      // invalid SLACK_BOT_TOKEN, etc.).
      process.exit(1);
    }
    logger.error('Services will be initialized lazily on first request');
  }
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down...`);

  heartbeatService.stopAll();
  cronSchedulerService.stopAll();
  sessionManagerService.stopAll();
  webSocketGatewayService.closeAll();
  await messageDeliveryService.shutdownAll();
  await getSlackHeartbeatThrottleQueue().stop();
  await shutdownLangfuse();
  await shutdownTelemetry().catch(() => {});

  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    logger.info('Force exit');
    process.exit(0);
  }, 5000).unref();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
