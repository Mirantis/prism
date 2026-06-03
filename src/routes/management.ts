/**
 * Management Routes
 *
 * Express router exposing the runtime's REST surface — the agent-runtime
 * owns its own data, so these routes are the canonical CRUD layer for
 * heartbeat, cron, Slack mappings, threads, agent identity, and
 * subagent wiring. Called by the bundled Web UI. Nexus inbound routing
 * terminates auth in front of the container; routes are not protected
 * by an internal secret.
 *
 * Agent identity:
 *   GET    /agents/me                              - Agent identity (Web UI bootstrap)
 *   PATCH  /agents/name                            - Rename agent
 *   GET    /agents/model                           - Effective model (override or env default)
 *   PATCH  /agents/model                           - Set/clear per-agent LLM model override
 *   GET    /agents/details                         - Full agent record (markdown fields, etc.)
 *   DELETE /agents                                 - Delete agent
 *
 * Backup / restore:
 *   GET    /agents/export                          - Gzipped snapshot of live SQLite
 *   POST   /agents/import                          - Upload + restart-to-apply
 *
 * Heartbeat management:
 *   POST   /agents/heartbeat/start        - Start/restart heartbeat timer (force-enables)
 *   POST   /agents/heartbeat/stop         - Stop heartbeat timer
 *   POST   /agents/heartbeat/trigger      - Execute heartbeat immediately
 *   POST   /agents/heartbeat/slack-trigger - Trigger from Slack channel
 *   GET    /agents/heartbeat/status       - Get heartbeat state (incl. intervalMs)
 *   PATCH  /agents/heartbeat/interval     - Update interval + re-register timer
 *
 * Cron management:
 *   GET    /agents/cron-tasks             - List cron tasks
 *   POST   /agents/cron-tasks             - Create + register
 *   DELETE /agents/cron-tasks/:taskId     - Unschedule + delete
 *
 * Slack heartbeat trigger management:
 *   GET    /agents/slack-heartbeat-trigger/channel/:channelId - Check if channel is a trigger
 *   GET    /agents/slack-heartbeat-trigger                    - List active triggers
 *   POST   /agents/slack-heartbeat-trigger                    - Create trigger
 *   PATCH  /agents/slack-heartbeat-trigger                    - Update throttle
 *   DELETE /agents/slack-heartbeat-trigger/:id                - Delete trigger
 *   POST   /agents/slack-heartbeat-trigger/claim              - Try claim trigger
 *
 * Conversation threads:
 *   POST   /agents/threads/get-or-create-active               - Get or create active thread
 *   GET    /agents/threads                                    - List threads
 *   GET    /agents/threads/:threadId                          - Fetch thread + messages
 *   POST   /agents/threads/:threadId/messages                 - Add message
 *   POST   /agents/threads/:threadId/archive                  - Archive thread
 *   POST   /agents/threads/get-or-create-by-external-id       - Get/create by external id
 *   POST   /agents/threads/:threadId/set-external-id          - Set external id
 *
 * Slack verification + mappings:
 *   POST   /agents/slack/create-verification-code             - Generate link code
 *   POST   /agents/slack/verify-link-code                     - Verify DM link code
 *   POST   /agents/slack/verify-channel-link-code             - Verify channel link code
 *   GET    /agents/slack/workspaces                            - List connected workspaces
 *   GET    /agents/slack-link-status                           - DM/channel mapping existence
 *   GET    /agents/slack-channel-mappings                      - List channel mappings
 *   GET    /agents/slack/channel-mapping/:channelId            - Find mapping by channel id
 *   DELETE /agents/slack/channel-mapping/:channelId            - Delete channel mapping
 *   DELETE /agents/slack/dm-mapping                            - Delete DM mappings
 *   GET    /agents/slack-connection-id                         - Lookup connection id
 *
 * Subagents:
 *   GET    /agents/:agentId/subagents                          - List
 *   POST   /agents/:agentId/subagents                          - Add child agent
 *   DELETE /agents/:agentId/subagents/:childAgentId            - Remove
 *
 * Misc:
 *   POST   /agents/chat                                        - Synchronous chat invoke
 *   POST   /agents                                             - Bootstrap agent
 *   POST   /agents/slack/deliver                               - Deliver a message
 *   POST   /agents/slack/{initialize,shutdown}                 - Slack adapter lifecycle
 *   POST   /agents/slack/{add,remove}-connection               - Slack connection wiring
 *   POST   /agents/slack/link-user                             - Slack user link
 *   GET    /agents/slack/is-connected/:userId                  - Connection check
 *   GET    /agents/slack/channel-name                          - Resolve channel id → name
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import multer from 'multer';
import { AgentType, MessageRole, MessageTrigger, Prisma, ThreadStatus } from '@prisma/client';
import { logger } from '../logger';
import { prisma } from '../lib/prisma';
import { heartbeatService } from '../services/heartbeat.service';
import { cronSchedulerService } from '../services/cron-scheduler.service';
import { slackHeartbeatTriggerService } from '../services/slack-heartbeat-trigger.service';
import { conversationService, type MessageInput } from '../services/conversation.service';
import { conversationEngineService, type ChatInput } from '../services/conversation-engine.service';
import { slackAdapterService } from '../services/slack-adapter.service';
import {
  agentWorkspaceService,
  ValidationError,
} from '../services/agent-workspace.service';
import {
  exportAgent as exportAgentArchive,
  importAgent as importAgentArchive,
  ArchiveValidationError,
} from '../services/agent-archive.service';
import { parseSchedule } from '../tools/cron';
import cron from 'node-cron';

// 100 MiB cap — agent DBs are tens of MB in practice; this keeps a
// malformed / oversized upload from filling memory before validation runs.
const archiveUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

/**
 * Wrap multer's `single('file')` middleware so its synchronous failures
 * (oversized body, malformed multipart) come back as JSON 400s — by default
 * a `MulterError` bubbles past the async route handler's try/catch and hits
 * Express's HTML error page, which the restore dialog can't parse.
 */
function uploadPrismFile(req: Request, res: Response, next: (err?: unknown) => void): void {
  archiveUpload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      res.status(400).json({ error: `Upload rejected: ${err.message}` });
      return;
    }
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Upload failed' });
      return;
    }
    next();
  });
}

const router = Router();

// ============================================================================
// Agent identity
// ============================================================================

/**
 * GET /agents/me
 * Returns the identity of the single agent this runtime owns. The Web UI
 * calls this on boot to resolve `agentId` and `userId` without needing
 * them in the URL.
 */
router.get('/me', async (_req: Request, res: Response) => {
  try {
    const agent = await agentWorkspaceService.getAgent();
    res.json({ agentId: agent.id, userId: agent.userId, name: agent.name });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get /me: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PATCH /agents/name
 * Rename the agent. Body: { name: string }.
 * Validates 1-64 chars (trimmed). The new name is read by
 * `contextService.buildContext()` on the next `invoke()` so the agent
 * picks up its new identity on the next chat turn.
 */
router.patch('/name', async (req: Request, res: Response) => {
  try {
    const updated = await agentWorkspaceService.renameAgent(req.body?.name);
    res.json({ agentId: updated.id, userId: updated.userId, name: updated.name });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to rename agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/model
 * Returns the **effective** model — the per-agent override when one is set,
 * otherwise the runtime's env-configured default (`BEDROCK_MODEL_ID`). The
 * caller doesn't need to know about the override/default distinction; the
 * server resolves it.
 */
router.get('/model', async (_req: Request, res: Response) => {
  try {
    const model = await agentWorkspaceService.getEffectiveModel();
    res.json({ model });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to read model for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PATCH /agents/model
 * Set or clear the per-agent LLM model override. Body: `{ model: string | null }`.
 * `null` clears the override (falls back to the runtime default). Returns the
 * **resolved** effective model — same shape as the GET, so the UI can prime
 * its cache from the mutation response without a refetch. The model string is
 * validated for format only — see `agentWorkspaceService.updateModel`.
 */
router.patch('/model', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!('model' in body)) {
      res.status(400).json({ error: "missing required field 'model' (use null to clear)" });
      return;
    }
    const model = await agentWorkspaceService.updateModel(body.model);
    res.json({ model });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to update model for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Backup / restore
// ============================================================================

/**
 * GET /agents/export
 * Stream a gzipped snapshot of the agent's SQLite DB as a `.prism` file.
 * The snapshot is taken with `VACUUM INTO` so heartbeat/cron writes in
 * flight don't tear the file. Single-agent only.
 */
router.get('/export', async (_req: Request, res: Response) => {
  try {
    const agent = await agentWorkspaceService.getAgent();

    const { stream, filename, cleanup } = await exportAgentArchive(agent.name);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.on('close', cleanup);
    stream.on('error', (err) => {
      logger.error({ err }, '[Management] export stream error');
      cleanup();
      if (!res.headersSent) res.status(500).end();
      else res.destroy(err);
    });
    stream.pipe(res);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to export agent: ${msg}`);
    if (!res.headersSent) res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/import
 * Multipart upload of a `.prism` file. Validates the archive, stages it for
 * the next process restart, then exits the process — bootstrap pickup
 * swaps the file into place before Prisma opens the DB.
 */
router.post(
  '/import',
  uploadPrismFile,
  async (req: Request, res: Response) => {
    try {
      await agentWorkspaceService.getAgent();
      const file = (req as Request & { file?: { buffer: Buffer } }).file;
      if (!file?.buffer?.length) {
        res.status(400).json({ error: 'Missing `file` field in multipart body' });
        return;
      }

      await importAgentArchive(file.buffer);

      // Restart so Prisma + better-sqlite3 re-open the freshly-promoted DB
      // file. Wait for the response to flush before exiting so the client
      // sees `{ ok: true, restarting: true }` and knows to poll /health.
      res.on('finish', () => {
        logger.info('[Management] import staged — exiting to apply on restart');
        setTimeout(() => process.exit(0), 100);
      });
      res.status(200).json({ ok: true, restarting: true });
    } catch (error: unknown) {
      if (error instanceof ArchiveValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Management] Failed to import agent: ${msg}`);
      res.status(500).json({ error: msg });
    }
  },
);

// ============================================================================
// Heartbeat Management
// ============================================================================

/**
 * POST /agents/heartbeat/start
 * Start or restart the heartbeat timer for an agent.
 * Body: { agent } — the agent config object
 */
router.post('/heartbeat/start', async (req: Request, res: Response) => {
  try {
    const { agent } = req.body;
    if (!agent) {
      res.status(400).json({ error: 'Missing agent in request body' });
      return;
    }

    // Force-enable: this endpoint's whole purpose is to turn the heartbeat on,
    // regardless of what status the body's agent object happens to carry. The
    // STOPPED short-circuit in startHeartbeat is for the boot-time loader.
    heartbeatService.startHeartbeat({ ...agent, heartbeatStatus: 'ENABLED' });
    res.json({ success: true, message: 'Heartbeat started' });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to start heartbeat for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/heartbeat/stop
 * Stop the heartbeat timer for an agent.
 */
router.post('/heartbeat/stop', async (_req: Request, res: Response) => {
  try {
    heartbeatService.stopHeartbeat();
    res.json({ success: true, message: 'Heartbeat stopped' });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to stop heartbeat for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/heartbeat/trigger
 * Execute a heartbeat immediately for an agent.
 */
router.post('/heartbeat/trigger', async (_req: Request, res: Response) => {
  try {
    const result = await heartbeatService.triggerHeartbeat();
    res.json({ success: true, result });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to trigger heartbeat for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/heartbeat/status
 * Get the heartbeat state for an agent.
 */
router.get('/heartbeat/status', async (_req: Request, res: Response) => {
  try {
    const status = heartbeatService.getStatus();
    res.json(status || { isActive: false, lastRun: null, isRunning: false, consecutiveErrors: 0 });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get heartbeat status for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/heartbeat/slack-trigger
 * Notify agent-runtime that new Slack messages are queued in the DB.
 * No body required — agent-runtime drains messages from the backend.
 */
router.post('/heartbeat/slack-trigger', async (_req: Request, res: Response) => {
  try {
    const status = heartbeatService.triggerFromSlack();

    if (status === 'ignored') {
      res.status(404).json({ error: 'No active heartbeat' });
      return;
    }

    res.json({ success: true, status });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to trigger heartbeat from Slack for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PATCH /agents/heartbeat/interval
 * Update the heartbeat interval. Persists to AgentWorkspace and restarts
 * the in-process timer with the new interval.
 * Body: { intervalMs: number }
 */
const MIN_INTERVAL = '1 minute';
const MIN_INTERVAL_MS = 60_000;

const MAX_INTERVAL = '1 week';
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60_000;

router.patch('/heartbeat/interval', async (req: Request, res: Response) => {
  try {
    const { intervalMs } = req.body;

    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs)) {
      res.status(400).json({ error: 'intervalMs must be a finite number' });
      return;
    }
    if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
      res.status(400).json({
        error: `intervalMs must be between ${MIN_INTERVAL_MS} (${MIN_INTERVAL}) and ${MAX_INTERVAL_MS} (${MAX_INTERVAL})`,
      });
      return;
    }

    const existing = await agentWorkspaceService.getAgent();

    const updated = await prisma.agentWorkspace.update({
      where: { id: existing.id },
      data: { heartbeatIntervalMs: intervalMs },
    });

    // Re-register the timer with the new interval. startHeartbeat already
    // clears any existing timer and short-circuits if heartbeatStatus is
    // STOPPED, so the user's start/stop preference is respected without
    // us racing the persisted heartbeat-status flag.
    heartbeatService.startHeartbeat(updated);

    res.json(
      heartbeatService.getStatus() ?? {
        isActive: false,
        lastRun: null,
        isRunning: false,
        consecutiveErrors: 0,
        intervalMs,
      },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to update heartbeat interval for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Cron Management
// ============================================================================

/**
 * GET /agents/cron-tasks
 * List cron tasks for an agent.
 */
router.get('/cron-tasks', async (_req: Request, res: Response) => {
  try {
    const tasks = await prisma.cronTask.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json(tasks);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to list cron tasks for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/cron-tasks
 * Create + register a cron task. Mirrors the agent's own `schedule_task`
 * tool: persists to Prisma first, then registers in-memory via the
 * scheduler service.
 * Body: { name, schedule, instruction }
 */
router.post('/cron-tasks', async (req: Request, res: Response) => {
  try {
    const { name, schedule, instruction } = req.body;
    if (!name || !schedule) {
      res.status(400).json({ error: 'Missing required fields: name, schedule' });
      return;
    }

    const agent = await agentWorkspaceService.getAgent();

    const { cronExpression, isOneShot, nextRunAt } = parseSchedule(schedule);
    if (!isOneShot && !cron.validate(cronExpression)) {
      res.status(400).json({ error: `Invalid cron expression: ${cronExpression}` });
      return;
    }

    const task = await prisma.cronTask.create({
      data: {
        agentId: agent.id,
        userId: agent.userId,
        name,
        schedule: cronExpression,
        instruction: instruction ?? '',
        nextRunAt,
      },
    });

    cronSchedulerService.scheduleTask({
      id: task.id,
      agentId: agent.id,
      userId: agent.userId,
      name: task.name,
      schedule: task.schedule,
      instruction: task.instruction,
      isActive: task.isActive,
      nextRunAt: task.nextRunAt?.toISOString() ?? null,
      lastRunAt: task.lastRunAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    });

    res.status(201).json(task);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to create cron task for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/cron-tasks/:taskId
 * Unschedule + delete a cron task.
 */
router.delete('/cron-tasks/:taskId', async (req: Request<{ taskId: string }>, res: Response) => {
  try {
    const { taskId } = req.params;
    cronSchedulerService.unscheduleTask(taskId);
    try {
      await prisma.cronTask.delete({ where: { id: taskId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        res.status(404).json({ error: 'Cron task not found' });
        return;
      }
      throw err;
    }
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete cron task ${req.params.taskId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Slack Heartbeat Trigger Management
// ============================================================================

/**
 * GET /agents/slack-heartbeat-trigger/channel/:channelId
 * Check if a Slack channel is a heartbeat trigger channel.
 */
router.get('/slack-heartbeat-trigger/channel/:channelId', async (req: Request<{ channelId: string }>, res: Response) => {
  try {
    const result = await slackHeartbeatTriggerService.isHeartbeatTriggerChannel(req.params.channelId);
    res.json(result);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to check heartbeat trigger channel ${req.params.channelId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/slack-heartbeat-trigger
 * Get active heartbeat triggers for a specific agent.
 * Query: ?userId=...
 */
router.get('/slack-heartbeat-trigger', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'Missing userId query parameter' });
      return;
    }
    const triggers = await slackHeartbeatTriggerService.getActiveTriggers(userId);
    res.json(triggers);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get heartbeat triggers for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/slack-heartbeat-trigger
 * Create a new heartbeat trigger.
 * Body: { connectionId, channelId, channelName, userId, throttleSeconds? }
 */
router.post('/slack-heartbeat-trigger', async (req: Request, res: Response) => {
  try {
    const { connectionId, channelId, channelName, userId, throttleSeconds } = req.body;
    if (!connectionId || !channelId || !userId) {
      res.status(400).json({ error: 'Missing required fields: connectionId, channelId, userId' });
      return;
    }
    const trigger = await slackHeartbeatTriggerService.createTrigger(
      connectionId, channelId, channelName ?? null, userId, throttleSeconds,
    );
    res.status(201).json(trigger);
  } catch (error: unknown) {
    // Prisma unique constraint violation (agentId is @unique)
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      res.status(409).json({ error: 'Agent already has a heartbeat trigger configured. Delete the existing one first.' });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to create heartbeat trigger for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PATCH /agents/slack-heartbeat-trigger
 * Update throttle settings for a trigger.
 * Body: { triggerId, userId, throttleSeconds }
 */
router.patch('/slack-heartbeat-trigger', async (req: Request, res: Response) => {
  try {
    const { triggerId, userId, throttleSeconds } = req.body;
    if (!triggerId || !userId || throttleSeconds === undefined) {
      res.status(400).json({ error: 'Missing required fields: triggerId, userId, throttleSeconds' });
      return;
    }
    const updated = await slackHeartbeatTriggerService.updateThrottle(triggerId, userId, throttleSeconds);
    if (!updated) {
      res.status(404).json({ error: 'Trigger not found' });
      return;
    }
    res.json(updated);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to update heartbeat trigger throttle for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/slack-heartbeat-trigger/:id
 * Delete a heartbeat trigger.
 * Query: ?userId=...
 */
router.delete('/slack-heartbeat-trigger/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'Missing userId query parameter' });
      return;
    }
    await slackHeartbeatTriggerService.deleteTrigger(req.params.id, userId);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete heartbeat trigger ${req.params.id}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/slack-heartbeat-trigger/claim
 * Atomically try to claim a trigger for firing.
 */
router.post('/slack-heartbeat-trigger/claim', async (_req: Request, res: Response) => {
  try {
    const result = await slackHeartbeatTriggerService.tryClaimTrigger();
    res.json(result);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to claim heartbeat trigger for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Conversation
// ============================================================================

/**
 * POST /agents/threads/get-or-create-active
 * Get or create the active thread for a user+agent pair.
 * Body: { agentId, userId }
 */
router.post('/threads/get-or-create-active', async (req: Request, res: Response) => {
  try {
    const { agentId, userId } = req.body;
    if (!agentId || !userId) {
      res.status(400).json({ error: 'Missing required fields: agentId, userId' });
      return;
    }
    const thread = await conversationService.getOrCreateActiveThread(agentId, userId);
    res.json(thread);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get or create active thread: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/threads
 * List threads for a user+agent with optional status filter and limit.
 * Query: { userId (required), agentId (required), status?, limit? }
 */
router.get('/threads', async (req: Request, res: Response) => {
  try {
    const { userId, agentId, status, limit } = req.query;
    if (!userId || !agentId) {
      res.status(400).json({ error: 'Missing required query params: userId, agentId' });
      return;
    }

    if (status !== undefined && !Object.values(ThreadStatus).includes(status as ThreadStatus)) {
      res.status(400).json({ error: `Invalid status: ${status}. Must be one of: ${Object.values(ThreadStatus).join(', ')}` });
      return;
    }

    let parsedLimit: number | undefined;
    if (limit !== undefined) {
      parsedLimit = Number(limit);
      if (!Number.isFinite(parsedLimit) || !Number.isInteger(parsedLimit) || parsedLimit < 1) {
        res.status(400).json({ error: 'limit must be a positive integer' });
        return;
      }
    }

    const threads = await conversationService.listThreads(
      userId as string,
      agentId as string,
      {
        status: status as ThreadStatus | undefined,
        limit: parsedLimit,
      }
    );

    res.json(threads);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to list threads: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/threads/get-or-create-by-external-id
 * Get or create a thread bound to an external thread ID (e.g. Slack thread timestamp).
 * Body: { userId, agentId, externalThreadId, channelId? }
 */
router.post('/threads/get-or-create-by-external-id', async (req: Request, res: Response) => {
  try {
    const { userId, agentId, externalThreadId, channelId } = req.body;
    if (!userId || !agentId || !externalThreadId) {
      res.status(400).json({ error: 'Missing required fields: userId, agentId, externalThreadId' });
      return;
    }
    const thread = await conversationService.getOrCreateThreadByExternalId(
      userId, agentId, externalThreadId, channelId ? { channelId } : undefined
    );
    res.json(thread);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get or create thread by external ID: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/threads/:threadId
 * Fetch a thread with messages (with ownership check).
 * Query: { userId, agentId }
 */
router.get('/threads/:threadId', async (req: Request<{ threadId: string }>, res: Response) => {
  try {
    const { threadId } = req.params;
    const { userId, agentId } = req.query;
    if (!userId || !agentId) {
      res.status(400).json({ error: 'Missing required query params: userId, agentId' });
      return;
    }

    const thread = await conversationService.getThread(
      userId as string,
      agentId as string,
      threadId
    );

    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    res.json(thread);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get thread: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/threads/:threadId/messages
 * Add a message to a thread.
 * Body: { content, role, triggeredBy, toolCalls?, blocks?, tokenCount?, senderExternalId?, senderName? }
 */
router.post('/threads/:threadId/messages', async (req: Request<{ threadId: string }, unknown, MessageInput>, res: Response) => {
  try {
    const { threadId } = req.params;
    const { content, role, triggeredBy, toolCalls, blocks, tokenCount, senderExternalId, senderName } = req.body;
    const missingFields = [
      ...(!content ? ['content'] : []),
      ...(!role ? ['role'] : []),
      ...(!triggeredBy ? ['triggeredBy'] : []),
    ];
    if (missingFields.length > 0) {
      res.status(400).json({ error: `Missing required field(s): ${missingFields.join(', ')}` });
      return;
    }

    if (!Object.values(MessageRole).includes(role)) {
      res.status(400).json({ error: `Invalid role: ${role}. Must be one of: ${Object.values(MessageRole).join(', ')}` });
      return;
    }

    if (!Object.values(MessageTrigger).includes(triggeredBy)) {
      res.status(400).json({ error: `Invalid triggeredBy: ${triggeredBy}. Must be one of: ${Object.values(MessageTrigger).join(', ')}` });
      return;
    }

    const message = await conversationService.addMessage(threadId, {
      content, role, triggeredBy, toolCalls, blocks, tokenCount, senderExternalId, senderName,
    });

    res.status(201).json(message);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to add message to thread ${req.params.threadId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/threads/:threadId/archive
 * Deactivate a thread (sets status to NON_ACTIVE). Path kept as /archive for backwards compatibility.
 * Body: { userId? } — optional ownership check param
 */
router.post('/threads/:threadId/archive', async (req: Request<{ threadId: string }>, res: Response) => {
  try {
    const { threadId } = req.params;
    const { userId } = req.body;
    await conversationService.deactivateThread(threadId, userId);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to deactivate thread ${req.params.threadId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/threads/:threadId/set-external-id
 * Set the external thread ID on a thread.
 * Body: { externalThreadId }
 */
router.post('/threads/:threadId/set-external-id', async (req: Request<{ threadId: string }>, res: Response) => {
  try {
    const { threadId } = req.params;
    const { externalThreadId } = req.body;
    if (!externalThreadId) {
      res.status(400).json({ error: 'Missing required field: externalThreadId' });
      return;
    }
    await conversationService.setExternalId(threadId, externalThreadId);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to set external ID on thread ${req.params.threadId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Slack Verification
// ============================================================================

/**
 * POST /agents/slack/verify-link-code
 * Verify a DM linking code from Slack.
 * Body: { code, slackUserId, dmChannelId }
 */
router.post('/slack/verify-link-code', async (req: Request, res: Response) => {
  try {
    const { code, slackUserId, dmChannelId } = req.body;
    if (!code || !slackUserId || !dmChannelId) {
      res.status(400).json({ error: 'Missing required fields: code, slackUserId, dmChannelId' });
      return;
    }

    const upperCode = (code as string).toUpperCase();
    const verification = await prisma.slackVerificationCode.findUnique({
      where: { code_type: { code: upperCode, type: 'DM' } },
    });

    if (!verification) {
      res.json({ success: false, message: 'Invalid code. Please generate a new code from the Lens Agents web app.' });
      return;
    }

    if (new Date() > verification.expiresAt) {
      await prisma.slackVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'DM' } },
      }).catch(() => {});
      res.json({ success: false, message: 'Code expired. Please generate a new code from the Lens Agents web app.' });
      return;
    }

    // Check if this Slack user is already linked to someone
    const existingSlackLink = await prisma.slackMapping.findFirst({
      where: {
        connectionId: verification.connectionId,
        slackUserId,
      },
    });

    if (existingSlackLink) {
      if (existingSlackLink.lensUserId === verification.lensUserId) {
        res.json({ success: false, message: 'Your Slack account is already linked to another agent. Unlink it first from that agent\'s settings.' });
        return;
      }
      res.json({ success: false, message: 'This Slack account is already linked to another Lens Platform user.' });
      return;
    }

    // Atomic: create mapping + consume code
    await prisma.$transaction([
      prisma.slackMapping.create({
        data: {
          connectionId: verification.connectionId,
          agentId: verification.agentId,
          slackUserId,
          lensUserId: verification.lensUserId,
          dmChannelId,
        },
      }),
      prisma.slackVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'DM' } },
      }),
    ]);

    logger.info({ slackUserId, lensUserId: verification.lensUserId }, 'Slack account linked via code: %s -> %s', slackUserId, verification.lensUserId);

    res.json({ success: true, message: 'Your Slack account is now linked to Lens Platform! You can now chat with your agent here.' });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to verify Slack link code: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/slack/verify-channel-link-code
 * Verify a channel linking code from Slack.
 * Body: { code, channelId, channelName? }
 */
router.post('/slack/verify-channel-link-code', async (req: Request, res: Response) => {
  try {
    const { code, channelId, channelName } = req.body;
    if (!code || !channelId) {
      res.status(400).json({ error: 'Missing required fields: code, channelId' });
      return;
    }

    const upperCode = (code as string).toUpperCase();
    const verification = await prisma.slackVerificationCode.findUnique({
      where: { code_type: { code: upperCode, type: 'CHANNEL' } },
    });

    if (!verification) {
      res.json({ success: false, message: 'Invalid code. Please generate a new code from the Lens Agents web app.' });
      return;
    }

    if (new Date() > verification.expiresAt) {
      await prisma.slackVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'CHANNEL' } },
      }).catch(() => {});
      res.json({ success: false, message: 'Code expired. Please generate a new code from the Lens Agents web app.' });
      return;
    }

    // Check if this channel is already linked
    const existingChannelLink = await prisma.slackMapping.findUnique({
      where: { slackChannelId: channelId },
    });

    if (existingChannelLink) {
      res.json({ success: false, message: 'This channel is already linked to an agent.' });
      return;
    }

    // Atomic: create channel mapping + consume code
    await prisma.$transaction([
      prisma.slackMapping.create({
        data: {
          connectionId: verification.connectionId,
          agentId: verification.agentId,
          slackChannelId: channelId,
          slackChannelName: channelName || null,
          lensUserId: verification.lensUserId,
          slackUserId: null,
          dmChannelId: null,
        },
      }),
      prisma.slackVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'CHANNEL' } },
      }),
    ]);

    logger.info({ channelId, lensUserId: verification.lensUserId }, 'Slack channel linked via code: %s -> %s\'s agent', channelId, verification.lensUserId);

    res.json({
      success: true,
      message: `Channel linked to ${verification.agentName}!`,
      agentName: verification.agentName ?? undefined,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to verify channel link code: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/slack/create-verification-code
 * Generate a 6-char hex verification code and persist it, retrying on unique constraint collision.
 * Body: { type, lensUserId, connectionId, agentId, agentName?, expiresAt }
 */
const MAX_CODE_ATTEMPTS = 5;

router.post('/slack/create-verification-code', async (req: Request, res: Response) => {
  logger.info('[Management] Received request to create Slack verification code');

  // Cleanup expired codes opportunistically (fire-and-forget)
  prisma.slackVerificationCode.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  }).catch(() => {});

  logger.debug('[Management] Triggered opportunistic cleanup of expired Slack verification codes');

  try {
    const { type, lensUserId, connectionId, agentId, agentName, expiresAt } = req.body;
    logger.info({ type, lensUserId, connectionId, agentId, agentName, expiresAt }, '[Management] Create verification code request body');
    if (!type || !lensUserId || !connectionId || !agentId || !expiresAt) {
      logger.warn('[Management] Rejecting create verification code request: missing required fields');
      res.status(400).json({ error: 'Missing required fields: type, lensUserId, connectionId, agentId, expiresAt' });
      return;
    }

    const data: Prisma.SlackVerificationCodeUncheckedCreateInput = {
      type,
      lensUserId,
      connectionId,
      agentId,
      expiresAt: new Date(expiresAt),
      code: '', // placeholder, set in loop
      ...(agentName ? { agentName } : {}),
    };

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      logger.debug(`[Management] Generating verification code, attempt ${attempt + 1}/${MAX_CODE_ATTEMPTS}`);
      const code = randomBytes(3).toString('hex').toUpperCase();
      try {
        await prisma.slackVerificationCode.create({ data: { ...data, code } });
        res.json({ code });
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Management] Error creating verification code on attempt ${attempt + 1}/${MAX_CODE_ATTEMPTS}: ${msg}`);
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          attempt < MAX_CODE_ATTEMPTS - 1
        ) {
          continue; // collision — retry with a new code
        }
        throw error;
      }
    }

    logger.error(`[Management] Failed to generate a unique verification code after ${MAX_CODE_ATTEMPTS} attempts`);
    res.status(500).json({ error: 'Failed to generate a unique verification code' });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to create verification code: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Slack Mapping Management
// ============================================================================

/**
 * GET /agents/slack/workspaces
 * List connected Slack workspaces (teamName + botUserId). Used by the
 * Web UI's Channels page header.
 */
router.get('/slack/workspaces', async (_req: Request, res: Response) => {
  try {
    res.json({ workspaces: slackAdapterService.listConnectedWorkspaces() });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to list slack workspaces: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/slack-link-status
 * Check whether the agent has DM and/or channel mappings for a connection.
 * Query: connectionId (required)
 */
router.get('/slack-link-status', async (req: Request, res: Response) => {
  try {
    const connectionId = req.query.connectionId as string;
    if (!connectionId) {
      res.status(400).json({ error: 'Missing connectionId query parameter' });
      return;
    }

    const dmMapping = await prisma.slackMapping.findFirst({
      where: { connectionId, slackUserId: { not: null } },
      select: { slackUserId: true },
    });

    const hasChannelMapping = await prisma.slackMapping.findFirst({
      where: { slackChannelId: { not: null } },
      select: { id: true },
    }) !== null;

    res.json({ hasDmMapping: dmMapping !== null, hasChannelMapping, slackUserId: dmMapping?.slackUserId ?? null });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get slack link status for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/slack-channel-mappings
 * List channel mappings for the agent, filtered by connection.
 * Query: connectionId (required)
 */
router.get('/slack-channel-mappings', async (req: Request, res: Response) => {
  try {
    const connectionId = req.query.connectionId as string;
    if (!connectionId) {
      res.status(400).json({ error: 'Missing connectionId query parameter' });
      return;
    }

    const mappings = await prisma.slackMapping.findMany({
      where: {
        connectionId,
        slackChannelId: { not: null },
      },
      include: {
        agentWorkspace: {
          select: { name: true },
        },
      },
    });

    const channels = mappings.map(m => ({
      id: m.id,
      channelId: m.slackChannelId,
      channelName: m.slackChannelName,
      agentName: m.agentWorkspace.name,
      linkedAt: m.createdAt,
    }));

    res.json({ channels });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get slack channel mappings for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/slack/channel-mapping/:channelId
 * Find a channel mapping by Slack channel ID.
 * Query: connectionId (optional, narrows search to specific connection)
 */
router.get('/slack/channel-mapping/:channelId', async (req: Request<{ channelId: string }>, res: Response) => {
  try {
    const { channelId } = req.params;
    const connectionId = req.query.connectionId as string | undefined;

    const where: { slackChannelId: string; connectionId?: string } = { slackChannelId: channelId };
    if (connectionId) where.connectionId = connectionId;

    const mapping = await prisma.slackMapping.findFirst({
      where,
      select: { id: true, agentId: true, slackChannelId: true },
    });

    if (!mapping) {
      res.status(404).json({ error: 'Channel mapping not found' });
      return;
    }

    res.json({ mapping });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to find channel mapping for ${req.params.channelId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/slack/channel-mapping/:channelId
 * Delete a channel mapping by Slack channel ID.
 * Query: connectionId (optional, narrows deletion to specific connection)
 */
router.delete('/slack/channel-mapping/:channelId', async (req: Request<{ channelId: string }>, res: Response) => {
  try {
    const { channelId } = req.params;
    const connectionId = req.query.connectionId as string | undefined;

    const where: { slackChannelId: string; connectionId?: string } = { slackChannelId: channelId };
    if (connectionId) where.connectionId = connectionId;

    const result = await prisma.slackMapping.deleteMany({
      where,
    });

    if (result.count === 0) {
      res.status(404).json({ error: 'Channel mapping not found' });
      return;
    }

    res.json({ deleted: result.count });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete channel mapping for ${req.params.channelId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/slack/dm-mapping
 * Delete DM mappings for the agent and connection.
 * Query: connectionId (required)
 */
router.delete('/slack/dm-mapping', async (req: Request, res: Response) => {
  try {
    const connectionId = req.query.connectionId as string;
    if (!connectionId) {
      res.status(400).json({ error: 'Missing connectionId query parameter' });
      return;
    }

    const result = await prisma.slackMapping.deleteMany({
      where: { connectionId, slackUserId: { not: null } },
    });

    res.json({ deleted: result.count });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete DM mapping for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/slack-connection-id
 * Find the connectionId for the agent via SlackMapping.
 */
router.get('/slack-connection-id', async (_req: Request, res: Response) => {
  try {
    const mapping = await prisma.slackMapping.findFirst({
      select: { connectionId: true },
    });
    if (!mapping) {
      res.status(404).json({ error: 'No Slack mapping found for agent' });
      return;
    }
    res.json({ connectionId: mapping.connectionId });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get connection ID for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Slack Adapter Management
// ============================================================================

/**
 * POST /agents/slack/deliver
 * Deliver a message to Slack (DM or channel).
 * Body: { userId, message, channelContext? }
 */
router.post('/slack/deliver', async (req: Request, res: Response) => {
  try {
    const { userId, message, channelContext } = req.body;
    if (!userId || !message) {
      res.status(400).json({ error: 'Missing required fields: userId, message' });
      return;
    }
    await slackAdapterService.deliver(userId, message, channelContext);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to deliver Slack message: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/slack/initialize
 * Initialize all Slack connections.
 */
router.post('/slack/initialize', async (_req: Request, res: Response) => {
  try {
    await slackAdapterService.initialize();
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to initialize Slack: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/slack/shutdown
 * Shutdown all Slack connections.
 */
router.post('/slack/shutdown', async (_req: Request, res: Response) => {
  try {
    await slackAdapterService.shutdown();
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to shutdown Slack: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/slack/add-connection
 * Initialize a Slack workspace connection that was already stored in the backend database.
 * Body: { connectionId }
 */
router.post('/slack/add-connection', async (req: Request, res: Response) => {
  try {
    const { connectionId } = req.body;
    if (!connectionId) {
      res.status(400).json({ error: 'Missing required field: connectionId' });
      return;
    }
    // Initialize in the background — Socket Mode startup can take 15-30s.
    // The connection is already persisted by the backend before this call.
    slackAdapterService.initializeConnection(connectionId).catch((err) => {
      logger.error('[Management] Background Slack connection init failed: %s', err instanceof Error ? err.message : String(err));
    });
    res.json({ success: true, connectionId });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to add Slack connection: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/slack/remove-connection
 * Remove a Slack workspace connection.
 * Body: { connectionId }
 */
router.delete('/slack/remove-connection', async (req: Request, res: Response) => {
  try {
    const { connectionId } = req.body;
    if (!connectionId) {
      res.status(400).json({ error: 'Missing required field: connectionId' });
      return;
    }
    await slackAdapterService.disconnectAndDeactivate(connectionId);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to remove Slack connection: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/slack/link-user
 * Link a Slack user to a Lens user.
 * Body: { connectionId, slackUserId, lensUserId, agentId, dmChannelId? }
 */
router.post('/slack/link-user', async (req: Request, res: Response) => {
  try {
    const { connectionId, slackUserId, lensUserId, agentId, dmChannelId } = req.body;
    if (!connectionId || !slackUserId || !lensUserId || !agentId) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }
    await slackAdapterService.linkSlackUser(connectionId, slackUserId, lensUserId, agentId, dmChannelId);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to link Slack user: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/slack/is-connected/:userId
 * Check if a user has an active Slack connection.
 */
router.get('/slack/is-connected/:userId', async (req: Request<{ userId: string }>, res: Response) => {
  try {
    const connected = await slackAdapterService.isUserConnected(req.params.userId);
    res.json({ connected });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to check Slack connection: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/slack/channel-name
 * Get a channel's name from Slack API.
 * Query: { channelId, teamId }
 */
router.get('/slack/channel-name', async (req: Request, res: Response) => {
  try {
    const channelId = req.query.channelId as string;
    const teamId = req.query.teamId as string;
    if (!channelId || !teamId) {
      res.status(400).json({ error: 'Missing required query params: channelId, teamId' });
      return;
    }
    const name = await slackAdapterService.getChannelName(channelId, teamId);
    res.json({ name });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get channel name: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Chat (for frontend REST API)
// ============================================================================

/**
 * POST /agents/chat
 * Synchronous chat endpoint for the frontend REST API.
 * Backend delegates here instead of running the conversation engine locally.
 * Body: { userId, agentId, message, threadId?, metadata? }
 */
router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { userId, agentId, message, threadId, metadata } = req.body as ChatInput;
    if (!userId || !agentId || !message) {
      res.status(400).json({ error: 'userId, agentId, and message are required' });
      return;
    }

    const response = await conversationEngineService.chat({ userId, agentId, message, threadId, metadata });
    res.json(response);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Chat failed for user ${req.body?.userId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Agent CRUD
// ============================================================================

/**
 * POST /agents
 * Create a new agent with org/team context and default workspace files.
 * Body: { id, userId, name, agentType, teamName }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, userId, name, agentType, teamName } = req.body;
    if (!id || !userId || !name || !agentType || !teamName) {
      res.status(400).json({ error: 'Missing required fields: id, userId, name, agentType, teamName' });
      return;
    }

    const allowedAgentTypes = Object.values(AgentType);
    if (!allowedAgentTypes.includes(agentType)) {
      res.status(400).json({
        error: `Invalid agentType. Must be one of: ${allowedAgentTypes.join(', ')}`,
      });
      return;
    }
    const agent = await agentWorkspaceService.createAgent({ id, userId, name, agentType, teamName });
    res.status(201).json({ agent });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to create agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/details
 * Get the agent record (no access check).
 */
router.get('/details', async (_req: Request, res: Response) => {
  try {
    const agent = await agentWorkspaceService.getAgent();
    res.json({ agent });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, '[Management] Failed to get agent');
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents
 * Delete the agent with optional ownership check.
 * Body: { userId?, allowedByTeam? }
 */
router.delete('/', async (req: Request, res: Response) => {
  try {
    const { userId, allowedByTeam } = req.body || {};
    const result = await agentWorkspaceService.deleteAgent({ userId, allowedByTeam });
    res.json({ result });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/:agentId/subagents
 * List subagents for an agent.
 */
router.get('/:agentId/subagents', async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const subagents = await agentWorkspaceService.getSubagents(req.params.agentId);
    res.json({ subagents });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get subagents for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/:agentId/subagents
 * Add a subagent to a parent agent.
 * Body: { childAgentId, description? }
 */
router.post('/:agentId/subagents', async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const { childAgentId, description } = req.body;
    if (!childAgentId) {
      res.status(400).json({ error: 'Missing required field: childAgentId' });
      return;
    }
    const result = await agentWorkspaceService.addSubagent(req.params.agentId, childAgentId, description);
    if (typeof result === 'string') {
      const status = result === 'parent_not_found' || result === 'child_not_found' ? 404 : 400;
      res.status(status).json({ error: result });
      return;
    }
    res.status(201).json({ agent: result });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to add subagent to agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/:agentId/subagents/:childAgentId
 * Remove a subagent from a parent agent.
 */
router.delete('/:agentId/subagents/:childAgentId', async (req: Request<{ agentId: string; childAgentId: string }>, res: Response) => {
  try {
    const result = await agentWorkspaceService.removeSubagent(req.params.agentId, req.params.childAgentId);
    if (result === 'parent_not_found') {
      res.status(404).json({ error: result });
      return;
    }
    if (result === 'link_not_found') {
      res.status(404).json({ error: result });
      return;
    }
    res.json({ result });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to remove subagent from agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

export { router as managementRouter };
