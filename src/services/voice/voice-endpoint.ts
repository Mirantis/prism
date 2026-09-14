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
import { serveUpgrades } from '../websocket-upgrades';
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

/**
 * How the agent's screen is encoded, before any of it arrives and again whenever the
 * source restarts. Video arrives as binary frames; pictures arrive as the frame below.
 */
export interface VoiceChatScreenStart {
  type: 'screen_start';
  encoding: 'jpeg' | 'h264';
  /** With `h264`: the name the browser configures its decoder with. */
  codec?: string;
}

/** One picture of the agent's screen, as base64 JPEG. */
export interface VoiceChatScreenFrame {
  type: 'screen';
  data: string;
}

/**
 * The size of the rectangle a client shows the screen in, read off the handshake.
 *
 * On the URL rather than in a frame, so the screen is the right size before the desktop
 * lays itself out on it. A client that leaves it off gets a default and can send a
 * `viewport` frame once it knows.
 */
function screenFrom(req: IncomingMessage): { width: number; height: number } | undefined {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const width = Number(url.searchParams.get('w'));
  const height = Number(url.searchParams.get('h'));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
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

export type VoiceChatFrame =
  | VoiceChatStatus
  | VoiceChatScreenStart
  | VoiceChatScreenFrame
  | VoiceChatClearFrame;

/**
 * The first byte of a binary frame says what is in it. The second byte is padding for the
 * two audio kinds, so their samples start on a 2-byte boundary, and says whether a screen
 * picture stands on its own.
 */
export const VOICE_FRAME = 0x01;
export const BROWSER_AUDIO_FRAME = 0x02;
export const SCREEN_VIDEO_FRAME = 0x03;

function tagged(tag: number, body: Buffer, flag = 0): Buffer {
  return Buffer.concat([Buffer.from([tag, flag]), body]);
}

/**
 * How much unsent data the socket may hold before the screen is skipped.
 *
 * The call's audio and the agent's screen share one socket, and the screen is the half
 * that can be skipped: a late frame of speech is heard, where a skipped picture costs one
 * frame of a stream that sends another within the tick. Roughly two pictures' worth, so an
 * ordinary burst is buffered and a client that has stopped draining is not fed.
 *
 * Video is skipped a whole run at a time, up to the next picture that stands on its own,
 * since every picture between them is read against the one before it.
 */
const SCREEN_BACKLOG_BYTES = 256 * 1024;

/**
 * How often a live socket is pinged, and so how long a client that went away silently
 * holds what its session owns.
 *
 * A voice chat with a computer holds more than a chat connection does: a metered Realtime
 * session, a browser, a desktop, and the runtime's one voice, which is why the check
 * matters here rather than being left to TCP. The chat gateway uses the same interval.
 */
const LIVENESS_INTERVAL_MS = 30_000;

/** The greeting the agent opens with, since the client opened a page rather than pressed a button. */
const GREETING =
  'Your user just opened the voice chat in the web UI and can hear you. ' +
  'Greet them in one short sentence.';

/** A client socket, with the answer to the last ping sent to it. */
interface VoiceSocket extends WebSocket {
  isAlive?: boolean;
}

class VoiceEndpoint {
  private wss: WebSocketServer | null = null;
  private liveness: NodeJS.Timeout | null = null;
  /**
   * The socket that holds this endpoint, or is in the middle of taking it.
   *
   * Claimed the moment a connection arrives, before anything is awaited, because that is
   * the only moment nothing else can be running. Everything a socket does afterwards is
   * conditional on still being the holder: a session takes seconds to open, mostly the
   * computer booting, and a page that reloads is two sockets whose lifetimes overlap.
   */
  private holder: WebSocket | null = null;

  /**
   * Serve this endpoint's upgrades on the shared HTTP server.
   *
   * `noServer` because a `ws` server bound with `path` answers every other path's
   * upgrade with a 400, and `/api/ws` already lives on the same server.
   */
  initialize(server: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    serveUpgrades(server, VOICE_CHAT_PATH, (req, socket, head) => {
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
      const screen = screenFrom(req);
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Before anything is awaited: `ws` emits `error` for a malformed frame, and an
        // `error` with no listener is an uncaught exception that takes the process down.
        ws.on('error', (err) => logger.warn({ err }, '[VoiceChat] Socket error'));
        void this.serve(ws, screen).catch((err: unknown) => {
          logger.error({ err }, '[VoiceChat] The endpoint failed to serve a connection');
        });
      });
    });
    // A socket that does not answer a ping is gone, whatever TCP still believes. Ending
    // it here is what returns the voice, and the desktop behind it, to the next caller.
    this.liveness = setInterval(() => {
      for (const client of wss.clients as Set<VoiceSocket>) {
        if (client.isAlive === false) {
          logger.info('[VoiceChat] Ending a client that stopped answering');
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, LIVENESS_INTERVAL_MS);
    // Unref'd: a timer is not a reason for the process to stay up.
    this.liveness.unref();

    logger.info(`Voice chat gateway initialized on ${VOICE_CHAT_PATH}`);
  }

  private async serve(ws: VoiceSocket, screen?: { width: number; height: number }): Promise<void> {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

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

    // The claim, taken here so that two pages opening at once cannot both believe they
    // have it. Whoever held it is displaced: a page that reloaded is a second socket for
    // the same surface, and taking the call over is what it wants. A meeting or a call
    // from the chat composer is somebody else's, and `start()` refuses this one in words.
    const displaced = this.holder;
    this.holder = ws;
    send({ type: 'status', state: 'connecting' });
    if (displaced) {
      // Ends its session, which also cancels one still starting, and closes its socket so
      // its page stops holding a microphone for a call it no longer has.
      await voiceChatService.stop('another page took over the voice chat', 'disconnected');
      displaced.close(1000, 'another page took over the voice chat');
    }
    if (this.holder !== ws) return;

    // The service says why before it says the session is over, and the page renders one
    // status at a time, so the reason is carried into the ending rather than replaced
    // by it.
    let reason: string | undefined;
    /** Pictures skipped since the last one that went out, for one log line rather than many. */
    let dropped = 0;
    /** True while a video run is being skipped, until a picture that stands on its own. */
    let resyncing = false;
    const behind = (): boolean => ws.bufferedAmount > SCREEN_BACKLOG_BYTES;
    const skipped = (): void => {
      if (dropped === 0) return;
      logger.debug(`[VoiceChat] Skipped ${dropped} screen picture(s) to a slow client`);
      dropped = 0;
    };
    const signal: VoiceChatSignal = {
      sendAudio: (pcm) => sendTagged(VOICE_FRAME, pcm),
      sendClear: () => send({ type: 'clear' }),
      screen: (frame) => {
        if (frame.kind === 'start') {
          // A stream that starts over is a new stream to a decoder, so nothing of the old
          // one is still owed to the client.
          resyncing = false;
          send(
            frame.encoding === 'h264'
              ? { type: 'screen_start', encoding: 'h264', codec: frame.codec }
              : { type: 'screen_start', encoding: 'jpeg' },
          );
          return;
        }
        if (frame.kind === 'jpeg') {
          if (behind()) {
            dropped += 1;
            return;
          }
          skipped();
          send({ type: 'screen', data: frame.data });
          return;
        }
        // Video. A picture read against one that was skipped decodes into rubbish, so a
        // client that fell behind is given nothing until the next one that stands alone.
        if (resyncing && !frame.keyframe) {
          dropped += 1;
          return;
        }
        if (!frame.keyframe && behind()) {
          resyncing = true;
          dropped += 1;
          return;
        }
        resyncing = false;
        skipped();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(tagged(SCREEN_VIDEO_FRAME, frame.data, frame.keyframe ? 1 : 0), {
            binary: true,
          });
        }
      },
      computerAudio: (pcm) => sendTagged(BROWSER_AUDIO_FRAME, pcm),
      state: (state, info) => {
        if (state === 'live') {
          send({ type: 'status', state: 'ready', desktop: info?.desktop ?? false });
          return;
        }
        send({ type: 'status', state: 'ended', message: reason });
        // The session ended without this socket asking — the model's own session closed,
        // or the runtime is shutting down. The socket holds nothing now, and a client
        // that does not hang up must not go on feeding audio into whatever session comes
        // next.
        if (this.holder === ws) this.holder = null;
        ws.close(1000, 'the voice chat ended');
      },
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
    const started = await voiceChatService.start({
      userId: config.ownerUserId,
      agentId,
      signal,
      surface: 'computer',
      computer: true,
      screen,
      // The client captures and plays at the rate the agent's screen is recorded at, so
      // the sound of a video on that screen reaches it unresampled.
      sampleRate: MEETING_SAMPLE_RATE,
      greeting: GREETING,
    });
    // A refused start gives the claim back. So does a client that went away while the
    // start ran, and that one takes the session with it, since its close handler ran
    // before there was a session to end.
    if (!started) {
      if (this.holder === ws) this.holder = null;
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'voice chat refused');
      return;
    }
    if (this.holder === ws && ws.readyState !== WebSocket.OPEN) {
      this.holder = null;
      await voiceChatService.stop('the client disconnected', 'disconnected');
    }
  }

  /** Stop taking connections; called from the process shutdown path. */
  close(): void {
    this.holder = null;
    if (this.liveness) clearInterval(this.liveness);
    this.liveness = null;
    this.wss?.close();
    this.wss = null;
  }
}

export const voiceEndpoint = new VoiceEndpoint();
