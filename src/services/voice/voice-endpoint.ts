/**
 * The WebSocket a voice chat with a computer runs on.
 *
 * A socket of its own rather than the chat gateway's, because this one also carries
 * pictures of the agent's screen several times a second, and behind a burst of those a
 * chat message would wait. The session itself is `voiceChatService`'s, the same one the
 * chat composer opens: this is the transport and nothing else.
 *
 * Binary frames are audio, tagged in their first byte so the client can tell the agent's
 * voice from the sound of its browser. Text frames are JSON: status and screen pictures
 * out, the user's pointer, keyboard and shared screen in.
 */

import type { Server as HttpServer, IncomingMessage } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { logger } from '../../logger';
import { isAllowedOrigin } from '../../lib/origin-guard';
import { config } from '../../config';
import { isRealtimeConfigured } from '../meeting/openai-endpoint';
import { MEETING_SAMPLE_RATE } from '../meeting/resampler';
import { voiceChatService, type VoiceChatSignal } from './voice-chat.service';

export const VOICE_CHAT_PATH = '/api/voice';

/** Sent to the client as a JSON text frame. Audio goes as binary frames. */
export interface VoiceChatStatus {
  type: 'status';
  state: 'connecting' | 'ready' | 'ended' | 'error';
  message?: string;
  /** With `ready`: whether the client may take the pointer and keyboard on the screen. */
  desktop?: boolean;
}

/** One picture of the agent's screen, as base64 JPEG. */
export interface VoiceChatScreenFrame {
  type: 'screen';
  data: string;
}

/**
 * Drop the agent's speech that has not been played yet.
 *
 * Sent when somebody interrupts. Everything already on the wire is in the client's own
 * buffer by then, and without this the agent talks over the person who interrupted it for
 * as long as that buffer holds.
 */
export interface VoiceChatClearFrame {
  type: 'clear';
}

export type VoiceChatFrame = VoiceChatStatus | VoiceChatScreenFrame | VoiceChatClearFrame;

/**
 * The first byte of a binary frame says what the pcm16 after it is. The second byte is
 * padding, so the samples start on a 2-byte boundary.
 */
export const VOICE_FRAME = 0x01;
export const BROWSER_AUDIO_FRAME = 0x02;

function tagged(tag: number, pcm: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag, 0]), pcm]);
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://localhost').pathname;
}

/** The greeting the agent opens with, since the client opened a page rather than pressed a button. */
const GREETING =
  'Your user just opened the voice chat in the web UI and can hear you. ' +
  'Greet them in one short sentence.';

class VoiceEndpoint {
  private wss: WebSocketServer | null = null;
  /** The socket whose request holds the session, so only it can end one. */
  private holder: WebSocket | null = null;
  /**
   * Connections are served one at a time.
   *
   * Opening a session takes seconds, most of it the computer booting, and the decision
   * below reads state a concurrent start would be in the middle of changing. Two pages
   * opening at once is a real case: a reload is two sockets whose lifetimes overlap.
   */
  private tail: Promise<void> = Promise.resolve();

  /**
   * Pick this endpoint's upgrades off the shared HTTP server.
   *
   * `noServer` because a `ws` server bound with `path` answers every other path's
   * upgrade with a 400, and `/api/ws` already lives on the same server.
   */
  initialize(server: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    server.on('upgrade', (req, socket, head) => {
      if (pathnameOf(req) !== VOICE_CHAT_PATH) return;
      // A WebSocket handshake is exempt from the same-origin policy, so the rules the
      // HTTP routes and `/api/ws` get are applied to it here.
      if (
        !isAllowedOrigin(req.headers.origin, req.headers.host, req.headers['x-forwarded-host'])
      ) {
        logger.warn(
          '[OriginGuard] refused a voice chat handshake (origin %s, host %s, x-forwarded-host %s)',
          req.headers.origin,
          req.headers.host,
          req.headers['x-forwarded-host'],
        );
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.tail = this.tail.then(() => this.serve(ws)).catch((err: unknown) => {
          logger.error({ err }, '[VoiceChat] The endpoint failed to serve a connection');
        });
      });
    });
    logger.info(`Voice chat gateway initialized on ${VOICE_CHAT_PATH}`);
  }

  private async serve(ws: WebSocket): Promise<void> {
    const send = (frame: VoiceChatFrame): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    const sendTagged = (tag: number, pcm: Buffer): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(tagged(tag, pcm), { binary: true });
    };

    const agentId = config.agentId;
    if (!isRealtimeConfigured() || !agentId) {
      send({
        type: 'status',
        state: 'error',
        message: 'Voice chat needs OPENAI_API_KEY set in the runtime environment.',
      });
      ws.close(1011, 'voice chat not configured');
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    send({ type: 'status', state: 'connecting' });

    // A page that reloaded is a second socket for the same surface, so it takes the
    // session over rather than being refused. A meeting or a call from the chat composer
    // is somebody else's, and `start()` refuses this one in words.
    if (voiceChatService.surface === 'computer') {
      await voiceChatService.stop('another page took over the voice chat', 'disconnected');
    }

    // The service says why before it says the session is over, and the page renders one
    // status at a time, so the reason is carried into the ending rather than replaced
    // by it.
    let reason: string | undefined;
    const signal: VoiceChatSignal = {
      sendAudio: (pcm) => sendTagged(VOICE_FRAME, pcm),
      sendClear: () => send({ type: 'clear' }),
      screen: (data) => send({ type: 'screen', data }),
      computerAudio: (pcm) => sendTagged(BROWSER_AUDIO_FRAME, pcm),
      state: (state, info) =>
        send(
          state === 'live'
            ? { type: 'status', state: 'ready', desktop: info?.desktop ?? false }
            : { type: 'status', state: 'ended', message: reason },
        ),
      error: (message) => {
        reason = message;
        send({ type: 'status', state: 'error', message });
      },
    };

    ws.on('message', (data, isBinary) => {
      if (this.holder !== ws) return;
      if (!isBinary) {
        voiceChatService.handleComputerInput(data.toString());
        return;
      }
      voiceChatService.pushAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
    ws.on('close', () => {
      if (this.holder !== ws) return;
      this.holder = null;
      voiceChatService.stop('the client disconnected', 'disconnected').catch((err: unknown) => {
        logger.error({ err }, '[VoiceChat] Failed to end the session of a disconnected client');
      });
    });
    ws.on('error', (err) => logger.warn({ err }, '[VoiceChat] Socket error'));

    // Claimed before the service is asked: the service reports `live` from inside
    // `start()`, so the client can be sending audio while this is still waiting.
    this.holder = ws;
    const started = await voiceChatService.start({
      userId: config.ownerUserId,
      agentId,
      signal,
      surface: 'computer',
      computer: true,
      // The client captures and plays at the rate the agent's screen is recorded at, so
      // the sound of a video on that screen reaches it unresampled.
      sampleRate: MEETING_SAMPLE_RATE,
      greeting: GREETING,
    });
    // The claim only survives a session this socket really holds. A refused start gives
    // it back; a client that went away during the start takes the session with it, which
    // its own close handler could not do while the claim was still being taken.
    if (!started) {
      if (this.holder === ws) this.holder = null;
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'voice chat refused');
      return;
    }
    if (ws.readyState !== WebSocket.OPEN && this.holder === ws) {
      this.holder = null;
      await voiceChatService.stop('the client disconnected', 'disconnected');
    }
  }

  /** Stop taking connections; called from the process shutdown path. */
  close(): void {
    this.holder = null;
    this.wss?.close();
  }
}

export const voiceEndpoint = new VoiceEndpoint();
