/**
 * Identity-Document Routes
 *
 * The user's write to one of the seven identity documents, its history, and the
 * restore of one revision:
 *
 *   PATCH /agents/documents/:field                    — replace the document
 *   GET   /agents/documents/:field/revisions          — the history, newest first
 *   GET   /agents/documents/:field/revisions/:id      — one revision, with content
 *   POST  /agents/documents/:field/revisions/:id/restore
 *
 * Each of these is the user acting, so locked-in mode does not gate them — that
 * lock withholds the agent's own writers.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import { prisma } from '../lib/prisma';
import { agentWorkspaceService, ValidationError } from '../services/agent-workspace.service';
import { documentRevisionService } from '../services/document-revision.service';
import { heartbeatService } from '../services/heartbeat.service';
import { isWorkspaceDocField, WorkspaceDocField } from '../lib/workspace-docs';

const router = Router();

/**
 * Answer 400 and report null when the path segment is not one of the seven
 * documents, so each handler reads the field or returns.
 */
function readField(req: Request<{ field: string }>, res: Response): WorkspaceDocField | null {
  const field = req.params.field;
  if (!isWorkspaceDocField(field)) {
    res.status(400).json({ error: `unknown identity document '${field}'` });
    return null;
  }
  return field;
}

/**
 * A write or a restore of the heartbeat config changes what a heartbeat run
 * reads, so the timer is restarted from the stored row, the same as a tool write
 * does (`src/tools/agent-config.ts`). It happens here rather than in the service,
 * because the heartbeat service imports the invoke path, which builds context
 * through the workspace service.
 */
async function restartHeartbeat(): Promise<void> {
  try {
    const agent = await agentWorkspaceService.getAgent();
    heartbeatService.startHeartbeat(agent);
  } catch (err) {
    logger.error({ err }, '[DocumentRevisions] Failed to restart the heartbeat');
  }
}

/**
 * PATCH /agents/documents/:field
 * Body: { content: string, reason?: string } — the whole document; an empty
 * string clears it, which drops that section from the prompt. `reason` is the
 * note the document's history shows for this write. There is no concurrency
 * control: the last write wins, so two editors open at once overwrite each other
 * instead of merging.
 */
router.patch('/documents/:field', async (req: Request<{ field: string }>, res: Response) => {
  const field = readField(req, res);
  if (!field) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!('content' in body)) {
      res.status(400).json({ error: "missing required field 'content'" });
      return;
    }

    const content = await agentWorkspaceService.updateWorkspaceDoc(field, body.content, body.reason);

    if (field === 'heartbeatMd') await restartHeartbeat();
    res.json({ field, content });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, field }, '[DocumentRevisions] Failed to write the document');
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/documents/:field/revisions
 * The history of one document, newest first, without the content of each
 * revision. `drifted` reports a document that no longer agrees with its newest
 * revision, which is what a write outside this path leaves behind.
 */
router.get('/documents/:field/revisions', async (req: Request<{ field: string }>, res: Response) => {
  const field = readField(req, res);
  if (!field) return;
  try {
    const agent = await agentWorkspaceService.getAgent();
    res.json(await documentRevisionService.history(agent, field));
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, field }, '[DocumentRevisions] Failed to read the history');
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /agents/documents/:field/revisions/:id
 * One revision with its content, which is what the client compares two of.
 */
router.get('/documents/:field/revisions/:id', async (req: Request<{ field: string; id: string }>, res: Response) => {
  const field = readField(req, res);
  if (!field) return;
  try {
    const agent = await agentWorkspaceService.getAgent();
    const revision = await documentRevisionService.get(prisma, agent.id, field, req.params.id);
    if (!revision) {
      res.status(404).json({ error: 'revision not found' });
      return;
    }
    res.json(revision);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, field }, '[DocumentRevisions] Failed to read a revision');
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /agents/documents/:field/revisions/:id/restore
 * Body: { expectedRevisionId: string, reason?: string }
 *
 * `expectedRevisionId` is the newest revision the caller read. A write that
 * lands in between answers 409, so a restore never overwrites content the caller
 * has not seen — the read-modify-write in the agent's own document tools has no
 * such check, and a restore widens that window.
 */
router.post(
  '/documents/:field/revisions/:id/restore',
  async (req: Request<{ field: string; id: string }>, res: Response) => {
    const field = readField(req, res);
    if (!field) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.expectedRevisionId !== 'string' || body.expectedRevisionId.length === 0) {
        res.status(400).json({ error: "missing required field 'expectedRevisionId'" });
        return;
      }

      const agent = await agentWorkspaceService.getAgent();
      const result = await agentWorkspaceService.rollbackWorkspaceDoc({
        agentId: agent.id,
        field,
        revisionId: req.params.id,
        expectedRevisionId: body.expectedRevisionId,
        reason: typeof body.reason === 'string' ? body.reason : '',
      });

      if (result.status === 'revision_not_found') {
        res.status(404).json({ error: 'revision not found' });
        return;
      }
      if (result.status === 'stale') {
        res.status(409).json({
          error: 'the document changed since this history was read',
          newestRevisionId: result.newestRevisionId,
        });
        return;
      }

      if (field === 'heartbeatMd') await restartHeartbeat();
      res.json({ field, content: result.content, revision: result.revision });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, field }, '[DocumentRevisions] Failed to restore a revision');
      res.status(500).json({ error: msg });
    }
  },
);

export { router as documentRevisionsRouter };
