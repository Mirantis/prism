/**
 * The web client's copy of the chat socket contract, `/api/ws` version 2.
 *
 * The runtime's schemas in `src/protocol/chat-protocol.ts` are the authority, and
 * `docs/websocket-protocol.md` describes them. This workspace cannot import runtime
 * code, so the shapes are repeated here, and the contract test replays the recorded
 * session in `src/protocol/fixtures/` against them.
 */

export const PROTOCOL_VERSION = 2;

/** The name this client gives in `hello`. */
export const CLIENT_NAME = 'web';

/** The close codes the client treats specially. Every other close is reconnected. */
export const CLOSE_CODES = {
  /** The runtime speaks another protocol version. Only a reload fixes it. */
  protocolUnsupported: 4426,
  /** A newer connection took this one's place. */
  replaced: 4001,
} as const;

export const CLIENT_PING_INTERVAL_MS = 25_000;
export const CLIENT_PONG_DEADLINE_MS = 10_000;

/** A connection counts as healthy, and the reconnect backoff starts over, after this long open. */
export const STABLE_CONNECTION_MS = 30_000;

/** The longest message the runtime stores, in characters. */
export const MAX_MESSAGE_CHARS = 200_000;

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'update-required';

export type TurnState = 'queued' | 'running' | 'idle';
export type TurnOutcome = 'completed' | 'cancelled' | 'failed';

export interface TurnEvent {
  threadId: string;
  state: TurnState;
  outcome?: TurnOutcome;
  /** Written for a person. Present when `outcome` is `failed`. */
  error?: string;
}

export interface ThreadEvent {
  threadId: string;
  title: string | null;
  /** Present when the thread was just created, absent on a new title. */
  createdAt?: string;
}

/** `single`: the agent has one conversation, and no client starts or switches one. */
export type ThreadMode = 'single' | 'multi';

export interface WelcomePayload {
  protocol: number;
  streamId: string;
  seq: number;
  resumed: boolean;
  you: Viewer;
  threadMode: ThreadMode;
  snapshot: {
    turns: Array<{ threadId: string; state: Exclude<TurnState, 'idle'> }>;
    computer: Record<string, unknown> | null;
  };
}

export type NackCode =
  | 'protocol_unsupported'
  | 'invalid'
  | 'unknown_thread'
  | 'id_conflict'
  | 'rate_limited'
  | 'unavailable'
  | 'failed';

export interface NackPayload {
  code: NackCode;
  message: string;
  retryAfterMs?: number;
}

/** The audio format a voice session carries, in both directions. */
export interface VoiceFormat {
  encoding: string;
  sampleRate: number;
  channels: number;
}

/**
 * A voice control frame, normalized. The audio itself arrives as binary frames.
 * See docs/voice-chat.md.
 */
export type VoiceEvent =
  | { type: 'hello'; format: VoiceFormat }
  /** `desktop` comes with `live` on a session that has a computer the client may drive. */
  | { type: 'state'; state: 'live' | 'ended'; desktop?: boolean }
  | { type: 'clear' }
  | { type: 'error'; error: string };

/**
 * A dictation control frame, normalized. The microphone goes up as binary frames.
 * See docs/dictation.md.
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

/**
 * Who a connection is, as the Mirantis Agent Platform sign-in named it. `id` tells one person
 * from another; `name` is for display. Both are null when the sign-in said nothing.
 */
export interface Viewer {
  id: string | null;
  name: string | null;
}
