/**
 * The seven identity documents, and the words a revision of one is described
 * with.
 *
 * One owner for the list, so the write path, the revision table and the
 * templates agree on what an identity document is. `src/lib/locked-in.ts` keeps
 * its own list: that one is the set the lock covers, six fields plus a logical
 * discriminator for vector memory, and it answers a different question.
 */

/**
 * The `AgentWorkspace` columns that hold an identity document, in the order the
 * Profile page shows them.
 */
export const WORKSPACE_DOC_FIELDS = [
  'agentMd',
  'soulMd',
  'userMd',
  'heartbeatMd',
  'memoryMd',
  'visionMd',
  'bootstrapMd',
] as const;

export type WorkspaceDocField = (typeof WORKSPACE_DOC_FIELDS)[number];

/** Who wrote a revision. A heartbeat write and a chat write are both the agent. */
export type DocumentWriteActor = 'agent' | 'user';

/**
 * How a revision was written. The middle four are the words the
 * `agent config updated` event already carries.
 */
export type DocumentWriteMethod =
  | 'seed'
  | 'replace'
  | 'edit'
  | 'clear'
  | 'rest'
  | 'rollback';
