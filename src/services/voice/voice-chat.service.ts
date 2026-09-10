/**
 * Owns the agent's side of a browser voice chat, start to finish.
 *
 * One session per runtime, and never at the same time as a meeting: both owners take
 * `voiceSessionLock`, because the agent has one voice. The lock is held for exactly as
 * long as this service is not `idle`, so the places that word is written are the places
 * the lock is released.
 *
 * Two surfaces reach it and the session is the same either way. The chat composer sends
 * its audio on the socket it already has. The Scratchpad page has a socket of its own,
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
import { meanGateLatencyMs } from '../meeting/gate-stats';
import {
  prepareMeetingTools,
  prepareRealtimeTools,
  prepareVoiceChatTools,
} from '../meeting/tool-bridge';
import { AgentComputer } from '../computer/agent-computer';
import { createComputerTools } from '../computer/computer-tools';
import { buildVoiceInstructions } from './voice-instructions';
import { voiceSessionLock } from './voice-session-lock';
import { SocketAudio, VOICE_AUDIO_FORMAT, type SocketAudioChannel } from './socket-audio';

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
  /** One picture of the agent's screen, as base64 JPEG. */
  screen?(jpegBase64: string): void;
  /** What the agent's browser is playing, pcm16 at the session's rate. */
  computerAudio?(pcm: Buffer): void;
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
  /** The thread the call was started from, for the tools that take one. */
  threadId?: string;
  /** Defaults to `open` — a client that says nothing is holding a phone to its ear. */
  mode?: VoiceListeningMode;
  signal: VoiceChatSignal;
  /** Which client asked. Defaults to the chat composer, the one that came first. */
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
  private signal: VoiceChatSignal | null = null;
  private userId: string | null = null;
  private startedAt: number | null = null;
  /** Held for the ending event: the gate numbers below mean nothing without it. */
  private mode: VoiceListeningMode = 'open';
  /** Held for the same reason, and read by a second client deciding whether to take over. */
  private startedFrom: VoiceChatSurface = 'chat';

  /** Whether a session is running, for a caller that wants to know before it offers. */
  get isLive(): boolean {
    return this.state === 'live';
  }

  /** Which client holds the voice, or null when nothing does. */
  get surface(): VoiceChatSurface | null {
    return this.state === 'idle' ? null : this.startedFrom;
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

    // Built into locals and published onto `this` only once the epoch check below says
    // the session is still wanted: a `stop()` during startup has nothing else to release,
    // and a conversation left running would hold a metered Realtime socket open.
    let transport: SocketAudio | null = null;
    let conversation: VoiceConversation | null = null;
    let computer: AgentComputer | null = null;
    const releaseLocals = async (): Promise<void> => {
      conversation?.stop();
      await transport?.close();
      await computer?.stop();
    };

    try {
      // The computer first, where one was asked for. It is the slow part and the one that
      // can fail on the host it runs on, so a client that cannot have it hears why before
      // a Realtime session is opened and billed.
      if (input.computer) {
        computer = new AgentComputer();
        await computer.openBrowser();
        if (this.epoch !== epoch) {
          await releaseLocals();
          return false;
        }
        if (input.signal.screen) {
          computer.startScreenStream((data) => input.signal.screen?.(data));
        }
        if (input.signal.computerAudio) {
          const streamed = computer.startBrowserAudio((pcm) => input.signal.computerAudio?.(pcm));
          logger.info(
            streamed
              ? '[VoiceChat] The browser is heard through the client'
              : '[VoiceChat] The browser plays on this host, not through the client',
          );
        }
      }

      const { instructions, agentName, lockedIn } = await buildVoiceInstructions({
        userId: input.userId,
        agentId: input.agentId,
        responseMode: mode,
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
      // The agent's own set without the meeting's tools, which act on a call this session
      // is not in, and with the computer's real `browse` and `see_screen` where there is
      // one to act on.
      const agentTools = await prepareMeetingTools({
        userId: input.userId,
        agentId: input.agentId,
        threadId: input.threadId,
        lockedIn,
      });
      const tools = prepareVoiceChatTools(
        agentTools,
        computer
          ? prepareRealtimeTools(
              createComputerTools(computer, computer.hasDesktop ? computer : null, computer),
              'Computer',
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

      conversation = new VoiceConversation({
        instructions,
        tools,
        sink: transport.sink,
        sampleRate,
        responseMode: mode,
        agentName,
        voice: config.openaiRealtimeVoice,
        onSessionLost: (reason) => void this.end(epoch, 'error', reason),
      });
      // Attached before the session opens, so the first tool call has somewhere to put its
      // picture. Nothing reaches it until the model asks for something.
      computer?.attach(conversation);
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
      this.signal = input.signal;
      this.userId = input.userId;
      this.startedAt = Date.now();
      this.mode = mode;
      this.startedFrom = surface;
      this.state = 'live';

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
        tools: String(tools.count),
        locked_in: String(lockedIn),
        response_mode: mode,
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
    this.transport?.push(pcm);
  }

  /**
   * A text frame from the client about the computer: the user's own pointer and keyboard
   * on its screen, or a picture of the screen they are sharing. Dropped when there is no
   * computer, for the same reason a stray audio frame is.
   */
  handleComputerInput(text: string): void {
    this.computer?.handleInput(text);
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

  /** Called from the process shutdown path so a container exit ends the call. */
  async shutdown(): Promise<void> {
    if (this.state === 'idle') return;
    logger.info('[VoiceChat] Shutting down — ending the live session');
    await this.stop('the runtime is shutting down');
  }

  /**
   * The one ending, used by the client's stop, a client that went away, a Realtime session
   * that died and process shutdown alike.
   */
  private async end(epoch: number, status: VoiceChatEndStatus, reason: string): Promise<void> {
    if (epoch !== this.epoch || this.state === 'idle' || this.state === 'ending') return;

    // Everything after this belongs to a session that is over: `ending` and the bumped
    // epoch together stop a teardown-triggered event, and a second `stop()` arriving
    // while the transport closes, from becoming a second ending.
    this.state = 'ending';
    this.epoch += 1;
    const { conversation, transport, computer, signal, userId, startedAt, mode, startedFrom } = this;
    this.clearPublished();

    logger.info({ status, reason }, '[VoiceChat] Session ended');

    try {
      conversation?.stop();
      await transport?.close().catch((err: unknown) => {
        logger.warn({ err }, '[VoiceChat] The transport would not close');
      });
      // The browser, the desktop and the virtual display go with the call. They are
      // processes, so a session that left them behind would cost the host a whole
      // desktop for every call it ever carried.
      await computer?.stop().catch((err: unknown) => {
        logger.warn({ err }, '[VoiceChat] The computer would not close');
      });

      // The client is told why before it is told it is over, so a failure reads as a
      // failure rather than as an ending it asked for.
      if (status !== 'completed') signal?.error(reason);
      signal?.state('ended');

      if (userId && startedAt) {
        const stats = conversation?.statistics;
        trackEvent('voice chat ended', userId, {
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
