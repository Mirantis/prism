import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Monitor, X } from 'lucide-react';
import { ScreenView } from '@/components/voice/screen-view';
import { computerRequest } from '@/api/computer';
import { useComputerScreen } from '@/hooks/use-computer-screen';
import { useComputerStatus } from '@/hooks/use-computer-status';
import { cn } from '@/lib/utils';
import type { ComputerHelp } from '@/types';
import { ComputerHelpCard } from './computer-help-card';

const PANEL_TRANSITION_MS = 1200;
const MIN_PANEL_WIDTH = 320;

export function ChatComputerPanel({
  requests,
  reopenRequest,
}: {
  requests: ComputerHelp[];
  reopenRequest?: { id: string; token: number };
}) {
  const queryClient = useQueryClient();
  const { data } = useComputerStatus();
  const current = requests.map(
    (request) => data?.help?.find((item) => item.id === request.id) ?? request,
  );
  const currentRef = useRef(current);
  currentRef.current = current;
  const waiting = [...current].reverse().find((request) => request.status === 'waiting');
  const [displayed, setDisplayed] = useState<ComputerHelp | null>(waiting ?? null);
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const autoOpenedIdRef = useRef<string | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number; maxWidth: number } | null>(
    null,
  );
  const ignoreAudio = useCallback(() => {}, []);
  const screen = useComputerScreen({ enabled: displayed !== null, onAudio: ignoreAudio });
  const state = screen.state ?? data;
  const ownControl = Boolean(screen.clientId) && state?.controller === screen.clientId;
  const anotherController = Boolean(state?.controller) && !ownControl;
  const waitingId = waiting?.id;
  const displayedCurrent =
    current.find((request) => request.id === displayed?.id) ?? displayed;
  const displayedStatus = displayedCurrent?.status;
  const active = open && displayedStatus === 'waiting';
  const reopenedId = reopenRequest
    ? current.find(
        (request) => request.id === reopenRequest.id && request.status === 'waiting',
      )?.id
    : undefined;

  const showPanel = useCallback((help: ComputerHelp) => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setDisplayed(help);
    const frame = window.requestAnimationFrame(() => setOpen(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const showPanelById = useCallback(
    (id: string) => {
      const help = currentRef.current.find(
        (request) => request.id === id && request.status === 'waiting',
      );
      if (!help) return;
      return showPanel(help);
    },
    [showPanel],
  );

  const hidePanel = useCallback(() => {
    setOpen(false);
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(
      () => {
        closeTimerRef.current = null;
        setDisplayed(null);
      },
      PANEL_TRANSITION_MS,
    );
  }, []);

  useEffect(() => {
    if (!waitingId) {
      autoOpenedIdRef.current = null;
      return;
    }
    if (autoOpenedIdRef.current === waitingId) return;
    autoOpenedIdRef.current = waitingId;
    const cancelOpen = showPanelById(waitingId);
    return () => {
      cancelOpen?.();
      if (autoOpenedIdRef.current === waitingId) autoOpenedIdRef.current = null;
    };
  }, [showPanelById, waitingId]);

  useEffect(() => {
    if (!reopenRequest || !reopenedId) return;
    return showPanelById(reopenedId);
  }, [reopenRequest?.token, reopenedId, showPanelById]);

  useEffect(() => {
    if (!displayedCurrent || displayedStatus === 'waiting' || !open) return;
    hidePanel();
  }, [displayedCurrent, displayedStatus, hidePanel, open]);

  useEffect(
    () => () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  const request = useCallback(
    async (path: string) => {
      if (!displayedCurrent) return false;
      setBusy(true);
      setError(null);
      try {
        await computerRequest(path, {
          clientId: screen.clientId,
          helpId: displayedCurrent.id,
        });
        await queryClient.invalidateQueries({ queryKey: ['computer'] });
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [displayedCurrent, queryClient, screen.clientId],
  );

  const finish = useCallback(async () => {
    if (!displayedCurrent) return;
    setBusy(true);
    setError(null);
    try {
      await computerRequest(`/help/${displayedCurrent.id}`, {
        action: 'continue',
        clientId: screen.clientId,
      });
      await queryClient.invalidateQueries({ queryKey: ['computer'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [displayedCurrent, queryClient, screen.clientId]);

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      startX: event.clientX,
      startWidth: panel.getBoundingClientRect().width,
      maxWidth: window.innerWidth,
    };
  };

  const continueResize = (event: PointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize) return;
    setWidth(
      Math.min(
        resize.maxWidth,
        Math.max(MIN_PANEL_WIDTH, resize.startWidth + resize.startX - event.clientX),
      ),
    );
  };

  const resizeWithKeyboard = (direction: number) => {
    const panel = panelRef.current;
    if (!panel) return;
    setWidth(
      Math.min(
        window.innerWidth,
        Math.max(MIN_PANEL_WIDTH, panel.offsetWidth + direction * 32),
      ),
    );
  };

  if (!displayedCurrent) return null;

  return createPortal(
    <aside
      ref={panelRef}
      aria-label="Computer help panel"
      data-state={open ? 'open' : 'closed'}
      style={{ width: width ?? '50vw', maxWidth: '100vw' }}
      className={cn(
        'fixed inset-y-0 right-0 z-50 flex min-w-0 flex-col border-l bg-background shadow-2xl transition-transform duration-[1200ms] ease-in-out motion-reduce:transition-none',
        !open && 'translate-x-full',
      )}
    >
      <button
        type="button"
        aria-label="Resize computer panel"
        title="Drag to resize"
        onPointerDown={startResize}
        onPointerMove={continueResize}
        onPointerUp={() => {
          resizeRef.current = null;
        }}
        onPointerCancel={() => {
          resizeRef.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') resizeWithKeyboard(1);
          if (event.key === 'ArrowRight') resizeWithKeyboard(-1);
        }}
        className="group absolute inset-y-0 left-0 z-10 w-3 -translate-x-1/2 cursor-col-resize touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="absolute inset-y-0 left-1/2 w-px bg-border transition-colors group-hover:bg-primary" />
      </button>

      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
          <Monitor className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Computer help</h2>
          <p className="text-xs text-muted-foreground">Complete the requested step on the desktop.</p>
        </div>
        <button
          type="button"
          aria-label="Close computer panel"
          title="Close"
          onClick={() => {
            hidePanel();
          }}
          className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="space-y-4">
          <ScreenView
            screenRef={screen.screenRef}
            hasScreen={screen.hasScreen}
            controllable={active && ownControl && !busy}
            canTakeControl={
              active && !anotherController && !busy && Boolean(screen.clientId)
            }
            onTakeControl={() => request('/control')}
            onInput={screen.sendInput}
            onRelease={() => void finish()}
            connecting={!screen.message}
          />
          <ComputerHelpCard
            help={displayedCurrent}
            clientId={screen.clientId}
            inComputer
            showConversationLink={false}
            showHeader={false}
            disabled={busy || anotherController || !screen.clientId}
          />
          {(error || screen.message) && (
            <p role="alert" className="text-sm text-destructive">
              {error || screen.message}
            </p>
          )}
        </div>
      </div>
    </aside>,
    document.body,
  );
}
