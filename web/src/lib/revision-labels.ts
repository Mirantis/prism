import type { DocumentRevisionSummary } from '@lensapp/prism-client';

const METHODS: Record<string, string> = {
  seed: 'Initial version',
  rest: 'Edited',
  edit: 'Edited',
  replace: 'Replaced',
  clear: 'Cleared',
  rollback: 'Restored',
};

export function revisionMethod(revision: DocumentRevisionSummary): string {
  return METHODS[revision.method] ?? 'Edited';
}

export function revisionTitle(revision: DocumentRevisionSummary): string {
  if (revision.method === 'seed') return 'Initial version';
  if (
    revision.method === 'rollback' &&
    revision.reason.startsWith('Restored the revision from ')
  ) {
    return 'Restored an earlier version';
  }
  return revision.reason.trim() || `${revisionMethod(revision)} document`;
}
