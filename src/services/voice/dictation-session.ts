/**
 * One dictation: the client's microphone in, the words it heard out, and nothing spoken back.
 *
 * A dictation is a Realtime session on the same managed endpoint and model voice chat uses,
 * and Lens Agents meters it there. Turn detection is off and no response is ever asked for,
 * so the only usage it produces is the transcription: the buffer holds everything the client
 * sent until the client commits it, and the one transcript of that one item is the result.
 *
 * It takes no part in `voiceSessionLock`. The agent speaks nothing in a dictation, so a
 * dictation on one socket runs while a voice chat or a meeting holds the agent's voice.
 *
 * Every method is safe in every state. The client streams from the moment the user presses,
 * which is before the upstream has answered, so audio and a commit that arrive while the
 * session is connecting wait for it, and a cancel ends it wherever it is.
 */

import WebSocket from 'ws';
import { logger } from '../../logger';
import { config } from '../../config';
import { trackEvent } from '../../lib/telemetry';
import {
  buildRealtimeSocketOptions,
  resolveRealtimeEndpoint,
  type RealtimeEndpoint,
} from '../meeting/openai-endpoint';
import { REALTIME_SAMPLE_RATE } from '../meeting/resampler';
import { isAudioFrameUsable, maxFrameBytes } from './socket-audio';

/**
 * Five minutes. Past it the session transcribes what it has, as if committed: by the audio
 * received, and by the clock, for a client that stops sending without letting go.
 */
const MAX_AUDIO_MS = 5 * 60_000;

/** How long the upstream has to open and accept the configuration. */
const CONNECT_TIMEOUT_MS = 10_000;

/** How long a committed buffer has to come back as a transcript. */
const RESULT_TIMEOUT_MS = 30_000;

/**
 * The shortest buffer the Realtime API commits. A shorter one is refused with an error, and
 * a press that short has no words in it, so the session answers an empty transcript itself.
 */
const MIN_COMMIT_MS = 100;

/** How the session answers the client that asked for it. */
export interface DictationSignal {
  /** The upstream accepted the session; audio the client sends now is transcribed. */
  ready(): void;
  /** Text of the transcript so far, in pieces, as the transcriber produces it. */
  delta(text: string): void;
  /** The whole transcript. Empty when the recording had no speech in it. */
  result(text: string): void;
  error(message: string): void;
}

export interface DictationSessionOptions {
  userId: string;
  signal: DictationSignal;
  /** Called once, when the session has ended by any path. */
  onEnd?: () => void;
  /** A local server in tests; the managed endpoint otherwise. */
  endpointOverride?: RealtimeEndpoint;
  /** The limits below are shortened by tests only. */
  maxAudioMs?: number;
  connectTimeoutMs?: number;
  resultTimeoutMs?: number;
}

/** How a dictation ended, as telemetry reports it. */
type DictationOutcome = 'transcribed' | 'empty' | 'cancelled' | 'failed' | 'disconnected';

type State = 'idle' | 'connecting' | 'recording' | 'transcribing' | 'ended';

const BYTES_PER_MS = (REALTIME_SAMPLE_RATE * 2) / 1000;

export class DictationSession {
  private state: State = 'idle';
  private ws: WebSocket | null = null;
  /** Frames the client sent before the upstream was ready, in order. */
  private readonly pending: string[] = [];
  private commitRequested = false;
  private audioBytes = 0;
  private transcript = '';
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  private readonly maxAudioMs: number;
  private readonly maxAudioBytes: number;
  private readonly maxFrame = maxFrameBytes(REALTIME_SAMPLE_RATE);

  constructor(private readonly options: DictationSessionOptions) {
    this.maxAudioMs = options.maxAudioMs ?? MAX_AUDIO_MS;
    this.maxAudioBytes = this.maxAudioMs * BYTES_PER_MS;
  }

  /**
   * Open the upstream and configure it. Answers `true` once the upstream is ready, and
   * `false` when the session ended first, having told the client why if it failed.
   */
  async start(): Promise<boolean> {
    if (this.state !== 'idle') return false;
    this.state = 'connecting';
    trackEvent('dictation started', this.options.userId, {});

    let endpoint: RealtimeEndpoint;
    try {
      endpoint = this.options.endpointOverride ?? resolveRealtimeEndpoint();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return false;
    }
    const socketOptions = await buildRealtimeSocketOptions(endpoint);
    if (this.state !== 'connecting') return false;

    const ws = new WebSocket(endpoint.url, socketOptions as WebSocket.ClientOptions);
    this.ws = ws;
    this.arm(this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, 'The transcriber did not answer in time.');

    const ready = new Promise<boolean>((resolve) => {
      ws.once('open', () => this.configure());
      ws.on('message', (data) => {
        const wasConnecting = this.state === 'connecting';
        this.handleEvent(data);
        if (wasConnecting && this.state !== 'connecting') resolve(this.state !== 'ended');
      });
      ws.on('error', (err) => {
        const status = /Unexpected server response: (\d{3})/.exec(err.message)?.[1];
        logger.warn({
          host: new URL(endpoint.url).host,
          provider: config.realtimeProvider,
          ...(status ? { status: Number(status) } : {}),
        }, '[Dictation] Realtime socket error');
      });
      ws.on('close', (code) => {
        if (this.state !== 'ended') {
          this.fail(`The transcriber closed the connection (code ${code}).`);
        }
        resolve(false);
      });
    });
    return ready;
  }

  /** One frame of the client's microphone, pcm16 mono at the Realtime rate. */
  pushAudio(pcm: Buffer): void {
    if (this.state !== 'connecting' && this.state !== 'recording') return;
    if (this.commitRequested) return;
    if (!isAudioFrameUsable(pcm, this.maxFrame)) return;
    this.audioBytes += pcm.length;
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
    // The cap stands in for the client's release, so a client that never lets go still
    // gets its words back rather than a session held open for as long as the socket.
    if (this.audioBytes >= this.maxAudioBytes) this.commit();
  }

  /** Transcribe everything recorded so far, then end. */
  commit(): void {
    if (this.state !== 'connecting' && this.state !== 'recording') return;
    if (this.commitRequested) return;
    this.commitRequested = true;
    if (this.audioBytes < MIN_COMMIT_MS * BYTES_PER_MS) {
      this.options.signal.result('');
      this.end('empty');
      return;
    }
    this.send({ type: 'input_audio_buffer.commit' });
    if (this.state === 'recording') this.beginTranscribing();
  }

  /** Drop the recording. Nothing is transcribed and nothing is sent back. */
  cancel(reason: 'cancelled' | 'disconnected' = 'cancelled'): void {
    if (this.state === 'ended') return;
    this.end(reason);
  }

  private configure(): void {
    this.ws?.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        // Text, never audio: nothing in a dictation is spoken, and no response is
        // requested, so this only keeps the session from preparing a voice.
        output_modalities: ['text'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE },
            // Off, so the buffer holds the whole recording until the client commits it.
            // A detector would split a dictation at every pause into items the client
            // never asked for, and answer each with a response.
            turn_detection: null,
            // No language: a dictation is one speaker for seconds, and the transcriber
            // detects the language the user speaks in.
            transcription: { model: config.openaiTranscriptionModel },
          },
        },
      },
    }));
  }

  private handleEvent(data: WebSocket.RawData): void {
    let event: { type?: string; [key: string]: unknown };
    try {
      event = JSON.parse(data.toString());
    } catch {
      logger.warn('[Dictation] Unparseable Realtime frame');
      return;
    }

    switch (event.type) {
      case 'session.updated':
        if (this.state === 'connecting') this.becomeReady();
        return;

      case 'conversation.item.input_audio_transcription.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (!delta) return;
        this.transcript += delta;
        this.options.signal.delta(delta);
        return;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const text = typeof event.transcript === 'string' ? event.transcript : this.transcript;
        const trimmed = text.trim();
        this.options.signal.result(trimmed);
        this.end(trimmed ? 'transcribed' : 'empty');
        return;
      }

      case 'conversation.item.input_audio_transcription.failed': {
        const err = event.error as { message?: string } | undefined;
        this.fail(err?.message ? `Transcription failed: ${err.message}` : 'Transcription failed.');
        return;
      }

      case 'error': {
        const err = event.error as { message?: string } | undefined;
        this.fail(err?.message ?? 'The transcriber reported an error.');
        return;
      }

      default:
        return;
    }
  }

  private becomeReady(): void {
    this.disarm();
    this.state = 'recording';
    // A client that already let go needs no confirmation that recording can start.
    if (!this.commitRequested) this.options.signal.ready();
    for (const frame of this.pending.splice(0)) this.ws?.send(frame);
    if (this.commitRequested) {
      this.beginTranscribing();
      return;
    }
    // The audio cap in `pushAudio` counts bytes, which a client that stopped sending never
    // reaches. The clock ends that recording too, instead of holding a Realtime session
    // for as long as the chat socket stays open.
    this.timer = setTimeout(() => this.commit(), this.maxAudioMs);
  }

  private beginTranscribing(): void {
    this.state = 'transcribing';
    this.arm(this.options.resultTimeoutMs ?? RESULT_TIMEOUT_MS, 'The transcript did not arrive in time.');
  }

  /** Send now when the upstream is ready, or queue it until it is. */
  private send(event: Record<string, unknown>): void {
    const frame = JSON.stringify(event);
    if (this.state === 'connecting') {
      this.pending.push(frame);
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  private arm(ms: number, message: string): void {
    this.disarm();
    this.timer = setTimeout(() => this.fail(message), ms);
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private fail(message: string): void {
    if (this.state === 'ended') return;
    logger.warn({ state: this.state }, '[Dictation] %s', message);
    this.options.signal.error(message);
    this.end('failed');
  }

  private end(outcome: DictationOutcome): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.disarm();
    this.pending.length = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
    trackEvent('dictation finished', this.options.userId, {
      status: outcome,
      audio_ms: String(Math.round(this.audioBytes / BYTES_PER_MS)),
      elapsed_ms: String(Date.now() - this.startedAt),
    });
    this.options.onEnd?.();
  }
}
