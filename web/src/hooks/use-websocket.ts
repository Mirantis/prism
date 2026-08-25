import { useCallback, useEffect, useRef, useState } from 'react';
import { webSocketUrl } from '@/api/runtime-client';
import type { CompactionEvent, ContextUsage, ConversationMessage, UpdateEvent } from '@/types';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type MessageMode = 'followup' | 'collect';

interface ChatMessage {
  mode: MessageMode;
  content: string;
  agentId: string;
  threadId?: string;
  attachmentIds?: string[];
}

interface WebSocketMessage {
  type:
    | 'chat'
    | 'status'
    | 'error'
    | 'typing'
    | 'heartbeat'
    | 'pong'
    | 'thread'
    | 'context'
    | 'compaction'
    | 'update';
  payload?: unknown;
}

interface UseWebSocketOptions {
  onMessage?: (msg: ConversationMessage) => void;
  /** A thread's title was (re)set server-side — update cached thread lists. */
  onThreadUpdate?: (update: { threadId: string; title: string }) => void;
  /**
   * A thread's context-window occupancy changed. Deliberately a callback rather
   * than hook state: the frame is thread-scoped and the caller is the only thing
   * that knows which thread is on screen (see the ref note below).
   */
  onContextUsage?: (usage: ContextUsage) => void;
  /**
   * Compaction progress for a thread (started/completed/failed). A callback for
   * the same reason as onContextUsage: the frame is thread-scoped and only the
   * caller knows which thread is on screen.
   */
  onCompaction?: (event: CompactionEvent) => void;
  /** Self-update progress (available/updating/failed). Install-level, not thread-scoped. */
  onUpdate?: (event: UpdateEvent) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export function useWebSocket(opts: UseWebSocketOptions = {}) {
  const {
    onMessage,
    onThreadUpdate,
    onContextUsage,
    onCompaction,
    onUpdate,
    reconnectInterval = 3000,
    maxReconnectAttempts = 10,
  } = opts;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  // The socket's `onmessage` is bound once at connect (the connect effect runs
  // with [] deps), so a handler that closed over `onMessage`/`onThreadUpdate`
  // would freeze the *first* render's callbacks — and with them any state they
  // captured (e.g. the active thread id). Route through refs that are refreshed
  // every render so the stable handler always invokes the latest callbacks.
  const onMessageRef = useRef(onMessage);
  const onThreadUpdateRef = useRef(onThreadUpdate);
  const onContextUsageRef = useRef(onContextUsage);
  const onCompactionRef = useRef(onCompaction);
  const onUpdateRef = useRef(onUpdate);
  onMessageRef.current = onMessage;
  onThreadUpdateRef.current = onThreadUpdate;
  onContextUsageRef.current = onContextUsage;
  onCompactionRef.current = onCompaction;
  onUpdateRef.current = onUpdate;

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [isTyping, setIsTyping] = useState(false);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        switch (data.type) {
          case 'chat': {
            // Deliberately does NOT clear isTyping: in verbose mode a turn
            // delivers every intermediate step, so an inbound message is not
            // evidence the turn is over. The runtime's `status.processing`
            // (below) brackets the turn and is the sole source of truth.
            const payload = data.payload as ConversationMessage | undefined;
            if (payload) onMessageRef.current?.(payload);
            break;
          }
          case 'typing': {
            const p = data.payload as { isTyping?: boolean } | undefined;
            setIsTyping(p?.isTyping ?? false);
            break;
          }
          case 'status': {
            // The runtime sends { processing: true } when a turn starts and
            // broadcasts { processing: false } when it ends (normal completion
            // or cancel), so the spinner/STOP button track the whole turn —
            // including every intermediate step in verbose mode — and reliably
            // revert even when a cancel produced no new message to deliver.
            // The connect handshake sends { connected: true } with no
            // `processing` key, hence the boolean guard.
            const p = data.payload as { processing?: boolean } | undefined;
            if (typeof p?.processing === 'boolean') setIsTyping(p.processing);
            break;
          }
          case 'thread': {
            const p = data.payload as { threadId?: string; title?: string } | undefined;
            if (p?.threadId && typeof p.title === 'string') {
              onThreadUpdateRef.current?.({ threadId: p.threadId, title: p.title });
            }
            break;
          }
          case 'context': {
            const p = data.payload as Partial<ContextUsage> | undefined;
            // Validate before forwarding: a malformed frame must not render as
            // "NaN% context used". threadId is type-checked rather than merely
            // truthy — a numeric id would pass a truthiness guard and then never
            // match the string comparison AgentChat filters on, silently dropping
            // every reading. Mirrors coerceContextUsage in cli/src/tui-adapter.ts.
            if (
              typeof p?.threadId === 'string' &&
              typeof p.modelId === 'string' &&
              typeof p.usedTokens === 'number' &&
              typeof p.windowTokens === 'number' &&
              typeof p.usedPercent === 'number'
            ) {
              onContextUsageRef.current?.(p as ContextUsage);
            }
            break;
          }
          case 'compaction': {
            const p = data.payload as Partial<CompactionEvent> | undefined;
            // Same strictness as the context case: a malformed frame must not
            // toggle a "compacting…" indicator it can never clear.
            if (
              typeof p?.threadId === 'string' &&
              (p.status === 'started' ||
                p.status === 'completed' ||
                p.status === 'failed' ||
                p.status === 'skipped') &&
              (p.trigger === 'auto' || p.trigger === 'manual')
            ) {
              onCompactionRef.current?.(p as CompactionEvent);
            }
            break;
          }
          case 'update': {
            const p = data.payload as Partial<UpdateEvent> | undefined;
            // Same strictness as the context case: a malformed frame must not
            // raise an update banner nothing can dismiss.
            if (
              typeof p?.version === 'string' &&
              (p.status === 'available' || p.status === 'updating' || p.status === 'failed')
            ) {
              onUpdateRef.current?.(p as UpdateEvent);
            }
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
    // Stable: reads the latest callbacks via refs, so the once-bound socket
    // handler never goes stale and we don't churn the connection.
    [],
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

  // Cancel the in-flight turn: tell the runtime to abort the LLM generation
  // and optimistically clear the typing state so the STOP button reverts
  // immediately (the runtime also broadcasts a terminal { processing: false }).
  const cancel = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'cancel' }));
    }
    setIsTyping(false);
  }, []);

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
    cancel,
  };
}
