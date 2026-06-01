/**
 * Agent Runtime Entry Point
 *
 * On startup:
 * 1. Start HTTP server
 * 2. Resolve (or bootstrap) the single AgentWorkspace row
 * 3. Start heartbeat timers and schedule cron tasks
 *
 * On shutdown:
 * - Stop all heartbeats, cron jobs, sessions, queues
 */

import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
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
import { getProviderType } from './lib/create-provider';
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

const initialize = async () => {
  try {
    logger.info(
      {
        provider: getProviderType(),
        nexusApiUrl: config.nexusApiUrl ?? '<unset>',
        nexusLlmBaseUrl: config.nexusLlmBaseUrl ?? '<unset>',
        projectId: config.projectId ?? '<unset>',
        awsRegion: config.awsRegion,
      },
      '[Startup] configuration',
    );

    // AGENT_ID is optional — when unset, `resolveOrBootstrapSingleAgent`
    // either picks up the existing row via findFirst() or creates a
    // fresh one with a generated UUID. Auth is handled by Nexus inbound
    // routing in front of the runtime; the container itself trusts
    // every incoming connection.
    logger.info(
      { agentId: config.agentId ?? '<unset, will resolve>' },
      '[Startup] resolving agent workspace',
    );
    const agent = await resolveOrBootstrapSingleAgent();

    // Clear stale RUNNING status from previous process crashes.
    await prisma.agentWorkspace.updateMany({
      where: { id: agent.id, status: 'RUNNING' },
      data: { status: 'IDLE' },
    });

    heartbeatService.startHeartbeat(agent);
    logger.info('Heartbeat started');

    const cronTasks = await cronSchedulerService.listActiveCronTasks(agent.id);
    for (const task of cronTasks) {
      cronSchedulerService.scheduleTask(task);
    }
    logger.info(`Cron tasks scheduled: ${cronTasks.length}`);

    await sessionManagerService.initialize();
    logger.info('Session manager initialized');

    await messageDeliveryService.initializeAll();

    await getSlackHeartbeatThrottleQueue().start();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to initialize services: ${msg}`);
    // Fail loudly — there's nothing to fall back to and lazy init would
    // mask config errors (missing AGENT_ID, invalid SLACK_BOT_TOKEN, etc.).
    process.exit(1);
  }
};

const getServer = async () => {
 await initialize();

 return httpServer.listen(config.port, async () => {
    logger.info(`Running on http://localhost:${config.port}`);
    logger.info(`Health: http://localhost:${config.port}/health`);
  });
};

// Graceful shutdown
const shutdown = async (server: Server<typeof IncomingMessage, typeof ServerResponse>,signal: string) => {
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

const start = async () => {
  const server = await getServer();

  process.on('SIGTERM', () => void shutdown(server, 'SIGTERM'));
  process.on('SIGINT', () => void shutdown(server, 'SIGINT'));
};

start().catch((error) => {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  logger.error(`Failed to start server: ${msg}`);
  process.exit(1);
});
