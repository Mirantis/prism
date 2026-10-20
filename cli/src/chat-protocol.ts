/**
 * The terminal UI's copy of the chat socket contract, `/api/ws`, version 2.
 *
 * The runtime's `src/protocol/chat-protocol.ts` is the authority, and
 * `docs/websocket-protocol.md` describes it. This package cannot import the
 * runtime, so it keeps the shapes it reads and writes here. The recorded
 * session in `src/protocol/fixtures/` holds both copies to the same frames
 * (`protocol-contract.test.ts`).
 */

export const PROTOCOL_VERSION = 2;

/** Close codes the runtime uses. The client acts on the code, never on the reason text. */
export const CLOSE_CODES = {
  protocolUnsupported: 4426,
  helloTimeout: 4408,
  slowConsumer: 4008,
  replaced: 4001,
} as const;

export const CLIENT_PING_INTERVAL_MS = 25_000;
export const CLIENT_PONG_DEADLINE_MS = 10_000;

/** The longest message the runtime stores. A longer one is refused before it is sent. */
export const MAX_MESSAGE_CHARS = 200_000;

export type TurnState = 'queued' | 'running' | 'idle';
export type TurnOutcome = 'completed' | 'cancelled' | 'failed';

export interface TurnEventPayload {
  threadId: string;
  state: TurnState;
  outcome?: TurnOutcome;
  /** What went wrong, when `outcome` is `failed`. Written for a person. */
  error?: string;
}

/** What the terminal UI shows for a failed turn whose event has no `error`. */
export const TURN_FAILED_TEXT = 'The response failed.';

/** `single`: the agent has one conversation, and no client starts or switches one. */
export type ThreadMode = 'single' | 'multi';

export interface WelcomePayload {
  protocol: number;
  streamId: string;
  /** The `seq` of the last event before this socket went live. */
  seq: number;
  /** True when every event after the client's cursor follows this frame. */
  resumed: boolean;
  you: Viewer;
  threadMode: ThreadMode;
  snapshot: {
    turns: Array<{ threadId: string; state: Exclude<TurnState, 'idle'> }>;
  };
}

/** One numbered event of the stream. The payload is read by whoever handles its type. */
export interface StreamEvent {
  type: string;
  seq: number;
  payload: unknown;
}

export interface SendAckPayload {
  messageId: string;
  seq: number;
  queued: boolean;
  duplicate: boolean;
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

/** A message this client sends. `id` is a uuid v4 the client makes up and keeps until it is confirmed. */
export interface OutgoingMessage {
  id: string;
  threadId: string;
  content: string;
  attachmentIds: string[];
}

/**
 * Who a connection is, as the Lens Agents sign-in named it. `id` tells one person
 * from another; `name` is for display. Both are null when the sign-in said nothing.
 */
export interface Viewer {
  id: string | null;
  name: string | null;
}
