/**
 * Reads the identity documents a deployment gives a new agent, from the
 * directory `PRISM_WORKSPACE_SEED_DIR` names: one `<field>.md` per document,
 * such as `soulMd.md` or `agentMd.md`. A document the directory holds replaces
 * the default template when the runtime first creates its agent
 * (`resolveOrBootstrapSingleAgent`); a document it lacks keeps the default.
 *
 * Only that first boot reads the directory. A platform that writes the files
 * on every start (Mirantis Agent Platform start files) therefore overwrites nothing the
 * agent or its user changed later.
 *
 * `memoryMd` is not seedable: memory is what the agent learns, not a document a
 * deployment writes. A file that cannot be read keeps the default for its
 * field: a bad seed never stops the agent from booting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import { WORKSPACE_DOC_FIELDS, type WorkspaceDocField } from './workspace-docs';

type SeedableField = Exclude<WorkspaceDocField, 'memoryMd'>;

export type WorkspaceSeed = Partial<Record<SeedableField, string>>;

const SEEDABLE_FIELDS = WORKSPACE_DOC_FIELDS.filter((field): field is SeedableField => field !== 'memoryMd');

export function readWorkspaceSeed(dir: string | undefined): WorkspaceSeed {
  if (!dir) return {};

  const seed: WorkspaceSeed = {};
  for (const field of SEEDABLE_FIELDS) {
    const file = path.join(dir, `${field}.md`);
    try {
      seed[field] = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // A missing document is the ordinary case: the seed names only the ones it changes.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, file }, '[WorkspaceSeed] cannot read a seeded document; keeping the default');
      }
    }
  }
  return seed;
}
