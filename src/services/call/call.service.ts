/**
 * Owns the agent's voice in a call on its computer, start to finish.
 *
 * The call runs in an app on the computer's desktop, which the agent joined with the
 * computer tools. Every program on that desktop plays into one virtual speaker and records
 * from one virtual microphone, so this service needs nothing from the app: it hears the
 * speaker, speaks into the microphone, and reads which program records that microphone.
 * The same path serves a web meeting in the browser and an installed client.
 *
 * One call per runtime, and never at the same time as a voice chat: both take
 * `voiceSessionLock`, held for exactly as long as this service is not `idle`.
 *
 * Nothing about a call is persisted: no transcript, no thread message, no tool-call row.
 */

import { logger } from '../../logger';
import { config } from '../../config';
import { trackEvent } from '../../lib/telemetry';
import { VoiceConversation } from '../meeting/voice-conversation';
import { MEETING_SAMPLE_RATE } from '../meeting/resampler';
import { buildVoiceInstructions } from '../voice/voice-instructions';
import { voiceSessionLock } from '../voice/voice-session-lock';
import { computerService } from '../computer/computer.service';
import { computerHelpService } from '../computer/computer-help.service';
import { isSilent, type CallAudio } from '../computer/agent-computer';

/** How long `join_call` waits for the call app to open the microphone. */
const MIC_WAIT_MS = 5_000;
/** How often the microphone is read during a call. */
const MIC_POLL_MS = 10_000;
/**
 * A call app lets go of the microphone when it leaves a call, and keeps it while muted.
 * Released and silent this long, the call is over.
 */
const HANG_UP_MS = 60_000;
/** Silent this long with the microphone never opened, nobody is in a call. */
const NEVER_JOINED_MS = 15 * 60_000;

/** What the prompts call the app when no program records the microphone yet. */
const UNKNOWN_APP = 'the call app';

/** How a call ended, as reported in telemetry. */
export type CallEndStatus = 'completed' | 'hung_up' | 'timeout' | 'error';

export interface JoinCallInput {
  userId: string;
  agentId: string;
}

export interface JoinCallResult {
  success: boolean;
  /** Whether the call app is recording the agent's microphone, so the call can hear it. */
  micCaptured: boolean;
  /** The program recording that microphone. */
  app: string | null;
  message: string;
}

class CallService {
  private state: 'idle' | 'starting' | 'live' | 'ending' = 'idle';
  /** Bumped by every ending, so a late event from a call that is over cannot act. */
  private epoch = 0;
  private conversation: VoiceConversation | null = null;
  private app: string | null = null;
  private userId: string | null = null;
  private startedAt: number | null = null;
  /** Unsubscribes from the computer's audio, and clears the timers. */
  private release: (() => void) | null = null;

  /** Whether a call is running or starting, for a caller that must not interrupt one. */
  get isActive(): boolean {
    return this.state !== 'idle';
  }

  async join(input: JoinCallInput): Promise<JoinCallResult> {
    if (!voiceSessionLock.tryAcquire('call')) {
      if (this.state === 'ending') return refusal('The last call is still ending. Try again in a moment.');
      return refusal(
        voiceSessionLock.holder === 'call'
          ? 'You are already in a call. Leave it first.'
          : 'A voice chat is running. It has to end before you can speak in a call.',
      );
    }

    this.state = 'starting';
    const epoch = ++this.epoch;
    let stage: 'computer' | 'session' = 'computer';
    let conversation: VoiceConversation | null = null;
    const offs: Array<() => void> = [];
    const releaseLocals = async (): Promise<void> => {
      for (const off of offs) off();
      await conversation?.stop().catch((err: unknown) => {
        logger.warn({ err }, '[Call] The conversation would not stop');
      });
      // A start cancelled by `leave()` was ended already, and a newer call may hold the
      // voice by now, so its help requests are not this start's to clear.
      if (this.epoch === epoch) computerHelpService.endVoiceSession();
    };

    try {
      const computer = await computerService.open();
      const audio = computer.callAudio;
      if (!audio) throw new Error('The computer has no audio');

      const loss: { reason: string | null } = { reason: null };
      offs.push(
        audio.onLost((reason) => {
          loss.reason = reason;
          if (this.epoch === epoch && this.state === 'live') void this.end(epoch, 'error', `audio lost: ${reason}`);
        }),
      );
      // Checked again after each long await: the stack can die while the call starts.
      const assertAudio = () => {
        if (loss.reason) throw new Error(`The computer's audio has stopped: ${loss.reason}`);
      };
      assertAudio();

      const micCaptured = await audio.waitForMicCapture(MIC_WAIT_MS);
      const app = micCaptured ? await audio.micClient() : null;

      stage = 'session';
      const { instructions, sessionInstructions } = await buildVoiceInstructions({
        userId: input.userId,
        agentId: input.agentId,
        call: { kind: 'call', app: app ?? UNKNOWN_APP, desktop: { width: computer.width, height: computer.height } },
      });

      // A `leave()` or a shutdown during the awaits above ended this call before it began,
      // and a voice session opened now would be billed for nothing.
      if (this.epoch !== epoch) {
        await releaseLocals();
        return refusal('The call was ended while it was starting.');
      }
      assertAudio();

      conversation = new VoiceConversation({
        instructions,
        backend: { userId: input.userId, agentId: input.agentId, sessionInstructions, computer: true },
        sink: audio.playbackSink,
        sampleRate: MEETING_SAMPLE_RATE,
        voice: config.openaiRealtimeVoice,
        onSessionLost: (reason) => void this.end(epoch, 'error', reason),
      });
      await conversation.start();

      if (this.epoch !== epoch) {
        await releaseLocals();
        return refusal('The call was ended while it was starting.');
      }
      assertAudio();

      const live = conversation;
      const watch = this.watch(epoch, audio, live, micCaptured);
      offs.push(watch);
      this.conversation = live;
      this.app = app;
      this.userId = input.userId;
      this.startedAt = Date.now();
      this.release = () => {
        for (const off of offs) off();
      };
      this.state = 'live';

      // Told rather than prompted: the call app may still be in a lobby, where a greeting
      // reaches nobody. The voice greets once it hears the call.
      live.notify(micCaptured ? JOINED_NOTE : MIC_CLOSED_NOTE);

      logger.info({ app, micCaptured }, '[Call] Voice is live');
      trackEvent('call started', input.userId, {
        inference_provider: config.realtimeProvider ?? 'unknown',
        inference_source: config.realtimeSource,
        app: app ?? 'unknown',
        mic_captured: String(micCaptured),
      });
      return {
        success: true,
        micCaptured,
        app,
        message: micCaptured
          ? `Your voice is in the call in ${app ?? UNKNOWN_APP}.`
          : 'Your voice is connected, but no app is using your microphone yet, so nobody hears you. ' +
            'Unmute in the call app, or choose PrismMicrophone as its microphone.',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, '[Call] Failed to start the voice');
      await releaseLocals();
      if (this.epoch === epoch) {
        this.clearPublished();
        this.markIdle();
      }
      trackEvent('call start failed', input.userId, {
        inference_provider: config.realtimeProvider ?? 'unknown',
        inference_source: config.realtimeSource,
        stage,
      });
      return refusal(`Could not connect your voice to the call: ${message}`);
    }
  }

  async leave(): Promise<{ success: boolean; message: string }> {
    if (this.state === 'idle' || this.state === 'ending') {
      return { success: true, message: 'You are not in a call.' };
    }
    await this.end(this.epoch, 'completed', 'the agent left');
    return { success: true, message: 'Your voice has left the call.' };
  }

  /** The user finished a computer help request the call raised: have the agent look and carry on. */
  continueComputer(reason: string): void {
    this.conversation?.ask(
      `Your user finished helping on the computer. The help request was: ${JSON.stringify(reason)}. ` +
        'Look at the screen and carry on with what the call asked for.',
    );
  }

  /** Called from the process shutdown path, before the computer closes. */
  async shutdown(): Promise<void> {
    if (this.state === 'idle') return;
    logger.info('[Call] Shutting down — ending the call');
    await this.end(this.epoch, 'completed', 'the runtime is shutting down');
  }

  /**
   * Feed the call to the voice, and watch for the call to end: the microphone released
   * and nothing heard for `HANG_UP_MS`, a desktop that stays silent with no call on it,
   * and the duration cap. Returns what stops the watching.
   */
  private watch(epoch: number, audio: CallAudio, conversation: VoiceConversation, micAtStart: boolean): () => void {
    const startedAt = Date.now();
    let lastSoundAt = startedAt;
    let micCaptured = micAtStart;
    let everCaptured = micAtStart;
    let releasedAt: number | null = null;

    const offCapture = audio.onCapture((pcm) => {
      if (!isSilent(pcm)) lastSoundAt = Date.now();
      conversation.pushAudio(pcm);
    });

    const poll = setInterval(() => {
      void (async () => {
        const captured = await audio.isMicCaptured();
        if (this.epoch !== epoch || this.state !== 'live') return;
        const now = Date.now();

        if (captured !== micCaptured) {
          micCaptured = captured;
          releasedAt = captured ? null : now;
          everCaptured ||= captured;
          conversation.notify(captured ? MIC_OPEN_NOTE : MIC_CLOSED_NOTE);
          logger.info({ captured }, '[Call] The microphone changed');
        }

        const quietFor = now - lastSoundAt;
        if (releasedAt !== null && now - releasedAt >= HANG_UP_MS && quietFor >= HANG_UP_MS) {
          void this.end(epoch, 'hung_up', 'the call app let go of the microphone');
        } else if (!everCaptured && quietFor >= NEVER_JOINED_MS) {
          void this.end(epoch, 'hung_up', 'no call app used the microphone');
        }
      })().catch((err: unknown) => logger.debug({ err }, '[Call] Microphone poll failed'));
    }, MIC_POLL_MS);

    const cap = setTimeout(() => {
      if (this.epoch === epoch) void this.end(epoch, 'timeout', 'the call reached its time limit');
    }, config.meetingTimeoutMinutes * 60_000);

    return () => {
      offCapture();
      clearInterval(poll);
      clearTimeout(cap);
    };
  }

  /** The one ending, for every way a call ends. */
  private async end(epoch: number, status: CallEndStatus, reason: string): Promise<void> {
    if (epoch !== this.epoch || this.state === 'idle' || this.state === 'ending') return;

    this.state = 'ending';
    this.epoch += 1;
    const { conversation, app, userId, startedAt, release } = this;
    this.clearPublished();
    logger.info({ status, reason }, '[Call] Voice left the call');

    try {
      release?.();
      await conversation?.stop();
      computerHelpService.endVoiceSession();
      if (userId && startedAt) {
        const stats = conversation?.statistics;
        trackEvent('call ended', userId, {
          inference_provider: config.realtimeProvider ?? 'unknown',
          inference_source: config.realtimeSource,
          status,
          app: app ?? 'unknown',
          duration_ms: String(Date.now() - startedAt),
          delegations: String(stats?.delegations ?? 0),
          tool_calls: String(stats?.toolCalls ?? 0),
          backend_input_tokens: String(stats?.backendInputTokens ?? 0),
          backend_output_tokens: String(stats?.backendOutputTokens ?? 0),
          ...(stats?.voiceSeconds != null ? { voice_seconds: String(stats.voiceSeconds) } : {}),
          ...(stats?.closeReason ? { close_reason: stats.closeReason } : {}),
        });
      }
    } catch (err) {
      logger.warn({ err }, '[Call] Teardown failed');
    } finally {
      this.markIdle();
    }
  }

  private clearPublished(): void {
    this.conversation = null;
    this.app = null;
    this.userId = null;
    this.startedAt = null;
    this.release = null;
  }

  /** Free the runtime's voice. The two are one act — see the file comment. */
  private markIdle(): void {
    this.state = 'idle';
    voiceSessionLock.release('call');
  }
}

const JOINED_NOTE =
  'You are in the call, or waiting in its lobby to be let in. Say nothing until you hear ' +
  'people in the call. Then greet them once, in one short sentence, and say what you can ' +
  'help with.';
const MIC_OPEN_NOTE = 'The call app is now using your microphone, so the call can hear you.';
const MIC_CLOSED_NOTE =
  'No app is using your microphone, so nobody in the call hears you. Do not greet anyone or ' +
  'answer out loud until that changes. Your backend can check that the call app is not muted ' +
  'and that its microphone is PrismMicrophone. Keep listening.';

function refusal(message: string): JoinCallResult {
  return { success: false, micCaptured: false, app: null, message };
}

export const callService = new CallService();
