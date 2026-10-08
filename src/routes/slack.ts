/**
 * Slack routes.
 *
 * One area, one router (AGENTS.md: a new HTTP route gets its own file). Mounted
 * under `/agents` in `server.ts` beside the other route modules. The REST
 * surface the Web UI's Channels page and the CLI use for Slack links, the
 * Slack heartbeat triggers, and the Slack adapter's lifecycle.
 *
 * Heartbeat:
 *   POST   /agents/heartbeat/slack-trigger                    - Trigger from Slack channel
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
 *   POST   /agents/threads/get-or-create-by-external-id       - Get/create by external id
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
 *   PUT    /agents/slack/channel-mapping/:channelId/main       - Flag the main channel
 *   DELETE /agents/slack/dm-mapping                            - Delete DM mappings
 *   GET    /agents/slack-connection-id                         - Lookup connection id
 *
 * Slack adapter:
 *   POST   /agents/slack/deliver                               - Deliver a message
 *   POST   /agents/slack/{initialize,shutdown}                 - Slack adapter lifecycle
 *   POST   /agents/slack/{add,remove}-connection               - Slack connection wiring
 *   POST   /agents/slack/link-user                             - Slack user link
 *   GET    /agents/slack/is-connected/:userId                  - Connection check
 *   GET    /agents/slack/channel-name                          - Resolve channel id → name
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { Prisma, ThreadSource } from '@prisma/client';
import { logger } from '../logger';
import { config } from '../config';
import { trackEvent } from '../lib/telemetry';
import { prisma } from '../lib/prisma';
import { heartbeatService } from '../services/heartbeat.service';
import { slackHeartbeatTriggerService } from '../services/slack-heartbeat-trigger.service';
import { slackMessageQueueService } from '../services/slack-message-queue.service';
import { slackMappingService } from '../services/slack-mapping.service';
import { conversationService } from '../services/conversation.service';
import { slackAdapterService } from '../services/slack-adapter.service';

const router = Router();

/**
 * POST /agents/heartbeat/slack-trigger
 * Notify agent-runtime that new Slack messages are queued in the DB.
 * No body required — agent-runtime drains messages from the backend.
 */
router.post('/heartbeat/slack-trigger', async (_req: Request, res: Response) => {
  try {
    const status = heartbeatService.triggerFrom(slackMessageQueueService);

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
      userId, agentId, externalThreadId, channelId ? { source: ThreadSource.SLACK, channelId } : undefined
    );
    res.json(thread);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get or create thread by external ID: ${msg}`);
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
 * Body: { userId, message, channelContext?: { channel, channelId?, threadTs?, threadId } }
 */
router.post('/slack/deliver', async (req: Request, res: Response) => {
  try {
    const { userId, message, channelContext } = req.body;
    if (!userId || !message) {
      res.status(400).json({ error: 'Missing required fields: userId, message' });
      return;
    }
    // The body names the thread `threadTs`, as Slack does.
    const { threadTs, ...context } = channelContext ?? {};
    await slackAdapterService.deliver(
      userId,
      message,
      channelContext ? { ...context, channelThreadId: threadTs } : undefined,
    );
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

export const slackRouter = router;
