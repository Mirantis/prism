import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAgent } from '@/lib/agent-context';

const popupPath = '/computer-window';
const report = (status: 'opened' | 'closed' | 'blocked') => {
  void fetch('/agents/computer-window/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
    keepalive: true,
  }).catch(() => {});
};

type WindowControls = {
  detached: boolean;
  popup: boolean;
  error: string | null;
  open: (helpId?: string) => void;
  focus: () => void;
  restore: () => void;
};
const Context = createContext<WindowControls | null>(null);

export function ComputerWindowProvider({ children }: { children: ReactNode }) {
  const agent = useAgent();
  const popup = window.location.pathname === popupPath;
  const [detached, setDetached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const child = useRef<Window | null>(null);
  const reported = useRef(false);
  useEffect(() => {
    const bus = new BroadcastChannel(`computer-window:${agent.agentId}`);
    channel.current = bus;
    const announce = () => bus.postMessage({ type: 'ready' });
    const leaving = () => {
      if (!popup) return;
      bus.postMessage({ type: 'closed' });
      report('closed');
    };
    bus.onmessage = ({ data }) => {
      if (popup) {
        if (data.type === 'probe') announce();
        if (data.type === 'focus') window.focus();
        if (data.type === 'restore') window.close();
        return;
      }
      if (data.type === 'ready') setDetached(true);
      if (data.type === 'closed') setDetached(false);
    };
    if (popup) {
      announce();
      if (!reported.current) {
        report('opened');
        reported.current = true;
      }
    } else bus.postMessage({ type: 'probe' });
    window.addEventListener('pagehide', leaving);
    if (popup) window.addEventListener('pageshow', announce);
    const timer = window.setInterval(() => {
      if (child.current?.closed) {
        child.current = null;
        setDetached(false);
      }
    }, 500);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', leaving);
      window.removeEventListener('pageshow', announce);
      bus.close();
      channel.current = null;
    };
  }, [agent.agentId, popup]);

  const focus = () => {
    child.current?.focus();
    channel.current?.postMessage({ type: 'focus' });
  };
  const open = (helpId?: string) => {
    if (detached || (child.current && !child.current.closed)) {
      focus();
      return;
    }
    setError(null);
    const url = new URL(popupPath, window.location.origin);
    if (helpId) url.searchParams.set('help', helpId);
    child.current = window.open(
      url,
      `computer-${agent.agentId}`,
      'popup=yes,toolbar=no,menubar=no,location=no,status=no,resizable=yes,scrollbars=no,width=1280,height=800',
    );
    if (!child.current) {
      setError('Allow popups for this site, then choose Pop out again.');
      report('blocked');
      return;
    }
  };
  const restore = () => {
    child.current?.close();
    channel.current?.postMessage({ type: 'restore' });
  };
  return (
    <Context.Provider value={{ detached, popup, error, open, focus, restore }}>
      {children}
    </Context.Provider>
  );
}

export function useComputerWindow() {
  const value = useContext(Context);
  if (!value) throw new Error('ComputerWindowProvider is required');
  return value;
}
