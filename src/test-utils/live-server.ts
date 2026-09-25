/**
 * A local GPT-Live server for unit tests: it answers `session.start` and `session.close`
 * the way the API does, records every frame the client sends, and lets a test send any
 * server event. The event shapes follow frames recorded from the live endpoint.
 */

import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

export interface LiveServer {
  url: string;
  /** Every JSON frame the client sent, in order. */
  sent: Record<string, any>[];
  /** Resolves once the client has sent `session.start`. */
  started: Promise<Record<string, any>>;
  /** Send one server event. */
  emit: (event: Record<string, unknown>) => void;
  /** Close from the server's side after `session.closed` with this reason. */
  closeWith: (reason: string, seconds?: number) => void;
  /** Wait until the client has sent a frame matching `predicate`. */
  waitFor: (predicate: (frame: Record<string, any>) => boolean) => Promise<Record<string, any>>;
  dispose: () => Promise<void>;
}

export interface LiveServerOptions {
  /** Answer `session.start` with this error instead of `session.started`. */
  refuseWith?: { code: string; message: string };
}

export async function startLiveServer(options: LiveServerOptions = {}): Promise<LiveServer> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;

  const sent: Record<string, any>[] = [];
  let waiters: { predicate: (f: Record<string, any>) => boolean; resolve: (f: Record<string, any>) => void }[] = [];
  let socket: ServerSocket | null = null;
  let resolveStarted!: (frame: Record<string, any>) => void;
  const started = new Promise<Record<string, any>>((resolve) => (resolveStarted = resolve));

  const send = (event: Record<string, unknown>) => socket?.send(JSON.stringify(event));

  server.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, any>;
      sent.push(frame);
      const met = waiters.filter((waiter) => waiter.predicate(frame));
      waiters = waiters.filter((waiter) => !met.includes(waiter));
      for (const waiter of met) waiter.resolve(frame);
      if (frame.type === 'session.start') {
        resolveStarted(frame);
        if (options.refuseWith) {
          send({ type: 'error', error: { type: 'invalid_request_error', ...options.refuseWith } });
          return;
        }
        send({ type: 'session.started', session: { id: 'live_test', ...frame.session, status: 'active' } });
      }
      if (frame.type === 'session.close') {
        send({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 42 } });
        ws.close(1000);
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/v1/live/sessions`,
    sent,
    started,
    emit: send,
    closeWith: (reason, seconds = 7) => {
      send({ type: 'session.closed', reason, usage: { seconds } });
      socket?.close(1000);
    },
    waitFor: (predicate) => {
      const found = sent.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    dispose: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
