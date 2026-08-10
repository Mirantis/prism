/**
 * The OpenAI Realtime API session — the agent's voice and ears in a meeting.
 *
 * This is a speech-to-speech session: meeting audio goes in as pcm16 and the
 * model's speech comes back as pcm16. There is deliberately no transcript in the
 * conversation path — transcription, when enabled, is only used to decide whether
 * the bot was addressed (see `addressedOnly`), never as the model's input.
 *
 * The model carries the agent's real system prompt as session `instructions` and
 * the agent's real tools as Realtime function tools, so the participant in the
 * call *is* the Prism agent rather than a separate voice persona relaying to it.
 *
 * Wire protocol notes that shaped this file:
 * - WebSocket is the right transport for a server-side media pipeline (WebRTC is
 *   for browsers that capture audio themselves; SIP is for telephony).
 * - Audio is base64 pcm16 mono at 24 kHz in both directions.
 * - `interrupt_response` is left OFF: the server would kill the response on any
 *   detected speech, including a cough or an "mm-hm". Interruption is decided
 *   locally instead (see barge-in.ts) so backchannels don't cut the bot off.
 * - Truncation is the client's job on this transport. The server has no idea how
 *   much of its audio actually reached the room, so after an interruption we tell
 *   it via `conversation.item.truncate` — otherwise the model's context claims it
 *   said things nobody heard, and later turns get incoherent.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { logger } from '../../logger';
import { REALTIME_SAMPLE_RATE } from './resampler';
import {
  buildRealtimeSocketOptions,
  resolveRealtimeEndpoint,
  type RealtimeEndpoint,
} from './openai-endpoint';

/** A function tool offered to the model, already in JSON Schema form. */
export interface RealtimeFunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeSessionOptions {
  /** The agent's system prompt — Soul, User, Agent Guide, memory, and the rest. */
  instructions: string;
  tools: RealtimeFunctionTool[];
  /** Overrides `OPENAI_REALTIME_MODEL`. */
  model?: string;
  voice?: string;
  /**
   * When true the model never answers on its own: the caller decides who was
   * addressed and calls `requestResponse()`. Used for large meetings, where
   * answering every utterance in the room is both wrong and expensive. Turns on
   * input transcription, since that decision needs words.
   */
  addressedOnly?: boolean;
  /** Injected in tests so they can point at a local mock server. */
  endpointOverride?: RealtimeEndpoint;
}

/** Emitted when the model calls one of the agent's tools. */
export interface RealtimeFunctionCall {
  callId: string;
  name: string;
  /** Raw JSON text as streamed by the model; may be malformed. */
  argumentsJson: string;
}

/**
 * Typed event surface. Consumers listen rather than passing a callback bag so the
 * session can be driven by more than one collaborator (playback, barge-in policy,
 * the service's telemetry) without threading callbacks through each of them.
 */
export interface RealtimeSessionEvents {
  /** Model speech, pcm16 mono @24 kHz, tagged with the item it belongs to. */
  audio: (pcm: Buffer, itemId: string) => void;
  speechStarted: () => void;
  speechStopped: () => void;
  /** A participant's finished utterance (only when transcription is enabled). */
  transcript: (text: string) => void;
  functionCall: (call: RealtimeFunctionCall) => void;
  responseDone: () => void;
  /** A protocol-level error from the API; the socket usually stays open. */
  apiError: (message: string) => void;
  closed: (reason: string) => void;
}

export class RealtimeSession extends EventEmitter {
  /** Typed `on`, so a listener's arguments are checked against the event. */
  override on<E extends keyof RealtimeSessionEvents>(
    event: E,
    listener: RealtimeSessionEvents[E],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  /** Typed `emit`. Private: only this class raises its own events. */
  private emitEvent<E extends keyof RealtimeSessionEvents>(
    event: E,
    ...args: Parameters<RealtimeSessionEvents[E]>
  ): void {
    super.emit(event, ...args);
  }

  private ws: WebSocket | null = null;
  private closed = false;
  /** The audio item currently being spoken, for targeted truncation. */
  private currentItemId: string | null = null;
  private responseActive = false;
  /** A `response.create` deferred until the open response finishes. */
  private responsePending = false;
  /**
   * Items we have given up on, whose remaining audio must be discarded.
   *
   * An interrupt cannot un-send what is already in flight: deltas for the
   * abandoned response keep arriving for as long as the socket takes to drain.
   * Forwarding them would restart playback *over the person who interrupted*, and
   * would push the played-ms past the `audio_end_ms` already reported — after
   * which a second truncate for the same item is rejected by the API. So the
   * abandoned item is remembered and its later deltas are dropped.
   */
  private abandonedItemIds = new Set<string>();

  constructor(private readonly options: RealtimeSessionOptions) {
    super();
  }

  /** Open the socket and configure the session. Resolves once configured. */
  async connect(): Promise<void> {
    const endpoint = this.options.endpointOverride ?? resolveRealtimeEndpoint(this.options.model);
    const socketOptions = await buildRealtimeSocketOptions(endpoint);

    const ws = new WebSocket(endpoint.url, socketOptions as WebSocket.ClientOptions);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        reject(new Error(`Realtime connection failed: ${err.message}`));
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    ws.on('message', (data) => this.handleMessage(data));
    ws.on('error', (err) => {
      // Post-handshake socket errors: report, then let the close handler run.
      logger.error({ err }, '[Meeting] Realtime socket error');
      this.emitEvent('apiError', err.message);
    });
    ws.on('close', (code, reason) => {
      this.closed = true;
      this.emitEvent('closed', reason.toString() || `code ${code}`);
    });

    this.configureSession();
  }

  /** Send the session configuration: instructions, audio formats, tools, VAD. */
  private configureSession(): void {
    const addressedOnly = this.options.addressedOnly === true;
    const pcm = { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE };

    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.options.instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: pcm,
            // Semantic VAD judges whether a speaker is *done* rather than just
            // whether the line went quiet — meetings are full of mid-thought
            // pauses that energy-based VAD reads as a finished turn. `low`
            // eagerness waits longest before deciding, which is what a room full
            // of humans needs.
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'low',
              // In addressed-only mode the model must not answer on its own.
              create_response: !addressedOnly,
              // Always off: interruption is decided locally so a backchannel
              // ("mm-hm") doesn't cut the bot off mid-sentence.
              interrupt_response: false,
            },
            // Only needed to decide who was addressed; never fed back as input.
            ...(addressedOnly
              ? { transcription: { model: 'gpt-4o-mini-transcribe' } }
              : {}),
          },
          output: {
            format: pcm,
            ...(this.options.voice ? { voice: this.options.voice } : {}),
          },
        },
        ...(this.options.tools.length > 0
          ? {
              tools: this.options.tools.map((t) => ({
                type: 'function',
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
              tool_choice: 'auto',
            }
          : {}),
      },
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let event: { type?: string; [key: string]: unknown };
    try {
      event = JSON.parse(data.toString());
    } catch {
      logger.warn('[Meeting] Unparseable Realtime frame');
      return;
    }

    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        return;

      // GA renamed the audio output events to the `response.output_audio.*`
      // family; the older `response.audio.*` names are accepted too so a model
      // snapshot that still emits them doesn't go silent.
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const delta = event.delta;
        const itemId = typeof event.item_id === 'string' ? event.item_id : '';
        if (typeof delta !== 'string' || delta.length === 0) return;
        // Tail of an utterance we already yielded the floor on — see
        // `abandonedItemIds`. Dropped before it can restart playback.
        if (itemId && this.abandonedItemIds.has(itemId)) return;
        if (itemId) this.currentItemId = itemId;
        this.emitEvent('audio', Buffer.from(delta, 'base64'), itemId);
        return;
      }

      case 'input_audio_buffer.speech_started':
        this.emitEvent('speechStarted');
        return;

      case 'input_audio_buffer.speech_stopped':
        this.emitEvent('speechStopped');
        return;

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = event.transcript;
        if (typeof transcript === 'string' && transcript.trim()) {
          this.emitEvent('transcript', transcript.trim());
        }
        return;
      }

      case 'response.created':
        this.responseActive = true;
        return;

      case 'response.function_call_arguments.done': {
        const callId = typeof event.call_id === 'string' ? event.call_id : '';
        const name = typeof event.name === 'string' ? event.name : '';
        const argumentsJson = typeof event.arguments === 'string' ? event.arguments : '{}';
        if (!callId || !name) {
          logger.warn('[Meeting] Function call event missing call_id or name');
          return;
        }
        this.emitEvent('functionCall', { callId, name, argumentsJson });
        return;
      }

      case 'response.done':
        this.responseActive = false;
        this.emitEvent('responseDone');
        // Release a response that was requested while this one was still open.
        if (this.responsePending) {
          this.responsePending = false;
          this.requestResponse();
        }
        return;

      case 'error': {
        const err = event.error as { message?: string } | undefined;
        const message = err?.message ?? 'unknown Realtime API error';
        logger.error(`[Meeting] Realtime API error: ${message}`);
        this.emitEvent('apiError', message);
        return;
      }

      default:
        return;
    }
  }

  /** Append captured meeting audio (pcm16 mono @24 kHz) to the input buffer. */
  sendAudio(pcm24k: Buffer): void {
    if (pcm24k.length === 0) return;
    this.send({ type: 'input_audio_buffer.append', audio: pcm24k.toString('base64') });
  }

  /**
   * Ask the model to respond now (addressed-only mode drives turns this way).
   *
   * Deferred while a response is still generating: the API rejects a second
   * `response.create` and the request would simply be lost. This matters most for
   * tool results — `response.function_call_arguments.done` arrives *before* the
   * `response.done` of the response that made the call, so a tool that answers
   * quickly (a cache hit, or a rejected argument) gets here while the previous
   * response is still open. Without the deferral its answer would never be spoken
   * until some later turn happened to trigger a response.
   */
  requestResponse(): void {
    if (this.responseActive) {
      this.responsePending = true;
      return;
    }
    this.send({ type: 'response.create' });
  }

  /**
   * Abandon the in-flight response and tell the model how much of it was
   * actually heard, so its context matches the room's experience.
   *
   * `playedMs` must be what reached the meeting, not what was received — audio
   * deltas arrive far faster than real time.
   */
  interrupt(playedMs: number): void {
    // A response queued behind this one is abandoned with it: the human now has
    // the floor, and their speech is what should decide the next turn. (Any tool
    // result already sits in the conversation, so nothing is lost.)
    this.responsePending = false;
    if (this.responseActive) {
      this.send({ type: 'response.cancel' });
      this.responseActive = false;
    }
    if (this.currentItemId) {
      this.send({
        type: 'conversation.item.truncate',
        item_id: this.currentItemId,
        content_index: 0,
        audio_end_ms: Math.max(0, Math.round(playedMs)),
      });
      // Remember it so the tail still on the wire is discarded rather than played.
      this.abandonedItemIds.add(this.currentItemId);
      // Bounded: only the last few matter, and a long call would otherwise grow
      // this set for every interruption.
      if (this.abandonedItemIds.size > 32) {
        this.abandonedItemIds.delete(this.abandonedItemIds.values().next().value as string);
      }
      this.currentItemId = null;
    }
  }

  /** Return a tool result to the model and let it continue speaking. */
  sendFunctionOutput(callId: string, output: string): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    // The model does not resume on its own after a tool result — even with
    // automatic turn detection, a function_call_output needs an explicit
    // response.create or the answer never gets spoken.
    this.requestResponse();
  }

  /**
   * Inject context the model should know but nobody said out loud (e.g. "you
   * have just been admitted to the meeting").
   */
  sendContext(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // 1000 = normal closure; anything else shows up as an error in OpenAI's logs.
    try {
      this.ws?.close(1000, 'meeting ended');
    } catch {
      this.ws?.terminate();
    }
  }
}
