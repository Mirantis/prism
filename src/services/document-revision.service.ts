/**
 * Identity-document revisions.
 *
 * Every accepted write to one of the seven identity documents appends one
 * snapshot to `agent_workspace_revisions`. The table is append-only: a restore
 * writes a new revision instead of removing the revisions after it, so no step
 * of the history is lost.
 *
 * A method that has to join the caller's transaction takes a client as its first
 * argument, because the snapshot and the column write have to land or fail
 * together — see `agentWorkspaceService.writeWorkspaceDoc`. A method that owns
 * its own read opens none.
 */

import { AgentWorkspace, AgentWorkspaceRevision, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import {
  DocumentWriteActor,
  DocumentWriteMethod,
  WORKSPACE_DOC_FIELDS,
  WORKSPACE_DOC_LABELS,
  WorkspaceDocField,
} from '../lib/workspace-docs';

/**
 * How many revisions one document keeps. The insert deletes anything older in
 * the same transaction, so the table is bounded at 500 revisions × 7 documents
 * per agent. A constant rather than a setting: no deployment needs a second
 * value, and every option is a fork in the code and a line in the docs.
 *
 * The seed revision is a revision like any other, so a document written 500
 * times loses the content it was created with.
 */
export const MAX_REVISIONS_PER_DOCUMENT = 500;

/** Cap on the stored reason. A write is never refused over the length of its own note. */
const REASON_MAX_CHARS = 500;

/** The reason recorded for the revisions a new agent is created with. */
export const SEED_REASON = 'Created from the default template.';

/**
 * The reason recorded for the baseline an existing install gains on the first
 * boot after upgrading.
 */
export const UPGRADE_REASON = 'Recorded on upgrade. Earlier revisions were not kept.';

export interface RecordRevisionInput {
  agentId: string;
  field: WorkspaceDocField;
  content: string;
  actor: DocumentWriteActor;
  method: DocumentWriteMethod;
  reason: string;
}

/**
 * One row of the history. The content is left out: a list of 500 revisions
 * carrying 500 whole documents is the wrong response, and the client reads the
 * content of the two revisions it compares.
 */
export interface DocumentRevisionSummary {
  id: string;
  actor: string;
  method: string;
  reason: string;
  /** True while this revision holds exactly what the document reads now. */
  matchesCurrent: boolean;
  createdAt: Date;
}

/** The history of one document, and whether the document still agrees with it. */
export interface DocumentHistory {
  field: WorkspaceDocField;
  bound: number;
  drifted: boolean;
  revisions: DocumentRevisionSummary[];
}

/** The one builder for a revision row, so every insert stores the same shape. */
function revisionRow(input: RecordRevisionInput) {
  return {
    agentId: input.agentId,
    field: input.field,
    content: input.content,
    actor: input.actor,
    method: input.method,
    reason: input.reason.slice(0, REASON_MAX_CHARS),
  };
}

/**
 * Rows holding what the named documents read now: the seed of a new agent, and
 * the baseline of an upgraded one.
 *
 * A baseline is attributed to the user, because the content either came from the
 * template or predates the history. The reason tells the two cases apart.
 */
function baselineRows(agent: AgentWorkspace, fields: WorkspaceDocField[], reason: string) {
  return fields.map((field) =>
    revisionRow({
      agentId: agent.id,
      field,
      content: agent[field],
      actor: 'user',
      method: 'seed',
      reason,
    }),
  );
}

/**
 * The content last reported as drifted, per document. Remembered for the life of
 * the process, the shape `tool-risk-gate.ts` uses for its truncation warning:
 * the Profile page polls this history, and one line per poll would bury the
 * finding. A second out-of-band write is different content, so it is reported
 * again. At most one entry per document, dropped when the document agrees again.
 */
const reportedDrift = new Map<WorkspaceDocField, string>();

function noteDrift(
  agentId: string,
  field: WorkspaceDocField,
  liveContent: string,
  drifted: boolean,
): void {
  if (!drifted) {
    reportedDrift.delete(field);
    return;
  }
  if (reportedDrift.get(field) === liveContent) return;
  reportedDrift.set(field, liveContent);

  logger.warn(
    { agentId, field },
    `[DocumentRevisions] ${WORKSPACE_DOC_LABELS[field]} does not agree with its newest revision; it was written outside the write path`,
  );
  // The agent and the field only. The content and the reason text stay out of telemetry.
  trackEvent('agent document drift detected', null, {
    'agent.id': agentId,
    'config.field': field,
  });
}

class DocumentRevisionService {
  /**
   * Append one revision and bring the document back inside the retention bound.
   *
   * @param tx Transaction client — the caller's, so the revision and the column
   *   write are one act.
   */
  async record(
    tx: Prisma.TransactionClient,
    input: RecordRevisionInput,
  ): Promise<AgentWorkspaceRevision> {
    const revision = await tx.agentWorkspaceRevision.create({ data: revisionRow(input) });
    await this.dropOverBound(tx, input.agentId, input.field);
    return revision;
  }

  /**
   * Record the seed revision of every document of a new agent. One insert, and
   * no retention pass, because each field is gaining its first revision.
   *
   * @param tx Transaction client — the caller's, so the agent row and its
   *   history land together.
   */
  async recordSeeds(tx: Prisma.TransactionClient, agent: AgentWorkspace): Promise<void> {
    await tx.agentWorkspaceRevision.createMany({
      data: baselineRows(agent, [...WORKSPACE_DOC_FIELDS], SEED_REASON),
    });
  }

  /**
   * Record a baseline for every document of this agent that has no revision
   * yet, holding what the column reads now. This is what an install upgraded
   * from a build without the table gains on its first boot; without it the
   * oldest reachable content is the first edit after the upgrade, and drift is
   * undetectable until then.
   *
   * Idempotent: an agent whose documents all have a revision matches nothing.
   * Returns the fields it wrote a baseline for.
   */
  async recordMissingBaselines(agent: AgentWorkspace): Promise<WorkspaceDocField[]> {
    const present = await prisma.agentWorkspaceRevision.findMany({
      where: { agentId: agent.id },
      distinct: ['field'],
      select: { field: true },
    });
    const recorded = new Set(present.map((row) => row.field));
    const missing = WORKSPACE_DOC_FIELDS.filter((field) => !recorded.has(field));
    if (missing.length === 0) return [];

    await prisma.agentWorkspaceRevision.createMany({
      data: baselineRows(agent, missing, UPGRADE_REASON),
    });
    return missing;
  }

  /**
   * The history of one document, newest first, with the drift verdict for the
   * content the column holds now. Reporting the drift is part of reading it:
   * this is the only place the column and its revisions meet.
   *
   * Which revisions hold the current content is a second query for their ids
   * alone, because the summaries carry no content and reading 500 whole
   * documents to compare them is the response this history avoids. A document
   * that matches no revision was written outside the write path.
   */
  async history(agent: AgentWorkspace, field: WorkspaceDocField): Promise<DocumentHistory> {
    const rows = await prisma.agentWorkspaceRevision.findMany({
      where: { agentId: agent.id, field },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, actor: true, method: true, reason: true, createdAt: true },
    });
    const matching = await prisma.agentWorkspaceRevision.findMany({
      where: { agentId: agent.id, field, content: agent[field] },
      select: { id: true },
    });

    const current = new Set(matching.map((row) => row.id));
    const revisions = rows.map((row) => ({ ...row, matchesCurrent: current.has(row.id) }));
    const drifted = revisions.length > 0 && !revisions[0].matchesCurrent;
    noteDrift(agent.id, field, agent[field], drifted);

    return { field, bound: MAX_REVISIONS_PER_DOCUMENT, drifted, revisions };
  }

  /**
   * One revision with its content. Scoped to the field as well as the agent, so
   * an id from another document is not found rather than served under the wrong
   * document.
   */
  async get(
    client: Prisma.TransactionClient,
    agentId: string,
    field: WorkspaceDocField,
    id: string,
  ): Promise<AgentWorkspaceRevision | null> {
    return client.agentWorkspaceRevision.findFirst({ where: { id, agentId, field } });
  }

  /** The newest revision of one document, or null while it has none. */
  async newest(
    client: Prisma.TransactionClient,
    agentId: string,
    field: WorkspaceDocField,
  ): Promise<AgentWorkspaceRevision | null> {
    return client.agentWorkspaceRevision.findFirst({
      where: { agentId, field },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * Delete the revisions of one document that sit past the bound. Ordered by
   * time and then by id, so a total order holds when two revisions share a
   * millisecond and the same set is dropped whatever the read order.
   */
  private async dropOverBound(
    tx: Prisma.TransactionClient,
    agentId: string,
    field: WorkspaceDocField,
  ): Promise<number> {
    const overBound = await tx.agentWorkspaceRevision.findMany({
      where: { agentId, field },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: MAX_REVISIONS_PER_DOCUMENT,
      select: { id: true },
    });
    if (overBound.length === 0) return 0;

    await tx.agentWorkspaceRevision.deleteMany({
      where: { id: { in: overBound.map((row) => row.id) } },
    });
    return overBound.length;
  }
}

export const documentRevisionService = new DocumentRevisionService();
