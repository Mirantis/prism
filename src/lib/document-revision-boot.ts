/**
 * Boot-time baseline for the identity-document history.
 *
 * An install created before the revision table holds seven documents and no
 * revisions, so the first boot after the upgrade records what each document
 * reads now. Runs once per process from `index.ts`.
 */

import { logger } from '../logger';
import { documentRevisionService } from '../services/document-revision.service';
import { AgentWorkspace } from '@prisma/client';

/**
 * Record a baseline revision for every document of this agent that has none.
 * Idempotent, so a second boot writes nothing.
 *
 * Catches its own failure. This runs inside `initialize()`, whose catch exits
 * the process, and a container that will not boot is far worse than a document
 * whose history starts at its next edit. Whatever fails here is logged and
 * retried next boot.
 */
export async function backfillDocumentRevisions(agent: AgentWorkspace): Promise<void> {
  try {
    const recorded = await documentRevisionService.recordMissingBaselines(agent);
    if (recorded.length > 0) {
      logger.info(
        '[DocumentRevisions] recorded a baseline revision for %d document(s): %s',
        recorded.length,
        recorded.join(', '),
      );
    }
  } catch (err) {
    logger.error({ err }, '[DocumentRevisions] boot baseline failed');
  }
}
