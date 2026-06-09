/**
 * Teams Management Routes
 *
 * Express router exposing the runtime's Microsoft Teams REST surface —
 * mirrors the Slack routes in `management.ts`. Mounted under `/agents` by
 * the management router, so all paths below are relative to it.
 *
 * Heartbeat:
 *   POST   /agents/heartbeat/teams-trigger                     - Trigger from Teams channel
 *
 * Teams heartbeat trigger management:
 *   GET    /agents/teams-heartbeat-trigger/channel/:channelId  - Check if channel is a trigger
 *   GET    /agents/teams-heartbeat-trigger                     - List active triggers
 *   POST   /agents/teams-heartbeat-trigger                     - Create trigger
 *   PATCH  /agents/teams-heartbeat-trigger                     - Update throttle
 *   DELETE /agents/teams-heartbeat-trigger/:id                 - Delete trigger
 *   POST   /agents/teams-heartbeat-trigger/claim               - Try claim trigger
 *
 * Teams verification + mappings:
 *   POST   /agents/teams/create-verification-code              - Generate link code
 *   POST   /agents/teams/verify-link-code                      - Verify personal link code
 *   POST   /agents/teams/verify-channel-link-code              - Verify channel link code
 *   GET    /agents/teams/connections                           - Connected bot registration info
 *   GET    /agents/teams-link-status                           - Personal/channel mapping existence
 *   GET    /agents/teams-channel-mappings                      - List channel mappings
 *   GET    /agents/teams/channel-mapping/:channelId            - Find mapping by channel id
 *   DELETE /agents/teams/channel-mapping/:channelId            - Delete channel mapping
 *   DELETE /agents/teams/dm-mapping                            - Delete personal mappings
 *   GET    /agents/teams-connection-id                         - Lookup connection id
 *
 * Adapter management:
 *   POST   /agents/teams/deliver                               - Deliver a message
 *   POST   /agents/teams/{initialize,shutdown}                 - Teams adapter lifecycle
 *   POST   /agents/teams/{add,remove}-connection               - Teams connection wiring
 *   POST   /agents/teams/link-user                             - Teams user link
 *   GET    /agents/teams/is-connected/:userId                  - Connection check
 *   GET    /agents/teams/channel-name                          - Resolve channel id → name
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { logger } from '../logger';
import { prisma } from '../lib/prisma';
import { heartbeatService } from '../services/heartbeat.service';
import { teamsHeartbeatTriggerService } from '../services/teams-heartbeat-trigger.service';
import { teamsAdapterService } from '../services/teams-adapter.service';

const router = Router();

// ============================================================================
// Heartbeat trigger notification
// ============================================================================

/**
 * POST /agents/heartbeat/teams-trigger
 * Notify agent-runtime that new Teams messages are queued in the DB.
 * No body required — the runtime drains messages from its own database.
 */
router.post('/heartbeat/teams-trigger', async (_req: Request, res: Response) => {
  try {
    const status = heartbeatService.triggerFromChannel();

    if (status === 'ignored') {
      res.status(404).json({ error: 'No active heartbeat' });
      return;
    }

    res.json({ success: true, status });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to trigger heartbeat from Teams for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Teams Heartbeat Trigger Management
// ============================================================================

/**
 * GET /agents/teams-heartbeat-trigger/channel/:channelId
 * Check if a Teams channel is a heartbeat trigger channel.
 */
router.get('/teams-heartbeat-trigger/channel/:channelId', async (req: Request<{ channelId: string }>, res: Response) => {
  try {
    const result = await teamsHeartbeatTriggerService.isHeartbeatTriggerChannel(req.params.channelId);
    res.json(result);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to check Teams heartbeat trigger channel ${req.params.channelId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/teams-heartbeat-trigger
 * Get active heartbeat triggers for a specific agent.
 * Query: ?userId=...
 */
router.get('/teams-heartbeat-trigger', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'Missing userId query parameter' });
      return;
    }
    const triggers = await teamsHeartbeatTriggerService.getActiveTriggers(userId);
    res.json(triggers);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get Teams heartbeat triggers for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/teams-heartbeat-trigger
 * Create a new heartbeat trigger.
 * Body: { connectionId, channelId, channelName, userId, throttleSeconds? }
 */
router.post('/teams-heartbeat-trigger', async (req: Request, res: Response) => {
  try {
    const { connectionId, channelId, channelName, userId, throttleSeconds } = req.body;
    if (!connectionId || !channelId || !userId) {
      res.status(400).json({ error: 'Missing required fields: connectionId, channelId, userId' });
      return;
    }
    const trigger = await teamsHeartbeatTriggerService.createTrigger(
      connectionId, channelId, channelName ?? null, userId, throttleSeconds,
    );
    res.status(201).json(trigger);
  } catch (error: unknown) {
    // Prisma unique constraint violation (agentId is @unique)
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      res.status(409).json({ error: 'Agent already has a Teams heartbeat trigger configured. Delete the existing one first.' });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to create Teams heartbeat trigger for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PATCH /agents/teams-heartbeat-trigger
 * Update throttle settings for a trigger.
 * Body: { triggerId, userId, throttleSeconds }
 */
router.patch('/teams-heartbeat-trigger', async (req: Request, res: Response) => {
  try {
    const { triggerId, userId, throttleSeconds } = req.body;
    if (!triggerId || !userId || throttleSeconds === undefined) {
      res.status(400).json({ error: 'Missing required fields: triggerId, userId, throttleSeconds' });
      return;
    }
    const updated = await teamsHeartbeatTriggerService.updateThrottle(triggerId, userId, throttleSeconds);
    if (!updated) {
      res.status(404).json({ error: 'Trigger not found' });
      return;
    }
    res.json(updated);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to update Teams heartbeat trigger throttle for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/teams-heartbeat-trigger/:id
 * Delete a heartbeat trigger.
 * Query: ?userId=...
 */
router.delete('/teams-heartbeat-trigger/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'Missing userId query parameter' });
      return;
    }
    await teamsHeartbeatTriggerService.deleteTrigger(req.params.id, userId);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete Teams heartbeat trigger ${req.params.id}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/teams-heartbeat-trigger/claim
 * Atomically try to claim a trigger for firing.
 */
router.post('/teams-heartbeat-trigger/claim', async (_req: Request, res: Response) => {
  try {
    const result = await teamsHeartbeatTriggerService.tryClaimTrigger();
    res.json(result);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to claim Teams heartbeat trigger for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Teams Verification
// ============================================================================

/**
 * POST /agents/teams/verify-link-code
 * Verify a personal-chat linking code from Teams.
 * Body: { code, teamsUserId, conversationId? }
 *
 * Note: linking through this route (rather than in-chat) creates the mapping
 * without a conversation reference — proactive delivery starts working after
 * the user's first personal-chat message captures one.
 */
router.post('/teams/verify-link-code', async (req: Request, res: Response) => {
  try {
    const { code, teamsUserId, conversationId } = req.body;
    if (!code || !teamsUserId) {
      res.status(400).json({ error: 'Missing required fields: code, teamsUserId' });
      return;
    }

    const upperCode = (code as string).toUpperCase();
    const verification = await prisma.teamsVerificationCode.findUnique({
      where: { code_type: { code: upperCode, type: 'DM' } },
    });

    if (!verification) {
      res.json({ success: false, message: 'Invalid code. Please generate a new code from the web app.' });
      return;
    }

    if (new Date() > verification.expiresAt) {
      await prisma.teamsVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'DM' } },
      }).catch(() => {});
      res.json({ success: false, message: 'Code expired. Please generate a new code from the web app.' });
      return;
    }

    const existingLink = await prisma.teamsMapping.findFirst({
      where: {
        connectionId: verification.connectionId,
        teamsUserId,
      },
    });

    if (existingLink) {
      if (existingLink.lensUserId === verification.lensUserId) {
        res.json({ success: false, message: 'Your Teams account is already linked to another agent. Unlink it first from that agent\'s settings.' });
        return;
      }
      res.json({ success: false, message: 'This Teams account is already linked to another user.' });
      return;
    }

    // Atomic: create mapping + consume code
    await prisma.$transaction([
      prisma.teamsMapping.create({
        data: {
          connectionId: verification.connectionId,
          agentId: verification.agentId,
          teamsUserId,
          lensUserId: verification.lensUserId,
          personalConversationId: conversationId ?? null,
        },
      }),
      prisma.teamsVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'DM' } },
      }),
    ]);

    logger.info({ teamsUserId, lensUserId: verification.lensUserId }, 'Teams account linked via code: %s -> %s', teamsUserId, verification.lensUserId);

    res.json({ success: true, message: 'Your Teams account is now linked! You can now chat with your agent here.' });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to verify Teams link code: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/teams/verify-channel-link-code
 * Verify a channel linking code from Teams.
 * Body: { code, channelId, channelName?, serviceUrl?, tenantId? }
 */
router.post('/teams/verify-channel-link-code', async (req: Request, res: Response) => {
  try {
    const { code, channelId, channelName, serviceUrl, tenantId } = req.body;
    if (!code || !channelId) {
      res.status(400).json({ error: 'Missing required fields: code, channelId' });
      return;
    }

    const result = await teamsAdapterService.verifyChannelLinkCodeLocal(
      (code as string).toUpperCase(), channelId, channelName, serviceUrl, tenantId,
    );
    res.json(result);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to verify Teams channel link code: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/teams/create-verification-code
 * Generate a 6-char hex verification code and persist it, retrying on unique
 * constraint collision.
 * Body: { type, lensUserId, connectionId, agentId, agentName?, expiresAt }
 */
const MAX_CODE_ATTEMPTS = 5;

router.post('/teams/create-verification-code', async (req: Request, res: Response) => {
  logger.info('[Management] Received request to create Teams verification code');

  // Cleanup expired codes opportunistically (fire-and-forget)
  prisma.teamsVerificationCode.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  }).catch(() => {});

  try {
    const { type, lensUserId, connectionId, agentId, agentName, expiresAt } = req.body;
    if (!type || !lensUserId || !connectionId || !agentId || !expiresAt) {
      logger.warn('[Management] Rejecting create Teams verification code request: missing required fields');
      res.status(400).json({ error: 'Missing required fields: type, lensUserId, connectionId, agentId, expiresAt' });
      return;
    }

    const data: Prisma.TeamsVerificationCodeUncheckedCreateInput = {
      type,
      lensUserId,
      connectionId,
      agentId,
      expiresAt: new Date(expiresAt),
      code: '', // placeholder, set in loop
      ...(agentName ? { agentName } : {}),
    };

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = randomBytes(3).toString('hex').toUpperCase();
      try {
        await prisma.teamsVerificationCode.create({ data: { ...data, code } });
        res.json({ code });
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[Management] Error creating Teams verification code on attempt ${attempt + 1}/${MAX_CODE_ATTEMPTS}: ${msg}`);
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

    logger.error(`[Management] Failed to generate a unique Teams verification code after ${MAX_CODE_ATTEMPTS} attempts`);
    res.status(500).json({ error: 'Failed to generate a unique verification code' });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to create Teams verification code: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Teams Mapping Management
// ============================================================================

/**
 * GET /agents/teams/connections
 * Connected Teams bot registration info. Used by the Web UI's Channels page.
 */
router.get('/teams/connections', async (_req: Request, res: Response) => {
  try {
    res.json({ connections: teamsAdapterService.listConnections() });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to list Teams connections: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/teams-link-status
 * Check whether the agent has personal and/or channel mappings for a connection.
 * Query: connectionId (required)
 */
router.get('/teams-link-status', async (req: Request, res: Response) => {
  try {
    const connectionId = req.query.connectionId as string;
    if (!connectionId) {
      res.status(400).json({ error: 'Missing connectionId query parameter' });
      return;
    }

    const dmMapping = await prisma.teamsMapping.findFirst({
      where: { connectionId, teamsUserId: { not: null } },
      select: { teamsUserId: true },
    });

    // Scoped to the requested connectionId, like the DM check above and the
    // channel-mappings list the UI renders — otherwise a mapping left behind
    // by a rotated TEAMS_APP_ID would report linked with an empty list.
    const hasChannelMapping = await prisma.teamsMapping.findFirst({
      where: { connectionId, teamsChannelId: { not: null } },
      select: { id: true },
    }) !== null;

    res.json({ hasDmMapping: dmMapping !== null, hasChannelMapping, teamsUserId: dmMapping?.teamsUserId ?? null });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get Teams link status for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/teams-channel-mappings
 * List channel mappings for the agent, filtered by connection.
 * Query: connectionId (required)
 */
router.get('/teams-channel-mappings', async (req: Request, res: Response) => {
  try {
    const connectionId = req.query.connectionId as string;
    if (!connectionId) {
      res.status(400).json({ error: 'Missing connectionId query parameter' });
      return;
    }

    const mappings = await prisma.teamsMapping.findMany({
      where: {
        connectionId,
        teamsChannelId: { not: null },
      },
      include: {
        agentWorkspace: {
          select: { name: true },
        },
      },
    });

    const channels = mappings.map(m => ({
      id: m.id,
      channelId: m.teamsChannelId,
      channelName: m.teamsChannelName,
      agentName: m.agentWorkspace.name,
      linkedAt: m.createdAt,
    }));

    res.json({ channels });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get Teams channel mappings for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/teams/channel-mapping/:channelId
 * Find a channel mapping by Teams channel ID (URL-encoded).
 * Query: connectionId (optional, narrows search to specific connection)
 */
router.get('/teams/channel-mapping/:channelId', async (req: Request<{ channelId: string }>, res: Response) => {
  try {
    const { channelId } = req.params;
    const connectionId = req.query.connectionId as string | undefined;

    const where: { teamsChannelId: string; connectionId?: string } = { teamsChannelId: channelId };
    if (connectionId) where.connectionId = connectionId;

    const mapping = await prisma.teamsMapping.findFirst({
      where,
      select: { id: true, agentId: true, teamsChannelId: true },
    });

    if (!mapping) {
      res.status(404).json({ error: 'Channel mapping not found' });
      return;
    }

    res.json({ mapping });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to find Teams channel mapping for ${req.params.channelId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/teams/channel-mapping/:channelId
 * Delete a channel mapping by Teams channel ID (URL-encoded).
 * Query: connectionId (optional, narrows deletion to specific connection)
 */
router.delete('/teams/channel-mapping/:channelId', async (req: Request<{ channelId: string }>, res: Response) => {
  try {
    const { channelId } = req.params;
    const connectionId = req.query.connectionId as string | undefined;

    const where: { teamsChannelId: string; connectionId?: string } = { teamsChannelId: channelId };
    if (connectionId) where.connectionId = connectionId;

    const result = await prisma.teamsMapping.deleteMany({
      where,
    });

    if (result.count === 0) {
      res.status(404).json({ error: 'Channel mapping not found' });
      return;
    }

    res.json({ deleted: result.count });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete Teams channel mapping for ${req.params.channelId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/teams/dm-mapping
 * Delete personal mappings for the agent and connection.
 * Query: connectionId (required)
 */
router.delete('/teams/dm-mapping', async (req: Request, res: Response) => {
  try {
    const connectionId = req.query.connectionId as string;
    if (!connectionId) {
      res.status(400).json({ error: 'Missing connectionId query parameter' });
      return;
    }

    const result = await prisma.teamsMapping.deleteMany({
      where: { connectionId, teamsUserId: { not: null } },
    });

    res.json({ deleted: result.count });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete Teams personal mapping for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/teams-connection-id
 * Find the connectionId for the agent via TeamsMapping.
 */
router.get('/teams-connection-id', async (_req: Request, res: Response) => {
  try {
    const mapping = await prisma.teamsMapping.findFirst({
      select: { connectionId: true },
    });
    if (!mapping) {
      res.status(404).json({ error: 'No Teams mapping found for agent' });
      return;
    }
    res.json({ connectionId: mapping.connectionId });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get Teams connection ID for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ============================================================================
// Teams Adapter Management
// ============================================================================

/**
 * POST /agents/teams/deliver
 * Deliver a message to Teams (personal chat or channel).
 * Body: { userId, message, channelContext? }
 */
router.post('/teams/deliver', async (req: Request, res: Response) => {
  try {
    const { userId, message, channelContext } = req.body;
    if (!userId || !message) {
      res.status(400).json({ error: 'Missing required fields: userId, message' });
      return;
    }
    await teamsAdapterService.deliver(userId, message, channelContext);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to deliver Teams message: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/teams/initialize
 * Initialize the Teams adapter.
 */
router.post('/teams/initialize', async (_req: Request, res: Response) => {
  try {
    await teamsAdapterService.initialize();
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to initialize Teams: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/teams/shutdown
 * Shutdown the Teams adapter.
 */
router.post('/teams/shutdown', async (_req: Request, res: Response) => {
  try {
    await teamsAdapterService.shutdown();
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to shutdown Teams: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/teams/add-connection
 * (Re)initialize the env-sourced Teams connection.
 * Body: { connectionId }
 */
router.post('/teams/add-connection', async (req: Request, res: Response) => {
  try {
    const { connectionId } = req.body;
    if (!connectionId) {
      res.status(400).json({ error: 'Missing required field: connectionId' });
      return;
    }
    // Initialize in the background — mirrors the Slack add-connection shape.
    teamsAdapterService.initialize().catch((err) => {
      logger.error('[Management] Background Teams connection init failed: %s', err instanceof Error ? err.message : String(err));
    });
    res.json({ success: true, connectionId });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to add Teams connection: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/teams/remove-connection
 * Remove the Teams connection (deletes mappings, codes, triggers).
 * Body: { connectionId }
 */
router.delete('/teams/remove-connection', async (req: Request, res: Response) => {
  try {
    const { connectionId } = req.body;
    if (!connectionId) {
      res.status(400).json({ error: 'Missing required field: connectionId' });
      return;
    }
    await teamsAdapterService.disconnectAndDeactivate(connectionId);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to remove Teams connection: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/teams/link-user
 * Link a Teams user to a Lens user.
 * Body: { connectionId, teamsUserId, lensUserId, agentId, conversationId? }
 */
router.post('/teams/link-user', async (req: Request, res: Response) => {
  try {
    const { connectionId, teamsUserId, lensUserId, agentId, conversationId } = req.body;
    if (!connectionId || !teamsUserId || !lensUserId || !agentId) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }
    await teamsAdapterService.linkTeamsUser(connectionId, teamsUserId, lensUserId, agentId, conversationId);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to link Teams user: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/teams/is-connected/:userId
 * Check if a user has an active Teams link.
 */
router.get('/teams/is-connected/:userId', async (req: Request<{ userId: string }>, res: Response) => {
  try {
    const connected = await teamsAdapterService.isUserConnected(req.params.userId);
    res.json({ connected });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to check Teams connection: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/teams/channel-name
 * Get a channel's display name (from the stored mapping — Teams bots can't
 * query channel info outside a turn).
 * Query: { channelId }
 */
router.get('/teams/channel-name', async (req: Request, res: Response) => {
  try {
    const channelId = req.query.channelId as string;
    if (!channelId) {
      res.status(400).json({ error: 'Missing required query param: channelId' });
      return;
    }
    const name = await teamsAdapterService.getChannelName(channelId);
    res.json({ name });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get Teams channel name: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

export { router as teamsManagementRouter };
