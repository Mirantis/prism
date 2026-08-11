/**
 * The conversation itself: meeting audio in, agent speech out.
 *
 * Wires the five collaborators into one loop and owns nothing else — the browser,
 * the audio devices and the meeting's lifecycle all belong to the service above:
 *
 *     capture (48k) → Downsampler → RealtimeSession → Upsampler → AudioPlayback
 *                                        │
 *                                   BargeInPolicy (yields the floor to humans)
 *                                        │
 *                                   ToolBridge (runs the agent's real tools)
 *
 * The one subtlety is the ordering between a new utterance and a pending pause.
 * When the model starts speaking again while a barge-in pause is still undecided,
 * the stale audio has to be dropped *before* the new audio queues, or the two get
 * spliced into one garbled utterance. Hence `commitIfPending()` ahead of the
 * enqueue rather than after.
 */

import { logger } from '../../logger';
import { Downsampler, Upsampler } from './resampler';
import { RealtimeSession, type RealtimeSessionOptions } from './realtime-session';
import { AudioPlayback, type PlaybackSink } from './audio-playback';
import { BargeInPolicy } from './barge-in';
import { isAddressedToAgent } from './addressed-detection';
import type { PreparedMeetingTools } from './tool-bridge';

export interface VoiceConversationOptions {
  instructions: string;
  tools: PreparedMeetingTools;
  /** Written with 48 kHz pcm16 — `pacat`'s stdin in production. */
  sink: PlaybackSink;
  /** Decides who is being addressed locally; see addressed-detection.ts. */
  addressedOnly?: boolean;
  /** Needed by addressed-only mode to recognize its own name. */
  agentName: string;
  model?: string;
  voice?: string;
  endpointOverride?: RealtimeSessionOptions['endpointOverride'];
  /**
   * The session died on its own — the agent has no voice and no ears any more.
   *
   * Only fired for a close we did not ask for: `stop()` sets `stopped` before it
   * closes the socket, so a teardown-initiated close is already distinguishable.
   * The owner is expected to end the call, because everything that makes the bot a
   * participant is gone while the browser is still sitting in the room.
   */
  onSessionLost?: (reason: string) => void;
}

/** Counters the service reports as telemetry when the meeting ends. */
export interface VoiceConversationStats {
  responses: number;
  toolCalls: number;
  interruptions: number;
}

export class VoiceConversation {
  private readonly session: RealtimeSession;
  private readonly playback: AudioPlayback;
  private readonly bargeIn: BargeInPolicy;
  private readonly downsampler = new Downsampler();
  private readonly upsampler = new Upsampler();
  private readonly stats: VoiceConversationStats = {
    responses: 0,
    toolCalls: 0,
    interruptions: 0,
  };
  private currentItemId: string | null = null;
  private stopped = false;

  constructor(private readonly options: VoiceConversationOptions) {
    this.session = new RealtimeSession({
      instructions: options.instructions,
      tools: options.tools.declarations,
      addressedOnly: options.addressedOnly,
      model: options.model,
      voice: options.voice,
      endpointOverride: options.endpointOverride,
    });

    this.playback = new AudioPlayback(options.sink);

    this.bargeIn = new BargeInPolicy({
      pausePlayback: () => this.playback.pause(),
      resumePlayback: () => this.playback.resume(),
      isSpeaking: () => this.playback.isSpeaking,
      commitInterrupt: () => {
        // Drop what hasn't been heard, then tell the model exactly how far each
        // item actually got — otherwise its context claims words the room never
        // heard. A turn can hold several audio items (a native preamble, then the
        // answer), so every one of them is reported.
        const items = this.playback.flush();
        this.session.interrupt(items);
        this.stats.interruptions += 1;
        const heard = items.reduce((n, i) => n + i.playedMs, 0);
        logger.info(
          `[Meeting] Yielded the floor after ${Math.round(heard)}ms of speech ` +
            `across ${items.length} item(s)`,
        );
      },
    });

    this.wireSession();
  }

  private wireSession(): void {
    this.session.on('audio', (pcm24k, itemId) => {
      if (itemId && itemId !== this.currentItemId) {
        // A new utterance begins: settle any undecided pause first so stale
        // audio can't be spliced onto the front of the new one.
        this.bargeIn.commitIfPending();
        this.bargeIn.onUtteranceStarted();
        this.currentItemId = itemId;
      }
      this.playback.enqueue(this.upsampler.process(pcm24k), itemId);
    });

    this.session.on('speechStarted', () => this.bargeIn.onSpeechStarted());
    this.session.on('speechStopped', () => this.bargeIn.onSpeechStopped());

    this.session.on('responseDone', () => {
      this.stats.responses += 1;
    });

    this.session.on('functionCall', (call) => {
      this.stats.toolCalls += 1;
      void this.runTool(call.callId, call.name, call.argumentsJson);
    });

    // Addressed-only mode: the model never answers on its own, so a finished
    // utterance is examined here and a response is requested only when the bot
    // was the intended audience.
    if (this.options.addressedOnly) {
      this.session.on('transcript', (text) => {
        if (isAddressedToAgent(text, this.options.agentName)) {
          logger.info('[Meeting] Addressed directly — responding');
          this.session.requestResponse();
        }
      });
    }

    this.session.on('apiError', (message) => {
      logger.warn(`[Meeting] Realtime API reported: ${message}`);
    });

    this.session.on('closed', (reason) => {
      logger.info(`[Meeting] Realtime session closed: ${reason}`);
      // A close we didn't ask for is the end of the agent's participation: no
      // audio reaches the room and none of the room's audio reaches a model. The
      // browser is still in the call, so without this the bot lingers as a silent
      // tile until the empty-room poll or the duration cap notices.
      if (!this.stopped) this.options.onSessionLost?.(reason);
    });
  }

  private async runTool(callId: string, name: string, argumentsJson: string): Promise<void> {
    const output = await this.options.tools.execute(name, argumentsJson);
    if (this.stopped) return;
    this.session.sendFunctionOutput(callId, output);
  }

  /** Open the Realtime session. Throws if the connection or auth fails. */
  async start(): Promise<void> {
    await this.session.connect();
  }

  /** Feed captured meeting audio (48 kHz pcm16 mono) to the model. */
  pushMeetingAudio(pcm48k: Buffer): void {
    if (this.stopped || !this.session.isOpen) return;
    this.session.sendAudio(this.downsampler.process(pcm48k));
  }

  /**
   * Tell the model something that happened rather than was said — being admitted
   * to the call, a participant leaving, the meeting winding down.
   */
  notify(text: string): void {
    if (this.stopped) return;
    this.session.sendContext(text);
  }

  /** Ask the model to speak now (used to greet the room on admission). */
  speakNow(): void {
    if (this.stopped) return;
    this.session.requestResponse();
  }

  get statistics(): VoiceConversationStats {
    return { ...this.stats };
  }

  /** Tear down the session, playback timer and pending barge-in timer. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.bargeIn.dispose();
    this.playback.dispose();
    this.session.close();
  }
}
