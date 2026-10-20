/**
 * Agent Bootstrap
 *
 * Resolves the one `AgentWorkspace` row the runtime runs against. If
 * it doesn't exist yet, creates it with sensible defaults
 * (`config.ownerUserId` / `agentName` / `teamName`, and the documents
 * `PRISM_WORKSPACE_SEED_DIR` holds) so a fresh container — green-field, or
 * after a `/data` wipe — boots without external seeding.
 *
 * Resolution order:
 *   1. `AGENT_ID` set + row exists → use it.
 *   2. `AGENT_ID` set + row missing → bootstrap with that ID.
 *   3. `AGENT_ID` unset + DB has any row → use `findFirst()` (exactly
 *      one agent per container, so this is unambiguous).
 *   4. `AGENT_ID` unset + DB empty → bootstrap with a generated UUID.
 */

import { AgentWorkspace } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { logger } from '../logger';
import { prisma } from './prisma';
import { agentWorkspaceService } from '../services/agent-workspace.service';

export async function resolveOrBootstrapSingleAgent(): Promise<AgentWorkspace> {
  const agent = await resolve();
  // Pin the resolved id into config so downstream code that reads
  // `config.agentId` directly (notably `websocket-gateway.service.ts`'s
  // access-control gate) sees a consistent value whether AGENT_ID came
  // from env or was synthesized here.
  (config as { agentId?: string }).agentId = agent.id;
  // The row names the owner; `OWNER_USER_ID` seeds it on first boot only.
  (config as { ownerUserId: string }).ownerUserId = agent.userId;
  return agent;
}

async function resolve(): Promise<AgentWorkspace> {
  if (config.agentId) {
    const existing = await prisma.agentWorkspace.findUnique({ where: { id: config.agentId } });
    if (existing) {
      logger.info({ agentId: existing.id }, '[SingleAgent] using existing agent (AGENT_ID match)');
      return existing;
    }
    return bootstrap(config.agentId);
  }

  const anyExisting = await prisma.agentWorkspace.findFirst();
  if (anyExisting) {
    logger.info({ agentId: anyExisting.id }, '[SingleAgent] using existing agent (DB findFirst — AGENT_ID unset)');
    return anyExisting;
  }

  return bootstrap(uuidv4());
}

async function bootstrap(id: string): Promise<AgentWorkspace> {
  const agent = await agentWorkspaceService.createAgent({
    id,
    userId: config.ownerUserId,
    name: config.agentName,
    agentType: 'AGENT',
    teamName: config.teamName,
    documents: config.workspaceSeed,
  });
  logger.info(
    { agentId: agent.id, name: agent.name, ownerUserId: agent.userId },
    '[SingleAgent] bootstrapped new agent — set AGENT_ID to this id to pin identity across restarts',
  );
  return agent;
}
