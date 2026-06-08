import { useCallback, useEffect, useRef, useState } from 'react';
import { webSocketUrl } from '@/api/runtime-client';
import type { ConversationMessage } from '@/types';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type MessageMode = 'steer' | 'followup' | 'collect';

interface ChatMessage {
  mode: MessageMode;
  content: string;
  agentId: string;
  threadId?: string;
  attachmentIds?: string[];
}

interface WebSocketMessage {
  type: 'chat' | 'status' | 'error' | 'typing' | 'heartbeat' | 'pong';
  payload?: unknown;
}

interface UseWebSocketOptions {
  onMessage?: (msg: ConversationMessage) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export function useWebSocket(opts: UseWebSocketOptions = {}) {
  const { onMessage, reconnectInterval = 3000, maxReconnectAttempts = 10 } = opts;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [isTyping, setIsTyping] = useState(false);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        switch (data.type) {
          case 'chat': {
            const payload = data.payload as ConversationMessage | undefined;
            if (payload) onMessage?.(payload);
            setIsTyping(false);
            break;
          }
          case 'typing': {
            const p = data.payload as { isTyping?: boolean } | undefined;
            setIsTyping(p?.isTyping ?? false);
            break;
          }
          case 'heartbeat':
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ type: 'pong' }));
            }
            break;
          case 'error':
            console.error('[ws] server error:', data.payload);
            break;
          default:
            break;
        }
      } catch (err) {
        console.error('[ws] failed to parse message:', err);
      }
    },
    [onMessage],
  );

  const connect = useCallback(() => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    setStatus('connecting');
    try {
      const ws = new WebSocket(webSocketUrl());
      ws.onopen = () => {
        setStatus('connected');
        reconnectAttempts.current = 0;
      };
      ws.onmessage = handleMessage;
      ws.onerror = () => setStatus('error');
      ws.onclose = (event) => {
        wsRef.current = null;
        if (!isMountedRef.current) return;
        setStatus('disconnected');
        if (event.code !== 1000 && reconnectAttempts.current < maxReconnectAttempts) {
          reconnectAttempts.current++;
          reconnectTimeoutRef.current = setTimeout(() => {
            if (isMountedRef.current) connect();
          }, reconnectInterval);
        }
      };
      wsRef.current = ws;
    } catch (err) {
      console.error('[ws] failed to create:', err);
      setStatus('error');
    }
  }, [handleMessage, maxReconnectAttempts, reconnectInterval]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        wsRef.current.close(1000, 'user disconnect');
      }
      wsRef.current = null;
    }
    setStatus('disconnected');
    reconnectAttempts.current = maxReconnectAttempts;
  }, [maxReconnectAttempts]);

  const sendMessage = useCallback((message: ChatMessage) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      console.error('[ws] cannot send: not connected');
      return;
    }
    wsRef.current.send(JSON.stringify({ type: 'chat', payload: message }));
    setIsTyping(true);
  }, []);

  const sendFollowup = useCallback(
    (content: string, agentId: string, threadId?: string, attachmentIds?: string[]) => {
      sendMessage({ mode: 'followup', content, agentId, threadId, attachmentIds });
    },
    [sendMessage],
  );

  useEffect(() => {
    isMountedRef.current = true;
    const timer = setTimeout(() => {
      if (isMountedRef.current) connect();
    }, 100);
    return () => {
      clearTimeout(timer);
      isMountedRef.current = false;
      // Always disconnect — handles OPEN, CONNECTING, and clears any pending
      // reconnect timer. Gating on OPEN leaked sockets that were still
      // CONNECTING and dangling reconnect timeouts.
      if (wsRef.current) disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status,
    isConnected: status === 'connected',
    isTyping,
    sendFollowup,
  };
}
