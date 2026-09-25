/**
 * The GPT-Live session: the agent's voice and ears in a call.
 *
 * The voice model hears the call and speaks, and decides by itself when to take a turn,
 * when to yield and when to backchannel. When a request needs work it creates a client
 * delegation, and the runtime does that work in an agent run of its own (see
 * `voice-backend.ts`), then hands the voice the result to say.
 *
 * Wire notes, as measured against the live endpoint:
 * - The first frame is `session.start`, and everything in it is fixed for the session.
 * - Audio is base64 pcm16 mono at 24 kHz both ways. Output is a continuous real-time
 *   stream of 100 ms frames, silence included, with no timing fields.
 * - A delegation names no task. What was asked is in the transcript, which carries
 *   `start_ms`/`end_ms` on the session timeline.
 * - Context appends take at most 500 tokens each.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { config } from '../../config';
import { logger } from '../../logger';
import {
  buildRealtimeSocketOptions,
  resolveLiveEndpoint,
  type RealtimeEndpoint,
} from '../meeting/openai-endpoint';

/** How long `connect()` waits for `session.started`. */
const DEFAULT_START_TIMEOUT_MS = 15_000;

/** How long `close()` waits for `session.closed` before dropping the socket. */
const CLOSE_TIMEOUT_MS = 2_000;

export interface LiveSessionOptions {
  /** The voice model's instructions: who it is, how to talk, and what to delegate. */
  instructions: string;
  voice?: string;
  /** Injected in tests so they can point at a local mock server. */
  endpointOverride?: RealtimeEndpoint;
  /** Injected in tests, so a start that never answers fails inside a test's time. */
  startTimeoutMs?: number;
}

export interface LiveSessionEvents {
  /** Voice audio, pcm16 mono at 24 kHz. */
  audio: (pcm: Buffer) => void;
  /** The voice handed a request over, `offsetMs` into the session. */
  delegation: (id: string, offsetMs: number | null) => void;
  /**
   * A fragment of what the call said (`input`) or what the voice said (`output`), with
   * where it falls on the session timeline when the API says.
   */
  transcript: (side: 'input' | 'output', delta: string, startMs: number | null) => void;
  /** A protocol-level error from the API; the socket usually stays open. */
  apiError: (message: string) => void;
  /** The session is over. `reason` is the API's close reason, or the socket's. */
  closed: (reason: string, voiceSeconds: number | null) => void;
}

interface ServerEvent {
  type?: string;
  [key: string]: unknown;
}

export class LiveSession extends EventEmitter {
  override on<E extends keyof LiveSessionEvents>(event: E, listener: LiveSessionEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  private emitEvent<E extends keyof LiveSessionEvents>(
    event: E,
    ...args: Parameters<LiveSessionEvents[E]>
  ): void {
    super.emit(event, ...args);
  }

  private ws: WebSocket | null = null;
  private closed = false;
  private voiceSeconds: number | null = null;
  private closeReason: string | null = null;
  private eventCounter = 0;

  constructor(private readonly options: LiveSessionOptions) {
    super();
  }

  /** Open the socket and start the session. Resolves on `session.started`. */
  async connect(): Promise<void> {
    const endpoint = this.options.endpointOverride ?? resolveLiveEndpoint();
    const socketOptions = await buildRealtimeSocketOptions(endpoint);
    const ws = new WebSocket(endpoint.url, socketOptions as WebSocket.ClientOptions);
    this.ws = ws;
    let started = false;
    // Attached for the socket's whole life: a socket with no 'error' listener throws, and
    // terminating one that is still connecting emits an error on the next tick.
    ws.on('error', (err) => {
      if (!started) return;
      logger.error({ err }, '[Voice] Live socket error');
      this.emitEvent('apiError', err.message);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('The voice session did not start in time'));
        ws.terminate();
      }, this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('error', onError);
        ws.off('message', onStartMessage);
        ws.off('close', onEarlyClose);
      };
      const onError = (err: Error) => {
        cleanup();
        const status = /Unexpected server response: (\d{3})/.exec(err.message)?.[1];
        logger.warn({
          host: new URL(endpoint.url).host,
          provider: config.realtimeProvider,
          source: config.realtimeSource,
          ...(status ? { status: Number(status) } : {}),
        }, '[Voice] Live handshake failed');
        reject(new Error(`Voice connection failed: ${err.message}`));
      };
      const onEarlyClose = (code: number, reason: Buffer) => {
        cleanup();
        reject(new Error(`The voice session closed before it started (${reason.toString() || `code ${code}`})`));
      };
      const onStartMessage = (data: WebSocket.RawData) => {
        const event = parse(data);
        if (event?.type === 'session.started') {
          cleanup();
          started = true;
          // What the API accepted, which is not always what was asked for.
          logger.info({ model: (event.session as { model?: string } | undefined)?.model }, '[Voice] Session started');
          resolve();
          return;
        }
        if (event?.type === 'error') {
          cleanup();
          reject(new Error(`The voice session was refused: ${errorMessage(event)}`));
          ws.terminate();
        }
      };
      ws.once('open', () => this.start());
      ws.once('error', onError);
      ws.on('message', onStartMessage);
      ws.once('close', onEarlyClose);
    });

    ws.on('message', (data) => this.handleMessage(data));
    ws.on('close', (code, reason) => {
      this.closed = true;
      this.emitEvent('closed', this.closeReason ?? (reason.toString() || `code ${code}`), this.voiceSeconds);
    });
  }

  private start(): void {
    this.send({
      type: 'session.start',
      session: {
        model: config.openaiRealtimeModel,
        instructions: this.options.instructions,
        ...(this.options.voice ? { audio: { output: { voice: this.options.voice } } } : {}),
        delegation: { type: 'client' },
      },
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    const event = parse(data);
    if (!event) {
      logger.warn('[Voice] Unparseable Live frame');
      return;
    }

    switch (event.type) {
      case 'session.output_audio.delta': {
        if (typeof event.delta !== 'string' || event.delta.length === 0) return;
        this.emitEvent('audio', Buffer.from(event.delta, 'base64'));
        return;
      }
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        if (typeof event.delta !== 'string' || event.delta === '') return;
        const startMs = typeof event.start_ms === 'number' ? event.start_ms : null;
        this.emitEvent('transcript', event.type.includes('input') ? 'input' : 'output', event.delta, startMs);
        return;
      }
      case 'session.delegation.created': {
        const delegation = event.delegation as { id?: string } | undefined;
        if (!delegation?.id) return;
        this.emitEvent('delegation', delegation.id, typeof event.offset_ms === 'number' ? event.offset_ms : null);
        return;
      }
      case 'session.usage.updated':
      case 'session.closed': {
        const seconds = (event.usage as { seconds?: unknown } | undefined)?.seconds;
        if (typeof seconds === 'number') this.voiceSeconds = seconds;
        if (event.type !== 'session.closed') return;
        if (typeof event.reason === 'string') this.closeReason = event.reason;
        // The session is over once the API says so. It does not answer a WebSocket close
        // handshake after this, and nothing more will arrive, so the socket is dropped.
        this.ws?.terminate();
        return;
      }
      case 'error':
        logger.warn(`[Voice] Live API reported: ${errorMessage(event)}`);
        this.emitEvent('apiError', errorMessage(event));
        return;
      default:
        return;
    }
  }

  sendAudio(pcm24k: Buffer): void {
    this.send({ type: 'session.input_audio.append', audio: pcm24k.toString('base64') });
  }

  /** Trusted instructions that take effect at once: a change in the call, a rule for now. */
  appendInstructions(text: string): void {
    this.sendAppend('session.instructions.append', text);
  }

  /**
   * Context the voice knows from now on without saying it: progress on a delegation, or,
   * with no id, something about the session.
   */
  appendThinking(text: string, delegationId: string | null = null): void {
    this.sendAppend('session.thinking.append', text, delegationId);
  }

  /** Something for the voice to say now, in its own words: a delegation's result, or a greeting. */
  appendCommentary(text: string, delegationId: string | null = null): void {
    this.sendAppend('session.commentary.append', text, delegationId);
  }

  private sendAppend(type: string, content: string, delegationId: string | null = null): void {
    this.send({ type, event_id: `ctx_${++this.eventCounter}`, delegation_id: delegationId, content });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * End the session. `session.close` lets the API report the final usage, so this
   * resolves once the socket is gone, which is within `CLOSE_TIMEOUT_MS` either way.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => ws.terminate(), CLOSE_TIMEOUT_MS);
      timer.unref?.();
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      if (ws.readyState === WebSocket.OPEN) this.send({ type: 'session.close' });
      else ws.terminate();
    });
  }
}

function parse(data: WebSocket.RawData): ServerEvent | null {
  try {
    const event: unknown = JSON.parse(data.toString());
    return event && typeof event === 'object' ? (event as ServerEvent) : null;
  } catch {
    return null;
  }
}

function errorMessage(event: ServerEvent): string {
  const err = event.error as { message?: string; code?: string } | undefined;
  return err?.message ?? err?.code ?? 'unknown error';
}
