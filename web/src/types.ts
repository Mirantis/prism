export type MessageRole = 'USER' | 'AGENT' | 'SYSTEM';
export type MessageTrigger = 'USER_INPUT' | 'HEARTBEAT' | 'CRON_TASK' | 'SYSTEM';
export type ThreadStatus = 'ACTIVE' | 'NON_ACTIVE';

export interface ToolCallRecord {
  tool: string;
  input: string;
  output: string;
  success: boolean;
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
}

export interface ConversationThread {
  id: string;
  agentId: string;
  userId: string;
  status: ThreadStatus;
  externalThreadId: string | null;
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
  status: 'RUNNING' | 'IDLE' | 'ERROR';
  lastHeartbeat: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelInfo {
  model: string;
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

export interface TeamsLinkStatus {
  hasDmMapping: boolean;
  hasChannelMapping: boolean;
  teamsUserId: string | null;
}

export interface TeamsConnection {
  appId: string;
  tenantId: string | null;
  botId: string;
}

export interface TeamsChannelMapping {
  id: string;
  channelId: string;
  channelName: string | null;
  agentName: string;
  linkedAt: string;
}

export interface TeamsHeartbeatTrigger {
  id: string;
  agentId: string;
  userId: string;
  connectionId: string;
  teamsChannelId: string;
  teamsChannelName: string | null;
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
