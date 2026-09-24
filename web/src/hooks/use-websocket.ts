import { useCallback, useEffect, useRef, useState } from 'react';
import { webSocketUrl } from '@/api/runtime-client';
import type {
  CompactionEvent,
  ComputerStatus,
  ContextUsage,
  ConversationMessage,
  UpdateEvent,
} from '@/types';

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
    | 'update'
    | 'computer'
    | 'voice_state'
    | 'voice_error'
    | 'voice_hello'
    | 'voice_clear'
    | 'dictation_hello'
    | 'dictation_delta'
    | 'dictation_result'
    | 'dictation_error';
  payload?: unknown;
}

/** The audio format a voice session carries, in both directions. */
export interface VoiceFormat {
  encoding: string;
  sampleRate: number;
  channels: number;
}

/**
 * A voice control frame, normalized. The audio itself is not here: it arrives as
 * binary frames and goes straight to `onVoiceAudio`. See docs/voice-chat.md.
 */
export type VoiceEvent =
  | { type: 'hello'; format: VoiceFormat }
  /** `desktop` comes with `live` on a session that has a computer the client may drive. */
  | { type: 'state'; state: 'live' | 'ended'; desktop?: boolean }
  | { type: 'clear' }
  | { type: 'error'; error: string };

/**
 * A dictation control frame, normalized. The microphone goes up as binary frames through
 * `sendVoiceAudio`, and nothing comes back but these. See docs/dictation.md.
 */
export type DictationEvent =
  | { type: 'hello'; format: VoiceFormat }
  | { type: 'delta'; text: string }
  | { type: 'result'; text: string }
  | { type: 'error'; error: string };

/** What a client asks for beyond a plain call. */
export interface VoiceStartOptions {
  threadId?: string;
  /** Open a browser and a desktop for the agent, which the client then watches. */
  computer?: boolean;
  /** The rectangle the client will show that screen in, in its own device pixels. */
  screen?: { width: number; height: number };
  /** What the agent opens with, for a client that started the call by opening a page. */
  greeting?: string;
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
  /**
   * The state of the desktop: which threads wait for it, who holds it, and the open
   * help requests. Install-level as well — the caller filters by thread where it shows
   * the state.
   */
  onComputerStatus?: (status: ComputerStatus) => void;
  /**
   * A voice control frame arrived. A callback for the same reason as the two
   * above: the voice session belongs to the caller, which owns the microphone
   * and the playback.
   */
  onVoiceEvent?: (event: VoiceEvent) => void;
  /**
   * A frame of the agent's speech, pcm16 at the rate `voice_hello` states. Called
   * from the socket handler with no await in front of it, so frames and the
   * `clear` that cancels them arrive in the order the runtime sent them.
   */
  onVoiceAudio?: (frame: ArrayBuffer) => void;
  /** A dictation control frame arrived. The dictation belongs to the caller, like a call. */
  onDictationEvent?: (event: DictationEvent) => void;
  /**
   * The thread on screen. A turn runs on one thread, and the runtime says which, so this
   * is what keeps work on another thread — a Slack conversation, a goal — from showing
   * the agent typing here.
   */
  activeThreadId?: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

/** A turn the runtime reported without naming a thread; it belongs to every view. */
const ANY_THREAD = '';

/**
 * The set a frame leaves behind.
 *
 * A frame that names no thread is the cancel of a turn sent without one, or a runtime
 * older than the per-thread report, so its end clears every turn rather than one.
 */
function nextRunning(
  current: ReadonlySet<string>,
  threadId: string | undefined,
  active: boolean,
): ReadonlySet<string> {
  const key = threadId ?? ANY_THREAD;
  if (!active && key === ANY_THREAD) return current.size ? new Set() : current;
  if (current.has(key) === active) return current;
  const next = new Set(current);
  if (active) next.add(key);
  else next.delete(key);
  return next;
}

export function useWebSocket(opts: UseWebSocketOptions = {}) {
  const {
    onMessage,
    onThreadUpdate,
    onContextUsage,
    onCompaction,
    onUpdate,
    onComputerStatus,
    onVoiceEvent,
    onVoiceAudio,
    onDictationEvent,
    activeThreadId,
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
  const onComputerStatusRef = useRef(onComputerStatus);
  const onVoiceEventRef = useRef(onVoiceEvent);
  const onVoiceAudioRef = useRef(onVoiceAudio);
  const onDictationEventRef = useRef(onDictationEvent);
  const activeThreadIdRef = useRef(activeThreadId);
  onMessageRef.current = onMessage;
  onThreadUpdateRef.current = onThreadUpdate;
  onContextUsageRef.current = onContextUsage;
  onCompactionRef.current = onCompaction;
  onUpdateRef.current = onUpdate;
  onComputerStatusRef.current = onComputerStatus;
  onVoiceEventRef.current = onVoiceEvent;
  onVoiceAudioRef.current = onVoiceAudio;
  onDictationEventRef.current = onDictationEvent;
  activeThreadIdRef.current = activeThreadId;

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  /**
   * The threads a turn is running on, as the runtime reports them.
   *
   * A set rather than a flag: turns run per thread and the user can move between threads
   * mid-turn, so what this view shows is a question asked of the thread on screen. A
   * frame naming no thread — the answer to a cancel — ends whatever is running.
   */
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * The thread a message was just sent to, until the runtime reports its turn. The empty
   * string is a message sent before a thread had been named.
   */
  const [sent, setSent] = useState<string | null>(null);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      // Audio, not JSON. Taken before the parse so a frame of speech is never
      // read as chat, and handed on synchronously so it keeps its place among
      // the text frames — `voice_clear` cancels the audio that precedes it.
      // `binaryType` is 'arraybuffer' (set at connect), so nothing else arrives
      // here as a non-string.
      if (typeof event.data !== 'string') {
        onVoiceAudioRef.current?.(event.data as ArrayBuffer);
        return;
      }
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        switch (data.type) {
          case 'chat': {
            // Deliberately does NOT clear the running set: in verbose mode a turn
            // delivers every intermediate step, so an inbound message is not
            // evidence the turn is over. The runtime's `status.processing`
            // (below) brackets the turn and is the sole source of truth.
            const payload = data.payload as ConversationMessage | undefined;
            if (payload) onMessageRef.current?.(payload);
            break;
          }
          case 'typing': {
            const p = data.payload as { isTyping?: boolean } | undefined;
            const thread = activeThreadIdRef.current;
            setRunning((prev) => nextRunning(prev, thread, p?.isTyping ?? false));
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
            const p = data.payload as { processing?: boolean; threadId?: string } | undefined;
            if (typeof p?.processing !== 'boolean') break;
            setRunning((prev) => nextRunning(prev, p.threadId, p.processing === true));
            // The runtime is reporting this thread now, so the optimistic state a send
            // put up has been taken over, whichever way the report went.
            setSent((prev) =>
              prev === null || prev === p.threadId || prev === ANY_THREAD ? null : prev,
            );
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
          case 'computer': {
            const p = data.payload as Partial<ComputerStatus> | undefined;
            // Same strictness as the context case. The banner and the computer page
            // read `waiting` directly, so a frame without it throws in render, and the
            // cache holds it until the desktop changes again.
            if (Array.isArray(p?.waiting)) {
              onComputerStatusRef.current?.(p as ComputerStatus);
            }
            break;
          }
          case 'voice_state': {
            const p = data.payload as { state?: string; desktop?: boolean } | undefined;
            if (p?.state === 'live' || p?.state === 'ended') {
              onVoiceEventRef.current?.({
                type: 'state',
                state: p.state,
                desktop: p.desktop === true,
              });
            }
            break;
          }
          case 'voice_hello': {
            const p = data.payload as { format?: Partial<VoiceFormat> } | undefined;
            const format = p?.format;
            // Validated before forwarding, like the two cases above: the caller
            // builds its capture around this format, and a half-stated one would
            // configure the microphone with an undefined rate.
            if (
              typeof format?.encoding === 'string' &&
              typeof format.sampleRate === 'number' &&
              typeof format.channels === 'number'
            ) {
              onVoiceEventRef.current?.({ type: 'hello', format: format as VoiceFormat });
            }
            break;
          }
          case 'voice_clear':
            onVoiceEventRef.current?.({ type: 'clear' });
            break;
          case 'voice_error': {
            const p = data.payload as { error?: string } | undefined;
            // A refusal with no text still has to reach the user as words, since
            // the alternative is a control that does nothing and says nothing.
            onVoiceEventRef.current?.({
              type: 'error',
              error: p?.error?.trim() || 'The voice chat could not run.',
            });
            break;
          }
          case 'dictation_hello': {
            const p = data.payload as { format?: Partial<VoiceFormat> } | undefined;
            const format = p?.format;
            if (
              typeof format?.encoding === 'string' &&
              typeof format.sampleRate === 'number' &&
              typeof format.channels === 'number'
            ) {
              onDictationEventRef.current?.({ type: 'hello', format: format as VoiceFormat });
            }
            break;
          }
          case 'dictation_delta':
          case 'dictation_result': {
            const p = data.payload as { text?: unknown } | undefined;
            if (typeof p?.text !== 'string') break;
            onDictationEventRef.current?.({
              type: data.type === 'dictation_delta' ? 'delta' : 'result',
              text: p.text,
            });
            break;
          }
          case 'dictation_error': {
            const p = data.payload as { error?: string } | undefined;
            onDictationEventRef.current?.({
              type: 'error',
              error: p?.error?.trim() || 'The dictation could not be transcribed.',
            });
            break;
          }
          case 'heartbeat':
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ type: 'pong' }));
            }
            break;
          case 'error':
            console.error('[ws] server error:', data.payload);
            // A request that failed before its turn started gets no status frame, so the
            // optimistic report ends here. A turn the runtime reported stays in `running`.
            setSent(null);
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
      // The agent's speech arrives as binary frames. As Blobs they would need a
      // read to open, which is asynchronous — and audio that is reordered against
      // the `voice_clear` cancelling it is audio the user hears after a barge-in.
      ws.binaryType = 'arraybuffer';
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
    // The runtime reports the turn a moment later; this covers the gap, and only for the
    // thread the message went to.
    setSent(message.threadId ?? ANY_THREAD);
  }, []);

  const sendFollowup = useCallback(
    (content: string, agentId: string, threadId?: string, attachmentIds?: string[]) => {
      sendMessage({ mode: 'followup', content, agentId, threadId, attachmentIds });
    },
    [sendMessage],
  );

  // The voice senders. None of them touches the running set: a call is not a turn, and
  // the composer's spinner and STOP button belong to the text conversation.
  //
  // `mode` is left unset on purpose, which the runtime reads as `open` — every
  // utterance answered. A browser tab is somebody talking to the agent.
  const sendVoiceStart = useCallback((options: VoiceStartOptions = {}) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    wsRef.current.send(JSON.stringify({ type: 'voice_start', payload: options }));
    return true;
  }, []);

  const sendVoiceStop = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'voice_stop' }));
  }, []);

  /**
   * One frame of the microphone, pcm16 mono at the session's rate. Dropped when the
   * socket is not open: the client streams continuously, silence included, so a
   * dropped frame is a gap in the audio and never an error to report.
   */
  const sendVoiceAudio = useCallback((frame: ArrayBuffer) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(frame);
  }, []);

  // The dictation senders. The audio goes through `sendVoiceAudio`: a socket carries one
  // microphone, and the runtime routes it to whichever of the two this socket started.
  const sendDictationStart = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    wsRef.current.send(JSON.stringify({ type: 'dictation_start', payload: {} }));
    return true;
  }, []);

  /** `commit` transcribes the recording; `false` discards it. */
  const sendDictationStop = useCallback((commit: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'dictation_stop', payload: { commit } }));
  }, []);

  // Cancel the in-flight turn: tell the runtime to abort the LLM generation
  // and optimistically clear the typing state so the STOP button reverts
  // immediately (the runtime also broadcasts a terminal { processing: false }).
  const cancel = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'cancel' }));
    }
    setSent(null);
    setRunning((prev) => nextRunning(prev, activeThreadIdRef.current, false));
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

  // What this view shows: a turn running on the thread it has open, or the moment between
  // a message being sent and the runtime reporting the turn it starts.
  const isTyping =
    running.has(ANY_THREAD) ||
    (activeThreadId ? running.has(activeThreadId) : running.size > 0) ||
    (sent !== null && (sent === ANY_THREAD || sent === activeThreadId));

  return {
    status,
    isConnected: status === 'connected',
    isTyping,
    sendFollowup,
    cancel,
    sendVoiceStart,
    sendVoiceStop,
    sendVoiceAudio,
    sendDictationStart,
    sendDictationStop,
  };
}
