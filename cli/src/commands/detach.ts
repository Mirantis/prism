import type { SlashCommand } from './types.js';

export const detachCommand: SlashCommand = {
  name: '/detach',
  description: 'Remove all staged attachments',
  run: async (ctx) => {
    const staged = ctx.stagedAttachments;
    if (staged.length === 0) return 'No files staged.';
    // Best-effort server cleanup: unlinked uploads are also reaped by the
    // runtime's hourly orphan janitor (24h TTL), so per-file failures are
    // safe to swallow.
    for (const att of staged) {
      try {
        await ctx.api.deleteAttachment(att.id);
      } catch {
        // Janitor covers it.
      }
    }
    ctx.clearStagedAttachments();
    return `Removed ${staged.length} staged file(s).`;
  },
};
