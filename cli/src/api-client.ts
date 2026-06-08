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

import { loadConfig } from './config.js';

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

    if (!res.ok) {
      const detail = await extractErrorDetail(res);
      throw new ApiError(
        detail ?? `Request failed with status ${res.status}`,
        res.status,
        detail,
      );
    }

    // A successful mutation may reply 204 No Content (or an empty body) —
    // common for DELETE and plausible for the heartbeat stop/trigger routes —
    // in which case res.json() would throw and surface a succeeded call as an
    // error. Read the text first and only parse when there's something to parse
    // (mirrors the e2e runtimeRequest helper in setup.ts).
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
