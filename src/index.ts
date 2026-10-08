import { computerService } from './services/computer/computer.service';
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
import { createApp, listenOn } from './server';
import { webhookReceiverService } from './services/webhook-receiver.service';
import { webhookRunService } from './services/webhook-run.service';
import { initLangfuse, shutdownLangfuse } from './lib/langfuse';
import { initTelemetry, shutdownTelemetry } from './lib/telemetry';
import { trackAgentStarted } from './lib/startup-telemetry';
import { heartbeatService } from './services/heartbeat.service';
import { meetingBotService } from './services/meeting/meeting-bot.service';
import { voiceChatService } from './services/voice/voice-chat.service';
import { computerEndpoint } from './services/computer/computer-endpoint';
import { initMeetingToolAvailability } from './lib/tool-collection';
import { initComputerAvailability } from './services/computer/supported';
import { cronSchedulerService } from './services/cron-scheduler.service';
import { goalService } from './services/goal.service';
import { sessionManagerService } from './services/session-manager.service';
import { slackAdapterService } from './services/slack-adapter.service';
import { teamsAdapterService } from './services/teams/teams-adapter.service';
import { webSocketAdapterService } from './services/websocket-adapter.service';
import { webSocketGatewayService } from './services/websocket-gateway.service';
import { messageDeliveryService } from './services/message-delivery.service';
import { conversationService } from './services/conversation.service';
import { slackMessageQueueService } from './services/slack-message-queue.service';
import { SlackThreadProvider } from './services/providers/slack-thread.provider';
import { ThreadSource } from '@prisma/client';
import { pluginMcpService } from './services/plugin-mcp.service';
import { updateService } from './services/update/update.service';
import { pluginCatalogService } from './services/plugin-catalog.service';
import { reconcileAttachmentStorage } from './lib/attachment-boot';
import { startFileJanitor } from './lib/file-janitor';
import { getSlackHeartbeatThrottleQueue } from './queues/slack-heartbeat-throttle-queue';
import { prisma } from './lib/prisma';
import { resolveOrBootstrapSingleAgent } from './lib/single-agent-bootstrap';
import { migrateStorageIfEnvironmentChanged } from './lib/execution-environments/storage-migration';
import {
  ensureExecutionEnvironmentDetected,
  getExecutionEnvironment,
} from './lib/execution-environments/get-execution-environment';
import { ensureDataDirs } from './lib/data-dir';
import { getCodingAgent } from './lib/coding-agents/get-coding-agent';
import { ensureCodingAgentsDetected } from './lib/coding-agents/availability';
import { getProcessManager } from './tools/shell/process-manager';
import { getAgentTaskManager } from './tools/shell/agent-task-manager';
import { cancelModelCatalogRefresh, refreshModelCatalog } from './lib/model-catalog';
import { createProvider, missingProviderSettings } from './lib/llm-providers/create-provider';
import { runBackfill } from './scripts/backfill-embeddings';

// What `ps` and `top` show for this process.
process.title = 'prism-agent';

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

let fileJanitorTimer: NodeJS.Timeout | undefined;

// Register channel adapters for unified message delivery
// Note: Must be registered BEFORE server starts accepting connections
messageDeliveryService.register(webSocketAdapterService);
messageDeliveryService.register(slackAdapterService);
messageDeliveryService.register(teamsAdapterService);
conversationService.registerThreadProvider(ThreadSource.SLACK, new SlackThreadProvider());
heartbeatService.registerTriggerSource(slackMessageQueueService);

// Initialize WebSocket gateway before listening
webSocketGatewayService.initialize(httpServer);
computerEndpoint.initialize(httpServer);

const initialize = async () => {
  try {
    // The data dirs come first: an execution environment that isolates the
    // agent has to mount them, and a mount whose host path does not exist yet
    // is one the engine invents as a root-owned directory.
    const dirs = ensureDataDirs();
    if (dirs.fellBackFrom) {
      logger.warn(
        '[Startup] data dir %s is not usable; falling back to %s. Set PRISM_DATA_DIR to choose another.',
        dirs.fellBackFrom,
        dirs.dataDir,
      );
    }
    logger.info('[Startup] skills dir: %s', dirs.skillsDir);

    // Ensure the shell tools' workspace dir exists before any invocation can
    // spawn a command there — a missing cwd surfaces as `spawn /bin/bash
    // ENOENT`, which masquerades as a missing shell (e.g. `npm run dev` on
    // macOS, where the default /home/node can't be created). It is a host
    // directory in either environment, so it is made before one is chosen.
    const ws = getExecutionEnvironment().prepareWorkspace();
    if (ws.fellBackFrom) {
      logger.warn(
        '[Startup] shell workspace %s is not usable; falling back to %s. Set SHELL_WORKSPACE_ROOT to choose another.',
        ws.fellBackFrom,
        ws.root,
      );
    } else {
      logger.info('[Startup] shell workspace: %s', ws.root);
    }

    // Where the agent's commands run. Derived, not configured — and it reports
    // itself, including when it wanted a container and could not have one.
    await ensureExecutionEnvironmentDetected();

    // Before anything reads the agent's directories: the two environments keep
    // them in different places, so a deployment that has moved between them
    // finds empty storage until its files are brought across.
    await migrateStorageIfEnvironmentChanged();

    // Which agents have credentials is a question for the execution
    // environment, so it is asked here rather than derived at import — and
    // after the line above, so it is asked of the environment that won.
    await ensureCodingAgentsDetected();
    for (const name of config.availableCodingAgents) {
      const codingAgent = getCodingAgent(name);
      const home = await codingAgent.prepareHome();
      logger.info({ agent: name, ...home }, '[Startup] coding agent');
    }
    // Scanning here also surfaces any malformed plugin's warning at boot rather
    // than on whichever turn first happens to build a system prompt.
    logger.info(
      '[Startup] plugins dir: %s (%d installed)',
      getExecutionEnvironment().paths().pluginsDir,
      (await pluginCatalogService.getPlugins()).length,
    );

    // Bring the attachment rows and the media dir back into agreement (missing
    // files, over-TTL content, legacy BLOBs) before anything can serve them.
    await reconcileAttachmentStorage(dirs.mediaDir);

    // The provider answers for prompt caching, and only a vendor whose answer
    // varies by model declares the member at all — so the field is absent for a
    // vendor that has nothing to say, and no vendor is named here. Reported for
    // the configured model, which a per-agent or per-invocation override can
    // still replace.
    const provider = createProvider();

    // Active LLM provider + routing, so the deployed vendor is observable in
    // logs. `routing` is 'nexus' when the gateway serves the chat endpoint, else
    // 'direct'; `endpoint` names that endpoint (origin and path only, so a
    // credential in a URL cannot reach the log) and `endpointSource` says whether
    // an explicit `*_BASE_URL` replaced a derived mount. `embeddings` surfaces
    // the embedding vendor at boot — it can be off (e.g. anthropic without an
    // OpenAI key), and without this line the only signal is a per-call warn once
    // a memory write happens.
    logger.info(
      {
        provider: config.llmProvider,
        routing: config.chatRouting,
        endpoint: config.chatEndpointForLog,
        endpointSource: config.chatEndpointSource,
        chatModel: config.chatModelId,
        embeddings: config.embeddingModelId
          ? `${config.embeddingProvider}:${config.embeddingModelId}`
          : 'disabled',
        ...(provider.promptCacheState
          ? { promptCache: provider.promptCacheState(config.chatModelId) }
          : {}),
      },
      '[Startup] LLM provider',
    );
    const missingSettings = missingProviderSettings();
    if (missingSettings.length > 0) {
      logger.warn(
        { provider: config.llmProvider, missingSettings },
        '[Startup] the LLM provider is missing settings; chat answers with a notice until they are set',
      );
    }
    // Not awaited: a check that waits on the network must not hold up boot.
    void provider.startupCheck?.();

    if (config.invalidLlmProvider) {
      logger.warn(
        { configuredProvider: config.invalidLlmProvider, effectiveProvider: config.llmProvider },
        '[Startup] invalid LLM_PROVIDER; using bedrock',
      );
    }

    // A typo'd EMBEDDING_PROVIDER keeps the derived default running, so
    // nothing ever looks broken without this line (same pattern as the
    // TOOL_RISK_GATE_MODE warning below).
    if (config.invalidEmbeddingProvider) {
      logger.warn(
        {
          configuredProvider: config.invalidEmbeddingProvider,
          effectiveProvider: config.embeddingProvider,
        },
        '[Startup] invalid EMBEDDING_PROVIDER; using the chat vendor default',
      );
    }

    if (config.invalidToolRiskGateMode) {
      logger.warn(
        { configuredMode: config.invalidToolRiskGateMode, effectiveMode: config.toolRiskGateMode },
        '[Startup] invalid TOOL_RISK_GATE_MODE; risk gate is disabled',
      );
    } else {
      logger.info(
        { mode: config.toolRiskGateMode },
        '[Startup] tool risk gate',
      );
    }

    // AGENT_ID is optional — when unset, `resolveOrBootstrapSingleAgent`
    // either picks up the existing row via findFirst() or creates a
    // fresh one with a generated UUID. Auth is handled by Lens Agents inbound
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

    const interruptedWebhookRuns = await webhookRunService.failInterrupted(agent.id);
    if (interruptedWebhookRuns > 0) {
      logger.warn('[Startup] %d webhook run(s) did not finish before the restart', interruptedWebhookRuns);
    }

    // Boot keeps the schedule the last run set, so a restart cannot defer a
    // check, and an overdue one runs promptly.
    heartbeatService.startHeartbeat(agent, 'keep-schedule');
    logger.info('Heartbeat started');

    // Recurring schedules are read in the agent's time zone.
    cronSchedulerService.useTimezone(agent.timezone);
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

    // Resolve any update attempt left pending by a previous process (the
    // restart sentinel), then start the check loop where the install allows
    // self-update (SEA binary with a release version, DISABLE_UPDATER unset).
    await updateService.start();

    await messageDeliveryService.initializeAll();

    await getSlackHeartbeatThrottleQueue().start();

    // Sweep abandoned uploads, scratch dirs, expired content, stray media files
    // and expired saved tool outputs now, then hourly (see lib/file-janitor.ts).
    fileJanitorTimer = await startFileJanitor();

    // Probe for the voice-meeting toolchain once, here rather than per turn: the
    // tools block must stay byte-identical across requests for the provider's
    // prompt cache to hit.
    if (config.realtimeUnavailableReason) {
      logger.info({ reason: config.realtimeUnavailableReason }, 'Voice is not configured');
    }
    const meetingsAvailable = await initMeetingToolAvailability();
    logger.info(
      meetingsAvailable
        ? 'Voice meetings available (browser + audio toolchain and Realtime credential present)'
        : 'Voice meetings unavailable — meeting tools not registered',
    );

    // The same question for the agent's own computer, which needs a desktop on top of
    // that toolchain. The Web UI reads the answer and leaves its Computer page out
    // where it is no.
    const computerAvailable = await initComputerAvailability();
    logger.info(
      computerAvailable
        ? "The agent's computer is available (desktop packages present)"
        : "The agent's computer is unavailable — the Computer page is not offered",
    );

    // Embed the memory entries that have no vector yet. In-process and
    // best-effort: it never blocks startup, and a failure costs a log line.
    void runBackfill().catch((err) => {
      logger.warn({ err }, '[Startup] embedding backfill failed');
    });
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

 await webhookReceiverService.initialize();
 listenOn(httpServer);
 return httpServer;
};

// Graceful shutdown
const shutdown = async (server: Server<typeof IncomingMessage, typeof ServerResponse>,signal: string) => {
  logger.info(`${signal} received, shutting down...`);

  // Armed first, before anything that can block. The 5s timer below is only
  // reached once six awaited teardowns have resolved, so a wedged plugin MCP
  // child or an unreachable telemetry endpoint would leave no backstop at all.
  // That matters most to the self-updater: it signals this shutdown *after*
  // swapping the install, so a shutdown that never exits leaves the old
  // process serving new files with no supervisor restart coming.
  const hardExit = setTimeout(() => {
    logger.warn('[Shutdown] teardown did not finish in 30s — exiting anyway');
    process.exit(0);
  }, 30_000);
  hardExit.unref();

  heartbeatService.stopAll();
  cronSchedulerService.stopAll();
  goalService.stopAll();
  sessionManagerService.stopAll();
  updateService.stop();
  // A delivery starts an agent run, so deliveries stop with the timers.
  await webhookReceiverService.shutdown();
  if (fileJanitorTimer) clearInterval(fileJanitorTimer);
  // A SIGTERM early in boot would otherwise leave the catalog fetch holding a
  // socket, so server.close() waits and the 5s force-exit below fires.
  cancelModelCatalogRefresh();

  // The agent's own work goes early, ahead of the slower teardowns below.
  // Locally these die with us because they are our children; in a container
  // they do not, and a shutdown that is cut short after this point would leave
  // both them and the container behind. A crashed runtime still leaves the
  // container, which is why `start()` removes a stale one by name.
  getProcessManager().killAll();
  getAgentTaskManager().killAll();
  await getExecutionEnvironment().shutdown();

  webSocketGatewayService.closeAll();
  computerEndpoint.close();
  await computerService.close();
  // Leave any live call before the process goes: otherwise the browser and audio
  // daemon die with us and the bot lingers in the meeting as a frozen participant.
  await meetingBotService.shutdown().catch((err) => {
    logger.warn(`[Meeting] Shutdown teardown failed: ${String(err)}`);
  });
  // Same for a browser voice chat: the peer dies with the process, so end the
  // session while there is still a socket to say so on.
  await voiceChatService.shutdown().catch((err) => {
    logger.warn(`[VoiceChat] Shutdown teardown failed: ${String(err)}`);
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
  // A closed terminal on a host install: without a handler Node ends at once, and the
  // exit hooks that stop the agent's own processes never run.
  process.on('SIGHUP', () => void shutdown(server, 'SIGHUP'));
};

start().catch((error) => {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  logger.error(`Failed to start server: ${msg}`);
  process.exit(1);
});
