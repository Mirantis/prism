/**
 * `/api/computer-link`: where a remote computer's client holds its link open.
 *
 * The upgrade gets the origin rule every route on this server gets, so a client that is
 * not a browser, which sends no `Origin`, passes it; the platform in front of the runtime
 * authenticates the user. The client names its computer in `?computer=`, and its first
 * message is `initialize`. After that the runtime sends the requests, and the client
 * reports the person at the computer and changes to its displays and permissions.
 */

import type { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { isAllowedOrigin } from '../../../lib/origin-guard';
import prisma from '../../../lib/prisma';
import { trackEvent } from '../../../lib/telemetry';
import { serveUpgrades } from '../../websocket-upgrades';
import { computerHelpService } from '../computer-help.service';
import { computerService } from '../computer.service';
import { ComputerLink, type LinkRequest } from './computer-link';
import {
  COMPUTER_LINK_PATH,
  initializeParams,
  LINK_CLOSE,
  LINK_PROTOCOL_VERSION,
  MAX_LINK_FRAME_BYTES,
  RPC_ERROR,
} from './link-protocol';
import { RemoteComputer } from './remote-computer';
import { remoteComputerService } from './remote-computer.service';

/** How long a new link has to send `initialize`. */
const INITIALIZE_TIMEOUT_MS = 10_000;
/** The runtime pings this often, and ends a link that has not answered by the next ping. */
const PING_INTERVAL_SECONDS = 30;

/** What `computer disconnected` reports for each way a link can end. */
const CLOSE_REASONS: Record<number, string> = {
  1001: 'going_away',
  1006: 'lost',
  [LINK_CLOSE.protocolError]: 'protocol_error',
  [LINK_CLOSE.removed]: 'removed',
  [LINK_CLOSE.replaced]: 'replaced',
  [LINK_CLOSE.unsupportedVersion]: 'unsupported_version',
};

interface LinkSocket extends WebSocket {
  isAlive?: boolean;
}

function refuse(socket: { write(text: string): void; destroy(): void }, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

class ComputerLinkEndpoint {
  private wss: WebSocketServer | null = null;
  private liveness: NodeJS.Timeout | null = null;

  initialize(server: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LINK_FRAME_BYTES });
    this.wss = wss;
    serveUpgrades(server, COMPUTER_LINK_PATH, (req, socket, head) => {
      if (!isAllowedOrigin(req.headers.origin, req.headers.host, req.headers['x-forwarded-host'])) {
        logger.warn('[Computer:Link] refused a handshake (origin %s, host %s)', req.headers.origin, req.headers.host);
        refuse(socket, '403 Forbidden');
        return;
      }
      const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('computer') ?? '';
      if (!remoteComputerService.get(id)) {
        refuse(socket, '404 Not Found');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Before anything else: `ws` emits `error` for a malformed frame, and an `error`
        // with no listener is an uncaught exception that takes the process down.
        ws.on('error', (err) => logger.warn({ err }, '[Computer:Link] Socket error'));
        this.serve(ws as LinkSocket, id);
      });
    });
    this.liveness = setInterval(() => {
      for (const client of wss.clients as Set<LinkSocket>) {
        if (client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, PING_INTERVAL_SECONDS * 1000);
    this.liveness.unref?.();
    logger.info(`[Computer:Link] Listening on ${COMPUTER_LINK_PATH}`);
  }

  private serve(ws: LinkSocket, id: string): void {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    const link = new ComputerLink(ws);
    const deadline = setTimeout(() => link.close(LINK_CLOSE.protocolError, 'no initialize'), INITIALIZE_TIMEOUT_MS);
    let remote: RemoteComputer | null = null;
    let since = 0;
    let unwatch = () => {};
    // Hold and release apply in the order the person did them.
    let presence: Promise<void> = Promise.resolve();

    link.on('request', (request: LinkRequest) => {
      if (remote) {
        link.fail(request.id, RPC_ERROR.methodNotFound, `The runtime answers no ${request.method} request.`);
        return;
      }
      if (request.method !== 'initialize') {
        link.close(LINK_CLOSE.protocolError, 'initialize first');
        return;
      }
      clearTimeout(deadline);
      const parsed = initializeParams.safeParse(request.params);
      if (!parsed.success) {
        link.fail(request.id, RPC_ERROR.invalidParams, `initialize: ${parsed.error.issues[0]?.message ?? 'invalid params'}`);
        link.close(LINK_CLOSE.protocolError, 'invalid initialize');
        return;
      }
      if (parsed.data.protocolVersion !== LINK_PROTOCOL_VERSION) {
        link.fail(request.id, RPC_ERROR.invalidParams, `This runtime speaks protocol version ${LINK_PROTOCOL_VERSION}.`);
        link.close(LINK_CLOSE.unsupportedVersion, 'unsupported protocol version');
        return;
      }
      const row = remoteComputerService.get(id);
      if (!row) {
        link.close(LINK_CLOSE.removed, 'computer removed');
        return;
      }
      const hello = parsed.data;
      remote = new RemoteComputer(
        () => remoteComputerService.get(id)?.name ?? row.name,
        link,
        hello,
        () => computerService.emit('change'),
      );
      since = Date.now();
      link.answer(request.id, {
        protocolVersion: LINK_PROTOCOL_VERSION,
        computer: { id, name: row.name },
        pingIntervalSeconds: PING_INTERVAL_SECONDS,
      });
      computerService.linked(id, remote, link);
      unwatch = this.reportState(id, link);
      void remoteComputerService
        .recordConnected(id, { platform: hello.platform, clientVersion: hello.client.version })
        .catch((err) => logger.warn({ err }, '[Computer:Link] Could not record the connection'));
      trackEvent('computer connected', config.ownerUserId, {
        ...(config.agentId ? { 'agent.id': config.agentId } : {}),
        'computer.id': id,
        platform: hello.platform,
        'client.version': hello.client.version,
      });
      logger.info(`[Computer:Link] ${row.name} connected (${hello.platform}, client ${hello.client.version})`);
    });

    link.on('notification', (method: string) => {
      if (!remote) {
        link.close(LINK_CLOSE.protocolError, 'initialize first');
        return;
      }
      if (method !== 'local.hold' && method !== 'local.release') return;
      presence = presence
        .then(() => {
          // A link that was replaced or closed speaks for nobody at the computer any more.
          const current = remote;
          if (!current || !computerService.isLinked(id, current)) return;
          return method === 'local.hold' ? this.hold(id, current) : computerService.session(id)?.releaseLocally();
        })
        .catch((err) => logger.info(`[Computer:Link] ${method} on ${remote?.name}: ${String(err)}`));
    });

    link.on('binary', () => {
      if (!remote) link.close(LINK_CLOSE.protocolError, 'initialize first');
    });

    link.on('close', (code: number) => {
      clearTimeout(deadline);
      if (!remote) return;
      unwatch();
      computerService.unlinked(id, remote);
      void remote.stop();
      void remoteComputerService
        .recordSeen(id)
        .catch((err) => logger.warn({ err }, '[Computer:Link] Could not record the disconnection'));
      trackEvent('computer disconnected', config.ownerUserId, {
        ...(config.agentId ? { 'agent.id': config.agentId } : {}),
        'computer.id': id,
        reason: CLOSE_REASONS[code] ?? 'closed',
        elapsed_ms: String(Date.now() - since),
      });
      logger.info(`[Computer:Link] ${remote.name} disconnected (${code})`);
    });
  }

  /** The person at the computer takes it: secure while a help request waits on it. */
  private async hold(id: string, remote: RemoteComputer): Promise<void> {
    const session = computerService.session(id);
    if (!session || !config.agentId) return;
    const waiting = await computerHelpService.waiting(config.agentId, config.ownerUserId);
    // The link can end during the read, and then there is nobody left to release the hold.
    if (!computerService.isLinked(id, remote)) return;
    await session.holdLocally(waiting.find((help) => help.computerId === id)?.id);
  }

  /**
   * Tell the client who is using its computer and what help it waits for, whenever that
   * changes. A burst of changes is read once, after the tick that made them.
   */
  private reportState(id: string, link: ComputerLink): () => void {
    let last = '';
    let building = false;
    let again = false;
    const build = async (): Promise<void> => {
      if (building) {
        again = true;
        return;
      }
      building = true;
      try {
        do {
          again = false;
          await Promise.resolve();
          const state = await this.stateOf(id);
          const text = JSON.stringify(state);
          if (state && text !== last && link.open) {
            last = text;
            link.notify('computer.state', state);
          }
        } while (again);
      } catch (err) {
        logger.warn({ err }, '[Computer:Link] Could not read the computer state');
      } finally {
        building = false;
      }
    };
    const listener = () => void build();
    computerService.on('change', listener);
    void build();
    return () => computerService.off('change', listener);
  }

  private async stateOf(id: string) {
    const session = computerService.session(id);
    if (!session || !config.agentId) return null;
    const owner = session.access.owner;
    const help = (await computerHelpService.waiting(config.agentId, config.ownerUserId)).find(
      (item) => item.computerId === id,
    );
    const title = owner?.threadId
      ? (await prisma.conversationThread.findUnique({ where: { id: owner.threadId }, select: { title: true } }))
          ?.title
      : null;
    return {
      agentActive: owner !== null,
      watched: session.watched,
      controller: session.controller,
      owner: owner
        ? { threadId: owner.threadId ?? null, mode: owner.mode, ...(title ? { title } : {}) }
        : null,
      help: help ? { id: help.id, reason: help.reason } : null,
    };
  }

  /** Stop taking links; called from the process shutdown path, after the links close. */
  close(): void {
    for (const ws of this.wss?.clients ?? []) ws.close(LINK_CLOSE.shuttingDown, 'runtime shutting down');
    if (this.liveness) clearInterval(this.liveness);
    this.liveness = null;
    this.wss?.close();
    this.wss = null;
  }
}

export const computerLinkEndpoint = new ComputerLinkEndpoint();
