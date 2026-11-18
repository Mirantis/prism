/**
 * The Prism runtime as the ACP bridge uses it: the chat socket for sending and
 * for the event stream, and REST for conversations, history and uploads.
 */

import type { EventEmitter } from 'node:events';
import { RequestError } from '@agentclientprotocol/sdk';
import type { OutgoingMessage } from '../chat-protocol.js';
import { wsUrlFromHttpUrl } from '../config.js';
import { coerceMessage, coerceThreadSummary, type ThreadSummary, type TuiMessage } from '../tui-adapter.js';
import { WsClient } from '../ws-client.js';

/** The most messages one `GET /messages` page holds. */
export const HISTORY_PAGE = 200;

const REQUEST_TIMEOUT_MS = 15_000;

export interface Runtime {
  /** The chat socket's events: `welcome`, `event`, `sent`, `sendFailed` and `unsupported`. */
  readonly events: EventEmitter;
  /** Start a conversation whose shell and file tools work in `cwd`. */
  createThread(cwd: string): Promise<string>;
  /** The newest conversations, or with `workspaceRoot` the newest of those rooted in that folder. */
  listThreads(workspaceRoot?: string): Promise<ThreadSummary[]>;
  /**
   * One page of a conversation, oldest first: its newest messages, or the ones
   * before `before`. Null when the runtime has no such conversation.
   */
  messages(threadId: string, before?: string): Promise<TuiMessage[] | null>;
  /** Store a file for a message to name, and return its attachment id. */
  upload(data: Uint8Array, filename: string): Promise<string>;
  /** Where a client downloads a stored attachment. */
  attachmentUrl(attachmentId: string): string;
  send(message: OutgoingMessage): void;
  /** Stop a conversation's work. False when the socket is down, so nothing was asked. */
  cancel(threadId: string): boolean;
  close(): void;
}

export class HttpRuntime implements Runtime {
  readonly events: EventEmitter;
  private readonly httpUrl: string;
  private readonly socket: WsClient;

  constructor(httpUrl: string, version: string) {
    this.httpUrl = httpUrl.replace(/\/$/, '');
    this.socket = new WsClient({
      url: wsUrlFromHttpUrl(this.httpUrl),
      clientName: 'prism-acp',
      clientVersion: version,
    });
    this.events = this.socket.events;
    // The socket reconnects by itself. stdout belongs to the protocol, so the reason goes to stderr.
    this.events.on('error', (err: Error) => process.stderr.write(`prism acp: ${err.message}\n`));
  }

  async createThread(cwd: string): Promise<string> {
    const res = await this.request('/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: cwd }),
    });
    const body = (await res.json()) as { threadId: string };
    return body.threadId;
  }

  async listThreads(workspaceRoot?: string): Promise<ThreadSummary[]> {
    const query = workspaceRoot ? `?${new URLSearchParams({ workspaceRoot }).toString()}` : '';
    const res = await this.request(`/threads${query}`);
    const body = (await res.json()) as unknown[];
    return body.map(coerceThreadSummary).filter((thread): thread is ThreadSummary => thread !== null);
  }

  async messages(threadId: string, before?: string): Promise<TuiMessage[] | null> {
    const params = new URLSearchParams({ threadId, limit: String(HISTORY_PAGE) });
    if (before) params.set('before', before);
    const res = await this.request(`/messages?${params.toString()}`, undefined, 404);
    if (res.status === 404) return null;
    const body = (await res.json()) as unknown[];
    return body.map(coerceMessage).filter((message): message is TuiMessage => message !== null);
  }

  async upload(data: Uint8Array, filename: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(data)]), filename);
    const res = await this.request('/agents/attachments', { method: 'POST', body: form });
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  attachmentUrl(attachmentId: string): string {
    return `${this.httpUrl}/agents/attachments/${attachmentId}`;
  }

  send(message: OutgoingMessage): void {
    this.socket.send(message);
  }

  cancel(threadId: string): boolean {
    return this.socket.cancel(threadId);
  }

  close(): void {
    this.socket.close();
  }

  /** A response with a 2xx status, or with `allowed`. Anything else is the request's error. */
  private async request(path: string, init?: RequestInit, allowed?: number): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.httpUrl}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw RequestError.internalError(undefined, `the Prism server at ${this.httpUrl} did not answer`);
    }
    if (res.ok || res.status === allowed) return res;
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const reason = typeof body?.error === 'string' ? body.error : `status ${res.status}`;
    throw RequestError.internalError(undefined, `the Prism server refused the request: ${reason}`);
  }
}
