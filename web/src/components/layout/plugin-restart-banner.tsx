import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useWebSocket } from '@/hooks/use-websocket';
import type { PrismPluginsEvent } from '@/hooks/use-websocket';

/**
 * Says what happened when a Prism plugin changed.
 *
 * A page change needs no strip at all — the page is refetched and the nav
 * re-read. The two cases worth a line are the runtime ending to load a plugin's
 * server half, and the same change where nothing will bring the runtime back.
 *
 * Mounts its own WebSocket, as the update strip does, so the frame reaches every
 * page rather than only the chat route.
 */
export function PluginRestartBanner() {
  const [state, setState] = useState<
    { phase: 'idle' } | { phase: 'restarting' } | { phase: 'required'; instruction: string }
  >({ phase: 'idle' });
  const queryClient = useQueryClient();

  const { status } = useWebSocket({
    onPrismPlugins: (event: PrismPluginsEvent) => {
      if (event.status === 'reloaded') {
        // The page was rebuilt in place. Its module URL carries the new
        // revision, so re-reading the list is what swaps it on screen.
        void queryClient.invalidateQueries({ queryKey: ['prism-plugins'] });
        return;
      }
      if (event.status === 'restart-required') {
        setState({
          phase: 'required',
          instruction: event.instruction ?? 'Restart the runtime to load it.',
        });
        return;
      }
      setState({ phase: 'restarting' });
    },
  });

  // The socket coming back is the runtime up again with the plugin loaded.
  useEffect(() => {
    if (state.phase !== 'restarting' || status !== 'connected') return;
    void queryClient.invalidateQueries({ queryKey: ['prism-plugins'] });
    setState({ phase: 'idle' });
  }, [state.phase, status, queryClient]);

  if (state.phase === 'idle') return null;

  if (state.phase === 'restarting') {
    return (
      <div
        data-testid="plugin-restart-banner"
        className="mx-4 mb-2 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm"
      >
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        <span>A plugin changed — restarting, reconnecting when it's back.</span>
      </div>
    );
  }

  return (
    <div
      data-testid="plugin-restart-banner"
      className="mx-4 mb-2 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm"
    >
      <AlertTriangle className="size-4" />
      <span>A plugin's backend changed. {state.instruction}</span>
    </div>
  );
}
