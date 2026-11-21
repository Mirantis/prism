/**
 * Owns the agent's side of a browser voice chat, start to finish.
 *
 * One session per runtime, and never at the same time as a meeting: both owners take
 * `voiceSessionLock`, because the agent has one voice. The lock is held for exactly as
 * long as this service is not `idle`, so the places that word is written are the places
 * the lock is released.
 *
 * Two surfaces reach it and the session is the same either way. A client on the chat
 * socket sends its audio on the socket it already has. The Computer page has a socket of its own,
 * because it also carries a computer's screen, and asks for that computer here.
 *
 * A call continues the text conversation it was started from: the session opens with
 * the end of that conversation, and when the user hangs up, the model writes a short
 * summary of the call into it. Nothing else is persisted: no transcript and no tool-call
 * row.
 *
 * Signalling is somebody else's job. This service is handed a `VoiceChatSignal` to talk
 * back through, so the socket the client is on stays somebody else's to own.
 *
 * The audio travels on that same socket. There is nothing to negotiate and nothing to
 * reach, so a session is live as soon as it is built — which is why a hosted runtime can
 * carry a call at all: it has no inbound path for media, and a peer connection needed
 * one.
 */

import { randomUUID } from 'node:crypto';
import { ThreadSource } from '@prisma/client';
import { logger } from '../../logger';
import { config } from '../../config';
import { trackEvent } from '../../lib/telemetry';
import { VoiceConversation } from '../meeting/voice-conversation';
import { meanGateLatencyMs } from '../meeting/gate-stats';
import { prepareMeetingTools } from '../meeting/tool-bridge';
import { prepareRealtimeTools } from './realtime-tools';
import {
  prepareVoiceChatTools,
  VOICE_CHAT_TRUNCATION_GUIDANCE,
} from './voice-chat-tools';
import { AgentComputer } from '../computer/agent-computer';
import { getComputerTools } from '../../tools/computer';
import { computerService } from '../computer/computer.service';
import { computerHelpService } from '../computer/computer-help.service';
import type { ComputerUse } from '../computer/computer-access';
import type { ScreenFrame } from '../computer/picture-stream';
import { buildVoiceInstructions } from './voice-instructions';
import { conversationService } from '../conversation.service';
import { messageDeliveryService } from '../message-delivery.service';
import { NO_CALL_SUMMARY, VOICE_CALL_SUMMARY_INSTRUCTIONS } from '../../prompts/voice-chat-prompt';
import { voiceSessionLock } from './voice-session-lock';
import { voiceForAgent } from './agent-voice';
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
  'Your user is recording their screen and talking through what they are doing. You will ' +
  'be given the whole recording when they stop, so say nothing until then — you cannot ' +
  'hear them while it runs.';

/** And when the page carrying one goes away, so it stops waiting for it. */
const RECORDING_LOST_NOTE =
  'Your user was recording their screen, and the page showing it went away before they ' +
  'finished. The recording is gone and you will not be given it. You can hear them again ' +
  'now, so carry on with them.';

/** What the model is told a recording is, before the segments of it arrive. */
function recordingNote(result: RecordingResult): string {
  const pictures = result.frames === 1 ? '1 picture' : `${result.frames} pictures`;
  return (
    `Your user recorded their own screen for ${formatOffset(result.ms)} and has just handed ` +
    'it to you. What follows is that recording in order: the pictures are their screen as ' +
    `it changed (${pictures}), and the voice is theirs, recorded while they worked rather ` +
    'than said to you now. Watch it through, then answer them about it in a sentence or two.' +
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

/**
 * This mode determines if the agent will always respond or only if addressed.
 *
 * `open` is a conversation: one person is talking to the agent, so everything the
 * microphone hears is meant for it and every utterance is answered at its turn
 * boundary. `addressed` is a room: a phone on a table with several people around it,
 * where most of what is said is said to somebody else, so each utterance is put to
 * the addressed gate and only the ones aimed at the agent are answered.
 *
 * `auto` is not offered: it resolves from a participant count, and one mixed microphone
 * yields none. The client states which of the two it wants.
 */
export type VoiceListeningMode = 'open' | 'addressed';

export interface StartVoiceChatInput {
  userId: string;
  agentId: string;
  /**
   * The thread the call was started from. In single-thread mode the call continues the
   * one conversation whatever this says.
   */
  threadId?: string;
  /** Defaults to `open` — a client that says nothing is holding a phone to its ear. */
  mode?: VoiceListeningMode;
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

/** The first line of the message a call's summary is stored as. */
export const VOICE_CALL_SUMMARY_HEADING = 'Voice call summary:';

/**
 * How long the session may take to write the summary. The client is told the call ended
 * before this starts, and the voice stays taken until it is over.
 */
const SUMMARY_DEADLINE_MS = 15_000;

type SummaryOutcome = 'stored' | 'skipped' | 'failed';

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
  private computerUse: ComputerUse | null = null;
  /** The user's recording of their own screen. Built for a session that has a page. */
  private recording: ScreenRecording | null = null;
  /** Which client's socket the running recording came in on, so its loss is noticed. */
  private recordingClient: string | null = null;
  private signal: VoiceChatSignal | null = null;
  private userId: string | null = null;
  /** The stored conversation the call continues, which its summary is written to. */
  private summaryThreadId: string | null = null;
  private startedAt: number | null = null;
  /** Held for the ending event: the gate numbers below mean nothing without it. */
  private mode: VoiceListeningMode = 'open';
  /** Held for the same reason, and read by a second client deciding whether to take over. */
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
        voiceSessionLock.holder === 'meeting'
          ? `I'm in a meeting call right now. That has to end before I can talk here.`
          : this.state === 'ending'
            ? `I'm still writing up the last voice chat. Try again in a few seconds.`
            : `There is already a voice chat running. End that one first.`,
      );
      return false;
    }

    this.state = 'starting';
    const epoch = ++this.epoch;
    // Resolved once and passed to both halves: the prompt tells the model it is being
    // filtered and the policy does the filtering. A call where those two disagree either
    // explains gaps in a conversation that has none, or waits to be named in a room that
    // will not name it.
    const mode: VoiceListeningMode = input.mode ?? 'open';
    const surface: VoiceChatSurface = input.surface ?? 'chat';
    const sampleRate = input.sampleRate ?? VOICE_AUDIO_FORMAT.sampleRate;
    this.rate = sampleRate;

    // Built into locals and published onto `this` only once the epoch check below says
    // the session is still wanted: a `stop()` during startup has nothing else to release,
    // and a conversation left running would hold a metered Realtime socket open.
    let transport: SocketAudio | null = null;
    let conversation: VoiceConversation | null = null;
    let computer: AgentComputer | null = null;
    let computerUse: ComputerUse | undefined;
    // Where a failure happened, for the event below. An operator reads this to tell an
    // image that cannot carry a computer from a Realtime session that would not open.
    let stage: 'computer' | 'session' = 'session';
    // Each step is guarded: this runs on the way out of a failure, and a throw here would
    // skip the lines below that free the runtime's voice, leaving it held with no session
    // on it for the life of the process.
    const releaseLocals = async (): Promise<void> => {
      try {
        conversation?.stop();
      } catch (err) {
        logger.warn({ err }, '[VoiceChat] The conversation would not stop');
      }
      await transport?.close().catch((err: unknown) => {
        logger.warn({ err }, '[VoiceChat] The transport would not close');
      });
      if (computerUse) {
        computerHelpService.endVoice(computerUse);
        computerService.finish(computerUse);
      }

      // A recording still running has no model left to be handed to, and reporting it as
      // cancelled is what keeps one that never arrived out of the delivered count.
      this.recording?.cancel();
    };

    try {
      // The computer first, where one was asked for. It is the slow part and the one that
      // can fail on the host it runs on, so a client that cannot have it hears why before
      // a Realtime session is opened and billed.
      if (input.computer) {
        stage = 'computer';
        computer = await computerService.local.open();
        computerUse = computerService.createUse({ userId: input.userId, agentId: input.agentId, mode: 'voice' });
        if (this.epoch !== epoch) {
          await releaseLocals();
          return false;
        }
        stage = 'session';
      }

      const threadId = await conversationFor(input);
      const summaryThreadId =
        threadId && (await conversationService.getThreadSource(threadId)) === ThreadSource.DATABASE
          ? threadId
          : null;
      const { instructions, agentName, lockedIn, openingContext } = await buildVoiceInstructions({
        userId: input.userId,
        agentId: input.agentId,
        responseMode: mode,
        call: {
          kind: 'voice-chat',
          threadId,
          summarized: summaryThreadId !== null,
          computer: computer
            ? { desktop: computer.hasDesktop ? { width: computer.width, height: computer.height } : null }
            : null,
          // Only a client that sends pictures of the user's screen can be asked to share
          // one, and that is the same client that shows the computer.
          userScreen: computer !== null,
        },
      });
      // Bind computer tools to this voice session’s ownership and image delivery.
      const agentTools = await prepareMeetingTools({
        userId: input.userId,
        agentId: input.agentId,
        threadId,
        lockedIn,
      });
      const tools = prepareVoiceChatTools(
        agentTools,
        computer
          ? prepareRealtimeTools(
              getComputerTools(computerUse, () => conversation),
              { label: 'Computer', truncationGuidance: VOICE_CHAT_TRUNCATION_GUIDANCE },
            )
          : null,
      );

      transport = new SocketAudio(
        input.signal,
        {
          onAudio: (pcm) => {
            if (this.epoch === epoch) this.conversation?.pushAudio(pcm);
          },
        },
        sampleRate,
      );

      const agentVoice = await voiceForAgent(agentName);
      conversation = new VoiceConversation({
        instructions,
        openingContext,
        tools,
        sink: transport.sink,
        sampleRate,
        responseMode: mode,
        agentName,
        voice: agentVoice.voice,
        onSessionLost: (reason) => void this.end(epoch, 'error', reason),
        onResponseFinished: () => { if (computerUse) computerService.yield(computerUse); },
        spend: { purpose: 'voice-chat', requestId: randomUUID(), ...(threadId ? { threadId } : {}) },
      });
      // Attached before the session opens, so the first tool call has somewhere to put its
      // picture. Nothing reaches it until the model asks for something.

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
      this.computerUse = computerUse ?? null;
      // Only a client that shows the computer has a screen to record, and it is the same
      // client that sends the pictures.
      this.recording = computer
        ? new ScreenRecording({ clientSampleRate: sampleRate, userId: input.userId })
        : null;
      this.signal = input.signal;
      this.userId = input.userId;
      this.summaryThreadId = summaryThreadId;
      this.startedAt = Date.now();
      this.mode = mode;
      this.startedFrom = surface;
      this.state = 'live';
      computerUse?.signal.addEventListener('abort', () => {
        if (this.epoch === epoch) void this.end(epoch, 'completed', 'Computer task stopped');
      }, { once: true });

      // Live immediately: the socket that asked is the socket the audio travels on, so
      // there is no media path still to come up and nothing to wait for.
      input.signal.state('live', { desktop: computer?.hasDesktop ?? false });

      if (input.greeting) {
        conversation.notify(input.greeting);
        conversation.speakNow();
      }

      logger.info(
        { tools: tools.count, mode, surface, computer: computer !== null },
        '[VoiceChat] Session is live',
      );
      trackEvent('voice chat started', input.userId, {
        inference_provider: config.realtimeProvider ?? 'unknown',
        inference_source: config.realtimeSource,
        tools: String(tools.count),
        locked_in: String(lockedIn),
        response_mode: mode,
        surface,
        computer: String(computer !== null),
        voice: agentVoice.voice,
        voice_source: agentVoice.source,
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
    // Judged before the frame is routed, since a recording takes it before the transport
    // sees it and would resample whatever arrived.
    if (!isAudioFrameUsable(pcm, maxFrameBytes(this.rate))) return;
    // A recording of the user's screen takes the microphone while it runs, so the model
    // hears the narration once — at the end, with the pictures — rather than answering
    // over the demonstration and then being handed the same words again.
    if (this.recording?.pushAudio(pcm)) return;
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
        'Your user stopped their recording, and there was nothing in it — no pictures of ' +
          'their screen and nothing said. Tell them so and ask them to try again.',
      );
      return;
    }
    if (!conversation.showRecording(result.segments, recordingNote(result))) {
      logger.info('[VoiceChat] The recording did not reach the model');
    }
  }

  /**
   * Show a client the agent's screen, and let it hear the desktop. Answers a detach.
   *
   * Called once the client's call is live, from whichever transport carries the screen.
   * Nothing captures the screen until somebody is watching it, and detaching stops the
   * capture again, so a session nobody is looking at costs no encoder.
   *
   * Answers null when this session has no computer to show.
   */
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

  /** Called from the process shutdown path so a container exit ends the call. */
  continueComputer(reason: string): void {
    if (!this.computerUse || !this.conversation) return;
    this.conversation.notify(`Your user finished helping. The help request was: ${JSON.stringify(reason)}\n\nInspect the current screen and continue their request.`);
    this.conversation.speakNow();
  }

  async shutdown(): Promise<void> {
    if (this.state === 'idle') return;
    logger.info('[VoiceChat] Shutting down — ending the live session');
    // No summary: it would hold the exit for as long as the model takes to write it.
    await this.end(this.epoch, 'completed', 'the runtime is shutting down', false);
  }

  /**
   * The one ending, used by the client's stop, a client that went away, a Realtime session
   * that died and process shutdown alike.
   */
  private async end(
    epoch: number,
    status: VoiceChatEndStatus,
    reason: string,
    summarize = status === 'completed',
  ): Promise<void> {
    if (epoch !== this.epoch || this.state === 'idle' || this.state === 'ending') return;

    // Everything after this belongs to a session that is over: `ending` and the bumped
    // epoch together stop a teardown-triggered event, and a second `stop()` arriving
    // while the transport closes, from becoming a second ending.
    this.state = 'ending';
    this.epoch += 1;
    const {
      conversation, transport, computer, computerUse, signal, userId, summaryThreadId, startedAt, mode, startedFrom,
    } = this;
    this.clearPublished();

    logger.info({ status, reason }, '[VoiceChat] Session ended');

    try {
      const stats = conversation?.statistics;
      // Only an ending the user chose leaves a summary: a session that died or a client
      // that dropped has no open session to ask, or no user who decided the call was over.
      const summary =
        summarize && conversation && userId && summaryThreadId && (stats?.utterances ?? 0) > 0
          ? {
              // Caught at once: the transport and the computer close before it is awaited.
              text: conversation.stopWithText(SUMMARY_REQUEST).catch((err: unknown) => {
                logger.warn({ err }, '[VoiceChat] The call summary request failed');
                return null;
              }),
              userId,
              threadId: summaryThreadId,
            }
          : null;
      if (!summary) conversation?.stop();
      await transport?.close().catch((err: unknown) => {
        logger.warn({ err }, '[VoiceChat] The transport would not close');
      });
      // The browser, the desktop and the virtual display go with the call. They are
      // processes, so a session that left them behind would cost the host a whole
      // desktop for every call it ever carried.
      if (computerUse) {
        computerHelpService.endVoice(computerUse);
        computerService.finish(computerUse);
      }

      // A recording still running has no model left to be handed to, and reporting it as
      // cancelled is what keeps one that never arrived out of the delivered count.
      this.recording?.cancel();

      // The client is told why before it is told it is over, so a failure reads as a
      // failure rather than as an ending it asked for.
      if (status !== 'completed') signal?.error(reason);
      signal?.state('ended');

      const summaryOutcome: SummaryOutcome = summary
        ? await storeSummary(summary.text, summary.userId, summary.threadId)
        : 'skipped';

      if (userId && startedAt) {
        trackEvent('voice chat ended', userId, {
          inference_provider: config.realtimeProvider ?? 'unknown',
          inference_source: config.realtimeSource,
          status,
          surface: startedFrom,
          computer: String(computer !== null),
          response_mode: mode,
          duration_ms: String(Date.now() - startedAt),
          responses: String(stats?.responses ?? 0),
          tool_calls: String(stats?.toolCalls ?? 0),
          interruptions: String(stats?.interruptions ?? 0),
          utterances: String(stats?.utterances ?? 0),
          // Answers the agent gave that produced no audio — silence the user cannot
          // account for, and the one number that says the call was not what it looked like.
          responses_failed: String(stats?.responsesFailed ?? 0),
          // Zero throughout an `open` call, which is the point of reporting `mode` beside
          // them. In `addressed` they are how a quiet call is read: `suppressed` is the
          // gate doing its job, while `gate_failed` is the agent having been deaf, and the
          // two produce identical silence in the room.
          suppressed: String(stats?.suppressed ?? 0),
          gate_calls: String(stats?.gateCalls ?? 0),
          gate_failed: String(stats?.gateFailed ?? 0),
          // The mean, which is what `meeting ended` emits under this key.
          gate_latency_ms: String(meanGateLatencyMs(stats)),
          summary: summaryOutcome,
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
    this.computerUse = null;
    this.recording = null;
    this.recordingClient = null;
    this.signal = null;
    this.userId = null;
    this.summaryThreadId = null;
    this.startedAt = null;
  }

  /** Free the runtime's voice. The two words are one act — see the file comment. */
  private markIdle(): void {
    this.state = 'idle';
    voiceSessionLock.release('voice-chat');
  }
}

const SUMMARY_REQUEST = {
  instructions: VOICE_CALL_SUMMARY_INSTRUCTIONS,
  deadlineMs: SUMMARY_DEADLINE_MS,
  // A few sentences, with room for the reasoning before them.
  maxOutputTokens: 1_000,
  reasoningEffort: 'low',
} satisfies Parameters<VoiceConversation['stopWithText']>[0];

/**
 * The conversation a call continues. Single-thread mode has one, whatever the client
 * sent; otherwise it is the thread the client started the call from, or none.
 */
async function conversationFor(input: StartVoiceChatInput): Promise<string | undefined> {
  if (input.threadId) return conversationService.writableThreadId(input.threadId);
  if (config.threadMode !== 'single') return undefined;
  return (await conversationService.findLatestWebThread(input.agentId, input.userId))?.id;
}

/** Store the call's summary in the conversation it continues, and show it to web clients. */
async function storeSummary(text: Promise<string | null>, userId: string, threadId: string): Promise<SummaryOutcome> {
  try {
    const summary = (await text)?.trim();
    if (!summary) {
      logger.warn('[VoiceChat] The call summary did not arrive');
      return 'failed';
    }
    if (summary === NO_CALL_SUMMARY) return 'skipped';
    await messageDeliveryService.publish(userId, threadId, `${VOICE_CALL_SUMMARY_HEADING}\n\n${summary}`, 'USER_INPUT', {
      channelContext: { channel: 'websocket', threadId },
    });
    return 'stored';
  } catch (err) {
    logger.warn({ err }, '[VoiceChat] Could not store the call summary');
    return 'failed';
  }
}

export const voiceChatService = new VoiceChatService();
