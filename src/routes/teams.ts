/**
 * Teams Mapping Management routes.
 *
 * One area, one router (CLAUDE.md: a new HTTP route gets its own file). Mounted
 * under `/agents` in `server.ts` beside the other route modules. The REST
 * surface the Web UI's Channels page and the CLI use for Teams links.
 */
import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { logger } from '../logger';
import { config } from '../config';
import { trackEvent } from '../lib/telemetry';
import { prisma } from '../lib/prisma';
import { teamsMappingService } from '../services/teams/teams-mapping.service';
import { getTeamsConfig } from '../lib/teams-config';

const router = Router();

/** Retry bound for generating a collision-free verification code. */
const MAX_CODE_ATTEMPTS = 5;

// ============================================================================
// Teams Mapping Management — mirror of the Slack block above. One env-sourced
// Teams connection (see `lib/teams-config.ts`), so reads/deletes are not
// scoped by connectionId. Conversation ids contain `:` and `@`
// (`19:…@thread.tacv2`) — clients must encodeURIComponent path params.
// ============================================================================

/**
 * GET /agents/teams/workspaces
 * The configured Teams connection (tenant), or an empty list when Teams is
 * disabled. Used by the Web UI's Channels page to gate the Teams section.
 */
router.get('/teams/workspaces', async (_req: Request, res: Response) => {
  try {
    const connection = await getTeamsConfig();
    res.json({
      workspaces: connection
        ? [{ tenantId: connection.tenantId, clientId: connection.clientId, name: connection.name }]
        : [],
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to list teams workspaces: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/teams-link-status
 * Check whether the agent has a Teams DM and/or channel mapping.
 */
router.get('/teams-link-status', async (_req: Request, res: Response) => {
  try {
    const dmMapping = await prisma.teamsMapping.findFirst({
      where: { teamsUserId: { not: null } },
      select: { teamsUserId: true },
    });

    const hasChannelMapping = await prisma.teamsMapping.findFirst({
      where: { channelConversationId: { not: null } },
      select: { id: true },
    }) !== null;

    res.json({
      hasDmMapping: dmMapping !== null,
      hasChannelMapping,
      teamsUserId: dmMapping?.teamsUserId ?? null,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get teams link status for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/teams-channel-mappings
 * List the agent's Teams channel mappings, with the effective main channel
 * resolved the same way delivery does (flagged, else oldest).
 */
router.get('/teams-channel-mappings', async (_req: Request, res: Response) => {
  try {
    const mappings = await prisma.teamsMapping.findMany({
      where: {
        channelConversationId: { not: null },
      },
      include: {
        agentWorkspace: {
          select: { name: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const mainId = (mappings.find(m => m.isMainChannel) ?? mappings[0])?.id ?? null;

    const channels = mappings.map(m => ({
      id: m.id,
      conversationId: m.channelConversationId,
      channelName: m.channelName,
      agentName: m.agentWorkspace.name,
      linkedAt: m.createdAt,
      isMain: m.id === mainId,
    }));

    res.json({ channels });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to get teams channel mappings for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/teams/create-verification-code
 * Generate a 6-char hex verification code and persist it, retrying on unique
 * constraint collision. Body: { type, lensUserId, connectionId, agentId, agentName?, expiresAt }
 */
router.post('/teams/create-verification-code', async (req: Request, res: Response) => {
  logger.info('[Management] Received request to create Teams verification code');

  // Cleanup expired codes opportunistically (fire-and-forget)
  prisma.teamsVerificationCode.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  }).catch(() => {});

  try {
    const { type, lensUserId, connectionId, agentId, agentName, expiresAt } = req.body;
    if (!type || !lensUserId || !connectionId || !agentId || !expiresAt) {
      logger.warn('[Management] Rejecting create teams verification code request: missing required fields');
      res.status(400).json({ error: 'Missing required fields: type, lensUserId, connectionId, agentId, expiresAt' });
      return;
    }
    // Validate up front — a bad enum or date would otherwise surface as a
    // Prisma 500 echoing internal validation text.
    if (type !== 'DM' && type !== 'CHANNEL') {
      res.status(400).json({ error: "type must be 'DM' or 'CHANNEL'" });
      return;
    }
    if (Number.isNaN(new Date(expiresAt).getTime())) {
      res.status(400).json({ error: 'expiresAt must be a valid date' });
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
        // The code itself stays out of telemetry.
        trackEvent('teams verification code created', lensUserId, {
          'agent.id': agentId,
          'verification.type': String(type),
        });
        res.json({ code });
        return;
      } catch (error) {
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

    logger.error(`[Management] Failed to generate a unique teams verification code after ${MAX_CODE_ATTEMPTS} attempts`);
    res.status(500).json({ error: 'Failed to generate a unique verification code' });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to create teams verification code: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/teams/dm-mapping
 * Delete the agent's Teams DM mapping(s).
 */
router.delete('/teams/dm-mapping', async (_req: Request, res: Response) => {
  try {
    const result = await prisma.teamsMapping.deleteMany({
      where: { teamsUserId: { not: null } },
    });

    if (result.count > 0) {
      trackEvent('teams dm mapping deleted', null, {
        ...(config.agentId ? { 'agent.id': config.agentId } : {}),
        'teams.mappings_removed': String(result.count),
      });
    }

    res.json({ deleted: result.count });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete Teams DM mapping for agent: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * DELETE /agents/teams/channel-mapping/:conversationId
 * Delete a channel mapping by its (URI-encoded) channel conversation id.
 */
router.delete('/teams/channel-mapping/:conversationId', async (req: Request<{ conversationId: string }>, res: Response) => {
  try {
    const { conversationId } = req.params;

    const result = await prisma.teamsMapping.deleteMany({
      where: { channelConversationId: conversationId },
    });

    if (result.count === 0) {
      res.status(404).json({ error: 'Channel mapping not found' });
      return;
    }

    trackEvent('teams channel mapping deleted', null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'teams.conversation.id': conversationId,
    });

    res.json({ deleted: result.count });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to delete teams channel mapping for ${req.params.conversationId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/**
 * PUT /agents/teams/channel-mapping/:conversationId/main
 * Mark a linked Teams channel as the agent's main channel — where heartbeat
 * alerts (and scheduled tasks with no resolvable origin channel) are posted.
 */
router.put('/teams/channel-mapping/:conversationId/main', async (req: Request<{ conversationId: string }>, res: Response) => {
  try {
    const { conversationId } = req.params;

    const mapping = await prisma.teamsMapping.findUnique({
      where: { channelConversationId: conversationId },
      select: { agentId: true },
    });

    if (!mapping) {
      res.status(404).json({ error: 'Channel mapping not found' });
      return;
    }

    await teamsMappingService.setMainChannel(mapping.agentId, conversationId);

    trackEvent('teams main channel set', null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'teams.conversation.id': conversationId,
    });

    res.json({ ok: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Management] Failed to set teams main channel for ${req.params.conversationId}: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

export const teamsRouter = router;
