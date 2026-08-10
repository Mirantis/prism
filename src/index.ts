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
import { trackAgentStarted } from './lib/startup-telemetry';
import { heartbeatService } from './services/heartbeat.service';
import { meetingBotService } from './services/meeting/meeting-bot.service';
import { initMeetingToolAvailability } from './lib/tool-collection';
import { cronSchedulerService } from './services/cron-scheduler.service';
import { goalService } from './services/goal.service';
import { sessionManagerService } from './services/session-manager.service';
import { slackAdapterService } from './services/slack-adapter.service';
import { webSocketAdapterService } from './services/websocket-adapter.service';
import { webSocketGatewayService } from './services/websocket-gateway.service';
import { messageDeliveryService } from './services/message-delivery.service';
import { pluginMcpService } from './services/plugin-mcp.service';
import { pluginCatalogService } from './services/plugin-catalog.service';
import { reconcileAttachmentStorage } from './lib/attachment-boot';
import { startAttachmentJanitor } from './lib/attachment-janitor';
import { getSlackHeartbeatThrottleQueue } from './queues/slack-heartbeat-throttle-queue';
import { prisma } from './lib/prisma';
import { resolveOrBootstrapSingleAgent } from './lib/single-agent-bootstrap';
import { ensureWorkspaceRoot } from './tools/shell/config';
import { ensureDataDirs } from './lib/data-dir';
import { cancelModelCatalogRefresh, refreshModelCatalog } from './lib/model-catalog';

// Initialize Langfuse tracing before any LLM calls
initLangfuse();

// Initialize product telemetry (OTEL Logs → Collector → S3)
initTelemetry();

// Refresh the model-window catalog in the background; lookups use the bundle until it lands.
void refreshModelCatalog().catch((err) => {
  logger.warn({ err }, '[ModelCatalog] refresh failed; using the bundled catalog');
});

const app = createApp();
const httpServer = createServer(app);

let orphanCleanupTimer: NodeJS.Timeout | undefined;

// Register channel adapters for unified message delivery
// Note: Must be registered BEFORE server starts accepting connections
messageDeliveryService.register(webSocketAdapterService);
messageDeliveryService.register(slackAdapterService);

// Initialize WebSocket gateway before listening
webSocketGatewayService.initialize(httpServer);

const initialize = async () => {
  try {
    // Ensure the shell tools' workspace dir exists before any invocation can
    // spawn a command there — a missing cwd surfaces as `spawn /bin/bash
    // ENOENT`, which masquerades as a missing shell (e.g. `npm run dev` on
    // macOS, where the default /home/node can't be created).
    const ws = ensureWorkspaceRoot();
    if (ws.fellBackFrom) {
      logger.warn(
        '[Startup] shell workspace %s is not usable; falling back to %s. Set SHELL_WORKSPACE_ROOT to choose another.',
        ws.fellBackFrom,
        ws.root,
      );
    } else {
      logger.info('[Startup] shell workspace: %s', ws.root);
    }

    // Ensure the persistent skills dir exists and point Claude Code
    // (CLAUDE_CONFIG_DIR + a symlink inside our own data dir) at the same
    // canonical skills folder, so the prism loop and the embedded claude_code
    // tool see one shared set of skills without touching the user's ~/.claude.
    const dirs = ensureDataDirs();
    if (dirs.fellBackFrom) {
      logger.warn(
        '[Startup] data dir %s is not usable; falling back to %s. Set PRISM_DATA_DIR to choose another.',
        dirs.fellBackFrom,
        dirs.dataDir,
      );
    }
    logger.info(
      '[Startup] skills dir: %s (claude config: %s, symlink %s)',
      dirs.skillsDir,
      dirs.claudeConfigDir,
      dirs.symlinkOk ? 'ok' : 'unavailable',
    );
    // Scanning here also surfaces any malformed plugin's warning at boot rather
    // than on whichever turn first happens to build a system prompt.
    logger.info(
      '[Startup] plugins dir: %s (%d installed)',
      dirs.pluginsDir,
      pluginCatalogService.getPlugins().length,
    );

    // Bring the attachment rows and the media dir back into agreement (missing
    // files, over-TTL content, legacy BLOBs) before anything can serve them.
    await reconcileAttachmentStorage(dirs.mediaDir);

    // Active LLM provider + routing, so the deployed vendor is observable in
    // logs. `routing` is 'nexus' when the selected vendor's Nexus chat mount is
    // set, else 'direct'.
    logger.info(
      {
        provider: config.llmProvider,
        routing: config.nexusChatBaseUrl ? 'nexus' : 'direct',
        chatModel: config.chatModelId,
      },
      '[Startup] LLM provider',
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
      // Boot re-registration of existing tasks — not a new schedule, so
      // scheduleTask skips its 'cron task scheduled' telemetry.
      cronSchedulerService.scheduleTask(task, { source: 'boot' });
    }
    logger.info(`Cron tasks scheduled: ${cronTasks.length}`);

    // Product telemetry: the boot census — the provider/routing logged above
    // plus the rest of the deployment shape (integrations, host, feature
    // counts). Best-effort; never throws.
    await trackAgentStarted(agent, { cronTasks: cronTasks.length });

    // Resume any goal that was still active when the process last stopped.
    await goalService.restoreActiveGoals(agent.id);

    await sessionManagerService.initialize();
    logger.info('Session manager initialized');

    await messageDeliveryService.initializeAll();

    await getSlackHeartbeatThrottleQueue().start();

    // Sweep abandoned uploads, scratch dirs, expired content and stray media
    // files now, then hourly (see lib/attachment-janitor.ts).
    orphanCleanupTimer = await startAttachmentJanitor();

    // Probe for the voice-meeting toolchain once, here rather than per turn: the
    // tools block must stay byte-identical across requests for the provider's
    // prompt cache to hit.
    const meetingsAvailable = await initMeetingToolAvailability();
    logger.info(
      meetingsAvailable
        ? 'Voice meetings available (browser + audio toolchain and OpenAI key present)'
        : 'Voice meetings unavailable — meeting tools not registered',
    );
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
  goalService.stopAll();
  sessionManagerService.stopAll();
  if (orphanCleanupTimer) clearInterval(orphanCleanupTimer);
  // A SIGTERM early in boot would otherwise leave the catalog fetch holding a
  // socket, so server.close() waits and the 5s force-exit below fires.
  cancelModelCatalogRefresh();
  webSocketGatewayService.closeAll();
  // Leave any live call before the process goes: otherwise the browser and audio
  // daemon die with us and the bot lingers in the meeting as a frozen participant.
  await meetingBotService.shutdown().catch((err) => {
    logger.warn(`[Meeting] Shutdown teardown failed: ${String(err)}`);
  });
  await messageDeliveryService.shutdownAll();
  // Plugin MCP servers are child processes we spawned; close them explicitly so
  // a bare SIGTERM to the runtime doesn't orphan them.
  await pluginMcpService.shutdownAll();
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
