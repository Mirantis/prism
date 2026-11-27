import { ApiError } from './errors';
import type {
  AgentDetails,
  AgentSummary,
  Attachment,
  CodingAgentId,
  CodingAgentSignIn,
  CodingAgentSummary,
  ChatGptAuthStatus,
  ChatGptSignInStart,
  ConversationMessage,
  ConversationThread,
  CronTask,
  CronTaskInput,
  DocumentField,
  DocumentRevision,
  DocumentRevisionHistory,
  HeartbeatDelivery,
  HeartbeatStatus,
  SlackChannelMapping,
  SlackHeartbeatTrigger,
  SlackLinkStatus,
  SlackWorkspace,
  TeamsChannelMapping,
  TeamsLinkStatus,
  TeamsWorkspace,
  ModelInfo,
  LlmProviderStatus,
  OverrideModelInfo,
  ModelSelectionInfo,
  ModelSelectionPatch,
  SkillSummary,
  PluginSummary,
  QuestionCardAnswer,
  QuestionCardBlock,
  GeneratedUiBlock,
  Goal,
  WebhookReceiver,
  WebhookSubscription,
  UpdateStatus,
  LlmUsageSummary,
  RequestSpendDetail,
  SourcedSpendCategory,
  SourceSpend,
  SpendBreakdown,
  SpendPeriodLength,
  SpendPeriods,
  ThreadSpendDetail,
  ThreadSpendPage,
  ToolCallHistoryPage,
  WebhookRunDetail,
  WebhookRunPage,
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
    let body: unknown;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { error?: string; fieldErrors?: Record<string, string> };
        body = parsed;
        if (typeof parsed.error === 'string' && parsed.error) message = parsed.error;
        if (parsed.fieldErrors && typeof parsed.fieldErrors === 'object') {
          fieldErrors = parsed.fieldErrors;
        }
      } catch {
        message = `${message}: ${raw}`;
      }
    }
    throw new ApiError(message, fieldErrors, res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const runtimeApi = {
  /** The first answer wins; a later one is refused with 409 and the stored card in the error's body. */
  answerQuestionCard: (id: string, answers: QuestionCardAnswer[]) =>
    request<{ card: QuestionCardBlock; replyPending?: true }>(`/agents/question-cards/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),

  pressGeneratedUiButton: (id: string, elementId: string) =>
    request<{ ui: GeneratedUiBlock; replyPending?: true }>(`/agents/generated-ui/${encodeURIComponent(id)}/press`, {
      method: 'POST',
      body: JSON.stringify({ elementId }),
    }),

  // Single-agent identity
  me: () => request<AgentSummary>('/agents/me'),

  // Agent profile
  details: () =>
    request<{ agent: AgentDetails }>('/agents/details').then((r) => r.agent),

  // Heartbeat
  heartbeatStatus: () =>
    request<HeartbeatStatus>('/agents/heartbeat/status'),
  heartbeatStart: (agent: AgentDetails) =>
    request<{ success: boolean }>('/agents/heartbeat/start', {
      method: 'POST',
      body: JSON.stringify({ agent }),
    }),
  heartbeatStop: () =>
    request<{ success: boolean }>('/agents/heartbeat/stop', { method: 'POST' }),
  heartbeatTrigger: () =>
    request<{ success: boolean }>('/agents/heartbeat/trigger', { method: 'POST' }),
  updateHeartbeatInterval: (intervalMs: number) =>
    request<HeartbeatStatus>('/agents/heartbeat/interval', {
      method: 'PATCH',
      body: JSON.stringify({ intervalMs }),
    }),
  heartbeatDelivery: () => request<HeartbeatDelivery>('/agents/heartbeat/delivery'),
  updateHeartbeatDelivery: (changes: Partial<HeartbeatDelivery>) =>
    request<HeartbeatDelivery>('/agents/heartbeat/delivery', {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),
  updateAgentName: (name: string) =>
    request<AgentSummary>('/agents/name', {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  // Model selector
  getModel: () => request<ModelInfo>('/agents/model'),
  getLlmProvider: () => request<LlmProviderStatus>('/agents/llm-provider'),
  updateModel: (model: string | null) =>
    request<ModelInfo>('/agents/model', {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    }),

  // Heartbeat-specific model override (empty → falls back to the main model)
  getHeartbeatModel: () => request<OverrideModelInfo>('/agents/heartbeat-model'),
  updateHeartbeatModel: (model: string | null) =>
    request<OverrideModelInfo>('/agents/heartbeat-model', {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    }),

  // Cron/scheduled-task model override (empty → falls back to the main model)
  getCronModel: () => request<OverrideModelInfo>('/agents/cron-model'),
  updateCronModel: (model: string | null) =>
    request<OverrideModelInfo>('/agents/cron-model', {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    }),

  // Fixed or Auto model selection, and the three Auto tiers
  getModelSelection: () => request<ModelSelectionInfo>('/agents/model-selection'),
  updateModelSelection: (patch: ModelSelectionPatch) =>
    request<ModelSelectionInfo>('/agents/model-selection', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // Coding agents, and signing one in to the person's own subscription
  codingAgents: () =>
    request<{ agents: CodingAgentSummary[] }>('/agents/coding-agents').then((r) => r.agents),
  startCodingAgentSignIn: (agent: CodingAgentId) =>
    request<CodingAgentSignIn>(`/agents/coding-agents/${agent}/sign-in`, { method: 'POST' }),
  codingAgentSignIn: (agent: CodingAgentId, id: string) =>
    request<CodingAgentSignIn>(`/agents/coding-agents/${agent}/sign-in/${encodeURIComponent(id)}`),
  // Answers once the code is checked, with the sign-in `signed_in` or `failed`.
  sendClaudeSignInCode: (id: string, code: string) =>
    request<CodingAgentSignIn>(
      `/agents/coding-agents/claude-code/sign-in/${encodeURIComponent(id)}/code`,
      { method: 'POST', body: JSON.stringify({ code }) },
    ),
  signOutCodingAgent: (agent: CodingAgentId) =>
    request<CodingAgentSummary>(`/agents/coding-agents/${agent}/sign-out`, { method: 'POST' }),

  // Sign in with ChatGPT (`LLM_PROVIDER=chatgpt`)
  chatGptAuthStatus: () => request<ChatGptAuthStatus>('/agents/chatgpt-auth/status'),
  startChatGptSignIn: () => request<ChatGptSignInStart>('/agents/chatgpt-auth/start', { method: 'POST' }),
  signOutChatGpt: () => request<ChatGptAuthStatus>('/agents/chatgpt-auth/sign-out', { method: 'POST' }),

  // Verbose (delivery mode)
  updateVerbose: (verbose: boolean) =>
    request<{ verbose: boolean }>('/agents/verbose', {
      method: 'PATCH',
      body: JSON.stringify({ verbose }),
    }),

  // Locked-in mode (workspace markdown files read-only to the agent's own tools)
  updateLockedIn: (lockedIn: boolean) =>
    request<{ lockedIn: boolean }>('/agents/locked-in', {
      method: 'PATCH',
      body: JSON.stringify({ lockedIn }),
    }),

  // Replace one identity document. `reason` is the note its history shows.
  updateWorkspaceDoc: (field: DocumentField, content: string, reason?: string) =>
    request<{ field: DocumentField; content: string }>(`/agents/documents/${field}`, {
      method: 'PATCH',
      body: JSON.stringify({ content, reason }),
    }),

  // Identity-document history. `expectedRevisionId` is the newest revision the
  // list was read with, so a document written since then refuses the restore.
  documentRevisions: (field: string) =>
    request<DocumentRevisionHistory>(`/agents/documents/${field}/revisions`),
  documentRevision: (field: string, id: string) =>
    request<DocumentRevision>(`/agents/documents/${field}/revisions/${id}`),
  restoreDocumentRevision: (
    field: string,
    id: string,
    expectedRevisionId: string,
    reason?: string,
  ) =>
    request<{ field: string; content: string; revision: DocumentRevision }>(
      `/agents/documents/${field}/revisions/${id}/restore`,
      { method: 'POST', body: JSON.stringify({ expectedRevisionId, reason }) },
    ),

  // Threads
  getOrCreateLatestThread: (agentId: string, userId: string) =>
    request<ConversationThread>('/agents/threads/get-or-create-latest', {
      method: 'POST',
      body: JSON.stringify({ agentId, userId }),
    }),
  // Start a fresh conversation; the server reuses the newest thread when it
  // is still untouched, so repeated clicks don't pile up empty threads.
  createThread: (agentId: string, userId: string) =>
    request<ConversationThread>('/agents/threads', {
      method: 'POST',
      body: JSON.stringify({ agentId, userId }),
    }),
  listThreads: (
    agentId: string,
    userId: string,
    opts?: { limit?: number; threadSource?: 'DATABASE' | 'SLACK' },
  ) => {
    const params = new URLSearchParams({ agentId, userId });
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.threadSource) params.set('threadSource', opts.threadSource);
    return request<ConversationThread[]>(`/agents/threads?${params.toString()}`);
  },
  // With `page`, the thread holds `page.limit` messages: the newest, or those before `page.before`.
  getThread: (agentId: string, userId: string, threadId: string, page?: { limit: number; before?: string }) => {
    const params = new URLSearchParams({ agentId, userId });
    if (page) params.set('limit', String(page.limit));
    if (page?.before) params.set('before', page.before);
    return request<ConversationThread>(`/agents/threads/${threadId}?${params.toString()}`);
  },
  addMessage: (threadId: string, body: Partial<ConversationMessage>) =>
    request<ConversationMessage>(`/agents/threads/${threadId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Slack mappings
  slackWorkspaces: () => request<{ workspaces: SlackWorkspace[] }>('/agents/slack/workspaces'),
  // There is one Slack connection, so these read/delete routes are not scoped by
  // connectionId (see the runtime's `lib/slack-source.ts`).
  slackLinkStatus: () => request<SlackLinkStatus>('/agents/slack-link-status'),
  slackChannelMappings: () =>
    request<{ channels: SlackChannelMapping[] }>('/agents/slack-channel-mappings'),
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
  deleteDmMapping: () =>
    request<{ deleted: number }>('/agents/slack/dm-mapping', { method: 'DELETE' }),
  deleteChannelMapping: (channelId: string) =>
    request<{ deleted: number }>(`/agents/slack/channel-mapping/${channelId}`, {
      method: 'DELETE',
    }),
  setMainChannel: (channelId: string) =>
    request<{ ok: true }>(`/agents/slack/channel-mapping/${channelId}/main`, {
      method: 'PUT',
    }),

  // Teams mappings — mirror of the Slack block. Conversation ids contain `:`
  // and `@` (`19:…@thread.tacv2`), hence the encodeURIComponent on path params.
  teamsWorkspaces: () => request<{ workspaces: TeamsWorkspace[] }>('/agents/teams/workspaces'),
  teamsLinkStatus: () => request<TeamsLinkStatus>('/agents/teams-link-status'),
  teamsChannelMappings: () =>
    request<{ channels: TeamsChannelMapping[] }>('/agents/teams-channel-mappings'),
  createTeamsVerificationCode: (body: {
    type: 'DM' | 'CHANNEL';
    lensUserId: string;
    connectionId: string;
    agentId: string;
    agentName?: string;
    expiresAt: string;
  }) =>
    request<{ code: string }>('/agents/teams/create-verification-code', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteTeamsDmMapping: () =>
    request<{ deleted: number }>('/agents/teams/dm-mapping', { method: 'DELETE' }),
  deleteTeamsChannelMapping: (conversationId: string) =>
    request<{ deleted: number }>(
      `/agents/teams/channel-mapping/${encodeURIComponent(conversationId)}`,
      { method: 'DELETE' },
    ),
  setTeamsMainChannel: (conversationId: string) =>
    request<{ ok: true }>(
      `/agents/teams/channel-mapping/${encodeURIComponent(conversationId)}/main`,
      { method: 'PUT' },
    ),

  // Heartbeat triggers
  listHeartbeatTriggers: (userId: string) => {
    const params = new URLSearchParams({ userId });
    return request<SlackHeartbeatTrigger[]>(
      `/agents/slack-heartbeat-trigger?${params.toString()}`,
    );
  },
  createHeartbeatTrigger: (
    body: { connectionId: string; channelId: string; channelName?: string; userId: string; throttleSeconds?: number },
  ) =>
    request<SlackHeartbeatTrigger>('/agents/slack-heartbeat-trigger', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateHeartbeatTriggerThrottle: (
    body: { triggerId: string; userId: string; throttleSeconds: number },
  ) =>
    request<SlackHeartbeatTrigger>('/agents/slack-heartbeat-trigger', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteHeartbeatTrigger: (triggerId: string, userId: string) => {
    const params = new URLSearchParams({ userId });
    return request<{ success: true }>(
      `/agents/slack-heartbeat-trigger/${triggerId}?${params.toString()}`,
      { method: 'DELETE' },
    );
  },

  // Cron tasks
  listCronTasks: () =>
    request<CronTask[]>('/agents/cron-tasks'),
  createCronTask: (body: CronTaskInput) =>
    request<CronTask>('/agents/cron-tasks', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateCronTask: (taskId: string, body: Partial<CronTaskInput>) =>
    request<CronTask>(`/agents/cron-tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteCronTask: (taskId: string) =>
    request<{ success: true }>(`/agents/cron-tasks/${taskId}`, { method: 'DELETE' }),

  // Webhooks — inbound receiver toggle + subscription CRUD
  getWebhookReceiver: () => request<WebhookReceiver>('/agents/webhooks/receiver'),
  setWebhookReceiver: (enabled: boolean) =>
    request<{ enabled: boolean }>('/agents/webhooks/receiver', {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  listWebhookSubscriptions: () =>
    request<WebhookSubscription[]>('/agents/webhook-subscriptions'),
  createWebhookSubscription: (body: {
    name: string;
    description?: string;
    events?: string;
    prompt?: string;
    deliverTo?: WebhookSubscription['deliverTo'];
    slackChannelIds?: string[];
    deliverOnly?: boolean;
    coalesceSeconds?: number | null;
    authType?: WebhookSubscription['authType'];
    authHeader?: string;
    authPrefix?: string;
    authAlgorithm?: WebhookSubscription['authAlgorithm'];
    authEncoding?: WebhookSubscription['authEncoding'];
    authSignedUrl?: string;
    /** Write-only: never returned by the API (see `hasSecret`). */
    secret?: string;
  }) =>
    request<WebhookSubscription>('/agents/webhook-subscriptions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateWebhookSubscription: (
    id: string,
    body: Partial<
      Pick<
        WebhookSubscription,
        | 'isActive'
        | 'description'
        | 'events'
        | 'prompt'
        | 'deliverTo'
        | 'slackChannelIds'
        | 'deliverOnly'
        | 'coalesceSeconds'
        | 'authType'
        | 'authHeader'
        | 'authPrefix'
        | 'authAlgorithm'
        | 'authEncoding'
        | 'authSignedUrl'
      >
    > & { secret?: string },
  ) =>
    request<WebhookSubscription>(`/agents/webhook-subscriptions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteWebhookSubscription: (id: string) =>
    request<{ success: true }>(`/agents/webhook-subscriptions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  // Skills (Agent Skills — agentskills.io). threadId scopes the listing to that
  // thread's workspace (repo skills); web threads have no workspaceRoot so it's
  // a harmless no-op that returns global skills.
  listSkills: (threadId?: string) =>
    request<SkillSummary[]>(
      `/agents/skills${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ''}`,
    ),
  runSkill: (name: string, threadId?: string) =>
    request<{ threadId: string; skill: string }>(
      `/agents/skills/${encodeURIComponent(name)}/run`,
      { method: 'POST', body: JSON.stringify(threadId ? { threadId } : {}) },
    ),

  // Plugins (Agent Plugins — agent-plugins.org). Installed once for the
  // container rather than per workspace, so this takes no thread id.
  listPlugins: () => request<PluginSummary[]>('/agents/plugins'),

  // Compaction (fold older history into the thread's summary). 202 + WS
  // `compaction` frames carry the progress; 409 when there's nothing to compact.
  compactThread: (threadId: string) =>
    request<{ threadId: string }>(
      `/agents/threads/${encodeURIComponent(threadId)}/compact`,
      { method: 'POST' },
    ),

  // Goals (background objectives the agent works toward across turns). Goal-turn
  // output streams back over the WebSocket channel, so create tags originChannel.
  createGoal: (input: { threadId: string; objective: string; tokenBudget?: number }) =>
    request<Goal>('/agents/goals', {
      method: 'POST',
      body: JSON.stringify({ ...input, originChannel: 'websocket' }),
    }),
  getThreadGoal: (threadId: string) =>
    request<Goal | null>(`/agents/threads/${encodeURIComponent(threadId)}/goal`),
  listGoals: () => request<Goal[]>('/agents/goals'),
  stopGoal: (goalId: string) =>
    request<Goal>(`/agents/goals/${encodeURIComponent(goalId)}`, { method: 'DELETE' }),
  pauseGoal: (goalId: string) =>
    request<Goal>(`/agents/goals/${encodeURIComponent(goalId)}/pause`, { method: 'POST' }),
  resumeGoal: (goalId: string) =>
    request<Goal>(`/agents/goals/${encodeURIComponent(goalId)}/resume`, { method: 'POST' }),

  // Backup / restore
  importAgent: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ ok: true; restarting: true }>('/agents/import', {
      method: 'POST',
      body: fd,
    });
  },

  // Self-update. POST answers 202 before the download starts; progress
  // arrives as WS `update` frames and the outcome lands in updateStatus().
  updateStatus: () => request<UpdateStatus>('/agents/update/status'),
  applyUpdate: () =>
    request<{ ok: true; version: string }>('/agents/update', {
      method: 'POST',
    }),

  // Shared files
  uploadAttachment: (file: File, threadId?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (threadId) fd.append('threadId', threadId);
    return request<Attachment>('/agents/attachments', { method: 'POST', body: fd });
  },
  deleteAttachment: (id: string) =>
    request<{ success: true }>(`/agents/attachments/${id}`, { method: 'DELETE' }),

  // Activity
  llmUsage: (hours: number) =>
    request<LlmUsageSummary>(`/agents/activity/llm-usage?hours=${hours}`),
  listToolCalls: (opts?: { limit?: number; cursor?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const query = params.toString();
    return request<ToolCallHistoryPage>(`/agents/activity/tool-calls${query ? `?${query}` : ''}`);
  },
  listWebhookRuns: (opts?: { limit?: number; cursor?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const query = params.toString();
    return request<WebhookRunPage>(`/agents/activity/webhook-runs${query ? `?${query}` : ''}`);
  },
  getWebhookRun: (id: string) =>
    request<WebhookRunDetail>(`/agents/activity/webhook-runs/${encodeURIComponent(id)}`),

  // Spending
  spendingSummary: (range: SpendRange) =>
    request<SpendBreakdown & { from: string; to: string }>(`/agents/spending?${rangeQuery(range)}`),
  spendingPeriods: (period: SpendPeriodLength, count: number) =>
    request<SpendPeriods>(`/agents/spending/periods?period=${period}&count=${count}`),
  spendingThreads: (range: SpendRange, opts: { limit: number; offset: number }) =>
    request<ThreadSpendPage>(`/agents/spending/threads?${rangeQuery(range)}&limit=${opts.limit}&offset=${opts.offset}`),
  spendingThread: (threadId: string) =>
    request<ThreadSpendDetail>(`/agents/spending/threads/${encodeURIComponent(threadId)}`),
  spendingRequest: (requestId: string) =>
    request<RequestSpendDetail>(`/agents/spending/requests/${encodeURIComponent(requestId)}`),
  spendingSources: (category: SourcedSpendCategory, range: SpendRange) =>
    request<{ sources: SourceSpend[] }>(`/agents/spending/sources?category=${category}&${rangeQuery(range)}`),
};

/** A time range, as ISO strings. */
export interface SpendRange {
  from: string;
  to: string;
}

function rangeQuery(range: SpendRange): string {
  return new URLSearchParams({ from: range.from, to: range.to }).toString();
}

/** URL to download/preview a stored attachment by id. */
export function attachmentUrl(id: string): string {
  return `/agents/attachments/${id}`;
}

export function webSocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/ws`;
}

/**
 * The computer socket: the agent's screen and the sound of its desktop out, the user's
 * pointer, keyboard and shared screen in.
 *
 * The call itself is on the chat socket. This one is opened once that call is live, and
 * carries only the computer, so a burst of video cannot put a chat message behind it.
 */
export const COMPUTER_SOCKET_PATH = '/api/computer';

/** The socket for one computer: the runtime's own, `local`, unless another is named. */
export function computerWebSocketUrl(computerId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}${COMPUTER_SOCKET_PATH}?computer=${encodeURIComponent(computerId)}`;
}
