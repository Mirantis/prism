/**
 * The conversation itself: call audio in, agent speech out.
 *
 *     capture → Downsampler → LiveSession → Upsampler → AudioPlayback
 *                                  │
 *                             the agent's tools, run here for the backend
 *
 * The voice model takes its own turns: it decides when to speak, yields when somebody
 * talks over it and stays quiet while people talk to each other. So this file holds no
 * turn policy. It moves audio, runs the tools the backend calls, and tells the voice what
 * happened in the call that nobody said.
 *
 * The two resamplers are there for a transport that speaks 48 kHz, which a browser on a
 * virtual audio device does. A transport that already speaks the model's 24 kHz says so
 * in `sampleRate`, and both become identity.
 */

import { logger } from '../../logger';
import { config } from '../../config';
import { Downsampler, Upsampler, MEETING_SAMPLE_RATE, REALTIME_SAMPLE_RATE } from './resampler';
import { LiveSession, type LiveContentPart, type LiveSessionOptions } from '../voice/live-session';
import { AudioPlayback, type PlaybackSink } from './audio-playback';
import { formatTranscript } from './transcript-log';
import { inferenceGate } from '../../lib/inference-gate';
import type { SpeakerDetails, SpeakerReading } from './meeting-provider.interface';
import type { PreparedTools } from '../voice/realtime-tools';

/**
 * How long a speaker reading stays worth believing.
 *
 * The meters go still when nobody has spoken for a while, and a read then names nobody at
 * all. Holding the last name indefinitely would keep naming somebody who stopped talking a
 * minute ago. Six seconds is past the poll's lag and short of a conversational pause.
 */
const SPEAKER_FRESHNESS_MS = 6_000;

/** How long a side of the transcript may go quiet before its words are logged as a line. */
const TRANSCRIPT_LINE_GAP_MS = 1_500;

/** One window of a recording of the user's own screen: where it starts, and the pictures in it. */
export interface RecordingSegment {
  /** Where the window starts, the way the model is told it: `0:30`. */
  label: string;
  /** Pictures in the order they were taken, as data URIs. */
  images: string[];
}

export interface VoiceConversationOptions {
  /** Called when the backend has answered a request and has no tool call left in it. */
  onResponseFinished?: () => void;
  /** The voice model's instructions. */
  instructions: string;
  /** The backend's: the agent's own system prompt and how to work for the voice. */
  backendInstructions: string;
  tools: PreparedTools;
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
  /** The name the agent answers to, so the roster it is told leaves it out. */
  agentName: string;
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
  private delegations = 0;
  private toolCalls = 0;
  private backendInputTokens = 0;
  private backendOutputTokens = 0;
  private voiceSeconds: number | null = null;
  private closeReason: LiveCloseReason | null = null;
  /** The last speaker the platform showed, and when it was read. */
  private speaker: { reading: SpeakerReading; at: number } | null = null;
  /** The person the voice was told has the floor, so a steady speaker is told once. */
  private announcedSpeakerId: string | null = null;
  /** Who was speaking when the voice last handed a request to the backend. */
  private answering: SpeakerReading | null = null;
  /** Everyone else the room currently holds, agent excluded. Empty until the first read. */
  private rosterNames: string[] = [];
  private rosterSignature: string | null = null;
  /** Transcript fragments not yet logged, per side. */
  private readonly transcriptLines = {
    input: { text: '', timer: null as NodeJS.Timeout | null },
    output: { text: '', timer: null as NodeJS.Timeout | null },
  };
  private stopped = false;

  constructor(private readonly options: VoiceConversationOptions) {
    this.session = new LiveSession({
      instructions: options.instructions,
      backendInstructions: options.backendInstructions,
      tools: options.tools.declarations,
      voice: options.voice,
      endpointOverride: options.endpointOverride,
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

    this.session.on('delegation', () => {
      this.delegations += 1;
      // Pinned at the hand-off. Asked later, the meters would answer about whoever is
      // talking then, which during the answer is the agent itself.
      this.answering = this.currentSpeaker;
    });

    this.session.on('functionCall', (call) => {
      this.toolCalls += 1;
      // `execute` never throws: a failed tool becomes an error string the backend reads.
      void this.runTool(call.callId, call.name, call.argumentsJson);
    });

    this.session.on('backendUsage', (usage) => {
      this.backendInputTokens += usage.inputTokens;
      this.backendOutputTokens += usage.outputTokens;
    });

    // A response that called tools is followed by the one that uses their results, so
    // only a response without calls ends the backend's work on a request.
    this.session.on('backendAnswered', () => this.options.onResponseFinished?.());

    this.session.on('transcript', (side, delta) => this.logTranscript(side, delta));

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

  private async runTool(callId: string, name: string, argumentsJson: string): Promise<void> {
    // A secure takeover of the computer stops the runtime: nothing the backend asks for
    // runs until the user hands the computer back, and then it runs as asked.
    if (inferenceGate.held) logger.info(`[Voice] Holding ${name} — the computer is held for a secure sign-in`);
    await inferenceGate.wait();
    if (this.stopped) return;
    const output = await this.options.tools.execute(name, argumentsJson);
    if (this.stopped) return;
    this.session.sendFunctionOutput(callId, output);
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
    this.session.sendAudio(this.toModel(pcm));
  }

  /**
   * Tell the voice something that happened rather than was said — being admitted to the
   * call, a participant leaving, the microphone going off. It applies at once.
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
   * Show the backend a picture of a screen.
   *
   * Returns whether it was sent. A closed session takes nothing, and a tool that reported
   * success would have the agent describe a picture it never saw. During a tool call the
   * picture goes in after the call's result, which is what the backend reads next.
   */
  showImage(imageUrl: string, note: string): boolean {
    if (this.stopped || !this.session.isOpen) return false;
    this.session.showBackend(
      [
        { type: 'input_text', text: note },
        { type: 'input_image', image_url: imageUrl },
      ],
      false,
    );
    return true;
  }

  /**
   * Show the backend a recording of the user's own screen and have it answer.
   *
   * The pictures go in order, each window under its label. The user's words over them
   * reached the voice live, so the backend reads them in the conversation it already has.
   */
  showRecording(segments: RecordingSegment[], note: string): boolean {
    if (this.stopped || !this.session.isOpen) return false;
    const content: LiveContentPart[] = [{ type: 'input_text', text: note }];
    for (const segment of segments) {
      content.push({ type: 'input_text', text: `At ${segment.label}:` });
      for (const image of segment.images) content.push({ type: 'input_image', image_url: image });
    }
    this.session.showBackend(content, true);
    return true;
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

  /**
   * Report who the meeting platform last showed as speaking.
   *
   * `null` means "could not tell", which covers the panel not being open, nobody talking,
   * two people talking at once, and the read having failed. All of them leave the last
   * known speaker in place to age out rather than clearing it.
   *
   * A new person with the floor is passed to the voice as quiet context, so it can answer
   * people by name. The audio reaches it as one mixed channel with no names in it.
   */
  setCurrentSpeaker(reading: SpeakerReading | null): void {
    if (this.stopped || reading === null) return;
    this.speaker = { reading, at: Date.now() };
    if (reading.isSelf || reading.id === this.announcedSpeakerId) return;
    this.announcedSpeakerId = reading.id;
    this.session.appendThinking(speakingNote(reading.who));
  }

  /**
   * The human who currently has the floor, or null.
   *
   * Null for all three of "nobody has been identified", "the reading is too old to
   * believe" and "that was the agent's own voice".
   */
  get currentSpeaker(): SpeakerReading | null {
    if (this.speaker === null || Date.now() - this.speaker.at > SPEAKER_FRESHNESS_MS) return null;
    return this.speaker.reading.isSelf ? null : this.speaker.reading;
  }

  /** Who was speaking when the voice handed the current request to the backend. */
  get answeringSpeaker(): SpeakerReading | null {
    return this.answering;
  }

  /** The other people the platform last listed, agent excluded. Empty until the first read. */
  get roster(): readonly string[] {
    return this.rosterNames;
  }

  /**
   * Tell the voice who is in the call.
   *
   * Sorted before anything is derived from it: Meet reorders participant tiles by who is
   * speaking, so the same people arrive in a different order poll after poll, and only a
   * real change is passed on.
   */
  setParticipantNames(names: string[]): void {
    if (this.stopped) return;
    const others = names
      .filter((n) => n.toLowerCase() !== this.options.agentName.toLowerCase())
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    // A scrape that found nobody but the agent is a failed read, not an empty room: tiles
    // render late, and the grid drops off-screen participants. Leaving the call is the
    // count's job, from a reading with its own confirmation.
    if (others.length === 0) {
      logger.debug('[Meeting] Participant names came back empty — leaving the roster as it was');
      return;
    }

    const signature = others.join('\u0000');
    if (signature === this.rosterSignature) return;
    this.rosterSignature = signature;
    this.rosterNames = others;
    this.session.appendThinking(`The people in the call with you are now: ${others.join(', ')}.`);
    logger.info(`[Meeting] The voice now knows ${others.length} other name(s) in the call`);
  }

  get statistics(): VoiceConversationStats {
    return {
      delegations: this.delegations,
      toolCalls: this.toolCalls,
      backendInputTokens: this.backendInputTokens,
      backendOutputTokens: this.backendOutputTokens,
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
    this.flushTranscript('input');
    this.flushTranscript('output');
    this.playback.dispose();
    return this.session.close();
  }
}

/** Who has the floor: a person by name, or a room sharing one microphone by its members. */
function speakingNote(who: SpeakerDetails): string {
  if (who.kind === 'person') return `${who.name} is speaking now.`;
  return who.members.length > 0
    ? `Several people on one microphone are speaking now: ${who.members.join(', ')}.`
    : 'Several people on one microphone are speaking now.';
}

/** Whether a frame is digital silence, which is how the voice's stream carries a pause. */
function isSilent(pcm: Buffer): boolean {
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    if (pcm.readInt16LE(i) !== 0) return false;
  }
  return true;
}
