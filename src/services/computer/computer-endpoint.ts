/**
 * The WebSocket that carries the agent's screen, the sound of its desktop, and the user's
 * hand on it.
 *
 * The call itself is not here. A client starts and ends its voice chat on the chat
 * socket, like every other client, and opens this one once that call is live and has a
 * computer. What this carries is the computer: video several times a second, the
 * desktop's audio, and the pointer, keyboard and shared screen coming back. Behind a
 * burst of video a chat message would wait, which is the whole reason it is a socket of
 * its own.
 *
 * Binary frames out are tagged in their first byte, so a client can tell the desktop's
 * sound from a picture of it. Text frames are JSON: the screen's encoding out, and the
 * user's pointer, keyboard and shared screen in.
 */

import type { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { logger } from '../../logger';
import { isAllowedOrigin } from '../../lib/origin-guard';
import { serveUpgrades } from '../websocket-upgrades';
import { voiceChatService } from '../voice/voice-chat.service';
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

export type ComputerFrame = ScreenStartFrame | ScreenPictureFrame | ComputerErrorFrame;

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
   * The socket watching the screen, and the way to stop sending it.
   *
   * One at a time, because there is one screen and one session. A second connection takes
   * it over, which is what a page reload is: the first socket is closed and its capture
   * stopped before the new one starts its own.
   */
  private watcher: { ws: WebSocket; detach: () => void } | null = null;

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
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Before anything else: `ws` emits `error` for a malformed frame, and an `error`
        // with no listener is an uncaught exception that takes the process down.
        ws.on('error', (err) => logger.warn({ err }, '[Computer] Socket error'));
        this.serve(ws);
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

  private serve(ws: ComputerSocket): void {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // The watcher that was here goes first, and that order is the whole of it: there is
    // one screen, so attaching starts a stream that replaces the one before it, and a
    // detach run afterwards would stop the replacement and leave the original encoding
    // for nobody. A reload is two sockets whose lifetimes overlap, so this is the
    // ordinary case rather than a rare one.
    this.release();

    // The call is the chat socket's. This one only shows what that call already has, so a
    // client that opens it too early is told rather than left watching a blank canvas.
    const detach = voiceChatService.attachComputerClient(this.clientFor(ws));
    if (!detach) {
      send(ws, { type: 'error', message: 'there is no voice chat with a computer running' });
      ws.close(1011, 'no computer');
      return;
    }
    this.watcher = { ws, detach };

    ws.on('message', (data, isBinary) => {
      if (isBinary || this.watcher?.ws !== ws) return;
      voiceChatService.handleComputerInput(data.toString());
    });
    ws.on('close', () => {
      if (this.watcher?.ws === ws) this.release();
    });
  }

  /** Stop the capture the current watcher started, and forget it. */
  private release(): void {
    const watcher = this.watcher;
    this.watcher = null;
    if (!watcher) return;
    watcher.detach();
    if (watcher.ws.readyState === WebSocket.OPEN) watcher.ws.close(1000, 'replaced');
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
    this.release();
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
