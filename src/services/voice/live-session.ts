/**
 * The GPT-Live session: the agent's voice and ears in a call.
 *
 * Two models share it. The voice model hears the call and speaks, and decides by itself
 * when to take a turn, when to yield and when to backchannel. When a request needs work it
 * delegates to a backend Responses model, which holds the agent's system prompt and tools.
 * This class runs the tools that backend calls, in this process, and hands the results
 * back.
 *
 * Wire notes, as measured against the live endpoint:
 * - The first frame is `session.start`, and everything in it is fixed for the session.
 *   Only `delegation.responses` can change later.
 * - Audio is base64 pcm16 mono at 24 kHz both ways. Output is a continuous real-time
 *   stream of 100 ms frames, silence included, with no timing fields.
 * - The backend is one conversation. A reply names no delegation, so a response's function
 *   calls are answered together, after that response completes, and `response.create`
 *   continues it.
 * - A tool result may carry pictures: `function_call_output.output` takes content parts.
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

/** A function tool offered to the backend, already in JSON Schema form. */
export interface LiveFunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One part of what the backend is shown: words or a picture. */
export type LiveContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string };

/** What a tool hands back: text, or text and pictures. */
export type LiveToolOutput = string | LiveContentPart[];

export interface LiveSessionOptions {
  /** The voice model's instructions: who it is, how to talk, and what to delegate. */
  instructions: string;
  /** The backend's: the agent's system prompt and how to work for a voice. */
  backendInstructions: string;
  tools: LiveFunctionTool[];
  voice?: string;
  /** Injected in tests so they can point at a local mock server. */
  endpointOverride?: RealtimeEndpoint;
  /** Injected in tests, so a start that never answers fails inside a test's time. */
  startTimeoutMs?: number;
}

/** Emitted when the backend calls one of the agent's tools. */
export interface LiveFunctionCall {
  callId: string;
  name: string;
  /** Raw JSON text as the backend wrote it; may be malformed. */
  argumentsJson: string;
}

export interface LiveSessionEvents {
  /** Voice audio, pcm16 mono at 24 kHz. */
  audio: (pcm: Buffer) => void;
  /** The voice handed a request to the backend. */
  delegation: () => void;
  functionCall: (call: LiveFunctionCall) => void;
  /** A fragment of what the call said (`input`) or what the voice said (`output`). */
  transcript: (side: 'input' | 'output', delta: string) => void;
  /** Tokens one backend response used. */
  backendUsage: (usage: { inputTokens: number; outputTokens: number }) => void;
  /** The backend finished a response that called no tools, so the request is answered. */
  backendAnswered: () => void;
  /** A protocol-level error from the API; the socket usually stays open. */
  apiError: (message: string) => void;
  /** The session is over. `reason` is the API's close reason, or the socket's. */
  closed: (reason: string, voiceSeconds: number | null) => void;
}

interface ServerEvent {
  type?: string;
  [key: string]: unknown;
}

/** A response's function calls, and the outputs that have come back for them. */
interface PendingBatch {
  outputs: Map<string, LiveToolOutput | null>;
  /** The backend finished the response, so no more calls will join this batch. */
  completed: boolean;
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
  /** The calls of the backend response in progress, answered together once it completes. */
  private batch: PendingBatch | null = null;
  /**
   * What the backend should see next, held while a batch is open.
   *
   * A message between a function call and its output breaks the backend's conversation,
   * so a picture shown during a tool call waits for the outputs and goes in after them.
   */
  private readonly heldItems: LiveContentPart[][] = [];
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
    const effort = config.openaiRealtimeReasoningEffort;
    this.send({
      type: 'session.start',
      session: {
        model: config.openaiRealtimeModel,
        instructions: this.options.instructions,
        ...(this.options.voice ? { audio: { output: { voice: this.options.voice } } } : {}),
        delegation: {
          type: 'responses',
          responses: {
            model: config.openaiVoiceBackendModel,
            instructions: this.options.backendInstructions,
            ...(effort ? { reasoning: { effort } } : {}),
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
        },
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
        this.emitEvent('transcript', event.type.includes('input') ? 'input' : 'output', event.delta);
        return;
      }
      case 'session.delegation.created':
        this.emitEvent('delegation');
        return;
      case 'response.event':
        this.handleBackendEvent(event.event as ServerEvent | undefined);
        return;
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

  /** One event of the backend's own Responses stream. */
  private handleBackendEvent(event: ServerEvent | undefined): void {
    if (!event) return;
    if (event.type === 'response.output_item.done') {
      const item = event.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
      if (item?.type !== 'function_call' || !item.call_id || !item.name) return;
      this.batch ??= { outputs: new Map(), completed: false };
      this.batch.outputs.set(item.call_id, null);
      this.emitEvent('functionCall', {
        callId: item.call_id,
        name: item.name,
        argumentsJson: item.arguments ?? '',
      });
      return;
    }
    if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      const response = event.response as {
        status?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { message?: string } | null;
      } | undefined;
      if (response?.usage) {
        this.emitEvent('backendUsage', {
          inputTokens: response.usage.input_tokens ?? 0,
          outputTokens: response.usage.output_tokens ?? 0,
        });
      }
      if (event.type !== 'response.completed') {
        logger.warn(`[Voice] A backend response ended ${response?.status ?? event.type}: ${response?.error?.message ?? 'no detail'}`);
      }
      if (!this.batch) {
        this.emitEvent('backendAnswered');
        return;
      }
      this.batch.completed = true;
      this.flushBatch();
    }
  }

  /** Return a tool result to the backend. It continues once every call of its response has one. */
  sendFunctionOutput(callId: string, output: LiveToolOutput): void {
    if (!this.batch?.outputs.has(callId)) return;
    this.batch.outputs.set(callId, output);
    this.flushBatch();
  }

  private flushBatch(): void {
    const batch = this.batch;
    if (!batch?.completed) return;
    if ([...batch.outputs.values()].some((o) => o === null)) return;
    this.batch = null;
    for (const [callId, output] of batch.outputs) {
      this.send({
        type: 'response.item.create',
        item: { type: 'function_call_output', call_id: callId, output },
      });
    }
    for (const content of this.heldItems.splice(0)) this.sendUserItem(content);
    this.send({ type: 'response.create' });
  }

  /**
   * Show the backend something: a picture of a screen, with a note about it.
   *
   * `respond` asks the backend to answer it now, which the voice then speaks. Without it
   * the item waits in the backend's context for the next request.
   */
  showBackend(content: LiveContentPart[], respond: boolean): void {
    if (this.batch) {
      // The batch's own `response.create` follows the item, so it is answered either way.
      this.heldItems.push(content);
      return;
    }
    this.sendUserItem(content);
    if (respond) this.send({ type: 'response.create' });
  }

  private sendUserItem(content: LiveContentPart[]): void {
    this.send({ type: 'response.item.create', item: { type: 'message', role: 'user', content } });
  }

  sendAudio(pcm24k: Buffer): void {
    this.send({ type: 'session.input_audio.append', audio: pcm24k.toString('base64') });
  }

  /** Trusted instructions that take effect at once: a change in the call, a rule for now. */
  appendInstructions(text: string): void {
    this.sendAppend('session.instructions.append', text);
  }

  /** Context the voice knows from now on without saying it. */
  appendThinking(text: string): void {
    this.sendAppend('session.thinking.append', text);
  }

  /** Something for the voice to say now, in its own words. */
  appendCommentary(text: string): void {
    this.sendAppend('session.commentary.append', text);
  }

  private sendAppend(type: string, content: string): void {
    this.send({ type, event_id: `ctx_${++this.eventCounter}`, delegation_id: null, content });
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
