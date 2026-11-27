import { ApiError } from '../api-client.js';
import type { SlashCommand } from './types.js';

const REASON_TEXT: Record<string, string> = {
  disabled_by_env: 'Updates are disabled (DISABLE_UPDATER is set).',
  not_sea_install: 'This install updates by other means (pull a new image, or restart the dev server).',
  dev_build: 'This is a development build — it has no release to update to.',
};

/** Why this install cannot update, from the runtime's `reason`. */
export function updateUnavailableText(reason: string | null): string {
  return REASON_TEXT[reason ?? ''] ?? 'Updates are not available in this install.';
}

export const updateCommand: SlashCommand = {
  name: '/update',
  description: 'Check for a newer Prism release and install it',
  run: async (ctx) => {
    try {
      const status = await ctx.api.updateStatus();
      if (!status.enabled) {
        return updateUnavailableText(status.reason);
      }
      if (status.applying) return 'An update is already in progress.';

      // 202 — the runtime downloads and verifies in the background; the WS
      // `update` frames show the progress, and the ws-client's reconnect
      // brings the session back on the new version after the restart.
      const result = await ctx.api.applyUpdate();
      return `Updating to ${result.version} — downloading, then the backend restarts…`;
    } catch (err) {
      // Surfaces the runtime's reason, e.g. the 409 "Already up to date".
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
