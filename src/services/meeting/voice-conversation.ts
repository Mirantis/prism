/**
 * The conversation itself: meeting audio in, agent speech out.
 *
 * Wires the five collaborators into one loop and owns nothing else — the browser,
 * the audio devices and the meeting's lifecycle all belong to the service above:
 *
 *     capture (48k) → Downsampler → RealtimeSession → Upsampler → AudioPlayback
 *                                        │
 *                                   ResponsePolicy (decides whether to answer)
 *                                        │
 *                                   BargeInPolicy (yields the floor to humans)
 *                                        │
 *                                   ToolBridge (runs the agent's real tools)
 *
 * Every response on this session is one asked for here: the server is configured
 * never to answer on its own, so an utterance becomes speech only if
 * `ResponsePolicy` says it was aimed at the agent.
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
import { ResponsePolicy, type EffectiveMode, type ResponseMode } from './response-policy';
import { classifyAddressed, CLASSIFY_DEADLINE_MS } from './addressed-classifier';

/**
 * How much of a partial transcript is worth judging.
 *
 * Long enough that a name isn't cut in half — a verdict on "Pri" is worthless —
 * and short enough to still beat the finished transcript by a useful margin.
 */
const EARLY_VERDICT_MIN_CHARS = 12;

/** Utterances remembered as early-judged. Insertion-ordered, oldest evicted. */
const EARLY_JUDGED_LIMIT = 32;
import type { PreparedMeetingTools } from './tool-bridge';

export interface VoiceConversationOptions {
  instructions: string;
  tools: PreparedMeetingTools;
  /** Written with 48 kHz pcm16 — `pacat`'s stdin in production. */
  sink: PlaybackSink;
  /** `auto` follows the participant count; see response-policy.ts. */
  responseMode: ResponseMode;
  /** The name the agent answers to — the same one the room hears it introduce. */
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
  /** Utterances the room produced, and how they were handled. */
  utterances: number;
  suppressed: number;
  addressedMatches: number;
  modeSwitches: number;
}

export class VoiceConversation {
  private readonly session: RealtimeSession;
  private readonly playback: AudioPlayback;
  private readonly bargeIn: BargeInPolicy;
  private readonly responsePolicy: ResponsePolicy;
  private readonly downsampler = new Downsampler();
  private readonly upsampler = new Upsampler();
  private responses = 0;
  private toolCalls = 0;
  private interruptions = 0;
  private currentItemId: string | null = null;
  /**
   * Utterances already judged from a partial transcript, so it happens once.
   *
   * Bounded rather than cleared purely on the `transcript` event: a transcription
   * that fails, or one that trims to empty, never emits that event, so its id would
   * otherwise sit here for the rest of the call. A stale id can only ever suppress a
   * *second* early judgement of the same utterance, so evicting the oldest is safe.
   */
  private readonly earlyJudged = new Set<string>();
  private stopped = false;

  constructor(private readonly options: VoiceConversationOptions) {
    this.session = new RealtimeSession({
      instructions: options.instructions,
      tools: options.tools.declarations,
      model: options.model,
      voice: options.voice,
      endpointOverride: options.endpointOverride,
    });

    this.responsePolicy = new ResponsePolicy({ mode: options.responseMode });

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
        this.interruptions += 1;
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
      this.responses += 1;
    });

    this.session.on('functionCall', (call) => {
      this.toolCalls += 1;
      void this.runTool(call.callId, call.name, call.argumentsJson);
    });

    // The model never answers on its own, so every utterance passes the policy.
    // Two chances to say yes, and the policy makes sure only one of them fires
    // per utterance: at the turn boundary, which needs no words and so costs
    // nothing in a one-to-one call, and again once the transcript lands, which is
    // the only way to tell whether a crowded room meant the agent.
    this.session.on('utteranceCommitted', (itemId) => {
      if (this.responsePolicy.onUtteranceCommitted(itemId)) this.session.requestResponse();
    });

    // Judged twice, and on purpose. People put a name at the start of a sentence,
    // so a partial transcript usually settles the question several hundred
    // milliseconds before the finished one arrives — and those milliseconds sit
    // between someone finishing a sentence and the agent starting to answer. An
    // early *yes* therefore answers immediately; an early *no* is not trusted,
    // because the rest of the sentence is still coming, so the finished transcript
    // is judged again. The policy's per-item dedupe makes the overlap safe.
    this.session.on('transcriptPartial', (itemId, textSoFar) => {
      if (textSoFar.trim().length < EARLY_VERDICT_MIN_CHARS) return;
      if (this.earlyJudged.has(itemId)) return;
      if (this.responsePolicy.onTranscript(itemId) !== 'classify') return;
      this.earlyJudged.add(itemId);
      if (this.earlyJudged.size > EARLY_JUDGED_LIMIT) {
        this.earlyJudged.delete(this.earlyJudged.values().next().value as string);
      }
      void this.classifyThenMaybeRespond(itemId, textSoFar, 'partial');
    });

    this.session.on('transcript', (itemId, text) => {
      this.earlyJudged.delete(itemId);
      const decision = this.responsePolicy.onTranscript(itemId);
      if (decision === 'respond') {
        this.session.requestResponse();
        return;
      }
      if (decision === 'classify') void this.classifyThenMaybeRespond(itemId, text, 'final');
    });

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

  /**
   * Ask the model whether an unnamed utterance was aimed at the agent.
   *
   * Deferred rather than awaited inline because the whole point of the lexical
   * test is that the common cases never get this far. A verdict that arrives too
   * late is dropped: the room has moved on, and answering a question everyone has
   * stopped caring about is worse in a meeting than having missed it.
   */
  private async classifyThenMaybeRespond(
    itemId: string,
    transcript: string,
    stage: 'partial' | 'final',
  ): Promise<void> {
    const asked = Date.now();
    const addressed = await classifyAddressed({
      transcript,
      agentName: this.options.agentName,
      stage,
    });

    if (this.stopped) return;

    if (Date.now() - asked > CLASSIFY_DEADLINE_MS) {
      logger.info('[Meeting] Dropped a late verdict — the room has moved on');
      return;
    }

    if (this.responsePolicy.resolveClassification(itemId, addressed, stage)) {
      this.session.requestResponse();
    }
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

  /**
   * Report how many people are in the room, the agent included.
   *
   * Drives `auto` mode: one human means everything said is said to the agent,
   * more than one means it waits to be addressed. `null` (the count couldn't be
   * read) leaves the current behaviour alone.
   */
  setParticipantCount(count: number | null): void {
    if (this.stopped) return;
    this.responsePolicy.setParticipantCount(count);
  }

  /** What the policy is doing right now — reported by `meeting_status`. */
  get responseMode(): EffectiveMode {
    return this.responsePolicy.effectiveMode;
  }

  get statistics(): VoiceConversationStats {
    const policy = this.responsePolicy.statistics;
    return {
      responses: this.responses,
      toolCalls: this.toolCalls,
      interruptions: this.interruptions,
      utterances: policy.utterances,
      suppressed: policy.suppressed,
      addressedMatches: policy.addressedMatches,
      modeSwitches: policy.modeSwitches,
    };
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
