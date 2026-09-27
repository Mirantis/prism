import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, Loader2, X } from 'lucide-react';
import { runtimeApi } from '@/api/runtime-client';
import { useChatSocket } from '@/hooks/use-chat-socket';
import { Button } from '@/components/ui/button';
import type { UpdateEvent, UpdateStatus } from '@/types';

/**
 * The live half of the update strip, mounted by UpdateBanner only when the
 * updater is enabled for this install: renders "update available" with an
 * Update now button, "Backend updating…" while the runtime restarts (then
 * reloads once the runtime reports the target version), and a dismissible
 * error when an update fails. Listens on the tab's chat socket, so update
 * events reach every page, not only the chat route.
 */
export function UpdateBannerLive({ status }: { status: UpdateStatus }) {
  const [phase, setPhase] = useState<'idle' | 'updating' | 'failed'>('idle');
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  // The poll survives navigation only as long as this component does — clear
  // it on unmount so no orphaned timer keeps polling.
  useEffect(() => {
    return () => {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  // Reconcile an apply already in flight: a tab opened during the download
  // (or one whose socket missed the frame) must show "updating…" and watch
  // for the restart, not offer a second Update now.
  useEffect(() => {
    if (status.applying && status.latestVersion) {
      setPhase('updating');
      setVersion(status.latestVersion);
      startStatusPoll(status.latestVersion);
    }
    // Run once per status refresh; startStatusPoll self-guards against
    // double intervals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.applying, status.latestVersion]);

  // The poll starts on the WS 'updating' frame (sent after the download, just
  // before the restart), not on the POST — the POST answers 202 before a
  // possibly minutes-long download. The page reloads only when the runtime
  // itself reports the target version: an /health-style liveness probe would
  // accept the still-running old process (the frame precedes the swap) or a
  // process whose swap failed. Fetch errors are the restart window — keep
  // polling through them.
  const stopStatusPoll = () => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startStatusPoll = (targetVersion: string) => {
    if (pollRef.current != null) return;
    pollRef.current = window.setInterval(async () => {
      try {
        const fresh = await runtimeApi.updateStatus();
        if (fresh.currentVersion === targetVersion) {
          stopStatusPoll();
          window.location.reload();
        }
      } catch {
        // runtime restarting — keep polling
      }
    }, 1_000);
  };

  useChatSocket({
    update: (event: UpdateEvent) => {
      setVersion(event.version);
      if (event.status === 'updating') {
        setPhase('updating');
        startStatusPoll(event.version);
      } else if (event.status === 'failed') {
        // Terminal: the runtime is staying on the old version, so the poll
        // would never see the target.
        stopStatusPoll();
        setPhase('failed');
        setError(`Update to ${event.version} failed (${event.errorCode ?? 'unknown error'}).`);
      }
      // 'available' just refreshes the version; the strip renders from it.
    },
  });

  const onUpdateNow = async () => {
    setPhase('updating');
    setError(null);
    try {
      await runtimeApi.applyUpdate();
      // Download in progress server-side; the WS 'updating' frame starts the
      // status poll, and a failure arrives as a WS 'failed' frame.
    } catch (e) {
      setPhase('failed');
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  };

  const availableVersion = version ?? status.latestVersion ?? null;

  if (phase === 'updating') {
    return (
      <div
        data-testid="update-banner"
        className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-card px-3 py-2 text-sm ring-1 ring-foreground/10 md:mx-6"
      >
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        <span>Backend updating{availableVersion ? ` to ${availableVersion}` : ''}… reconnecting when it's back.</span>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div
        data-testid="update-banner"
        className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-card px-3 py-2 text-sm text-destructive ring-1 ring-destructive/30 md:mx-6"
      >
        <span className="flex-1">{error}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Dismiss"
          onClick={() => {
            setPhase('idle');
            setError(null);
          }}
        >
          <X className="size-4" />
        </Button>
      </div>
    );
  }

  if (!status.updateAvailable && !version) return null;

  return (
    <div
      data-testid="update-banner"
      className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-card px-3 py-2 text-sm ring-1 ring-foreground/10 md:mx-6"
    >
      <ArrowUpCircle className="size-4" />
      <span className="flex-1">
        Update available: {availableVersion}
        {status.currentVersion ? ` (current ${status.currentVersion})` : ''}
      </span>
      <Button size="sm" onClick={onUpdateNow}>
        Update now
      </Button>
    </div>
  );
}
