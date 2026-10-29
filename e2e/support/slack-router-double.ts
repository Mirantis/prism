/**
 * The router and the Slack API proxy of Slack routed mode, as the routed-mode
 * spec plays them.
 *
 * The proxy takes the agent's proxy token, serves the methods of the
 * cross-repo contract with the parameters the agent sends to each, and forwards
 * every call it allows to the real workspace with the e2e bot token. It records
 * each call and its answer, so the spec can assert what the agent asked Slack
 * for. The router posts envelopes to the agent's `slack` port, with or without
 * the header the ingress adds once it has verified the router's signature.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** The token the agent holds in routed mode. Only the proxy knows the real one. */
export const PROXY_TOKEN = 'e2e-routed-proxy-token';

/** The methods the proxy serves, and the parameters the agent sends to each. */
export const PROXY_METHODS: Record<string, readonly string[]> = {
  'auth.test': [],
  'bots.info': ['bot'],
  'chat.postMessage': ['channel', 'text', 'blocks', 'thread_ts', 'metadata'],
  'chat.update': ['channel', 'ts', 'blocks'],
  'reactions.add': ['channel', 'timestamp', 'name'],
  'reactions.remove': ['channel', 'timestamp', 'name'],
  'assistant.threads.setStatus': ['channel_id', 'thread_ts', 'status'],
  'conversations.replies': ['channel', 'ts', 'limit'],
  'conversations.info': ['channel'],
  'conversations.members': ['channel', 'limit', 'cursor'],
  'users.info': ['user'],
  'files.getUploadURLExternal': ['filename', 'length'],
  'files.completeUploadExternal': ['files', 'channel_id', 'thread_ts'],
};

export interface ProxyCall {
  method: string;
  params: Record<string, string>;
  /** The error the proxy answered with itself, when it refused the call. */
  refused?: string;
  /** Slack's answer to a call the proxy forwarded. */
  response?: Record<string, unknown>;
}

export class SlackApiProxy {
  /**
   * Whether the agent has been added to the workspace. Until then the agent's
   * token is bound to nothing, and `auth.test` answers `invalid_auth`.
   */
  bound = false;
  readonly calls: ProxyCall[] = [];
  private server?: http.Server;

  constructor(private readonly botToken: string) {}

  /** Listen on a free loopback port; resolves the `SLACK_API_URL` to give the agent. */
  async start(): Promise<string> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `proxy_error: ${String(err)}` }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/slack/api/`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = /^\/slack\/api\/([A-Za-z.]+)$/.exec(req.url ?? '')?.[1];
    if (req.method !== 'POST' || !method) {
      res.writeHead(404).end();
      return;
    }
    const contentType = req.headers['content-type'] ?? '';
    const body = await readBody(req);
    const call: ProxyCall = { method, params: parseParams(contentType, body) };
    this.calls.push(call);

    const answer = (status: number, payload: Record<string, unknown>, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    const refuse = (error: string) => {
      call.refused = error;
      answer(200, { ok: false, error });
    };

    if (req.headers.authorization !== `Bearer ${PROXY_TOKEN}`) return refuse('invalid_auth');
    const allowed = PROXY_METHODS[method];
    if (!allowed) return refuse('unknown_method');
    if (Object.keys(call.params).some((name) => !allowed.includes(name))) return refuse('invalid_arguments');
    if (method === 'auth.test' && !this.bound) return refuse('invalid_auth');

    const forwarded = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': contentType || 'application/x-www-form-urlencoded', authorization: `Bearer ${this.botToken}` },
      body,
    });
    const response = (await forwarded.json()) as Record<string, unknown>;
    call.response = response;
    const retryAfter = forwarded.headers.get('retry-after');
    answer(forwarded.status, response, retryAfter ? { 'retry-after': retryAfter } : {});
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** The call's parameters as strings, the way a form body carries them. */
function parseParams(contentType: string, body: string): Record<string, string> {
  if (!body) return {};
  if (contentType.startsWith('application/json')) {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]),
    );
  }
  return Object.fromEntries(new URLSearchParams(body));
}

let eventSequence = 0;

/** The fields every envelope carries, with a new event id and the current time. */
export function envelopeBase(teamId: string): { version: 1; eventId: string; sentAt: string; teamId: string } {
  eventSequence += 1;
  return {
    version: 1,
    eventId: `e2e-${process.pid}-${Date.now()}-${eventSequence}`,
    sentAt: new Date().toISOString(),
    teamId,
  };
}

/** Post an envelope to the agent's `slack` port, as the ingress forwards it. */
export async function deliverEnvelope(
  slackPort: number,
  envelope: object,
  headers: Record<string, string> = { 'x-nexus-webhook-verified': '1' },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${slackPort}/agents/slack/router`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(envelope),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
