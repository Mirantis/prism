/**
 * Owns the agent's side of a browser voice chat, start to finish.
 *
 * One session per runtime, and never at the same time as a call: both owners take
 * `voiceSessionLock`, because the agent has one voice. The lock is held for exactly as
 * long as this service is not `idle`, so the places that word is written are the places
 * the lock is released.
 *
 * Two surfaces reach it and the session is the same either way. A client on the chat
 * socket sends its audio on the socket it already has. The Computer page has a socket of its own,
 * because it also carries a computer's screen, and asks for that computer here.
 *
 * The session is the whole of what a call is here — nothing is persisted. No transcript,
 * no thread message, no tool-call row: what the user hears is what the call produced.
 *
 * Signalling is somebody else's job. This service is handed a `VoiceChatSignal` to talk
 * back through, so the socket the client is on stays somebody else's to own.
 *
 * The audio travels on that same socket. There is nothing to negotiate and nothing to
 * reach, so a session is live as soon as it is built — which is why a hosted runtime can
 * carry a call at all: it has no inbound path for media, and a peer connection needed
 * one.
 */

import { logger } from '../../logger';
import { config } from '../../config';
import { trackEvent } from '../../lib/telemetry';
import { VoiceConversation } from '../meeting/voice-conversation';
import { AgentComputer } from '../computer/agent-computer';
import { computerService } from '../computer/computer.service';
import { computerHelpService } from '../computer/computer-help.service';
import type { ScreenFrame } from '../computer/picture-stream';
import { buildVoiceInstructions } from './voice-instructions';
import { voiceSessionLock } from './voice-session-lock';
import {
  isAudioFrameUsable,
  maxFrameBytes,
  SocketAudio,
  VOICE_AUDIO_FORMAT,
  type SocketAudioChannel,
} from './socket-audio';
import {
  formatOffset,
  ScreenRecording,
  type RecordingEndReason,
  type RecordingResult,
} from './screen-recording';

/**
 * A recording of the user's own screen, as the Computer page sends it: it began, a
 * picture the page kept with the offset it was taken at, and the end. The pictures arrive
 * together, before the end.
 *
 * They come in on the screen's socket, because that is the socket the page has, and they
 * are answered here rather than by the computer: a recording is part of the call the page
 * started, and the desktop outlives any one call.
 */
export type RecordingFrame =
  | { type: 'recording_started' }
  | { type: 'recording_frame'; data: string; at: number }
  | { type: 'recording_stopped'; ms: number; reason: RecordingEndReason }
  | { type: 'recording_cancelled' };

/** Whether a page frame is one of those, so the socket knows where to send it. */
export function isRecordingFrame(type: unknown): boolean {
  return typeof type === 'string' && type.startsWith('recording_');
}

/** The reason a page states for ending a recording, or `user` for anything else it says. */
function endReason(reason: unknown): RecordingEndReason {
  return reason === 'limit' || reason === 'share_ended' ? reason : 'user';
}

/** What the model is told when a recording starts, so it waits rather than talking over it. */
const RECORDING_STARTED_NOTE =
  'Your user is recording their screen and talking you through what they are doing. Listen ' +
  'and say nothing until they stop: you will then be given the pictures of their screen, ' +
  'and they are waiting to hear about it.';

/** And when the page carrying one goes away, so it stops waiting for it. */
const RECORDING_LOST_NOTE =
  'Your user was recording their screen, and the page showing it went away before they ' +
  'finished. The recording is gone and you will not be given it, so carry on with them.';

/** What the model is told a recording is, before the segments of it arrive. */
function recordingNote(result: RecordingResult): string {
  const pictures = result.frames === 1 ? '1 picture' : `${result.frames} pictures`;
  return (
    `Your user recorded their own screen for ${formatOffset(result.ms)} and has just handed ` +
    `it to you. What follows is their screen as it changed (${pictures}), in order; what ` +
    'they said while they worked is in the conversation just before this. Take it in, then ' +
    'answer them about it in a sentence or two.' +
    (result.reason === 'limit'
      ? ' The recording stopped at its length limit, so it may end in the middle of something.'
      : '')
  );
}

/** What the client is told about the session it asked for. */
export type VoiceChatState = 'live' | 'ended';

/**
 * Which client asked for the session.
 *
 * The two are the same call. This says which one holds the voice, so a second request
 * from the same surface can take it over — a reloaded page is the ordinary case — while
 * a request from the other one is refused and told why.
 */
export type VoiceChatSurface = 'chat' | 'computer';

/** What a live session has, told to the client alongside `live`. */
export interface VoiceChatLiveInfo {
  /**
   * Whether the runtime owns the screen it is streaming, so the client may take the
   * pointer and keyboard on it. False on a host with a display of its own, where the
   * agent's browser is a window among the operator's.
   */
  desktop: boolean;
}

/**
 * How the service answers the client, and how the agent's audio reaches it.
 *
 * `sendAudio` and `sendClear` are the audio half; the rest is the session's state. The
 * last two are the computer's, and a client that cannot show one leaves them out.
 */
export interface VoiceChatSignal extends SocketAudioChannel {
  /** The session is up, or it is over. */
  state(state: VoiceChatState, info?: VoiceChatLiveInfo): void;
  /** Why the session could not start, or could not continue. */
  error(message: string): void;
}

/**
 * Where the agent's screen and the sound of its desktop go.
 *
 * A second transport rather than the voice signal, because the screen is video several
 * times a second and the conversation is not: behind a burst of it a control frame would
 * wait. A client attaches one after its call is live, and detaching stops the capture.
 */
export interface ComputerClient {
  /** The agent's screen: how it is encoded, then each picture of it. */
  screen(frame: ScreenFrame): void;
  /** What the agent's desktop is playing, pcm16 at the session's rate. */
  audio(pcm: Buffer): void;
}

export interface StartVoiceChatInput {
  userId: string;
  agentId: string;
  signal: VoiceChatSignal;
  /** Which client asked. Defaults to the chat socket, the one that came first. */
  surface?: VoiceChatSurface;
  /**
   * Open a computer for the agent to work on, and give it the tools that act on it.
   *
   * The computer comes up before anything else is built: it is the slow part, and a
   * client that asked for one and cannot have it should be told before the session costs
   * anything. Its screen starts streaming as soon as it opens, so the client has a
   * picture while the model is still connecting.
   */
  computer?: boolean;
  /** What the client speaks, in and out. Defaults to the model's own rate. */
  sampleRate?: number;
  /**
   * The size of the rectangle the client shows the computer's screen in, in its own
   * device pixels, so the screen comes up at the size it will be drawn at.
   *
   * A client that says nothing gets a default and may resize later; a client with no
   * computer has nothing to size.
   */
  screen?: { width: number; height: number };
  /** Said as soon as the session is live. Left out, the agent waits to be spoken to. */
  greeting?: string;
}

/**
 * How a session ended, as reported in telemetry.
 *
 * `completed` is the client asking, or the runtime shutting down under it. `disconnected`
 * is the client's socket going away, which its owner tells this service — from here the
 * two are the same act. `error` is the session dying on its own.
 */
export type VoiceChatEndStatus = 'completed' | 'disconnected' | 'error';

class VoiceChatService {
  private state: 'idle' | 'starting' | 'live' | 'ending' = 'idle';
  /**
   * Bumped by every ending, so a late event belonging to a session that is over cannot
   * act — and so `stop()` can cancel a start that is still several awaits from done.
   */
  private epoch = 0;
  private transport: SocketAudio | null = null;
  private conversation: VoiceConversation | null = null;
  private computer: AgentComputer | null = null;
  /** The user's recording of their own screen. Built for a session that has a page. */
  private recording: ScreenRecording | null = null;
  /** Which client's socket the running recording came in on, so its loss is noticed. */
  private recordingClient: string | null = null;
  private signal: VoiceChatSignal | null = null;
  private userId: string | null = null;
  private startedAt: number | null = null;
  /** Held for the ending event, and read by a second client deciding whether to take over. */
  private startedFrom: VoiceChatSurface = 'chat';
  /** The rate this session speaks, which the client opens its own audio at. */
  private rate: number = VOICE_AUDIO_FORMAT.sampleRate;

  /** What the client should capture and play at. The default until a session sets it. */
  get sampleRate(): number {
    return this.rate;
  }

  /** Whether a session is running, for a caller that wants to know before it offers. */
  get isLive(): boolean {
    return this.state === 'live';
  }

  /**
   * Open a session for the client that asked for one.
   *
   * A refusal is an `error` frame, never a rejection — every reason this cannot run is
   * something the user needs told in words — so the answer comes back as `true` when
   * this request opened the session, which is what lets signalling tell its own session
   * from one it was refused.
   *
   * There is no build that cannot carry a call any more: the audio rides the socket the
   * client is already on, so there is no native binding to be missing.
   */
  async start(input: StartVoiceChatInput): Promise<boolean> {
    if (!voiceSessionLock.tryAcquire('voice-chat')) {
      input.signal.error(
        voiceSessionLock.holder === 'call'
          ? `I'm in a call right now. That has to end before I can talk here.`
          : `There is already a voice chat running. End that one first.`,
      );
      return false;
    }

    this.state = 'starting';
    const epoch = ++this.epoch;
    const surface: VoiceChatSurface = input.surface ?? 'chat';
    const sampleRate = input.sampleRate ?? VOICE_AUDIO_FORMAT.sampleRate;
    this.rate = sampleRate;

    // Built into locals and published onto `this` only once the epoch check below says
    // the session is still wanted: a `stop()` during startup has nothing else to release,
    // and a conversation left running would hold a metered voice socket open.
    let transport: SocketAudio | null = null;
    let conversation: VoiceConversation | null = null;
    let computer: AgentComputer | null = null;
    // Where a failure happened, for the event below. An operator reads this to tell an
    // image that cannot carry a computer from a voice session that would not open.
    let stage: 'computer' | 'session' = 'session';
    // Each step is guarded: this runs on the way out of a failure, and a throw here would
    // skip the lines below that free the runtime's voice, leaving it held with no session
    // on it for the life of the process.
    const releaseLocals = async (): Promise<void> => {
      await conversation?.stop().catch((err: unknown) => {
        logger.warn({ err }, '[VoiceChat] The conversation would not stop');
      });
      await transport?.close().catch((err: unknown) => {
        logger.warn({ err }, '[VoiceChat] The transport would not close');
      });
      // A start cancelled by `stop()` was ended already, and a newer session may hold the
      // voice by now, so its help requests are not this start's to clear.
      if (this.epoch === epoch) computerHelpService.endVoiceSession();

      // A recording still running has no model left to be handed to, and reporting it as
      // cancelled is what keeps one that never arrived out of the delivered count.
      this.recording?.cancel();
    };

    try {
      // The computer first, where one was asked for. It is the slow part and the one that
      // can fail on the host it runs on, so a client that cannot have it hears why before
      // a voice session is opened and billed.
      if (input.computer) {
        stage = 'computer';
        computer = await computerService.open();
        if (this.epoch !== epoch) {
          await releaseLocals();
          return false;
        }
        stage = 'session';
      }

      const { instructions, sessionInstructions } = await buildVoiceInstructions({
        userId: input.userId,
        agentId: input.agentId,
        call: {
          kind: 'voice-chat',
          computer: computer
            ? { desktop: computer.hasDesktop ? { width: computer.width, height: computer.height } : null }
            : null,
          // Only a client that sends pictures of the user's screen can be asked to share
          // one, and that is the same client that shows the computer.
          userScreen: computer !== null,
        },
      });
      transport = new SocketAudio(
        input.signal,
        {
          onAudio: (pcm) => {
            if (this.epoch === epoch) this.conversation?.pushAudio(pcm);
          },
        },
        sampleRate,
      );

      conversation = new VoiceConversation({
        instructions,
        backend: { userId: input.userId, agentId: input.agentId, sessionInstructions, computer: computer !== null },
        sink: transport.sink,
        sampleRate,
        voice: config.openaiRealtimeVoice,
        onSessionLost: (reason) => void this.end(epoch, 'error', reason),
      });

      await conversation.start();

      // Startup is several awaits long, and a `stop()` in any of them ended this session
      // before it began. Release what was built rather than publishing a session nobody
      // is waiting for. The service's own state is not touched here: the `stop()` that
      // cancelled this start has already freed the voice, and a session may be running on
      // it by now.
      if (this.epoch !== epoch) {
        await releaseLocals();
        return false;
      }

      this.transport = transport;
      this.conversation = conversation;
      this.computer = computer;
      // Only a client that shows the computer has a screen to record, and it is the same
      // client that sends the pictures.
      this.recording = computer ? new ScreenRecording({ userId: input.userId }) : null;
      this.signal = input.signal;
      this.userId = input.userId;
      this.startedAt = Date.now();
      this.startedFrom = surface;
      this.state = 'live';

      // Live immediately: the socket that asked is the socket the audio travels on, so
      // there is no media path still to come up and nothing to wait for.
      input.signal.state('live', { desktop: computer?.hasDesktop ?? false });

      if (input.greeting) conversation.prompt(input.greeting);

      logger.info({ surface, computer: computer !== null }, '[VoiceChat] Session is live');
      trackEvent('voice chat started', input.userId, {
        inference_provider: config.realtimeProvider ?? 'unknown',
        inference_source: config.realtimeSource,
        surface,
        computer: String(computer !== null),
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, '[VoiceChat] Failed to start the session');
      // Locals unconditionally: they are the same objects the fields hold once published,
      // so this releases the session either way.
      await releaseLocals();
      // The voice goes back only if this failure belongs to the session the service still
      // describes — a cancelled start's does not. The fields go with it: a throw after the
      // block above published them would otherwise leave a transport and a conversation on
      // an `idle` service, where the next call's `stop()` finds nothing to end and this
      // one's audio keeps arriving.
      if (this.epoch === epoch) {
        this.clearPublished();
        this.markIdle();
      }
      // A start that failed emits neither `voice chat started` nor `voice chat ended`, so
      // without this a runtime that can never open a computer looks like a runtime nobody
      // called. The stage is the whole of what is reported: the message is an error's
      // prose, which telemetry does not carry.
      trackEvent('voice chat start failed', input.userId, {
        inference_provider: config.realtimeProvider ?? 'unknown',
        inference_source: config.realtimeSource,
        surface,
        computer: String(input.computer === true),
        stage,
      });
      // No `ended` frame: this session never reported `live`, so it has no ending to
      // report, and `live → ended` stays the one shape a session has. The error below is
      // the whole answer.
      input.signal.error(`Could not start the voice chat: ${message}`);
      return false;
    }
  }

  /**
   * A frame of the client's audio. Dropped when no session is running.
   *
   * Dropped rather than refused: a frame in flight when a call ends is ordinary, and
   * answering it would tell the client something it already knows.
   */
  pushAudio(pcm: Buffer): void {
    if (!isAudioFrameUsable(pcm, maxFrameBytes(this.rate))) return;
    this.transport?.push(pcm);
  }

  /**
   * A recording frame from the page showing the computer.
   *
   * `acknowledge` answers on the socket the frame arrived on, and the page opens its
   * microphone only when that answer lands: the microphone travels on the other socket,
   * and two sockets have no order between them.
   */
  handleRecordingFrame(clientId: string, frame: RecordingFrame, acknowledge: () => void): void {
    const recording = this.recording;
    const conversation = this.conversation;
    if (!recording || !conversation) return;

    switch (frame.type) {
      case 'recording_started':
        if (!recording.start()) return;
        this.recordingClient = clientId;
        acknowledge();
        // An answer already in the air would play over the demonstration, and what this
        // promises is an agent that stays quiet while a recording runs. Notifying alone
        // would not stop it: that adds context rather than ending the turn.
        conversation.stopSpeaking();
        conversation.notify(RECORDING_STARTED_NOTE);
        return;
      case 'recording_frame':
        recording.addFrame(frame.data, Number(frame.at));
        return;
      case 'recording_stopped':
        this.recordingClient = null;
        this.deliverRecording(endReason(frame.reason), Number(frame.ms));
        return;
      case 'recording_cancelled':
        this.recordingClient = null;
        recording.cancel();
        return;
    }
  }

  /**
   * The page a recording was coming from has gone.
   *
   * Its pictures and its end were going to arrive on that socket, so there is nothing to
   * wait for. Left running, the recording would take the microphone for the rest of the
   * call and the model would hear nothing.
   */
  releaseRecordingClient(clientId: string): void {
    if (this.recordingClient !== clientId) return;
    this.recordingClient = null;
    if (!this.recording?.cancel()) return;
    logger.info('[VoiceChat] The recording was dropped: its page is gone');
    this.conversation?.notify(RECORDING_LOST_NOTE);
  }

  /** Hand a finished recording to the model, or say why there is nothing to hand over. */
  private deliverRecording(reason: RecordingEndReason, ms: number): void {
    const result = this.recording?.stop(reason, ms) ?? null;
    const conversation = this.conversation;
    if (!conversation) return;
    if (!result) {
      conversation.notify(
        'Your user stopped their recording, and no picture of their screen came through. ' +
          'Tell them so and ask them to try again.',
      );
      return;
    }
    if (!conversation.showRecording(result.segments, recordingNote(result))) {
      logger.info('[VoiceChat] The recording did not reach the model');
    }
  }

  /**
   * End the session, from the client asking or from its socket closing.
   *
   * The status is the caller's to state, since only the caller knows which of the two it
   * is, and a call the user ended and a call whose connection dropped are read differently
   * afterwards.
   */
  async stop(
    reason = 'the client ended the session',
    status: VoiceChatEndStatus = 'completed',
  ): Promise<void> {
    await this.end(this.epoch, status, reason);
  }

  /** The user finished helping on the computer: have the agent look and carry on. */
  continueComputer(reason: string): void {
    if (!this.computer || !this.conversation) return;
    this.conversation.ask(`Your user finished helping. The help request was: ${JSON.stringify(reason)}. Inspect the current screen and continue their request.`);
  }

  /** Called from the process shutdown path so a container exit ends the call. */
  async shutdown(): Promise<void> {
    if (this.state === 'idle') return;
    logger.info('[VoiceChat] Shutting down — ending the live session');
    await this.stop('the runtime is shutting down');
  }

  /**
   * The one ending, used by the client's stop, a client that went away, a voice session
   * that died and process shutdown alike.
   */
  private async end(epoch: number, status: VoiceChatEndStatus, reason: string): Promise<void> {
    if (epoch !== this.epoch || this.state === 'idle' || this.state === 'ending') return;

    // Everything after this belongs to a session that is over: `ending` and the bumped
    // epoch together stop a teardown-triggered event, and a second `stop()` arriving
    // while the transport closes, from becoming a second ending.
    this.state = 'ending';
    this.epoch += 1;
    const { conversation, transport, computer, signal, userId, startedAt, startedFrom } = this;
    this.clearPublished();

    logger.info({ status, reason }, '[VoiceChat] Session ended');

    try {
      await conversation?.stop();
      await transport?.close().catch((err: unknown) => {
        logger.warn({ err }, '[VoiceChat] The transport would not close');
      });
      // The browser, the desktop and the virtual display go with the call. They are
      // processes, so a session that left them behind would cost the host a whole
      // desktop for every call it ever carried.
      computerHelpService.endVoiceSession();

      // A recording still running has no model left to be handed to, and reporting it as
      // cancelled is what keeps one that never arrived out of the delivered count.
      this.recording?.cancel();

      // The client is told why before it is told it is over, so a failure reads as a
      // failure rather than as an ending it asked for.
      if (status !== 'completed') signal?.error(reason);
      signal?.state('ended');

      if (userId && startedAt) {
        const stats = conversation?.statistics;
        trackEvent('voice chat ended', userId, {
          inference_provider: config.realtimeProvider ?? 'unknown',
          inference_source: config.realtimeSource,
          status,
          surface: startedFrom,
          computer: String(computer !== null),
          duration_ms: String(Date.now() - startedAt),
          delegations: String(stats?.delegations ?? 0),
          tool_calls: String(stats?.toolCalls ?? 0),
          backend_input_tokens: String(stats?.backendInputTokens ?? 0),
          backend_output_tokens: String(stats?.backendOutputTokens ?? 0),
          ...(stats?.voiceSeconds != null ? { voice_seconds: String(stats.voiceSeconds) } : {}),
          ...(stats?.closeReason ? { close_reason: stats.closeReason } : {}),
        });
      }
    } finally {
      // The voice comes back whatever the block above did. The session is over by the time
      // that block runs — the state and the epoch above say so — and a socket that throws
      // on its way out would otherwise leave the runtime holding a voice with no session on
      // it: no call, and no way to start one until the process restarts.
      this.markIdle();
    }
  }

  /** Drop the session's fields. The session itself is released by whoever holds its locals. */
  private clearPublished(): void {
    this.conversation = null;
    this.transport = null;
    this.computer = null;
    this.recording = null;
    this.recordingClient = null;
    this.signal = null;
    this.userId = null;
    this.startedAt = null;
  }

  /** Free the runtime's voice. The two words are one act — see the file comment. */
  private markIdle(): void {
    this.state = 'idle';
    voiceSessionLock.release('voice-chat');
  }
}

export const voiceChatService = new VoiceChatService();
