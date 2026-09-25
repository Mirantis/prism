/**
 * The conversation itself: call audio in, agent speech out.
 *
 *     capture → Downsampler → LiveSession → Upsampler → AudioPlayback
 *                                  │
 *                   delegations and transcript → VoiceBackend → the voice's context
 *
 * The voice model takes its own turns: it decides when to speak, yields when somebody
 * talks over it and stays quiet while people talk to each other. So this file holds no
 * turn policy. It moves audio, hands what the voice delegates to the backend, and tells
 * the voice what happened in the call that nobody said.
 *
 * The two resamplers are there for a transport that speaks 48 kHz, which a browser on a
 * virtual audio device does. A transport that already speaks the model's 24 kHz says so
 * in `sampleRate`, and both become identity.
 */

import { logger } from '../../logger';
import { config } from '../../config';
import { Downsampler, Upsampler, MEETING_SAMPLE_RATE, REALTIME_SAMPLE_RATE } from './resampler';
import { LiveSession, type LiveSessionOptions } from '../voice/live-session';
import { AudioPlayback, type PlaybackSink } from './audio-playback';
import { formatTranscript } from './transcript-log';
import { VoiceBackend, type VoiceBackendOptions } from '../voice/voice-backend';
import type { RecordingSegment } from '../voice/screen-recording';

/** How long a side of the transcript may go quiet before its words are logged as a line. */
const TRANSCRIPT_LINE_GAP_MS = 1_500;

export interface VoiceConversationOptions {
  /** The voice model's instructions. */
  instructions: string;
  /** Who the work behind the voice runs for, and the session's backend rules. */
  backend: Omit<VoiceBackendOptions, 'output'>;
  /** Written with pcm16 at `sampleRate` — `pacat`'s stdin in production. */
  sink: PlaybackSink;
  /**
   * The rate the transport speaks, in and out.
   *
   * `REALTIME_SAMPLE_RATE` means the transport already speaks the model's own rate, so
   * both resamplers are skipped. Only those two values exist: the resampler is a fixed
   * 2:1 decimation, and silently accepting another rate would change pitch rather than
   * fail. Stated rather than defaulted, because a default is right for one transport and
   * audibly wrong for the other.
   */
  sampleRate: number;
  voice?: string;
  endpointOverride?: LiveSessionOptions['endpointOverride'];
  /**
   * The session died on its own — the agent has no voice and no ears any more.
   *
   * Only fired for a close we did not ask for. The owner is expected to end the call.
   */
  onSessionLost?: (reason: string) => void;
}

/** Counters the owner reports as telemetry when the call ends. */
export interface VoiceConversationStats {
  /** Requests the voice handed to the backend. */
  delegations: number;
  toolCalls: number;
  backendInputTokens: number;
  backendOutputTokens: number;
  /** Voice time the API billed, from its own usage report. Null when it never sent one. */
  voiceSeconds: number | null;
  /** Why the API ended the session (`expired`, `content`, …), when it said. */
  closeReason: LiveCloseReason | null;
}

/** The reasons the API gives in `session.closed`. */
const LIVE_CLOSE_REASONS = ['close_requested', 'expired', 'content', 'remote_hangup', 'connection_lost'] as const;
export type LiveCloseReason = (typeof LIVE_CLOSE_REASONS)[number];

export class VoiceConversation {
  private readonly session: LiveSession;
  private readonly playback: AudioPlayback;
  private readonly downsampler = new Downsampler();
  private readonly upsampler = new Upsampler();
  /** Identity when the transport already speaks the model's rate. */
  private readonly toModel: (pcm: Buffer) => Buffer;
  private readonly fromModel: (pcm: Buffer) => Buffer;
  private readonly backend: VoiceBackend;
  private voiceSeconds: number | null = null;
  private closeReason: LiveCloseReason | null = null;
  /** Transcript fragments not yet logged, per side. */
  private readonly transcriptLines = {
    input: { text: '', timer: null as NodeJS.Timeout | null },
    output: { text: '', timer: null as NodeJS.Timeout | null },
  };
  private stopped = false;

  constructor(private readonly options: VoiceConversationOptions) {
    this.session = new LiveSession({
      instructions: options.instructions,
      voice: options.voice,
      endpointOverride: options.endpointOverride,
    });
    this.backend = new VoiceBackend({
      ...options.backend,
      output: {
        commentary: (text, id) => {
          if (!this.stopped) this.session.appendCommentary(text, id);
        },
        thinking: (text, id) => {
          if (!this.stopped) this.session.appendThinking(text, id);
        },
      },
    });

    const rate = options.sampleRate;
    if (rate !== MEETING_SAMPLE_RATE && rate !== REALTIME_SAMPLE_RATE) {
      throw new Error(
        `A voice conversation speaks ${MEETING_SAMPLE_RATE} or ${REALTIME_SAMPLE_RATE} Hz, not ${rate}`,
      );
    }
    const passthrough = rate === REALTIME_SAMPLE_RATE;
    this.toModel = passthrough ? (pcm) => pcm : (pcm) => this.downsampler.process(pcm);
    this.fromModel = passthrough ? (pcm) => pcm : (pcm) => this.upsampler.process(pcm);
    this.playback = new AudioPlayback(options.sink, rate);

    this.wireSession();
  }

  private wireSession(): void {
    // The stream carries the voice's silence too. Digital silence is dropped here, so
    // playback runs only while the voice is speaking and a quiet call writes nothing.
    this.session.on('audio', (pcm24k) => {
      if (isSilent(pcm24k)) return;
      this.playback.enqueue(this.fromModel(pcm24k));
    });

    this.session.on('delegation', (id, offsetMs) => this.backend.delegate(id, offsetMs));

    this.session.on('transcript', (side, delta, startMs) => {
      this.backend.hear(side, delta, startMs);
      this.logTranscript(side, delta);
    });

    this.session.on('apiError', (message) => {
      logger.warn(`[Voice] Live API reported: ${message}`);
    });

    this.session.on('closed', (reason, voiceSeconds) => {
      if (voiceSeconds !== null) this.voiceSeconds = voiceSeconds;
      if ((LIVE_CLOSE_REASONS as readonly string[]).includes(reason)) this.closeReason = reason as LiveCloseReason;
      logger.info(`[Voice] Live session closed: ${reason}`);
      // A close we didn't ask for is the end of the agent's participation: no audio
      // reaches the call and none of the call's audio reaches a model.
      if (!this.stopped) this.options.onSessionLost?.(reason);
    });
  }

  /**
   * Collect transcript fragments into lines, and log a line once its side goes quiet.
   *
   * Only when `MEETING_TRANSCRIPT_LOGGING` is `full`; otherwise nothing is held.
   */
  private logTranscript(side: 'input' | 'output', delta: string): void {
    if (config.meetingTranscriptLogging !== 'full') return;
    const line = this.transcriptLines[side];
    line.text += delta;
    if (line.timer) clearTimeout(line.timer);
    line.timer = setTimeout(() => this.flushTranscript(side), TRANSCRIPT_LINE_GAP_MS);
    line.timer.unref?.();
  }

  private flushTranscript(side: 'input' | 'output'): void {
    const line = this.transcriptLines[side];
    if (line.timer) clearTimeout(line.timer);
    line.timer = null;
    const text = line.text.trim();
    line.text = '';
    if (text === '') return;
    logger.info(`[Voice:${side === 'input' ? 'Heard' : 'Said'}] ${formatTranscript(text)}`);
  }

  /** Open the session. Throws if the connection or auth fails. */
  async start(): Promise<void> {
    await this.session.connect();
  }

  /** Feed captured audio (pcm16 mono, at the configured rate) to the model. */
  pushAudio(pcm: Buffer): void {
    if (this.stopped || !this.session.isOpen) return;
    // A capture chunk shorter than the downsampler's window yields no samples yet, and
    // the API refuses an empty append.
    const audio = this.toModel(pcm);
    if (audio.length > 0) this.session.sendAudio(audio);
  }

  /**
   * Tell the voice something that happened rather than was said — the call app opening
   * the microphone, or letting it go. It applies at once.
   */
  notify(text: string): void {
    if (this.stopped) return;
    this.session.appendInstructions(text);
  }

  /** Have the voice speak now, about `text`, in its own words — a greeting, a hand-back. */
  prompt(text: string): void {
    if (this.stopped) return;
    this.session.appendCommentary(text);
  }

  /**
   * Have the backend look at a recording of the user's own screen and answer.
   *
   * The pictures go in order, labelled by the window they fall in. The user's words over
   * them are in the transcript, which the backend reads with the request.
   */
  showRecording(segments: RecordingSegment[], note: string): boolean {
    if (this.stopped || !this.session.isOpen) return false;
    const images = segments.flatMap((segment) => segment.images.map(toImage));
    const windows = segments.map((segment) => `${segment.label} (${segment.images.length})`).join(', ');
    this.backend.ask(`${note} The pictures start at, in order: ${windows}.`, images);
    return true;
  }

  /** Have the backend do something the runtime asks for, and the voice say the result. */
  ask(request: string): void {
    if (this.stopped) return;
    this.backend.ask(request);
  }

  /**
   * Drop the speech that has not been heard yet, here and in the client.
   *
   * The voice itself cannot be stopped mid-sentence, so what it is still producing plays
   * on; the caller tells it to be quiet as well.
   */
  stopSpeaking(): void {
    if (this.stopped) return;
    this.playback.flush();
  }

  get statistics(): VoiceConversationStats {
    return {
      ...this.backend.statistics,
      voiceSeconds: this.voiceSeconds,
      closeReason: this.closeReason,
    };
  }

  /**
   * Tear down the session and the playback timer. Resolves once the API has reported the
   * call's final usage, so `statistics` read after it is complete.
   */
  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    this.backend.stopAll();
    this.flushTranscript('input');
    this.flushTranscript('output');
    this.playback.dispose();
    return this.session.close();
  }
}

/** A data URI as an image part: `data:image/jpeg;base64,…`. */
function toImage(dataUri: string): { data: string; mediaType: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUri);
  return match ? { mediaType: match[1], data: match[2] } : { mediaType: 'image/jpeg', data: dataUri };
}

/** Whether a frame is digital silence, which is how the voice's stream carries a pause. */
function isSilent(pcm: Buffer): boolean {
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    if (pcm.readInt16LE(i) !== 0) return false;
  }
  return true;
}
