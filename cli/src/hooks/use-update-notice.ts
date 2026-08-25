import { useEffect, useState } from 'react';
import { apiClient } from '../api-client.js';
import { tuiAdapterService, UpdateEvent } from '../tui-adapter.js';

/**
 * Self-update progress for the session: the available version (shown as a
 * status-bar hint), plus a SYSTEM line when the backend restarts to apply an
 * update or when an update fails. Install-level — no thread filter.
 *
 * The hint has two sources: one status fetch on mount (so a session opened
 * between announcements shows it immediately) and the WS `update` frames the
 * runtime re-announces each check tick. Both are silent on failure — a
 * failed update check never surfaces in the UI.
 */
export function useUpdateNotice(appendSystemMessage: (text: string) => void): string | null {
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .updateStatus()
      .then((status) => {
        if (!cancelled && status.enabled && status.updateAvailable && status.latestVersion) {
          setAvailableVersion(status.latestVersion);
        }
      })
      .catch(() => {
        // Unreachable or older runtime — the WS frames remain the source.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onUpdate = (event: UpdateEvent) => {
      if (event.status === 'available') {
        setAvailableVersion(event.version);
      } else if (event.status === 'updating') {
        // The ws-client's reconnect loop brings the session back once the
        // supervisor has respawned the new binary.
        setAvailableVersion(null);
        appendSystemMessage(`Backend updating to ${event.version} — reconnecting when it's back…`);
      } else if (event.status === 'failed') {
        appendSystemMessage(`Update to ${event.version} failed (${event.errorCode ?? 'unknown error'}).`);
      }
    };
    tuiAdapterService.events.on('update', onUpdate);
    return () => {
      tuiAdapterService.events.off('update', onUpdate);
    };
  }, [appendSystemMessage]);

  return availableVersion;
}
