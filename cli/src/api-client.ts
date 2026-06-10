/**
 * HTTP client for the agent-runtime management API (prism-cli).
 *
 * Every endpoint resolves the single agent server-side, so no agentId or
 * userId appears in any URL. The base URL is read once from
 * `loadConfig().httpUrl` (override via `PRISM_HTTP_URL`); the trailing slash
 * is stripped so path concatenation stays clean.
 *
 * Unlike the WebSocket adapter's `loadHistory()` (which swallows errors and
 * renders an empty history), these are mutation/query calls whose failures
 * must surface — non-2xx responses throw `ApiError`.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';
import {
  AttachmentMeta,
  formatFileSize,
  MAX_ATTACHMENT_BYTES,
} from './attachments.js';

/** Error carrying the HTTP status and an optional RFC 7807-style detail. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

export interface AgentDetails {
  id: string;
  userId: string;
  name: string;
  model: string | null;
  soulMd: string;
  userMd: string;
  memoryMd: string;
  heartbeatMd: string;
  visionMd: string;
  agentMd: string;
  bootstrapMd: string;
  proactivity: number;
  verbosity: number;
  timezone: string;
  heartbeatIntervalMs: number;
  heartbeatStatus: string;
  status: string;
  lastHeartbeat: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HeartbeatStatus {
  isActive: boolean;
  lastRun: string | null;
  isRunning: boolean;
  consecutiveErrors: number;
  intervalMs?: number;
}

export interface CronTask {
  id: string;
  name: string;
  schedule: string;
  instruction: string | null;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiClient {
  getMe(): Promise<{ agentId: string; userId: string; name: string }>;
  getDetails(): Promise<AgentDetails>;
  setName(name: string): Promise<{ name: string }>;
  getModel(): Promise<{ model: string | null }>;
  setModel(model: string | null): Promise<{ model: string | null }>;
  getHeartbeatStatus(): Promise<HeartbeatStatus>;
  startHeartbeat(agent: AgentDetails): Promise<{ success: boolean; message: string }>;
  stopHeartbeat(): Promise<{ success: boolean; message: string }>;
  triggerHeartbeat(): Promise<{ success: boolean; result: unknown }>;
  setHeartbeatInterval(intervalMs: number): Promise<HeartbeatStatus>;
  listCronTasks(): Promise<CronTask[]>;
  createCronTask(input: {
    name: string;
    schedule: string;
    instruction?: string;
  }): Promise<CronTask>;
  deleteCronTask(taskId: string): Promise<{ success: boolean }>;
  uploadAttachment(filePath: string): Promise<AttachmentMeta>;
  deleteAttachment(id: string): Promise<{ success: boolean }>;
}

export class HttpApiClient implements ApiClient {
  private readonly baseUrl = loadConfig().httpUrl.replace(/\/$/, '');

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = { method };
    if (method !== 'GET' && body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }

    const res = await fetch(`${this.baseUrl}${path}`, init);
    return this.handleResponse<T>(res);
  }

  /**
   * Shared response handling for JSON and multipart calls: non-2xx → ApiError
   * (with the body's `error`/`detail` when present); 204/empty body tolerated
   * (mirrors the e2e runtimeRequest helper in setup.ts).
   */
  private async handleResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const detail = await extractErrorDetail(res);
      throw new ApiError(
        detail ?? `Request failed with status ${res.status}`,
        res.status,
        detail,
      );
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  getMe(): Promise<{ agentId: string; userId: string; name: string }> {
    return this.request('GET', '/agents/me');
  }

  async getDetails(): Promise<AgentDetails> {
    // GET /agents/details wraps the payload in { agent } — unwrap it here.
    const body = await this.request<{ agent: AgentDetails }>('GET', '/agents/details');
    return body.agent;
  }

  setName(name: string): Promise<{ name: string }> {
    return this.request('PATCH', '/agents/name', { name });
  }

  getModel(): Promise<{ model: string | null }> {
    return this.request('GET', '/agents/model');
  }

  setModel(model: string | null): Promise<{ model: string | null }> {
    return this.request('PATCH', '/agents/model', { model });
  }

  getHeartbeatStatus(): Promise<HeartbeatStatus> {
    return this.request('GET', '/agents/heartbeat/status');
  }

  startHeartbeat(agent: AgentDetails): Promise<{ success: boolean; message: string }> {
    return this.request('POST', '/agents/heartbeat/start', { agent });
  }

  stopHeartbeat(): Promise<{ success: boolean; message: string }> {
    return this.request('POST', '/agents/heartbeat/stop');
  }

  triggerHeartbeat(): Promise<{ success: boolean; result: unknown }> {
    return this.request('POST', '/agents/heartbeat/trigger');
  }

  setHeartbeatInterval(intervalMs: number): Promise<HeartbeatStatus> {
    return this.request('PATCH', '/agents/heartbeat/interval', { intervalMs });
  }

  listCronTasks(): Promise<CronTask[]> {
    return this.request('GET', '/agents/cron-tasks');
  }

  createCronTask(input: {
    name: string;
    schedule: string;
    instruction?: string;
  }): Promise<CronTask> {
    return this.request('POST', '/agents/cron-tasks', input);
  }

  deleteCronTask(taskId: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/agents/cron-tasks/${taskId}`);
  }

  /**
   * Upload a local file as a shared attachment. Pre-checks (existence, not a
   * directory, ≤10 MB, non-empty) fail fast with friendly messages before any
   * network call; the server stays authoritative and re-validates. Multipart
   * can't go through request() — Content-Type must be left unset so fetch
   * writes the multipart boundary itself. The server detects the media type
   * from magic bytes + filename, so the Blob carries no mime type.
   */
  async uploadAttachment(filePath: string): Promise<AttachmentMeta> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }
    if (stat.isDirectory()) {
      throw new Error(`${filePath} is a directory — attach a single file.`);
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `File too large (${formatFileSize(stat.size)}) — max ${formatFileSize(MAX_ATTACHMENT_BYTES)}.`,
      );
    }
    if (stat.size === 0) {
      throw new Error(`File is empty: ${filePath}`);
    }

    const data = await fs.promises.readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(data)]), path.basename(filePath));

    const res = await fetch(`${this.baseUrl}/agents/attachments`, {
      method: 'POST',
      body: form,
    });
    return this.handleResponse<AttachmentMeta>(res);
  }

  deleteAttachment(id: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/agents/attachments/${id}`);
  }
}

/**
 * Pull a human-readable message out of an error response. Prefers the JSON
 * body's `error` then `detail` field; returns undefined if the body isn't
 * JSON or carries neither.
 */
async function extractErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown; detail?: unknown };
    if (typeof body.error === 'string') return body.error;
    if (typeof body.detail === 'string') return body.detail;
  } catch {
    // Non-JSON body — fall through to undefined.
  }
  return undefined;
}

export const apiClient: ApiClient = new HttpApiClient();
