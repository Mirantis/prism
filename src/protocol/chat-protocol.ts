/**
 * The chat socket's wire contract, `/api/ws`, version 2.
 *
 * This module is the contract: the gateway parses every inbound frame with these
 * schemas and builds every outbound one from these types. Each client keeps its
 * own copy of the shapes, and the recorded frames in `fixtures/` are what hold
 * all of them to this one. Client authors read `docs/websocket-protocol.md`.
 *
 * Every frame is JSON text except voice and dictation audio, which travels as
 * binary frames outside this contract.
 */

import { z } from 'zod';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../constants';
import type { InvokeError } from '../types';
import type { ThreadMode } from '../config';

/** The version a client names in `hello`. There is one; an older client is told to update. */
export const PROTOCOL_VERSION = 2;

/**
 * Close codes the server uses, in the 4000 range the WebSocket spec leaves to
 * applications. A client acts on the code, never on the reason text.
 */
export const CLOSE_CODES = {
  /** The client speaks another protocol version, or skipped `hello`. Update the client. */
  protocolUnsupported: 4426,
  /** No `hello` arrived in time. */
  helloTimeout: 4408,
  /** The socket fell too far behind to be sent to. Reconnect and resume. */
  slowConsumer: 4008,
  /** A newer connection took this one's place at the per-agent cap. Reconnect if still wanted. */
  replaced: 4001,
} as const;

/** How long the server waits for `hello` before it closes the socket. */
export const HELLO_TIMEOUT_MS = 5_000;

/** The largest text frame the server reads. The `ws` default of 100 MB is a denial of service. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * The longest message a person can send, in characters. Four bytes a character
 * at worst still leaves it inside `MAX_FRAME_BYTES`.
 */
export const MAX_MESSAGE_CHARS = 200_000;

/** How often a client pings, and how long it waits for the `pong`, before it treats the socket as dead. */
export const CLIENT_PING_INTERVAL_MS = 25_000;
export const CLIENT_PONG_DEADLINE_MS = 10_000;

// A version-4 uuid, the only id a client may choose for a message. Checked
// rather than trusted because it becomes the row's primary key.
export const uuidV4 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'must be a uuid v4');

// Any uuid. Threads and attachments are minted by the server, which does not
// promise a version.
export const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a uuid');

/** A client's name for one request, echoed back as `re` on the answer. */
const requestId = z.string().min(1).max(64);

// ============================================================================
// Client → server
// ============================================================================

export const helloFrame = z.object({
  type: z.literal('hello'),
  id: requestId,
  payload: z.object({
    protocol: z.number().int(),
    client: z.object({
      name: z.string().min(1).max(64),
      version: z.string().max(64).optional(),
    }),
    resume: z
      .object({
        streamId: z.string().min(1).max(64),
        seq: z.number().int().nonnegative(),
      })
      .optional(),
  }),
});

export const sendFrame = z.object({
  type: z.literal('send'),
  id: requestId,
  payload: z.object({
    message: z
      .object({
        id: uuidV4,
        threadId: uuid,
        content: z.string().max(MAX_MESSAGE_CHARS),
        attachmentIds: z.array(uuid).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
      })
      .refine((m) => m.content.trim().length > 0 || m.attachmentIds.length > 0, {
        message: 'a message needs text or an attachment',
      }),
  }),
});

export const cancelFrame = z.object({
  type: z.literal('cancel'),
  id: requestId,
  payload: z.object({ threadId: uuid }),
});

export const pingFrame = z.object({
  type: z.literal('ping'),
  id: requestId,
});

// Voice and dictation keep the fields they had; `docs/voice-chat.md` and
// `docs/dictation.md` describe them, and the gateway reads each one with care
// of its own. The envelope is what changes.
const loosePayload = z.record(z.string(), z.unknown()).default({});

export const voiceStartFrame = z.object({ type: z.literal('voice_start'), id: requestId, payload: loosePayload });
export const voiceStopFrame = z.object({ type: z.literal('voice_stop'), id: requestId, payload: loosePayload });
export const dictationStartFrame = z.object({ type: z.literal('dictation_start'), id: requestId, payload: loosePayload });
export const dictationStopFrame = z.object({
  type: z.literal('dictation_stop'),
  id: requestId,
  payload: z.object({ commit: z.boolean().optional() }).default({}),
});

/** Every frame a client may send after `hello`. */
export const clientFrame = z.discriminatedUnion('type', [
  sendFrame,
  cancelFrame,
  pingFrame,
  voiceStartFrame,
  voiceStopFrame,
  dictationStartFrame,
  dictationStopFrame,
]);

export type HelloFrame = z.infer<typeof helloFrame>;
export type ClientFrame = z.infer<typeof clientFrame>;
export type SendFrame = z.infer<typeof sendFrame>;

// ============================================================================
// Server → client
// ============================================================================

/** The state of one conversation's work, as every client sees it. */
export type TurnState = 'queued' | 'running' | 'idle';

/** How a turn that went idle ended. Absent on a thread that was only ever queued. */
export type TurnOutcome = 'completed' | 'cancelled' | 'failed';

export interface TurnEventPayload {
  threadId: string;
  state: TurnState;
  outcome?: TurnOutcome;
  /** What went wrong, when `outcome` is `failed`. Written for a person. */
  error?: string;
}

/** The `error` of a failed turn. The details go to the log. */
export const TURN_FAILED = 'The agent could not answer. Try again.';

/** The `error` of a turn that failed on the spending limit, which a retry does not lift. */
export const SPENDING_LIMIT_REACHED = 'The AI spending limit is reached.';

/** The `error` of a turn whose reply is an error report. */
export function turnError(error: InvokeError): string {
  return error.type === 'budget_exceeded' ? SPENDING_LIMIT_REACHED : TURN_FAILED;
}

export interface AttachmentPayload {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  category: string;
  expired?: boolean;
  /** The message's text shows this image at its place, as `![alt](attachment:<id>)`. */
  inline?: boolean;
}

/** One message, for any role. A client upserts it by `id`. */
export interface MessageEventPayload {
  id: string;
  threadId: string;
  role: 'USER' | 'AGENT' | 'SYSTEM';
  content: string;
  triggeredBy: string;
  toolCalls: unknown[] | null;
  blocks: unknown[] | null;
  isCompacted: boolean;
  /** ISO 8601 with milliseconds. Clients order a thread by `(createdAt, id)`. */
  createdAt: string;
  attachments: AttachmentPayload[] | null;
  /**
   * Who wrote a USER message, when the Lens Agents sign-in named the connection.
   * `senderId` tells one person from another; compare it with `welcome.you.id`.
   * `senderName` is for display. Neither is ever used to decide what is allowed.
   */
  senderId: string | null;
  senderName: string | null;
  /**
   * What a message from another agent is (`triggeredBy: AGENT_MESSAGE`): a
   * `message`, an `ask` that waits for an answer, or a `notice` the delivery
   * service itself sends. Null on every other message.
   */
  agentMessageKind: AgentMessageKind | null;
}

export type AgentMessageKind = 'message' | 'ask' | 'notice';

export interface ThreadEventPayload {
  threadId: string;
  title: string | null;
  createdAt?: string;
}

/**
 * Everything the stream carries. Each has a `seq`, so a client that misses some
 * can say where it stopped and have them again.
 */
export type StreamEvent =
  | { type: 'message'; payload: MessageEventPayload }
  | { type: 'turn'; payload: TurnEventPayload }
  | { type: 'thread'; payload: ThreadEventPayload }
  | { type: 'context'; payload: Record<string, unknown> }
  | { type: 'compaction'; payload: Record<string, unknown> }
  | { type: 'computer'; payload: Record<string, unknown> }
  | { type: 'update'; payload: Record<string, unknown> };

export type SequencedEvent = StreamEvent & { seq: number };

export interface WelcomePayload {
  protocol: number;
  /** Names this process's stream. A different one on reconnect means the replay is gone. */
  streamId: string;
  /** The `seq` of the last event before this socket went live. */
  seq: number;
  /** True when every event after the client's cursor follows this frame. */
  resumed: boolean;
  /** Who this connection is, or nulls when the sign-in did not say. */
  you: { id: string | null; name: string | null };
  /**
   * `single`: the agent has one conversation, which `POST /threads` returns and
   * `GET /threads` lists alone, so a client shows no way to start or switch one.
   */
  threadMode: ThreadMode;
  snapshot: {
    turns: Array<{ threadId: string; state: Exclude<TurnState, 'idle'> }>;
    computer: Record<string, unknown> | null;
  };
}

export interface SendAckPayload {
  messageId: string;
  /** A stream position at or after the stored message's `message` event. */
  seq: number;
  /** True when the message waits behind a turn in another conversation. */
  queued: boolean;
  /** True when this id was already stored and nothing new happened. */
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
  /** Present on `rate_limited`: when the same request may be tried again. */
  retryAfterMs?: number;
}

/** A frame for one socket rather than the stream. It carries no `seq`. */
export type DirectFrame =
  | { type: 'welcome'; payload: WelcomePayload }
  | { type: 'ack'; re: string; payload: SendAckPayload | Record<string, never> }
  | { type: 'nack'; re: string | null; payload: NackPayload }
  | { type: 'pong'; re: string }
  | { type: 'voice_hello'; payload: unknown }
  | { type: 'voice_state'; payload: unknown }
  | { type: 'voice_error'; payload: unknown }
  | { type: 'voice_clear' }
  | { type: 'dictation_hello'; payload: unknown }
  | { type: 'dictation_delta'; payload: unknown }
  | { type: 'dictation_result'; payload: unknown }
  | { type: 'dictation_error'; payload: unknown };
