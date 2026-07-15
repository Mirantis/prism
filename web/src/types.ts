export type MessageRole = 'USER' | 'AGENT' | 'SYSTEM';
export type MessageTrigger = 'USER_INPUT' | 'HEARTBEAT' | 'CRON_TASK' | 'GOAL' | 'WEBHOOK' | 'SYSTEM';

export interface ToolCallRecord {
  tool: string;
  input: string;
  output: string;
  success: boolean;
}

export type AttachmentCategory = 'image' | 'pdf' | 'text' | 'unreadable';

/**
 * Max files staged on one message — a UX guard mirroring the runtime's
 * authoritative cap (`MAX_ATTACHMENTS_PER_MESSAGE` in src/constants.ts;
 * separate workspace, not importable). The server re-enforces it at link time.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 100;

export interface Attachment {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  category: AttachmentCategory;
}

export interface ConversationMessage {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  triggeredBy: MessageTrigger;
  toolCalls: ToolCallRecord[] | null;
  blocks: unknown[] | null;
  tokenCount: number | null;
  isCompacted: boolean;
  createdAt: string;
  attachments?: Attachment[] | null;
}

export type ThreadSource = 'DATABASE' | 'SLACK';

export interface ConversationThread {
  id: string;
  agentId: string;
  userId: string;
  /** Auto-generated from the first user message; null until then. */
  title?: string | null;
  externalThreadId: string | null;
  threadSource?: ThreadSource;
  /** The directory this conversation is rooted in (the CLI's launch cwd); null for web threads. */
  workspaceRoot?: string | null;
  createdAt: string;
  updatedAt: string;
  messages?: ConversationMessage[];
}

export interface AgentDetails {
  id: string;
  userId: string;
  name: string;
  agentType: string;
  soulMd: string | null;
  userMd: string | null;
  memoryMd: string | null;
  heartbeatMd: string | null;
  visionMd: string | null;
  agentMd: string | null;
  bootstrapMd: string | null;
  model: string | null;
  heartbeatModel: string | null;
  cronModel: string | null;
  verbose: boolean;
  status: 'RUNNING' | 'IDLE' | 'ERROR';
  lastHeartbeat: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelInfo {
  model: string;
}

/**
 * A scoped model override (heartbeat/cron). `model` is the raw override
 * (`null` when unset); `effective` is the model that scope would actually use
 * after the fallback chain (override → main model → server default).
 */
export interface OverrideModelInfo {
  model: string | null;
  effective: string;
}

export interface AgentSummary {
  agentId: string;
  userId: string;
  name: string;
}

export interface HeartbeatStatus {
  isActive: boolean;
  lastRun: string | null;
  isRunning: boolean;
  consecutiveErrors: number;
  nextRun?: string | null;
  intervalMs: number | null;
}

export interface SlackLinkStatus {
  hasDmMapping: boolean;
  hasChannelMapping: boolean;
  slackUserId: string | null;
}

export interface SlackWorkspace {
  teamId: string;
  teamName: string;
  botUserId: string;
}

export interface SlackChannelMapping {
  id: string;
  channelId: string;
  channelName: string | null;
  agentName: string;
  linkedAt: string;
  /** True for the channel that receives heartbeat alerts (and scheduled-task
   *  output with no resolvable origin channel). Exactly one per agent. */
  isMain: boolean;
}

export interface SlackHeartbeatTrigger {
  id: string;
  agentId: string;
  userId: string;
  connectionId: string;
  slackChannelId: string;
  slackChannelName: string | null;
  isActive: boolean;
  throttleSeconds: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CronTask {
  id: string;
  userId: string;
  agentId: string;
  name: string;
  schedule: string;
  instruction: string | null;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WebhookDeliverTo = 'all' | 'chat' | 'slack';

export interface WebhookSubscription {
  id: string;
  agentId: string;
  name: string;
  description: string | null;
  /** Comma-separated event-type allowlist; null = accept all events. */
  events: string | null;
  /** Prompt template ({dot.path} / {__raw__}); null = raw payload dump. */
  prompt: string | null;
  deliverTo: WebhookDeliverTo;
  deliverOnly: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An available Agent Skill (agentskills.io), as listed by GET /agents/skills. */
export interface SkillSummary {
  name: string;
  description: string;
  dirName: string;
  /** Where the skill came from: the workspace repo or the global dir. */
  source: 'workspace' | 'global';
}

/** A background goal the agent works toward across turns (GET/POST /agents/goals). */
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
