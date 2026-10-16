/**
 * Live desktop video, audio, and user input on a separate WebSocket. `?computer=` names
 * the computer to watch, the runtime's own when absent.
 */

import type { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { logger } from '../../logger';
import { isAllowedOrigin } from '../../lib/origin-guard';
import { serveUpgrades } from '../websocket-upgrades';
import { randomUUID } from 'node:crypto';
import { computerService, LOCAL_COMPUTER_ID } from './computer.service';
import type { ComputerSession } from './computer-session';
import { isRecordingFrame, voiceChatService, type RecordingFrame } from '../voice/voice-chat.service';
import type { ScreenFrame } from './picture-stream';

export const COMPUTER_PATH = '/api/computer';

/**
 * How the agent's screen is encoded, before any of it arrives and again whenever the
 * source restarts. Video arrives as binary frames.
 */
export interface ScreenStartFrame {
  type: 'screen_start';
  encoding: 'jpeg' | 'h264';
  /** With `h264`: the name the browser configures its decoder with. */
  codec?: string;
}

/** One picture of the agent's screen, as base64 JPEG. */
export interface ScreenPictureFrame {
  type: 'screen';
  data: string;
}

/** Why this socket is closing, when it is not the client's doing. */
export interface ComputerErrorFrame {
  type: 'error';
  message: string;
}

/**
 * The call is recording the user's screen, so the page may open its microphone.
 *
 * Answered on this socket, which is the one the request arrived on: the microphone
 * travels on the other, and two sockets have no order between them.
 */
export interface RecordingStartedFrame {
  type: 'recording_started';
}

export type ComputerFrame =
  | ScreenStartFrame
  | ScreenPictureFrame
  | ComputerErrorFrame
  | RecordingStartedFrame;

/**
 * The first byte of a binary frame says what is in it. The second is padding, so audio
 * samples start on a 2-byte boundary, and says whether a picture stands on its own.
 */
export const DESKTOP_AUDIO_FRAME = 0x02;
export const SCREEN_VIDEO_FRAME = 0x03;

function tagged(tag: number, body: Buffer, flag = 0): Buffer {
  return Buffer.concat([Buffer.from([tag, flag]), body]);
}

/**
 * How much unsent data the socket may hold before the screen is skipped.
 *
 * The desktop's audio and its screen share this socket, and the screen is the half that
 * can be skipped: a late frame of sound is heard, where a skipped picture costs one frame
 * of a stream that sends another within the tick. Roughly two pictures' worth, so an
 * ordinary burst is buffered and a client that has stopped draining is not fed.
 *
 * Video is skipped a whole run at a time, up to the next picture that stands on its own,
 * since every picture between them is read against the one before it.
 */
const SCREEN_BACKLOG_BYTES = 256 * 1024;

/**
 * How often a live socket is pinged, and so how long a client that went away silently
 * keeps the screen being captured for nobody. The chat gateway uses the same interval.
 */
const LIVENESS_INTERVAL_MS = 30_000;

/** A client socket, with the answer to the last ping sent to it. */
interface ComputerSocket extends WebSocket {
  isAlive?: boolean;
}

class ComputerEndpoint {
  private wss: WebSocketServer | null = null;
  private liveness: NodeJS.Timeout | null = null;
  /**
   * Serve this endpoint's upgrades on the shared HTTP server.
   *
   * `noServer` because a `ws` server bound with `path` answers every other path's
   * upgrade with a 400, and `/api/ws` already lives on the same server.
   */
  initialize(server: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    serveUpgrades(server, COMPUTER_PATH, (req, socket, head) => {
      // A WebSocket handshake is exempt from the same-origin policy, so the rules the
      // HTTP routes and `/api/ws` get are applied to it here.
      if (
        !isAllowedOrigin(req.headers.origin, req.headers.host, req.headers['x-forwarded-host'])
      ) {
        logger.warn(
          '[Computer] refused a handshake (origin %s, host %s, x-forwarded-host %s)',
          req.headers.origin,
          req.headers.host,
          req.headers['x-forwarded-host'],
        );
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const computerId =
        new URL(req.url ?? '/', 'http://localhost').searchParams.get('computer') || LOCAL_COMPUTER_ID;
      const session = computerService.session(computerId);
      if (!session) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Before anything else: `ws` emits `error` for a malformed frame, and an `error`
        // with no listener is an uncaught exception that takes the process down.
        ws.on('error', (err) => logger.warn({ err }, '[Computer] Socket error'));
        this.serve(ws, session);
      });
    });
    // A socket that does not answer a ping is gone, whatever TCP still believes.
    this.liveness = setInterval(() => {
      for (const client of wss.clients as Set<ComputerSocket>) {
        if (client.isAlive === false) {
          logger.info('[Computer] Ending a socket that stopped answering');
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, LIVENESS_INTERVAL_MS);
    this.liveness.unref?.();
    logger.info(`[Computer] Screen endpoint listening on ${COMPUTER_PATH}`);
  }

  private serve(ws: ComputerSocket, session: ComputerSession): void {
    const id = randomUUID();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const state = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const summary = computerService.summaries().find((item) => item.id === session.id);
      const connection = summary?.connection ?? 'disconnected';
      ws.send(
        JSON.stringify({
          type: 'computer_state',
          clientId: id,
          ...session.status(),
          connection,
          // A connected computer can still lack the permission to send its screen.
          screen: connection === 'connected' && (summary?.capabilities.includes('stream') ?? false),
        }),
      );
    };
    computerService.on('change', state);
    state();
    ws.on('message', (data, binary) => {
      if (binary) return;
      const text = data.toString();
      // A recording belongs to the call this page started rather than to the desktop it
      // shows, so those frames go to the session and the rest to the computer.
      let frame: { type?: string };
      try {
        frame = JSON.parse(text) as { type?: string };
      } catch {
        return;
      }
      if (isRecordingFrame(frame.type)) {
        voiceChatService.handleRecordingFrame(id, frame as RecordingFrame, () =>
          send(ws, { type: 'recording_started' }),
        );
        return;
      }
      session.input(id, text);
    });
    ws.on('close', () => {
      computerService.off('change', state);
      session.detach(id);
      // The pictures and the end of a recording were going to arrive on this socket.
      voiceChatService.releaseRecordingClient(id);
    });
    void session.attach(id, this.clientFor(ws)).then((detach) => {
      if (ws.readyState !== WebSocket.OPEN) detach();
      state();
    }).catch((error) => {
      send(ws, { type: 'error', message: error instanceof Error ? error.message : String(error) });
      ws.close(1011, 'computer unavailable');
    });
  }

  /** How the session sends this socket the screen and the desktop's sound. */
  private clientFor(ws: WebSocket): { screen: (frame: ScreenFrame) => void; audio: (pcm: Buffer) => void } {
    // Whether video is being skipped right now, and so whether the next picture that
    // stands on its own ends the skip. Per socket, which is per watcher.
    let skipping = false;
    return {
      screen: (frame) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (frame.kind === 'start') {
          skipping = false;
          send(ws, { type: 'screen_start', encoding: frame.encoding, codec: (frame as { codec?: string }).codec });
          return;
        }
        if (frame.kind === 'jpeg') {
          if (ws.bufferedAmount > SCREEN_BACKLOG_BYTES) return;
          send(ws, { type: 'screen', data: frame.data });
          return;
        }
        // A run of video is skipped whole: every picture between two that stand on their
        // own is read against the one before it, so resuming mid-run decodes to nothing.
        if (skipping && !frame.keyframe) return;
        if (ws.bufferedAmount > SCREEN_BACKLOG_BYTES) {
          if (!skipping) {
            skipping = true;
            logger.warn(
              '[Computer] Skipping video: %d bytes are still unsent on the client socket',
              ws.bufferedAmount,
            );
          }
          return;
        }
        skipping = false;
        ws.send(tagged(SCREEN_VIDEO_FRAME, frame.data, frame.keyframe ? 1 : 0), { binary: true });
      },
      audio: (pcm) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(tagged(DESKTOP_AUDIO_FRAME, pcm), { binary: true });
      },
    };
  }

  /** Stop taking connections; called from the process shutdown path. */
  close(): void {
    for (const ws of this.wss?.clients ?? []) ws.close(1001, 'runtime shutting down');
    if (this.liveness) clearInterval(this.liveness);
    this.liveness = null;
    this.wss?.close();
    this.wss = null;
  }
}

function send(ws: WebSocket, frame: ComputerFrame): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

export const computerEndpoint = new ComputerEndpoint();
