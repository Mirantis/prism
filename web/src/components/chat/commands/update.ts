import { runtimeApi } from '@/api/runtime-client';
import { ApiError } from '@lensapp/prism-client';
import type { SlashCommand } from './types';

const REASON_TEXT: Record<string, string> = {
  disabled_by_env: 'Updates are disabled (DISABLE_UPDATER is set).',
  not_sea_install: 'This install updates by other means (pull a new image, or restart the dev server).',
  dev_build: 'This is a development build — it has no release to update to.',
};

export const updateCommand: SlashCommand = {
  name: '/update',
  description: 'Check for a newer Prism release and install it',
  run: async () => {
    try {
      const status = await runtimeApi.updateStatus();
      if (!status.enabled) {
        return REASON_TEXT[status.reason ?? ''] ?? 'Updates are not available in this install.';
      }
      if (status.applying) return 'An update is already in progress.';

      const result = await runtimeApi.applyUpdate();
      // The banner takes over from here: the WS 'updating' frame shows
      // "Backend updating…" and the page reloads when the runtime is back.
      return `Updating to ${result.version} — downloading, then the backend restarts…`;
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
