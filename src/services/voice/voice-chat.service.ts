/**
 * Owns the agent's side of a browser voice chat, start to finish.
 *
 * One session per runtime, and never at the same time as a meeting: both owners take
 * `voiceSessionLock`, because the agent has one voice. The lock is held for exactly as
 * long as this service is not `idle`, so the places that word is written are the places
 * the lock is released.
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
import { prepareMeetingTools } from '../meeting/tool-bridge';
import { buildVoiceInstructions } from './voice-instructions';
import { voiceSessionLock } from './voice-session-lock';
import { SocketAudio, VOICE_AUDIO_FORMAT, type SocketAudioChannel } from './socket-audio';

/** What the client is told about the session it asked for. */
export type VoiceChatState = 'live' | 'ended';

/**
 * How the service answers the client, and how the agent's audio reaches it.
 *
 * `sendAudio` and `sendClear` are the audio half; the rest is the session's state. One
 * implementation, in the gateway that owns the socket.
 */
export interface VoiceChatSignal extends SocketAudioChannel {
  /** The session is up, or it is over. */
  state(state: VoiceChatState): void;
  /** Why the session could not start, or could not continue. */
  error(message: string): void;
}

export interface StartVoiceChatInput {
  userId: string;
  agentId: string;
  /** The thread the call was started from, for the tools that take one. */
  threadId?: string;
  signal: VoiceChatSignal;
}

/** How a session ended, as reported in telemetry. */
type EndStatus = 'completed' | 'disconnected' | 'error';

class VoiceChatService {
  private state: 'idle' | 'starting' | 'live' | 'ending' = 'idle';
  /**
   * Bumped by every ending, so a late event belonging to a session that is over cannot
   * act — and so `stop()` can cancel a start that is still several awaits from done.
   */
  private epoch = 0;
  private transport: SocketAudio | null = null;
  private conversation: VoiceConversation | null = null;
  private signal: VoiceChatSignal | null = null;
  private userId: string | null = null;
  private startedAt: number | null = null;

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
          : `There is already a voice chat running. End that one first.`,
      );
      return false;
    }

    this.state = 'starting';
    const epoch = ++this.epoch;

    // Built into locals and published onto `this` only once the epoch check below says
    // the session is still wanted: a `stop()` during startup has nothing else to release,
    // and a peer left running would hold a metered Realtime socket open.
    let transport: SocketAudio | null = null;
    let conversation: VoiceConversation | null = null;
    const releaseLocals = async (): Promise<void> => {
      conversation?.stop();
      await transport?.close();
    };

    try {
      // Instructions and tools first: they need the database, and failing here should cost
      // nothing but a message.
      const { instructions, agentName, lockedIn } = await buildVoiceInstructions({
        userId: input.userId,
        agentId: input.agentId,
        platform: 'voice',
        // One person is on the other end, so everything said is said to the agent. No
        // addressed gate, and nothing to decide per utterance.
        responseMode: 'open',
      });
      const tools = await prepareMeetingTools({
        userId: input.userId,
        agentId: input.agentId,
        threadId: input.threadId,
        lockedIn,
      });

      transport = new SocketAudio(input.signal, {
        onAudio: (pcm) => {
          if (this.epoch === epoch) this.conversation?.pushAudio(pcm);
        },
      });

      conversation = new VoiceConversation({
        instructions,
        tools,
        sink: transport.sink,
        // The transport speaks the model's own rate, so nothing resamples between the
        // client's microphone and the model.
        sampleRate: VOICE_AUDIO_FORMAT.sampleRate,
        responseMode: 'open',
        agentName,
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
      this.signal = input.signal;
      this.userId = input.userId;
      this.startedAt = Date.now();
      this.state = 'live';

      // Live immediately: the socket that asked is the socket the audio travels on, so
      // there is no media path still to come up and nothing to wait for.
      input.signal.state('live');

      logger.info({ tools: tools.count }, '[VoiceChat] Session is live');
      trackEvent('voice chat started', input.userId, {
        tools: String(tools.count),
        locked_in: String(lockedIn),
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, '[VoiceChat] Failed to start the session');
      // Locals unconditionally: nothing reached the fields, so nothing else can release
      // them. The voice goes back only if this failure belongs to the session the service
      // still describes — a cancelled start's does not.
      await releaseLocals();
      if (this.epoch === epoch) this.markIdle();
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

  /** End the session, from the client asking or from its socket closing. */
  async stop(reason = 'the client ended the session'): Promise<void> {
    await this.end(this.epoch, 'completed', reason);
  }

  /** Called from the process shutdown path so a container exit ends the call. */
  async shutdown(): Promise<void> {
    if (this.state === 'idle') return;
    logger.info('[VoiceChat] Shutting down — ending the live session');
    await this.stop('the runtime is shutting down');
  }

  /**
   * The one ending, used by the client's stop, a peer that went away, a Realtime session
   * that died and process shutdown alike.
   */
  private async end(epoch: number, status: EndStatus, reason: string): Promise<void> {
    if (epoch !== this.epoch || this.state === 'idle' || this.state === 'ending') return;

    // Everything after this belongs to a session that is over: `ending` and the bumped
    // epoch together stop a teardown-triggered event, and a second `stop()` arriving
    // while the peer closes, from becoming a second ending.
    this.state = 'ending';
    this.epoch += 1;
    const { conversation, transport, signal, userId, startedAt } = this;
    this.conversation = null;
    this.transport = null;
    this.signal = null;
    this.userId = null;
    this.startedAt = null;

    logger.info({ status, reason }, '[VoiceChat] Session ended');

    conversation?.stop();
    await transport?.close().catch((err: unknown) => {
      logger.warn({ err }, '[VoiceChat] The peer would not close');
    });

    // The client is told why before it is told it is over, so a failure reads as a
    // failure rather than as an ending it asked for.
    if (status !== 'completed') signal?.error(reason);
    signal?.state('ended');

    if (userId && startedAt) {
      const stats = conversation?.statistics;
      trackEvent('voice chat ended', userId, {
        status,
        duration_ms: String(Date.now() - startedAt),
        responses: String(stats?.responses ?? 0),
        tool_calls: String(stats?.toolCalls ?? 0),
        interruptions: String(stats?.interruptions ?? 0),
        utterances: String(stats?.utterances ?? 0),
        // Answers the agent gave that produced no audio — silence the user cannot
        // account for, and the one number that says the call was not what it looked like.
        responses_failed: String(stats?.responsesFailed ?? 0),
      });
    }

    this.markIdle();
  }

  /** Free the runtime's voice. The two words are one act — see the file comment. */
  private markIdle(): void {
    this.state = 'idle';
    voiceSessionLock.release('voice-chat');
  }
}

export const voiceChatService = new VoiceChatService();
