/**
 * HTTP client for the agent-runtime management API (prism-cli).
 *
 * Every endpoint resolves the single agent server-side, so no agentId or
 * userId appears in any URL. The base URL is read once from
 * `loadConfig().httpUrl` (override via `PRISM_HTTP_URL`); the trailing slash
 * is stripped so path concatenation stays clean.
 *
 * Unlike the WebSocket adapter's history reload (which keeps the screen as
 * it is on an error), these are mutation/query calls whose failures must
 * surface — non-2xx responses throw `ApiError`.
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
  heartbeatModel: string | null;
  cronModel: string | null;
  soulMd: string;
  userMd: string;
  memoryMd: string;
  heartbeatMd: string;
  visionMd: string;
  agentMd: string;
  bootstrapMd: string;
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
  /** A cron schedule, as opposed to one run at a set time. */
  recurring: boolean;
  instruction: string | null;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The delivery targets this CLI offers. */
export type WebhookDeliverTo = 'all' | 'chat' | 'slack' | 'teams' | 'none';

/** GET /agents/webhook-subscriptions row, less the fields the TUI does not show. */
export interface WebhookSubscription {
  id: string;
  name: string;
  description: string | null;
  /** Comma-separated event-type allowlist; null accepts every event. */
  events: string | null;
  /** Prompt or message template; null sends the raw payload. */
  prompt: string | null;
  /** A `WebhookDeliverTo`, or a target that a newer runtime added. */
  deliverTo: string;
  /** Linked Slack channel ids a Slack delivery posts to; absent from an older runtime. */
  slackChannelIds?: string[];
  deliverOnly: boolean;
  isActive: boolean;
  authType: 'none' | 'token' | 'hmac';
}

/** PATCH body: an empty string clears `description`, `events` or `prompt`. */
export interface WebhookSubscriptionUpdate {
  isActive?: boolean;
  description?: string;
  events?: string;
  prompt?: string;
  deliverTo?: string;
  /** An empty list posts to the DM, else the main channel. */
  slackChannelIds?: string[];
  deliverOnly?: boolean;
}

/** A Slack channel linked to the agent, from GET /agents/slack-channel-mappings. */
export interface SlackChannel {
  channelId: string;
  channelName: string | null;
  /** The agent's main channel. */
  isMain: boolean;
}

export interface Goal {
  id: string;
  threadId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  turnCount: number;
  maxTurns: number;
  stallCount: number;
  lastReason: string | null;
  originChannel: string;
  originChannelId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface SkillSummary {
  name: string;
  description: string;
  dirName: string;
  /** Where the skill came from: the workspace repo, the global dir, or a plugin. */
  source: 'workspace' | 'global' | 'plugin';
  /** The contributing plugin's id — present only when `source` is `'plugin'`. */
  pluginId?: string;
}

export interface PluginSummary {
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** Names of the skills this plugin contributed to the catalog. */
  skills: string[];
  /** Names of the MCP servers its mcp.json declares. */
  mcpServers: string[];
  /** Non-fatal problems found while loading it. */
  diagnostics: string[];
}

/** GET /agents/update/status response (mirrors web/src/types.ts). */
export interface UpdateStatus {
  enabled: boolean;
  /** Why the updater is off; null when enabled. */
  reason: 'disabled_by_env' | 'not_sea_install' | 'dev_build' | null;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  applying: boolean;
  lastAttempt: {
    versionFrom: string;
    versionTo: string;
    trigger: 'AUTO' | 'MANUAL';
    outcome: 'PENDING' | 'SUCCESS' | 'FAILURE';
    errorCode: string | null;
    startedAt: string;
    finishedAt: string | null;
  } | null;
}

/** The agent's model mode and its three Auto tiers, stored and in force. */
export interface ModelSelectionInfo {
  mode: { override: 'fixed' | 'auto' | null; effective: 'fixed' | 'auto' };
  tiers: Record<'small' | 'medium' | 'large', { override: string | null; effective: string | null }>;
}

export interface ApiClient {
  getMe(): Promise<{ agentId: string; userId: string; name: string }>;
  getDetails(): Promise<AgentDetails>;
  setName(name: string): Promise<{ name: string }>;
  setAgentGuide(agentMd: string): Promise<{ agentMd: string }>;
  getModel(): Promise<{ model: string | null }>;
  setModel(model: string | null): Promise<{ model: string | null }>;
  getHeartbeatModel(): Promise<{ model: string | null; effective: string }>;
  setHeartbeatModel(model: string | null): Promise<{ model: string | null; effective: string }>;
  getCronModel(): Promise<{ model: string | null; effective: string }>;
  setCronModel(model: string | null): Promise<{ model: string | null; effective: string }>;
  setModelMode(mode: 'fixed' | 'auto'): Promise<ModelSelectionInfo>;
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
  /** Edit a task; a field left out keeps its value. */
  updateCronTask(
    taskId: string,
    update: { name?: string; schedule?: string; instruction?: string },
  ): Promise<CronTask>;
  deleteCronTask(taskId: string): Promise<{ success: boolean }>;
  listWebhookSubscriptions(): Promise<WebhookSubscription[]>;
  updateWebhookSubscription(id: string, update: WebhookSubscriptionUpdate): Promise<WebhookSubscription>;
  listSlackChannels(): Promise<SlackChannel[]>;
  createGoal(input: { threadId: string; objective: string; tokenBudget?: number }): Promise<Goal>;
  getThreadGoal(threadId: string): Promise<Goal | null>;
  listGoals(): Promise<Goal[]>;
  stopGoal(goalId: string): Promise<Goal>;
  pauseGoal(goalId: string): Promise<Goal>;
  resumeGoal(goalId: string): Promise<Goal>;
  uploadAttachment(filePath: string): Promise<AttachmentMeta>;
  deleteAttachment(id: string): Promise<{ success: boolean }>;
  downloadAttachment(id: string): Promise<Buffer>;
  listSkills(threadId?: string): Promise<SkillSummary[]>;
  runSkill(name: string, threadId?: string): Promise<{ threadId: string; skill: string }>;
  listPlugins(): Promise<PluginSummary[]>;
  compactThread(threadId: string): Promise<{ threadId: string }>;
  signInForComputer(
    helpId: string,
    credentials: { username: string; password: string },
  ): Promise<{ success: boolean }>;
  updateStatus(): Promise<UpdateStatus>;
  applyUpdate(): Promise<{ ok: true; version: string }>;
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

  setAgentGuide(agentMd: string): Promise<{ agentMd: string }> {
    return this.request('PATCH', '/agents/agent-guide', { agentMd });
  }

  getModel(): Promise<{ model: string | null }> {
    return this.request('GET', '/agents/model');
  }

  setModel(model: string | null): Promise<{ model: string | null }> {
    return this.request('PATCH', '/agents/model', { model });
  }

  getHeartbeatModel(): Promise<{ model: string | null; effective: string }> {
    return this.request('GET', '/agents/heartbeat-model');
  }

  setHeartbeatModel(model: string | null): Promise<{ model: string | null; effective: string }> {
    return this.request('PATCH', '/agents/heartbeat-model', { model });
  }

  getCronModel(): Promise<{ model: string | null; effective: string }> {
    return this.request('GET', '/agents/cron-model');
  }

  setCronModel(model: string | null): Promise<{ model: string | null; effective: string }> {
    return this.request('PATCH', '/agents/cron-model', { model });
  }

  setModelMode(mode: 'fixed' | 'auto'): Promise<ModelSelectionInfo> {
    return this.request('PATCH', '/agents/model-selection', { mode });
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

  updateCronTask(
    taskId: string,
    update: { name?: string; schedule?: string; instruction?: string },
  ): Promise<CronTask> {
    return this.request('PATCH', `/agents/cron-tasks/${taskId}`, update);
  }

  deleteCronTask(taskId: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/agents/cron-tasks/${taskId}`);
  }

  listWebhookSubscriptions(): Promise<WebhookSubscription[]> {
    return this.request('GET', '/agents/webhook-subscriptions');
  }

  updateWebhookSubscription(id: string, update: WebhookSubscriptionUpdate): Promise<WebhookSubscription> {
    return this.request('PATCH', `/agents/webhook-subscriptions/${encodeURIComponent(id)}`, update);
  }

  async listSlackChannels(): Promise<SlackChannel[]> {
    const { channels } = await this.request<{ channels: SlackChannel[] }>('GET', '/agents/slack-channel-mappings');
    return channels;
  }

  createGoal(input: { threadId: string; objective: string; tokenBudget?: number }): Promise<Goal> {
    // The CLI receives goal-turn output over the WS gateway, so deliver there.
    return this.request('POST', '/agents/goals', { ...input, originChannel: 'websocket' });
  }

  getThreadGoal(threadId: string): Promise<Goal | null> {
    return this.request('GET', `/agents/threads/${threadId}/goal`);
  }

  listGoals(): Promise<Goal[]> {
    return this.request('GET', '/agents/goals');
  }

  stopGoal(goalId: string): Promise<Goal> {
    return this.request('DELETE', `/agents/goals/${goalId}`);
  }

  pauseGoal(goalId: string): Promise<Goal> {
    return this.request('POST', `/agents/goals/${goalId}/pause`);
  }

  resumeGoal(goalId: string): Promise<Goal> {
    return this.request('POST', `/agents/goals/${goalId}/resume`);
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

  // Skills live on the management router under /agents (shared with the web SPA,
  // which reaches the runtime via the /agents proxy). Passing the active thread
  // id scopes the listing to that thread's workspace (repo skills included).
  listSkills(threadId?: string): Promise<SkillSummary[]> {
    const qs = threadId ? `?threadId=${encodeURIComponent(threadId)}` : '';
    return this.request('GET', `/agents/skills${qs}`);
  }

  runSkill(name: string, threadId?: string): Promise<{ threadId: string; skill: string }> {
    return this.request('POST', `/agents/skills/${encodeURIComponent(name)}/run`, threadId ? { threadId } : {});
  }

  // Plugins are installed once for the container rather than per workspace, so
  // this listing takes no thread id.
  listPlugins(): Promise<PluginSummary[]> {
    return this.request('GET', '/agents/plugins');
  }

  // Compaction (fold older history into the thread's summary). 202 + WS
  // `compaction` frames carry the progress; 409 when there's nothing to compact.
  compactThread(threadId: string): Promise<{ threadId: string }> {
    return this.request('POST', `/agents/threads/${encodeURIComponent(threadId)}/compact`);
  }

  // The answer to a sign-in the agent asked for. The runtime types it into the
  // browser and resolves the request; 409 carries what stopped it.
  signInForComputer(
    helpId: string,
    credentials: { username: string; password: string },
  ): Promise<{ success: boolean }> {
    return this.request(
      'POST',
      `/agents/computer/help/${encodeURIComponent(helpId)}/credentials`,
      credentials,
    );
  }

  // Self-update. POST answers 202 before the download starts; the outcome
  // arrives via WS `update` frames and the status endpoint's attempt record.
  // 409 when the updater is off, nothing is newer, or an update is already in
  // progress.
  updateStatus(): Promise<UpdateStatus> {
    return this.request('GET', '/agents/update/status');
  }

  applyUpdate(): Promise<{ ok: true; version: string }> {
    return this.request('POST', '/agents/update');
  }

  /**
   * Download a stored attachment's raw bytes. Used by `/save` to write a file
   * the agent shared to local disk. Non-2xx → ApiError (410 when the content
   * has expired — files are kept for 7 days).
   */
  async downloadAttachment(id: string): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/agents/attachments/${id}`);
    if (!res.ok) {
      const detail = await extractErrorDetail(res);
      throw new ApiError(
        detail ?? `Request failed with status ${res.status}`,
        res.status,
        detail,
      );
    }
    return Buffer.from(await res.arrayBuffer());
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
