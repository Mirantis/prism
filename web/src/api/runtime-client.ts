import { ApiError } from './errors';
import type {
  AgentDetails,
  AgentSummary,
  ConversationMessage,
  ConversationThread,
  CronTask,
  HeartbeatStatus,
  SlackChannelMapping,
  SlackHeartbeatTrigger,
  SlackLinkStatus,
  SlackWorkspace,
  ModelInfo,
  ThreadStatus,
} from '@/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // For multipart/FormData uploads we must NOT set a content-type — the
  // browser writes its own header with the correct boundary.
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(isFormData ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Prefer structured `{ error, fieldErrors }` so `useFormErrors` /
    // `<FieldError>` plumbing actually fires. Fall back to text body or
    // status line.
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    let fieldErrors: Record<string, string> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { error?: string; fieldErrors?: Record<string, string> };
        if (typeof parsed.error === 'string' && parsed.error) message = parsed.error;
        if (parsed.fieldErrors && typeof parsed.fieldErrors === 'object') {
          fieldErrors = parsed.fieldErrors;
        }
      } catch {
        message = `${message}: ${raw}`;
      }
    }
    throw new ApiError(message, fieldErrors);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const runtimeApi = {
  // Single-agent identity
  me: () => request<AgentSummary>('/agents/me'),

  // Agent profile
  details: (agentId: string) =>
    request<{ agent: AgentDetails }>(`/agents/${agentId}/details`).then((r) => r.agent),

  // Heartbeat
  heartbeatStatus: (agentId: string) =>
    request<HeartbeatStatus>(`/agents/${agentId}/heartbeat/status`),
  heartbeatStart: (agentId: string, agent: AgentDetails) =>
    request<{ success: boolean }>(`/agents/${agentId}/heartbeat/start`, {
      method: 'POST',
      body: JSON.stringify({ agent }),
    }),
  heartbeatStop: (agentId: string) =>
    request<{ success: boolean }>(`/agents/${agentId}/heartbeat/stop`, { method: 'POST' }),
  heartbeatTrigger: (agentId: string) =>
    request<{ success: boolean }>(`/agents/${agentId}/heartbeat/trigger`, { method: 'POST' }),
  updateHeartbeatInterval: (agentId: string, intervalMs: number) =>
    request<HeartbeatStatus>(`/agents/${agentId}/heartbeat/interval`, {
      method: 'PATCH',
      body: JSON.stringify({ intervalMs }),
    }),
  updateAgentName: (agentId: string, name: string) =>
    request<AgentSummary>(`/agents/${agentId}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  // Model selector
  getModel: (agentId: string) => request<ModelInfo>(`/agents/${agentId}/model`),
  updateModel: (agentId: string, model: string | null) =>
    request<ModelInfo>(`/agents/${agentId}/model`, {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    }),

  // Threads
  getOrCreateActiveThread: (agentId: string, userId: string) =>
    request<ConversationThread>('/agents/threads/get-or-create-active', {
      method: 'POST',
      body: JSON.stringify({ agentId, userId }),
    }),
  listThreads: (
    agentId: string,
    userId: string,
    opts?: { status?: ThreadStatus; limit?: number },
  ) => {
    const params = new URLSearchParams({ agentId, userId });
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return request<ConversationThread[]>(`/agents/threads?${params.toString()}`);
  },
  getThread: (agentId: string, userId: string, threadId: string) => {
    const params = new URLSearchParams({ agentId, userId });
    return request<ConversationThread>(`/agents/threads/${threadId}?${params.toString()}`);
  },
  addMessage: (threadId: string, body: Partial<ConversationMessage>) =>
    request<ConversationMessage>(`/agents/threads/${threadId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Slack mappings
  slackWorkspaces: () => request<{ workspaces: SlackWorkspace[] }>('/agents/slack/workspaces'),
  slackLinkStatus: (agentId: string, connectionId: string) => {
    const params = new URLSearchParams({ connectionId });
    return request<SlackLinkStatus>(`/agents/${agentId}/slack-link-status?${params.toString()}`);
  },
  slackChannelMappings: (agentId: string, connectionId: string) => {
    const params = new URLSearchParams({ connectionId });
    return request<{ channels: SlackChannelMapping[] }>(
      `/agents/${agentId}/slack-channel-mappings?${params.toString()}`,
    );
  },
  createSlackVerificationCode: (body: {
    type: 'DM' | 'CHANNEL';
    lensUserId: string;
    connectionId: string;
    agentId: string;
    agentName?: string;
    expiresAt: string;
  }) =>
    request<{ code: string }>('/agents/slack/create-verification-code', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteDmMapping: (agentId: string, connectionId: string) => {
    const params = new URLSearchParams({ connectionId });
    return request<{ deleted: number }>(
      `/agents/${agentId}/slack/dm-mapping?${params.toString()}`,
      { method: 'DELETE' },
    );
  },
  deleteChannelMapping: (channelId: string, connectionId?: string) => {
    const params = new URLSearchParams();
    if (connectionId) params.set('connectionId', connectionId);
    const q = params.toString();
    return request<{ deleted: number }>(
      `/agents/slack/channel-mapping/${channelId}${q ? `?${q}` : ''}`,
      { method: 'DELETE' },
    );
  },

  // Heartbeat triggers
  listHeartbeatTriggers: (agentId: string, userId: string) => {
    const params = new URLSearchParams({ userId });
    return request<SlackHeartbeatTrigger[]>(
      `/agents/${agentId}/slack-heartbeat-trigger?${params.toString()}`,
    );
  },
  createHeartbeatTrigger: (
    agentId: string,
    body: { connectionId: string; channelId: string; channelName?: string; userId: string; throttleSeconds?: number },
  ) =>
    request<SlackHeartbeatTrigger>(`/agents/${agentId}/slack-heartbeat-trigger`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateHeartbeatTriggerThrottle: (
    agentId: string,
    body: { triggerId: string; userId: string; throttleSeconds: number },
  ) =>
    request<SlackHeartbeatTrigger>(`/agents/${agentId}/slack-heartbeat-trigger`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteHeartbeatTrigger: (agentId: string, triggerId: string, userId: string) => {
    const params = new URLSearchParams({ userId });
    return request<{ success: true }>(
      `/agents/${agentId}/slack-heartbeat-trigger/${triggerId}?${params.toString()}`,
      { method: 'DELETE' },
    );
  },

  // Cron tasks
  listCronTasks: (agentId: string) =>
    request<CronTask[]>(`/agents/${agentId}/cron-tasks`),
  createCronTask: (agentId: string, body: { name: string; schedule: string; instruction: string }) =>
    request<CronTask>(`/agents/${agentId}/cron-tasks`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteCronTask: (agentId: string, taskId: string) =>
    request<{ success: true }>(`/agents/${agentId}/cron-tasks/${taskId}`, { method: 'DELETE' }),

  // Backup / restore
  importAgent: (agentId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ ok: true; restarting: true }>(`/agents/${agentId}/import`, {
      method: 'POST',
      body: fd,
    });
  },
};

export function webSocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/ws`;
}
