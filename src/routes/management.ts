/**
 * Management Routes
 *
 * Express router exposing the runtime's REST surface — the agent-runtime
 * owns its own data, so these routes are the canonical CRUD layer for
 * heartbeat, cron, Slack mappings, threads, agent identity, and
 * subagent wiring. Called by the bundled Web UI. Lens Agents inbound routing
 * terminates auth in front of the container; routes are not protected
 * by an internal secret.
 *
 * Agent identity:
 *   GET    /agents/me                              - Agent identity (Web UI bootstrap)
 *   PATCH  /agents/name                            - Rename agent
 *   GET    /agents/model                           - Effective model (override or env default)
 *   PATCH  /agents/model                           - Set/clear per-agent LLM model override
 *   GET    /agents/heartbeat-model                 - Heartbeat model override + resolved effective
 *   PATCH  /agents/heartbeat-model                 - Set/clear heartbeat model override
 *   GET    /agents/cron-model                      - Cron model override + resolved effective
 *   PATCH  /agents/cron-model                      - Set/clear cron model override
 *   PATCH  /agents/verbose                         - Set per-step delivery flag
 *   GET    /agents/details                         - Full agent record (markdown fields, verbose, lockedIn)
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
 * Webhook subscriptions (inbound ingestion lives in routes/webhook.ts):
 *   GET    /agents/webhooks/receiver              - Receiver enabled state
 *   PATCH  /agents/webhooks/receiver              - Enable/disable the receiver
 *   GET    /agents/webhook-subscriptions          - List subscriptions
 *   POST   /agents/webhook-subscriptions          - Create subscription
 *   PATCH  /agents/webhook-subscriptions/:id      - Update (toggle/edit) subscription
 *   DELETE /agents/webhook-subscriptions/:id      - Delete subscription
 *
 * Skills (Agent Skills — agentskills.io):
 *   GET    /agents/skills                 - List available skills (name + description + source)
 *   POST   /agents/skills/:name/run       - Manually trigger a skill (streams over WS)
 *
 * Plugins (Agent Plugins — agent-plugins.org):
 *   GET    /agents/plugins                - List installed plugins and what each contributes
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
 *   POST   /agents/threads                                    - Create a thread (reuses an untouched one)
 *   POST   /agents/threads/get-or-create-latest               - Get or create latest thread
 *   GET    /agents/threads                                    - List threads
 *   GET    /agents/threads/:threadId                          - Fetch thread + messages
 *   POST   /agents/threads/:threadId/messages                 - Add message
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
import fs from 'fs';
import multer from 'multer';
import { AgentType, MessageRole, Prisma, ThreadSource, WebhookSubscription } from '@prisma/client';
import { logger } from '../logger';
import { webhookReceiverService } from '../services/webhook-receiver.service';
import { config } from '../config';
import { trackEvent } from '../lib/telemetry';
import { prisma } from '../lib/prisma';
import { heartbeatService } from '../services/heartbeat.service';
import { cronSchedulerService } from '../services/cron-scheduler.service';
import { slackHeartbeatTriggerService } from '../services/slack-heartbeat-trigger.service';
import { slackMappingService } from '../services/slack-mapping.service';
import { conversationService, type MessageInput } from '../services/conversation.service';
import { MESSAGE_TRIGGERS } from '../services/message-delivery.service';
import { conversationEngineService, type ChatInput } from '../services/conversation-engine.service';
import { skillCatalogService } from '../services/skill-catalog.service';
import { pluginCatalogService } from '../services/plugin-catalog.service';
import { pluginMcpService } from '../services/plugin-mcp.service';
import { parseMcpJson } from '../services/plugin-mcp-config';
import path from 'path';
import {
  filesFor,
  getExecutionEnvironment,
} from '../lib/execution-environments/get-execution-environment';
import { compactionService } from '../services/compaction.service';
import { slackAdapterService } from '../services/slack-adapter.service';
import { attachmentService, detectMediaType, classifyMediaType } from '../services/attachment.service';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB, GOAL_MAX_OBJECTIVE_CHARS } from '../constants';
import { goalService } from '../services/goal.service';
import { hasComputer } from '../services/computer/supported';
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
import {
  WEBHOOK_NAME_RE,
  isValidDeliverTo,
  normalizeWebhookName,
  parseCommaList,
  toPublicSubscription,
  WEBHOOK_DELIVER_TARGETS,
} from '../services/webhook.service';
import {
  isValidAuthAlgorithm,
  isValidAuthEncoding,
  isValidAuthType,
  WEBHOOK_AUTH_ALGORITHMS,
  WEBHOOK_AUTH_ENCODINGS,
  WEBHOOK_AUTH_TYPES,
  type WebhookAuthAlgorithm,
  type WebhookAuthEncoding,
  type WebhookAuthType,
} from '../lib/webhook-signature';

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
    res.json({
      agentId: agent.id,
      userId: agent.userId,
      name: agent.name,
      // The Web UI leaves the Computer page out where this host has no desktop for one.
      hasComputer: hasComputer(),
    });
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

/**
 * GET /agents/heartbeat-model
 * Returns `{ model, effective }`: the raw heartbeat override (`null` when
 * unset, so the UI can show "empty → falls back") and the model a heartbeat
 * run would actually use (heartbeat override → main override → env default).
 */
router.get('/heartbeat-model', async (_req: Request, res: Response) => {
  try {
    const { override, effective } = await agentWorkspaceService.getHeartbeatModelInfo();
    res.json({ model: override, effective });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to read heartbeat model for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PATCH /agents/heartbeat-model
 * Set or clear the heartbeat model override. Body: `{ model: string | null }`.
 * `null` clears it (falls back to the main model, then env default). Returns
 * `{ model, effective }` — same shape as the GET so the UI can prime its cache.
 */
router.patch('/heartbeat-model', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!('model' in body)) {
      res.status(400).json({ error: "missing required field 'model' (use null to clear)" });
      return;
    }
    const { override, effective } = await agentWorkspaceService.updateHeartbeatModel(body.model);
    res.json({ model: override, effective });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to update heartbeat model for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/cron-model
 */
router.get('/cron-model', async (_req: Request, res: Response) => {
  try {
    const { override, effective } = await agentWorkspaceService.getCronModelInfo();
    res.json({ model: override, effective });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to read cron model for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PATCH /agents/cron-model
 */
router.patch('/cron-model', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!('model' in body)) {
      res.status(400).json({ error: "missing required field 'model' (use null to clear)" });
      return;
    }
    const { override, effective } = await agentWorkspaceService.updateCronModel(body.model);
    res.json({ model: override, effective });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to update cron model for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PATCH /agents/verbose
 * Set the verbose (per-step delivery) flag.
 * Body: { verbose: boolean }
 */
router.patch('/verbose', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!('verbose' in body)) {
      res.status(400).json({ error: "missing required field 'verbose'" });
      return;
    }
    const verbose = await agentWorkspaceService.updateVerbose(body.verbose);
    res.json({ verbose });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to update verbose for agent: ${msg}`);
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
// Attachments (shared files)
// ============================================================================

// 10 MB cap (MAX_FILE_SIZE_BYTES) — bounds storage and the token cost of
// re-exposing files to the LLM every turn. Same memory-storage + JSON-400
// wrapper shape as the archive upload above, just a smaller limit.
const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE_BYTES } });

function uploadAttachmentFile(req: Request, res: Response, next: (err?: unknown) => void): void {
  attachmentUpload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_FILE_SIZE_MB} MB)` : err.message;
      res.status(400).json({ error: `Upload rejected: ${message}` });
      return;
    }
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Upload failed' });
      return;
    }
    next();
  });
}

/** Strip CR/LF, quotes, backslashes and control chars from a header value. */
function sanitizeFilename(name: string): string {
  const noQuotes = name.replace(/[\r\n"\\]/g, '_');
  let out = '';
  for (let i = 0; i < noQuotes.length; i++) {
    if (noQuotes.charCodeAt(i) >= 0x20) out += noQuotes[i];
  }
  return out.trim().slice(0, 255) || 'file';
}

/**
 * Build a Content-Disposition value that survives non-latin1 filenames.
 * Node rejects header values outside latin-1 outright (ERR_INVALID_CHAR),
 * so `filename=` carries an ASCII-only fallback while the real name travels
 * RFC 5987-encoded in `filename*` (which modern clients prefer).
 */
function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const sanitized = sanitizeFilename(filename);
  const ascii = sanitized.replace(/[^\x20-\x7e]/g, '_');
  // RFC 5987 percent-encoding: encodeURIComponent, plus the characters it
  // leaves bare that aren't attr-chars.
  const rfc5987 = encodeURIComponent(sanitized).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${rfc5987}`;
}

/**
 * POST /agents/attachments
 * Multipart upload of one shared file (web drag-and-drop). Stores the bytes as
 * a BLOB and returns metadata only (never the bytes). The attachment is created
 * unlinked; the chat send links it to the user message via `attachmentIds`.
 */
router.post('/attachments', uploadAttachmentFile, async (req: Request, res: Response) => {
  try {
    const file = (req as Request & {
      file?: { buffer: Buffer; originalname: string; mimetype?: string; size: number };
    }).file;
    if (!file?.buffer?.length) {
      res.status(400).json({ error: 'Missing or empty `file` field in multipart body' });
      return;
    }
    // Defense-in-depth: multer already enforces the limit, but re-check.
    if (file.size > MAX_FILE_SIZE_BYTES) {
      res.status(400).json({ error: `File too large (max ${MAX_FILE_SIZE_MB} MB)` });
      return;
    }

    const threadId =
      typeof req.body?.threadId === 'string' && req.body.threadId ? req.body.threadId : undefined;
    const mediaType = detectMediaType(file.buffer, file.originalname, file.mimetype);
    const category = classifyMediaType(mediaType);

    const row = await attachmentService.create({
      filename: file.originalname || 'file',
      mediaType,
      sizeBytes: file.size,
      data: file.buffer,
      category,
      source: 'web',
      threadId,
    });

    res.status(201).json({
      id: row.id,
      filename: row.filename,
      mediaType: row.mediaType,
      sizeBytes: row.sizeBytes,
      category: row.category,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to store attachment: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/attachments/:id
 * Stream a stored file's bytes back for download/preview. `inline` lets the
 * browser preview images/PDFs; the web UI's `<a download>` still forces a save.
 */
router.get('/attachments/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const att = await attachmentService.getById(req.params.id);
    if (!att) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }
    const bytes = await attachmentService.loadBytes(att);
    if (!bytes) {
      // Metadata row outlives its content (168h TTL) — Gone, not Not Found.
      res.status(410).json({ error: 'Attachment content expired' });
      return;
    }
    const isPreviewable = att.mediaType.startsWith('image/') || att.mediaType === 'application/pdf';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', isPreviewable ? att.mediaType : 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(isPreviewable ? 'inline' : 'attachment', att.filename));
    res.send(bytes);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to fetch attachment ${req.params.id}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/attachments/:id
 * Remove a pre-send (unlinked) attachment — used when the user removes a chip
 * before sending. Linked attachments are immutable here (cascade with messages).
 */
router.delete('/attachments/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const deleted = await attachmentService.deleteUnlinked(req.params.id);
    if (deleted === 0) {
      res.status(404).json({ error: 'Attachment not found or already linked to a message' });
      return;
    }
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete attachment ${req.params.id}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Heartbeat Management
// ============================================================================

/**
 * POST /agents/heartbeat/start
 * Start or restart the heartbeat timer for an agent.
 * Body: { agent } — kept as the request's shape; the config is read from the
 * database.
 */
router.post('/heartbeat/start', async (req: Request, res: Response) => {
  try {
    const { agent } = req.body;
    if (!agent) {
      res.status(400).json({ error: 'Missing agent in request body' });
      return;
    }

    // The schedule comes off the persisted row, not the body: a client sends the
    // agent as JSON, where a timestamp is an ISO string rather than a Date, and
    // the interval, the last run and the stored deadline all decide it.
    const persisted = await agentWorkspaceService.getAgent();

    // Force-enable: this endpoint's whole purpose is to turn the heartbeat on,
    // regardless of what status the persisted row happens to carry. The
    // STOPPED short-circuit in startHeartbeat is for the boot-time loader.
    heartbeatService.startHeartbeat({ ...persisted, heartbeatStatus: 'ENABLED' }, 'keep-schedule');
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

    // Re-register the timer with the new interval, which starts from now:
    // a user changing the cadence asks for the next check one new interval
    // away. startHeartbeat short-circuits if heartbeatStatus is STOPPED, so
    // the user's start/stop preference is respected without us racing the
    // persisted heartbeat-status flag.
    heartbeatService.startHeartbeat(updated, 'new-interval');

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
    // A recurring task stores no next run; its running job knows it. A one-shot's schedule is
    // the wording it was asked in, which node-cron does not read.
    res.json(
      tasks.map((task) => ({
        ...task,
        recurring: cron.validate(task.schedule),
        nextRunAt: task.nextRunAt ?? cronSchedulerService.nextRunFor(task.id),
      })),
    );
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
    // Trimmed before the check: a task without an instruction runs on its name, so a name of
    // only whitespace would be an empty prompt.
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const name = text(req.body.name);
    const schedule = text(req.body.schedule);
    const instruction = text(req.body.instruction);
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
        instruction,
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
      threadId: task.threadId,
      originChannel: task.originChannel,
      originChannelId: task.originChannelId,
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
    try {
      await prisma.cronTask.delete({ where: { id: taskId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        res.status(404).json({ error: 'Cron task not found' });
        return;
      }
      throw err;
    }
    // After the confirmed delete so the 'cron task deleted' event (owned by
    // unscheduleTask) never fires for nonexistent tasks.
    cronSchedulerService.unscheduleTask(taskId);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete cron task ${req.params.taskId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Webhook Management
// ============================================================================
//
// CRUD for inbound webhook subscriptions + the receiver master switch,
// consumed by the Webhooks page in the web SPA. The ingestion endpoint
// (POST /agents/webhooks/:name) lives in routes/webhook.ts.
//
// Responses always go through `toPublicSubscription()`: the stored sender
// secret must never travel back out, so clients see `hasSecret` instead.

/**
 * The generic sender-auth fields, as stored on a subscription row. The three
 * enumerated ones are typed by lib/webhook-signature's unions, which are the
 * same members as the Prisma enums (pinned by a test), so validated values drop
 * straight into a create/update payload.
 */
interface WebhookAuthFields {
  authType: WebhookAuthType;
  authHeader: string | null;
  authPrefix: string | null;
  authAlgorithm: WebhookAuthAlgorithm;
  authEncoding: WebhookAuthEncoding;
  authSignedUrl: string | null;
  secret: string | null;
}

const WEBHOOK_AUTH_DEFAULTS: WebhookAuthFields = {
  authType: 'token',
  authHeader: null,
  authPrefix: null,
  authAlgorithm: 'sha256',
  authEncoding: 'hex',
  authSignedUrl: null,
  secret: null,
};

const WEBHOOK_AUTH_KEYS = [
  'authType',
  'authHeader',
  'authPrefix',
  'authAlgorithm',
  'authEncoding',
  'authSignedUrl',
  'secret',
] as const;

/** Whether `value` is an absolute http(s) URL, the only kind a sender can sign. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Read + validate the generic auth fields from a request body against the
 * subscription's current state, so a PATCH is judged on the **effective**
 * result (switching an existing row to 'hmac' without a stored secret is a 400,
 * not a silently unverifiable endpoint).
 *
 * Unlike the loosely-typed descriptive fields, a non-string credential is an
 * explicit error rather than an ignored value — silently dropping a secret
 * would leave the sender thinking it configured auth when it hasn't.
 */
function readWebhookAuthFields(
  body: Record<string, unknown>,
  current: WebhookAuthFields,
):
  | { ok: false; error: string; fieldErrors: Record<string, string> }
  | { ok: true; values: WebhookAuthFields } {
  const fail = (field: string, message: string) =>
    ({ ok: false as const, error: message, fieldErrors: { [field]: message } });

  // Pick the auth fields explicitly rather than spreading `current`: PATCH
  // passes the whole subscription row, and carrying its other columns into the
  // update payload would write back stale reads (clobbering a concurrent
  // isActive toggle, and pinning `updatedAt` to the value we just read).
  const values: WebhookAuthFields = {
    authType: current.authType,
    authHeader: current.authHeader,
    authPrefix: current.authPrefix,
    authAlgorithm: current.authAlgorithm,
    authEncoding: current.authEncoding,
    authSignedUrl: current.authSignedUrl,
    secret: current.secret,
  };

  if (body.authType !== undefined) {
    if (!isValidAuthType(body.authType)) {
      return fail('authType', `authType must be one of: ${WEBHOOK_AUTH_TYPES.join(', ')}`);
    }
    values.authType = body.authType;
  }
  if (body.authAlgorithm !== undefined) {
    if (!isValidAuthAlgorithm(body.authAlgorithm)) {
      return fail(
        'authAlgorithm',
        `authAlgorithm must be one of: ${WEBHOOK_AUTH_ALGORITHMS.join(', ')}`,
      );
    }
    values.authAlgorithm = body.authAlgorithm;
  }
  if (body.authEncoding !== undefined) {
    if (!isValidAuthEncoding(body.authEncoding)) {
      return fail('authEncoding', `authEncoding must be one of: ${WEBHOOK_AUTH_ENCODINGS.join(', ')}`);
    }
    values.authEncoding = body.authEncoding;
  }
  // Header, prefix, signed URL and secret: '' clears, non-strings are rejected.
  // The prefix keeps its inner spacing ('Bearer '); the others are trimmed.
  for (const key of ['authHeader', 'authPrefix', 'authSignedUrl', 'secret'] as const) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== 'string') {
      return fail(key, `${key} must be a string`);
    }
    const raw = body[key] === null ? '' : (body[key] as string);
    const normalized = key === 'authPrefix' ? raw : raw.trim();
    values[key] = normalized.length > 0 ? normalized : null;
  }

  // Only an HMAC signs a URL.
  if (values.authType !== 'hmac') values.authSignedUrl = null;
  if (values.authSignedUrl && !isHttpUrl(values.authSignedUrl)) {
    return fail('authSignedUrl', 'The signed URL must be an absolute http or https URL');
  }

  if (values.authType === 'none') {
    // Don't leave an orphan credential behind when verification is turned off.
    values.authHeader = null;
    values.authPrefix = null;
    values.secret = null;
    return { ok: true, values };
  }
  if (!values.secret) {
    return fail('secret', `A secret is required for '${values.authType}' authentication`);
  }
  if (!values.authHeader) {
    return fail(
      'authHeader',
      `A header name is required for '${values.authType}' authentication (e.g. X-Hub-Signature-256)`,
    );
  }
  return { ok: true, values };
}

/**
 * Read the Slack channel list from a request body, as the stored column value.
 * The list belongs to the Slack target. Each id has to name a channel linked
 * to the agent, or one the subscription already holds, so a channel unlinked
 * after it was chosen does not block an unrelated edit.
 */
async function readSlackChannelIds(
  raw: unknown,
  deliverTo: string,
  agentId: string,
  stored: string[],
): Promise<
  | { ok: false; error: string; fieldErrors: Record<string, string> }
  | { ok: true; value: string | null }
> {
  const fail = (message: string) =>
    ({ ok: false as const, error: message, fieldErrors: { slackChannelIds: message } });

  // null clears the list, as it clears the nullable fields beside it.
  const list = raw === null ? [] : raw;
  if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) {
    return fail('slackChannelIds must be an array of Slack channel ids');
  }
  const ids = [...new Set((list as string[]).map((id) => id.trim()).filter((id) => id.length > 0))];
  if (ids.length === 0) return { ok: true, value: null };
  if (deliverTo !== 'slack') {
    return fail("Slack channels apply only when deliverTo is 'slack'");
  }
  const linked = new Set(await slackMappingService.listChannelIds(agentId));
  const unknown = ids.filter((id) => !linked.has(id) && !stored.includes(id));
  if (unknown.length > 0) {
    return fail(`Not a Slack channel linked to the agent: ${unknown.join(', ')}`);
  }
  return { ok: true, value: ids.join(',') };
}

/**
 * GET /agents/webhooks/receiver
 * Whether the inbound webhook receiver is enabled, and where senders reach it:
 * the webhook port, plus its public origin when the deployment exposes one.
 */
router.get('/webhooks/receiver', async (_req: Request, res: Response) => {
  try {
    res.json({
      enabled: webhookReceiverService.enabled,
      port: config.webhookPort,
      publicUrl: config.webhookPublicUrl,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to read webhook receiver state: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PATCH /agents/webhooks/receiver
 * Enable/disable the inbound webhook receiver (hot toggle, no restart).
 * Body: { enabled: boolean }
 */
router.patch('/webhooks/receiver', async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    await webhookReceiverService.setEnabled(enabled);
    res.json({ enabled: webhookReceiverService.enabled });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to toggle webhook receiver: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/webhook-subscriptions
 * List webhook subscriptions.
 */
router.get('/webhook-subscriptions', async (_req: Request, res: Response) => {
  try {
    const subscriptions = await prisma.webhookSubscription.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json(subscriptions.map(toPublicSubscription));
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to list webhook subscriptions: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/** Deliver only posts the message template, and 'none' would discard it. */
const DELIVER_ONLY_NEEDS_TARGET = {
  error: "deliverOnly needs a deliverTo other than 'none'",
  fieldErrors: { deliverOnly: 'Deliver only needs a target. Choose a target other than None.' },
};

/**
 * POST /agents/webhook-subscriptions
 * Create a webhook subscription.
 * Body: { name, description?, events?, prompt?, deliverTo?, slackChannelIds?,
 *         deliverOnly?, authType?, authHeader?, authPrefix?, authAlgorithm?,
 *         authEncoding?, authSignedUrl?, secret? }
 */
router.post('/webhook-subscriptions', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const name = normalizeWebhookName(body.name);
    if (!name) {
      res.status(400).json({ error: 'name is required', fieldErrors: { name: 'Name is required' } });
      return;
    }
    if (!WEBHOOK_NAME_RE.test(name)) {
      res.status(400).json({
        error: `Invalid name: ${name}`,
        fieldErrors: { name: 'Use lowercase letters, digits, hyphens, and underscores (must start with a letter or digit)' },
      });
      return;
    }
    const deliverTo = body.deliverTo ?? 'all';
    if (!isValidDeliverTo(deliverTo)) {
      res.status(400).json({
        error: `deliverTo must be one of: ${WEBHOOK_DELIVER_TARGETS.join(', ')}`,
        fieldErrors: { deliverTo: `Must be one of: ${WEBHOOK_DELIVER_TARGETS.join(', ')}` },
      });
      return;
    }
    const deliverOnly = body.deliverOnly === true;
    if (deliverOnly && deliverTo === 'none') {
      res.status(400).json(DELIVER_ONLY_NEEDS_TARGET);
      return;
    }

    const auth = readWebhookAuthFields(body, WEBHOOK_AUTH_DEFAULTS);
    if (!auth.ok) {
      res.status(400).json({ error: auth.error, fieldErrors: auth.fieldErrors });
      return;
    }

    const agent = await agentWorkspaceService.getAgent();
    const channels = body.slackChannelIds === undefined
      ? { ok: true as const, value: null }
      : await readSlackChannelIds(body.slackChannelIds, deliverTo, agent.id, []);
    if (!channels.ok) {
      res.status(400).json({ error: channels.error, fieldErrors: channels.fieldErrors });
      return;
    }

    let subscription;
    try {
      subscription = await prisma.webhookSubscription.create({
        data: {
          agentId: agent.id,
          name,
          description: typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null,
          events: typeof body.events === 'string' && body.events.trim() ? body.events.trim() : null,
          prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : null,
          deliverTo,
          slackChannelIds: channels.value,
          deliverOnly,
          ...auth.values,
        },
      });
    } catch (err) {
      // P2002 = unique constraint (name)
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        res.status(409).json({
          error: `A subscription named "${name}" already exists`,
          fieldErrors: { name: `"${name}" is already taken` },
        });
        return;
      }
      throw err;
    }

    trackEvent('webhook subscription created', agent.userId, {
      'agent.id': agent.id,
      'webhook.subscription_id': subscription.id,
      'webhook.deliver_to': subscription.deliverTo,
      'webhook.slack_channels': String(parseCommaList(subscription.slackChannelIds).length),
      'webhook.deliver_only': String(subscription.deliverOnly),
      'webhook.auth_type': subscription.authType,
    });
    res.status(201).json(toPublicSubscription(subscription));
  } catch (error: unknown) {
    logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' },
      '[Management] Failed to create webhook subscription');
    res.status(500).json({ error: 'Failed to create webhook subscription' });
  }
});

/**
 * The update route's one telemetry event, sent on every terminal outcome with
 * the stored state on success.
 */
function trackSubscriptionUpdate(
  subscriptionId: string,
  outcome: 'success' | 'invalid' | 'not_found' | 'error',
  stored?: WebhookSubscription,
): void {
  trackEvent('webhook subscription updated', config.ownerUserId, {
    ...(config.agentId ? { 'agent.id': config.agentId } : {}),
    'webhook.subscription_id': subscriptionId,
    'webhook.outcome': outcome,
    ...(stored && {
      'webhook.is_active': String(stored.isActive),
      'webhook.deliver_to': stored.deliverTo,
      'webhook.slack_channels': String(parseCommaList(stored.slackChannelIds).length),
      'webhook.deliver_only': String(stored.deliverOnly),
      'webhook.auth_type': stored.authType,
    }),
  });
}

/**
 * PATCH /agents/webhook-subscriptions/:id
 * Update a subscription (isActive toggle and/or editable fields).
 * Body: any of { isActive, description, events, prompt, deliverTo,
 *                slackChannelIds, deliverOnly, authType, authHeader, authPrefix,
 *                authAlgorithm, authEncoding, authSignedUrl, secret }
 *
 * Auth fields are validated against the row's current state, so the *result*
 * of the update has to be verifiable — and switching authType to 'none' clears
 * the stored credential. The Slack channel list is validated against the
 * effective target, and a target other than 'slack' clears it.
 */
router.patch('/webhook-subscriptions/:id', async (req: Request<{ id: string }>, res: Response) => {
  const id = req.params.id;
  const reject = (status: 400 | 404, body: Record<string, unknown>) => {
    trackSubscriptionUpdate(id, status === 404 ? 'not_found' : 'invalid');
    res.status(status).json(body);
  };
  try {
    const body = req.body ?? {};
    const data: Prisma.WebhookSubscriptionUpdateInput = {};
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive;
    if (typeof body.description === 'string') data.description = body.description.trim() || null;
    if (typeof body.events === 'string') data.events = body.events.trim() || null;
    if (typeof body.prompt === 'string') data.prompt = body.prompt.trim() || null;
    if (body.deliverTo !== undefined) {
      if (!isValidDeliverTo(body.deliverTo)) {
        reject(400, {
          error: `deliverTo must be one of: ${WEBHOOK_DELIVER_TARGETS.join(', ')}`,
          fieldErrors: { deliverTo: `Must be one of: ${WEBHOOK_DELIVER_TARGETS.join(', ')}` },
        });
        return;
      }
      data.deliverTo = body.deliverTo;
    }
    if (typeof body.deliverOnly === 'boolean') data.deliverOnly = body.deliverOnly;

    // Auth, delivery and Slack channel fields need the current row to validate
    // the effective result.
    const editsAuth = WEBHOOK_AUTH_KEYS.some((key) => body[key] !== undefined);
    const editsDelivery = data.deliverTo !== undefined || data.deliverOnly !== undefined;
    const editsChannels = body.slackChannelIds !== undefined;
    if (editsAuth || editsDelivery || editsChannels) {
      const current = await prisma.webhookSubscription.findUnique({ where: { id } });
      if (!current) {
        reject(404, { error: 'Webhook subscription not found' });
        return;
      }
      const deliverTo = body.deliverTo ?? current.deliverTo;
      const deliverOnly = typeof body.deliverOnly === 'boolean' ? body.deliverOnly : current.deliverOnly;
      if (deliverOnly && deliverTo === 'none') {
        reject(400, DELIVER_ONLY_NEEDS_TARGET);
        return;
      }
      if (editsAuth) {
        const auth = readWebhookAuthFields(body, current);
        if (!auth.ok) {
          reject(400, { error: auth.error, fieldErrors: auth.fieldErrors });
          return;
        }
        Object.assign(data, auth.values);
      }
      if (editsChannels) {
        const channels = await readSlackChannelIds(
          body.slackChannelIds,
          deliverTo,
          current.agentId,
          parseCommaList(current.slackChannelIds),
        );
        if (!channels.ok) {
          reject(400, { error: channels.error, fieldErrors: channels.fieldErrors });
          return;
        }
        data.slackChannelIds = channels.value;
      } else if (data.deliverTo !== undefined && deliverTo !== 'slack') {
        data.slackChannelIds = null;
      }
    }

    if (Object.keys(data).length === 0) {
      reject(400, { error: 'No updatable fields provided' });
      return;
    }

    let subscription;
    try {
      subscription = await prisma.webhookSubscription.update({ where: { id }, data });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        reject(404, { error: 'Webhook subscription not found' });
        return;
      }
      throw err;
    }
    trackSubscriptionUpdate(id, 'success', subscription);
    res.json(toPublicSubscription(subscription));
  } catch (error: unknown) {
    logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' },
      '[Management] Failed to update webhook subscription');
    trackSubscriptionUpdate(id, 'error');
    res.status(500).json({ error: 'Failed to update webhook subscription' });
  }
});

/**
 * DELETE /agents/webhook-subscriptions/:id
 * Delete a subscription.
 */
router.delete('/webhook-subscriptions/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    let subscription;
    try {
      subscription = await prisma.webhookSubscription.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        res.status(404).json({ error: 'Webhook subscription not found' });
        return;
      }
      throw err;
    }
    // Telemetry is best-effort: the row is already gone, so a failure here
    // must not turn the response into a 500.
    try {
      const agent = await agentWorkspaceService.getAgent();
      trackEvent('webhook subscription deleted', agent.userId, {
        'agent.id': agent.id,
        'webhook.subscription_id': subscription.id,
      });
    } catch (telemetryError: unknown) {
      const msg = telemetryError instanceof Error ? telemetryError.message : String(telemetryError);
      logger.warn(`[Management] webhook-subscription-deleted telemetry failed: ${msg}`);
    }
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete webhook subscription ${req.params.id}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Goal Management
// ============================================================================

/**
 * GET /agents/goals
 * List all goals for the agent (newest first).
 */
router.get('/goals', async (_req: Request, res: Response) => {
  try {
    const agent = await agentWorkspaceService.getAgent();
    const goals = await goalService.listGoals(agent.id);
    res.json(goals);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to list goals: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/threads/:threadId/goal
 * The current active (or paused) goal for a thread, or null.
 */
router.get('/threads/:threadId/goal', async (req: Request<{ threadId: string }>, res: Response) => {
  try {
    const goal = await goalService.getGoalForThread(req.params.threadId);
    res.json(goal ?? null);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get goal for thread ${req.params.threadId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/goals
 * Start (or replace) the active goal on a thread. One active goal per thread.
 * Body: { threadId, objective, tokenBudget?, originChannel?, originChannelId? }
 */
router.post('/goals', async (req: Request, res: Response) => {
  try {
    const { threadId, objective, tokenBudget, originChannel, originChannelId } = req.body;
    if (!threadId || typeof objective !== 'string' || !objective.trim()) {
      res.status(400).json({ error: 'Missing required fields: threadId, objective' });
      return;
    }
    if (objective.length > GOAL_MAX_OBJECTIVE_CHARS) {
      res.status(400).json({ error: `Objective is too long (max ${GOAL_MAX_OBJECTIVE_CHARS} characters)` });
      return;
    }
    // tokenBudget is optional, but when present must be a positive integer —
    // reject negatives / non-integers / NaN / Infinity rather than passing them
    // through to a surprising immediate stop or a Prisma 500.
    if (tokenBudget !== undefined && tokenBudget !== null) {
      if (typeof tokenBudget !== 'number' || !Number.isInteger(tokenBudget) || tokenBudget <= 0) {
        res.status(400).json({ error: 'tokenBudget must be a positive integer' });
        return;
      }
    }

    const agent = await agentWorkspaceService.getAgent();
    const goal = await goalService.startGoal({
      userId: agent.userId,
      agentId: agent.id,
      threadId,
      objective,
      tokenBudget: typeof tokenBudget === 'number' ? tokenBudget : null,
      originChannel:
        originChannel === 'slack' || originChannel === 'teams' ? originChannel : 'websocket',
      originChannelId: typeof originChannelId === 'string' ? originChannelId : null,
    });
    res.status(201).json(goal);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to start goal: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/goals/:goalId
 * Stop a goal (aborts its loop).
 */
router.delete('/goals/:goalId', async (req: Request<{ goalId: string }>, res: Response) => {
  try {
    const goal = await goalService.stopGoal(req.params.goalId);
    if (!goal) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }
    res.json(goal);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to stop goal ${req.params.goalId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/goals/:goalId/pause
 * Pause an active goal (the loop exits after the current turn).
 */
router.post('/goals/:goalId/pause', async (req: Request<{ goalId: string }>, res: Response) => {
  try {
    const goal = await goalService.pauseGoal(req.params.goalId);
    if (!goal) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }
    res.json(goal);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to pause goal ${req.params.goalId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/goals/:goalId/resume
 * Resume a paused goal (restarts its loop).
 */
router.post('/goals/:goalId/resume', async (req: Request<{ goalId: string }>, res: Response) => {
  try {
    const goal = await goalService.resumeGoal(req.params.goalId);
    if (!goal) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }
    res.json(goal);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to resume goal ${req.params.goalId}: ${msg}`);
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
 * POST /agents/threads/get-or-create-latest
 * Get or create the latest thread for a user+agent pair.
 * Body: { agentId, userId }
 */
router.post('/threads/get-or-create-latest', async (req: Request, res: Response) => {
  try {
    const { agentId, userId } = req.body;
    if (!agentId || !userId) {
      res.status(400).json({ error: 'Missing required fields: agentId, userId' });
      return;
    }
    const thread = await conversationService.getOrCreateLatestThread(agentId, userId);
    res.json(thread);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get or create latest thread: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/threads
 * Start a fresh conversation (web "new conversation" button). Reuses the
 * newest thread when it is still untouched instead of creating another.
 * Body: { agentId, userId }
 */
router.post('/threads', async (req: Request, res: Response) => {
  try {
    const { agentId, userId } = req.body;
    if (!agentId || !userId) {
      res.status(400).json({ error: 'Missing required fields: agentId, userId' });
      return;
    }
    const thread = await conversationService.getOrCreateFreshThread(agentId, userId);
    res.json(thread);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to create thread: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/threads
 * List threads for a user+agent (newest first), with an optional limit.
 * `threadSource=DATABASE` keeps only web/CLI threads (drops Slack) — the
 * resumable set the web chat shows. Any value other than a known ThreadSource
 * is ignored (no channel filter).
 * Query: { userId (required), agentId (required), limit?, threadSource? }
 */
router.get('/threads', async (req: Request, res: Response) => {
  try {
    const { userId, agentId, limit, threadSource } = req.query;
    if (!userId || !agentId) {
      res.status(400).json({ error: 'Missing required query params: userId, agentId' });
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

    const source =
      threadSource === ThreadSource.DATABASE || threadSource === ThreadSource.SLACK
        ? (threadSource as ThreadSource)
        : undefined;

    const threads = await conversationService.listThreads(
      userId as string,
      agentId as string,
      { limit: parsedLimit, threadSource: source },
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
 * Body: { content, role, triggeredBy, toolCalls?, blocks?, senderExternalId?, senderName? }
 */
router.post('/threads/:threadId/messages', async (req: Request<{ threadId: string }, unknown, MessageInput>, res: Response) => {
  try {
    const { threadId } = req.params;
    const { content, role, triggeredBy, toolCalls, blocks, senderExternalId, senderName } = req.body;
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

    // Validated against the runtime's own list, not the Prisma enum: that enum keeps
    // SYSTEM so history stays readable, and nothing produces a SYSTEM message any more.
    if (!(MESSAGE_TRIGGERS as readonly string[]).includes(triggeredBy)) {
      res.status(400).json({ error: `Invalid triggeredBy: ${triggeredBy}. Must be one of: ${MESSAGE_TRIGGERS.join(', ')}` });
      return;
    }

    const { message } = await conversationService.addMessage(threadId, {
      content, role, triggeredBy, toolCalls, blocks, senderExternalId, senderName,
    });

    res.status(201).json(message);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to add message to thread ${req.params.threadId}: ${msg}`);
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
      res.json({ success: false, message: 'That code is not valid. Generate a new code in Prism Agent, under Settings → Channels.' });
      return;
    }

    if (new Date() > verification.expiresAt) {
      await prisma.slackVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'DM' } },
      }).catch(() => {});
      res.json({ success: false, message: 'That code has expired. Generate a new code in Prism Agent, under Settings → Channels.' });
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
      res.json({ success: false, message: 'This Slack account is already linked to another Prism Agent user.' });
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

    trackEvent('slack dm linked', verification.lensUserId, {
      'agent.id': verification.agentId,
      'slack.user.id': slackUserId,
    });

    res.json({ success: true, message: `Your Slack account is now linked. You can chat with ${verification.agentName || 'your agent'} here.` });
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
      res.json({ success: false, message: 'That code is not valid. Generate a new code in Prism Agent, under Settings → Channels.' });
      return;
    }

    if (new Date() > verification.expiresAt) {
      await prisma.slackVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'CHANNEL' } },
      }).catch(() => {});
      res.json({ success: false, message: 'That code has expired. Generate a new code in Prism Agent, under Settings → Channels.' });
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

    trackEvent('slack channel linked', verification.lensUserId, {
      'agent.id': verification.agentId,
      'slack.channel.id': channelId,
    });

    res.json({
      success: true,
      message: 'Your Slack channel is now linked. Mention me anytime you need help!',
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

  try {
    const { type, lensUserId, connectionId, agentId, agentName, expiresAt } = req.body;
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
        // The code itself stays out of telemetry.
        trackEvent('slack verification code created', lensUserId, {
          'agent.id': agentId,
          'verification.type': String(type),
        });
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
 * Check whether the agent has a DM and/or channel mapping.
 *
 * There is exactly one Slack connection (see `lib/slack-source.ts`), so there is
 * nothing to scope by — we intentionally do NOT filter by connectionId. Legacy
 * rows carry a UUID connectionId that never matches the env connection's teamId;
 * filtering on it would hide them.
 */
router.get('/slack-link-status', async (_req: Request, res: Response) => {
  try {
    const dmMapping = await prisma.slackMapping.findFirst({
      where: { slackUserId: { not: null } },
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
 * List the agent's channel mappings.
 *
 * There is exactly one Slack connection (see `lib/slack-source.ts`), so we
 * intentionally do NOT filter by connectionId — legacy rows carry a UUID
 * connectionId that never matches the env connection's teamId, and filtering on
 * it is what made linked channels vanish from the UI.
 */
router.get('/slack-channel-mappings', async (_req: Request, res: Response) => {
  try {
    const mappings = await prisma.slackMapping.findMany({
      where: {
        slackChannelId: { not: null },
      },
      include: {
        agentWorkspace: {
          select: { name: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Resolve the "main" channel the same way delivery does: the flagged one,
    // else the oldest linked channel as the implicit default. (One agent per
    // container, so a single resolution across the list is correct.)
    const mainId = (mappings.find(m => m.isMainChannel) ?? mappings[0])?.id ?? null;

    const channels = mappings.map(m => ({
      id: m.id,
      channelId: m.slackChannelId,
      channelName: m.slackChannelName,
      agentName: m.agentWorkspace.name,
      linkedAt: m.createdAt,
      isMain: m.id === mainId,
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
 *
 * `slackChannelId` is globally unique, and there is one Slack connection (see
 * `lib/slack-source.ts`), so the lookup is by channelId alone — no connectionId
 * scoping (which would 404 legacy rows).
 */
router.get('/slack/channel-mapping/:channelId', async (req: Request<{ channelId: string }>, res: Response) => {
  try {
    const { channelId } = req.params;

    const mapping = await prisma.slackMapping.findUnique({
      where: { slackChannelId: channelId },
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
 *
 * Keyed by the unique `slackChannelId` only — no connectionId scoping, so legacy
 * rows (UUID connectionId) can be unlinked. See `lib/slack-source.ts`.
 */
router.delete('/slack/channel-mapping/:channelId', async (req: Request<{ channelId: string }>, res: Response) => {
  try {
    const { channelId } = req.params;

    const result = await prisma.slackMapping.deleteMany({
      where: { slackChannelId: channelId },
    });

    if (result.count === 0) {
      res.status(404).json({ error: 'Channel mapping not found' });
      return;
    }

    trackEvent('slack channel mapping deleted', null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'slack.channel.id': channelId,
    });

    res.json({ deleted: result.count });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete channel mapping for ${req.params.channelId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PUT /agents/slack/channel-mapping/:channelId/main
 * Mark a linked channel as the agent's main channel — where heartbeat alerts
 * (and scheduled tasks with no resolvable origin channel) are posted. Clears the
 * flag on the agent's other channels so exactly one is main.
 */
router.put('/slack/channel-mapping/:channelId/main', async (req: Request<{ channelId: string }>, res: Response) => {
  try {
    const { channelId } = req.params;

    const mapping = await prisma.slackMapping.findUnique({
      where: { slackChannelId: channelId },
      select: { agentId: true },
    });

    if (!mapping) {
      res.status(404).json({ error: 'Channel mapping not found' });
      return;
    }

    await slackMappingService.setMainChannel(mapping.agentId, channelId);

    trackEvent('slack main channel set', null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'slack.channel.id': channelId,
    });

    res.json({ ok: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to set main channel for ${req.params.channelId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/slack/dm-mapping
 * Delete the agent's DM mapping.
 *
 * There is one Slack connection (see `lib/slack-source.ts`), so we delete the DM
 * mapping without connectionId scoping — legacy rows (UUID connectionId) would
 * otherwise be left undeletable.
 */
router.delete('/slack/dm-mapping', async (_req: Request, res: Response) => {
  try {
    const result = await prisma.slackMapping.deleteMany({
      where: { slackUserId: { not: null } },
    });

    if (result.count > 0) {
      trackEvent('slack dm mapping deleted', null, {
        ...(config.agentId ? { 'agent.id': config.agentId } : {}),
        'slack.mappings_removed': String(result.count),
      });
    }

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
    const { userId, agentId, message, threadId, metadata, attachmentIds } = req.body as ChatInput;
    const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;
    if (!userId || !agentId || typeof message !== 'string' || (!message.trim() && !hasAttachments)) {
      res.status(400).json({ error: 'userId, agentId, and either message text or attachmentIds are required' });
      return;
    }

    // Cancel the in-flight generation when the HTTP client hangs up. The
    // listener goes on `res`, not `req`: `req` emits 'close' once its stream is
    // drained, which the body parser does before this handler runs.
    // `writableEnded` tells a hang-up from a reply that finished normally.
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const response = await conversationEngineService.chat({
      userId, agentId, message, threadId, metadata, attachmentIds,
      abortSignal: controller.signal,
    });
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

// ---------------------------------------------------------------------------
// Skills (Agent Skills — agentskills.io). Used by both the web SPA and the CLI.
// ---------------------------------------------------------------------------

/**
 * GET /agents/skills — available Agent Skills (name + description + on-disk
 * folder + source). Bodies are NOT included; the agent loads a skill's full
 * SKILL.md via the `skill` tool (progressive disclosure). Powers the `/skills`
 * listing.
 *
 * The listing is scoped to a thread's workspace: when that thread has a
 * `workspaceRoot` (the repo the CLI was started in), the repo's `.claude/skills`
 * + `.agents/skills` are merged in (labeled `source: "workspace"`). The thread
 * is the ownership-checked `?threadId` when given, else the latest thread (so
 * the CLI — which doesn't track its thread id — still gets its repo's skills).
 * Web threads have no workspaceRoot, so they list global skills only.
 */
router.get('/skills', async (req: Request, res: Response) => {
  try {
    const requested = req.query.threadId;
    let workspaceRoot: string | undefined;
    if (typeof requested === 'string' && requested && config.agentId) {
      const owned = await conversationService.getOwnedThreadId(
        config.ownerUserId,
        config.agentId,
        requested,
      );
      if (owned) {
        workspaceRoot = (await conversationService.getThreadWorkspaceRoot(owned)) ?? undefined;
      }
    } else {
      // No explicit thread → use the latest thread's workspace, read-only (never
      // creates one). The CLI's startup thread carries its launch cwd here.
      const latest = await conversationService.getLatestThread(config.ownerUserId);
      workspaceRoot = latest?.workspaceRoot ?? undefined;
    }
    const skills = (await skillCatalogService.getCatalog(workspaceRoot)).map((s) => ({
      name: s.name,
      description: s.description,
      dirName: s.dirName,
      source: s.source,
      // Present only on plugin-contributed skills, so a capability can be
      // traced back to the plugin that supplied it.
      ...(s.pluginId ? { pluginId: s.pluginId } : {}),
    }));
    res.json(skills);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] GET /skills failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/skills/:name/run — manually trigger a skill (the `/skills run`
 * command in the web/CLI). The UI parses the slash command and calls this REST
 * endpoint (we never parse a slash command in the conversation engine). The run
 * is dispatched as an ordinary chat turn — the agent loads the skill body with
 * the `skill` tool and follows it — so the streamed reply rides out over the
 * WebSocket channel the client is already on. Fire-and-forget: we return 202
 * immediately and let the turn stream; engine errors surface as friendly steps.
 */
router.post('/skills/:name/run', async (req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Agent not initialized (agentId unset)' });
      return;
    }
    // Express 5 types a mid-path param as `string | string[]`; a single
    // `:name` is always a string at runtime.
    const rawName = req.params.name;
    const skillName = Array.isArray(rawName) ? rawName[0] : rawName;

    // Resolve the thread (and its workspace) FIRST: run in the thread the client
    // is viewing when given (ownership-checked), else the latest active thread —
    // same resolution as GET /messages. The workspaceRoot is needed so a repo
    // skill can be found, not just the global ones.
    const requested = req.body?.threadId;
    let threadId: string;
    if (typeof requested === 'string' && requested) {
      const owned = await conversationService.getOwnedThreadId(
        config.ownerUserId,
        config.agentId,
        requested,
      );
      if (!owned) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }
      threadId = owned;
    } else {
      const thread = await conversationService.getOrCreateLatestThread(
        config.agentId,
        config.ownerUserId,
      );
      threadId = thread.id;
    }
    const workspaceRoot =
      (await conversationService.getThreadWorkspaceRoot(threadId)) ?? undefined;

    const entry = await skillCatalogService.find(skillName, workspaceRoot);
    if (!entry) {
      res.status(404).json({ error: `No available skill named "${skillName}".` });
      return;
    }

    const directive = `Use the "${entry.name}" skill.`;
    void conversationEngineService
      .chat({
        userId: config.ownerUserId,
        agentId: config.agentId,
        message: directive,
        threadId,
        metadata: { channel: 'websocket' },
      })
      .catch((err) => logger.error({ err }, '[Management] skill run failed'));

    res.status(202).json({ threadId, skill: entry.name });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] POST /skills/:name/run failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Plugins (Agent Plugins — agent-plugins.org). Used by both the web SPA and the CLI.
// ---------------------------------------------------------------------------

/**
 * GET /agents/plugins — installed Agent Plugins and what each contributes.
 *
 * Unlike skills there is no thread scoping: plugins are installed once for the
 * container, so there is no workspace to resolve. `skills` lists the names this
 * plugin actually contributed to the catalog — a skill shadowed by a workspace
 * or global one of the same name is absent, which is the truthful answer to
 * "what is this plugin giving me".
 *
 * `diagnostics` carries the non-fatal problems found while loading, so a
 * half-broken plugin is attributable here rather than only in the logs. A
 * plugin whose manifest was rejected outright does not appear at all.
 */
router.get('/plugins', async (_req: Request, res: Response) => {
  try {
    const catalog = await skillCatalogService.getCatalog();
    // Connect anything not yet connected so a server that fails to start is
    // reported here rather than only in the logs. Idempotent and cached, so
    // this is a no-op once a turn has already collected tools.
    await pluginMcpService.getTools();
    const statuses = pluginMcpService.getServerStatuses();

    const pluginDataRoot = getExecutionEnvironment().paths().pluginDataDir;
    const plugins = await Promise.all((await pluginCatalogService.getPlugins()).map(async (p) => {
      const diagnostics = [...p.diagnostics];
      let mcpServers: string[] = [];

      if (p.mcpConfigPath) {
        try {
          // Read on the side the plugin's files are, which a container path is not.
          const raw = await filesFor(p.mcpConfigPath).readText(p.mcpConfigPath);
          const parsed = parseMcpJson(raw, {
            pluginId: p.id,
            pluginRoot: p.dir,
            pluginData: path.posix.join(pluginDataRoot, path.basename(p.id)),
          });
          if (!parsed) diagnostics.push('mcp.json is invalid — no MCP servers loaded');
          else {
            mcpServers = parsed.servers.map((s) => s.name);
            diagnostics.push(...parsed.warnings);
          }
        } catch {
          diagnostics.push('mcp.json could not be read — no MCP servers loaded');
        }
      }

      for (const s of statuses) {
        if (s.pluginId === p.id && s.status === 'failed') {
          diagnostics.push(`MCP server "${s.serverName}" failed to start: ${s.error}`);
        }
      }

      return {
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        skills: catalog.filter((s) => s.pluginId === p.id).map((s) => s.name),
        mcpServers,
        diagnostics,
      };
    }));
    res.json(plugins);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] GET /plugins failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/threads/:threadId/compact — manually compact a thread (the
 * `/compact` command in the web/CLI). The UI parses the slash command and calls
 * this REST endpoint (we never parse a slash command in the conversation
 * engine). Fire-and-forget: we return 202 immediately; progress and the result
 * ride out as `compaction` frames on the WebSocket channel the client is
 * already on.
 */
router.post('/threads/:threadId/compact', async (req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Agent not initialized (agentId unset)' });
      return;
    }
    const rawThreadId = req.params.threadId;
    const requested = Array.isArray(rawThreadId) ? rawThreadId[0] : rawThreadId;

    const threadId = await conversationService.getOwnedThreadId(
      config.ownerUserId,
      config.agentId,
      requested,
    );
    if (!threadId) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    if (!(await compactionService.hasCompactableHistory(threadId))) {
      res.status(409).json({ error: 'Nothing to compact yet.' });
      return;
    }

    void compactionService
      .compactNow({ userId: config.ownerUserId, agentId: config.agentId, threadId })
      .catch((err) => logger.error({ err, threadId }, '[Management] compact failed'));

    res.status(202).json({ threadId });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] POST /threads/:threadId/compact failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

export { router as managementRouter };
