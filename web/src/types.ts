export type MessageRole = 'USER' | 'AGENT' | 'SYSTEM';
export type MessageTrigger = 'USER_INPUT' | 'HEARTBEAT' | 'CRON_TASK' | 'GOAL' | 'WEBHOOK';

/** Mirrors `ToolOutputTruncation` in src/types.ts. */
export interface ToolOutputTruncation {
  totalChars: number;
  keptChars: number;
  omittedChars: number;
}

export interface ToolCallRecord {
  tool: string;
  input: string;
  /** The model-facing view of the result, which is what was stored. */
  output: string;
  success: boolean;
  /** Present only when that view was cut. */
  truncated?: ToolOutputTruncation;
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
  /** Content deleted by the retention sweep (7 days) — metadata only. */
  expired?: boolean;
}

export interface ConversationMessage {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  triggeredBy: MessageTrigger;
  toolCalls: ToolCallRecord[] | null;
  blocks: unknown[] | null;
  isCompacted: boolean;
  createdAt: string;
  attachments?: Attachment[] | null;
}

export type ThreadSource = 'DATABASE' | 'SLACK';

/**
 * How much of the model's context window a thread is using.
 *
 * Derived by the runtime, not here: the percentage needs the model's context
 * window, which comes from a models.dev catalog the runtime owns (this workspace
 * can't import it), and the token counts only exist in the provider's response.
 * Absent until the thread's first turn completes, and absent entirely for a model
 * whose window the runtime doesn't recognize.
 */
export interface ContextUsage {
  threadId: string;
  /** The model that actually ran, which can differ from the agent's configured model. */
  modelId: string;
  usedTokens: number;
  windowTokens: number;
  /** Share of the window consumed, as an integer 0-100. */
  usedPercent: number;
}

/**
 * Compaction progress frame (WS `compaction` envelope): older history was (or
 * is being) folded into the thread's summary so the model's context shrinks.
 */
export interface CompactionEvent {
  threadId: string;
  /** `skipped` is a benign no-op (nothing to compact), never an error. */
  status: 'started' | 'completed' | 'failed' | 'skipped';
  trigger: 'auto' | 'manual';
  tokensBefore?: number | null;
  tokensAfter?: number | null;
  messagesCompacted?: number;
  /** Failed only — short reason, shown for manual compactions. */
  error?: string;
  /** Skipped only — why there was nothing to do. */
  detail?: string;
}

/** Update progress frame (WS `update` envelope). Install-level, not per-thread. */
export interface UpdateEvent {
  status: 'available' | 'updating' | 'failed';
  version: string;
  /** Failed only — machine-readable reason. */
  errorCode?: string;
}

/** GET /agents/update/status response. */
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
  /** Last recorded context occupancy; null before the thread's first turn. */
  contextUsage?: ContextUsage | null;
}

/** The seven identity documents, each an editable tab on the Profile page. */
export type DocumentField =
  | 'agentMd'
  | 'soulMd'
  | 'userMd'
  | 'heartbeatMd'
  | 'memoryMd'
  | 'visionMd'
  | 'bootstrapMd';

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
  lockedIn: boolean;
  status: 'RUNNING' | 'IDLE' | 'ERROR';
  lastHeartbeat: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One entry in an identity document's history. The content is read on demand. */
export interface DocumentRevisionSummary {
  id: string;
  /** Who wrote it. A heartbeat write and a chat write are both the agent. */
  actor: 'agent' | 'user';
  method: 'seed' | 'replace' | 'edit' | 'clear' | 'rest' | 'rollback';
  /** The note the writer left, empty when it left none. */
  reason: string;
  /** True while this revision holds exactly what the document reads now. */
  matchesCurrent: boolean;
  createdAt: string;
}

/** One revision with its content. A single read carries no history flag. */
export interface DocumentRevision
  extends Omit<DocumentRevisionSummary, 'matchesCurrent'> {
  content: string;
}

export interface DocumentRevisionHistory {
  field: string;
  /** How many revisions one document keeps before its oldest is dropped. */
  bound: number;
  /** True while the document differs from its newest revision. */
  drifted: boolean;
  /** Newest first. */
  revisions: DocumentRevisionSummary[];
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
  /** Whether this runtime can give the agent a computer; false leaves the page out. */
  hasComputer?: boolean;
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
  /** Where the skill came from: the workspace repo, the global dir, or a plugin. */
  source: 'workspace' | 'global' | 'plugin';
  /** The contributing plugin's id — present only when `source` is `'plugin'`. */
  pluginId?: string;
}

/** An installed Agent Plugin (agent-plugins.org), as listed by GET /agents/plugins. */
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

// ============================================================================
// Activity page
// ============================================================================

/** Token totals (GET /agents/activity/llm-usage). */
export interface LlmUsageSummary {
  windowHours: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  noCacheTokens: number;
  /** null when no provider in the window reported a cache breakdown. */
  cacheHitPercent: number | null;
  /** Model calls in the window — not a turn count. */
  calls: number;
}

/** One tool call in the Activity feed (GET /agents/activity/tool-calls). */
export interface ToolCallHistoryEntry extends ToolCallRecord {
  id: string;
  timestamp: string;
  messageId: string;
  threadId: string;
  threadTitle: string | null;
  triggeredBy: MessageTrigger;
}

export interface ToolCallHistoryPage {
  items: ToolCallHistoryEntry[];
  nextCursor: string | null;
}
export interface ComputerHelp {
  type: 'computer_help';
  id: string;
  reason: string;
  tab?: number;
  threadId?: string;
  status: 'waiting' | 'continued' | 'dismissed';
}

export interface ComputerStatus {
  available: boolean;
  running: boolean;
  starting: boolean;
  paused: boolean;
  controller: string | null;
  owner: { id: string; threadId?: string; mode: string } | null;
  waiting: { id: string; threadId?: string; mode: string }[];
  help?: ComputerHelp[];
}
