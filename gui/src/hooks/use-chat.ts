import { useCallback, useEffect, useRef, useState } from 'react';
import { WsClient, WsEnvelope } from '../lib/ws-client';
import {
  coerceMessage,
  loadHistory,
  webSocketUrl,
  type ConversationMessage,
} from '../lib/runtime';

/** Agent activity, mirroring the CLI's TuiStatus. */
export type ChatStatus = 'idle' | 'thinking' | 'error';
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface UseChat {
  messages: ConversationMessage[];
  status: ChatStatus;
  statusDetail?: string;
  connection: ConnectionState;
  send: (text: string) => void;
}

export function useChat(): UseChat {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string | undefined>(undefined);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const clientRef = useRef<WsClient | null>(null);

  // Replay the active thread's recent messages on mount so reopening the app
  // doesn't show a blank screen for an existing conversation.
  useEffect(() => {
    let cancelled = false;
    void loadHistory(50).then((history) => {
      if (cancelled || history.length === 0) return;
      setMessages((prev) => [...history, ...prev]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Open the WebSocket and route inbound envelopes. Runs once for the app's
  // lifetime; the client handles its own reconnect/backoff.
  useEffect(() => {
    const client = new WsClient(webSocketUrl());
    clientRef.current = client;

    client.on('open', () => {
      setConnection('connected');
      setStatus((s) => (s === 'error' ? 'idle' : s));
      setStatusDetail(undefined);
    });
    client.on('close', () => setConnection('disconnected'));
    client.on('error', () => setConnection('disconnected'));

    client.on('envelope', (arg) => {
      const env = arg as WsEnvelope;
      switch (env.type) {
        case 'chat': {
          const msg = coerceMessage(env.payload);
          if (!msg) break;
          // Dedupe by id in case of any double-delivery. The runtime sends
          // one `chat` per streamed step, each a distinct message.
          setMessages((prev) =>
            prev.some((m) => m.id === msg.id) ? prev : [...prev, msg],
          );
          // The runtime doesn't emit a `processing: false` status — the agent
          // reply landing is the signal to clear the spinner.
          if (msg.role === 'AGENT') setStatus('idle');
          break;
        }
        case 'status': {
          const p = env.payload as { connected?: boolean; processing?: boolean } | undefined;
          if (p?.processing) setStatus('thinking');
          else if (p?.connected) setStatus((s) => (s === 'thinking' ? s : 'idle'));
          break;
        }
        case 'error': {
          const p = env.payload as { error?: string } | undefined;
          setStatus('error');
          setStatusDetail(p?.error ?? 'unknown error');
          break;
        }
        // typing / pong intentionally ignored
      }
    });

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, []);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Optimistically render the user line — the runtime only broadcasts AGENT
    // messages back, so we add it locally for immediate feedback (same as CLI).
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        threadId: '',
        role: 'USER',
        content: trimmed,
        triggeredBy: 'USER_INPUT',
        toolCalls: null,
        blocks: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    setStatus('thinking');
    setStatusDetail(undefined);
    // Omit agentId/threadId — the runtime substitutes them server-side.
    clientRef.current?.send({
      type: 'chat',
      payload: { mode: 'followup', content: trimmed },
    });
  }, []);

  return { messages, status, statusDetail, connection, send };
}
