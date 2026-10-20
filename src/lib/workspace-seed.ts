/**
 * Reads the identity documents a deployment gives a new agent, from the
 * directory `PRISM_WORKSPACE_SEED_DIR` names: one `<field>.md` per document,
 * such as `soulMd.md` or `agentMd.md`. A document the directory holds replaces
 * the default template when the runtime first creates its agent
 * (`resolveOrBootstrapSingleAgent`); a document it lacks keeps the default.
 *
 * The files are read once, at startup, and only the first boot uses them. A
 * platform that writes them on every start (Lens Agents start files) therefore
 * overwrites nothing the agent or its user changed later.
 *
 * `memoryMd` is not seedable: memory is what the agent learns, not a document a
 * deployment writes. A file that cannot be read, or one over the size cap,
 * keeps the default for its field and says why on stderr: a bad seed never
 * stops the agent from booting. Stderr rather than the logger, because this
 * runs while `config` loads, before the logger can.
 */

import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DOC_FIELDS, type WorkspaceDocField } from './workspace-docs';

export type SeedableField = Exclude<WorkspaceDocField, 'memoryMd'>;

export type WorkspaceSeed = Partial<Record<SeedableField, string>>;

export const SEEDABLE_FIELDS = WORKSPACE_DOC_FIELDS.filter(
  (field): field is SeedableField => field !== 'memoryMd',
);

// The size of a Lens Agents start file, which is how the seed usually arrives.
// A document this long is already far past what a prompt section should hold.
export const MAX_SEED_DOCUMENT_BYTES = 128 * 1024;

export function readWorkspaceSeed(dir = process.env.PRISM_WORKSPACE_SEED_DIR): WorkspaceSeed {
  if (!dir) return {};

  const seed: WorkspaceSeed = {};
  for (const field of SEEDABLE_FIELDS) {
    const file = path.join(dir, `${field}.md`);
    let content: Buffer;
    try {
      content = fs.readFileSync(file);
    } catch (err) {
      // A missing document is the ordinary case: the seed names only the ones it changes.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[workspace-seed] failed to read ${file}: ${(err as Error).message}\n`);
      }
      continue;
    }
    if (content.byteLength > MAX_SEED_DOCUMENT_BYTES) {
      process.stderr.write(
        `[workspace-seed] ${file} is over ${MAX_SEED_DOCUMENT_BYTES} bytes; keeping the default\n`,
      );
      continue;
    }
    seed[field] = content.toString('utf8');
  }
  return seed;
}
