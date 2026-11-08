import type { ThreadMode } from '@/lib/chat-socket/protocol';

export type MessageRole = 'USER' | 'AGENT' | 'SYSTEM';
/** `AGENT_MESSAGE` marks a USER message that another agent of the project sent. */
export type MessageTrigger = 'USER_INPUT' | 'HEARTBEAT' | 'CRON_TASK' | 'GOAL' | 'WEBHOOK' | 'AGENT_MESSAGE';

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
  /**
   * Who wrote a USER message, when their connection was named: `senderId` tells
   * one person from another, `senderName` is shown. Neither decides anything.
   */
  senderId?: string | null;
  senderName?: string | null;
  /** For a message from another agent: `message`, `ask`, or a `notice` from the delivery service. */
  agentMessageKind?: 'message' | 'ask' | 'notice' | null;
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
  /** Completed only — the conversation was compacted while it sat idle. */
  idle?: boolean;
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
  /** The IANA zone the agent's schedules and daily reset are read in. */
  timezone: string;
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

export type ModelTier = 'small' | 'medium' | 'large';

/**
 * How the agent's turns pick a model. Each field has the stored value (`null`
 * when the agent has not set it) and the value in force after the deployment
 * default.
 */
export interface ModelSelectionInfo {
  mode: { override: 'fixed' | 'auto' | null; effective: 'fixed' | 'auto' };
  tiers: Record<ModelTier, { override: string | null; effective: string | null }>;
}

export type ModelSelectionPatch = Partial<
  { mode: 'fixed' | 'auto' | null } & Record<ModelTier, string | null>
>;

export interface AgentSummary {
  agentId: string;
  userId: string;
  name: string;
  /** Whether this runtime can give the agent a computer; false leaves the page out. */
  hasComputer?: boolean;
  /** `single` leaves out every way to start or switch a conversation. */
  threadMode?: ThreadMode;
}

export interface HeartbeatStatus {
  isActive: boolean;
  lastRun: string | null;
  isRunning: boolean;
  consecutiveErrors: number;
  nextRun?: string | null;
  intervalMs: number | null;
}

/** Where a heartbeat run may post. */
export interface HeartbeatDelivery {
  deliverTo: DeliverTo;
  channelIds: string[];
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

export interface TeamsLinkStatus {
  hasDmMapping: boolean;
  hasChannelMapping: boolean;
  teamsUserId: string | null;
}

export interface TeamsWorkspace {
  tenantId: string;
  clientId: string;
  name: string;
}

export interface TeamsChannelMapping {
  id: string;
  conversationId: string;
  channelName: string | null;
  agentName: string;
  linkedAt: string;
  /** True for the channel that receives heartbeat alerts (and scheduled-task
   *  output with no resolvable origin channel). Exactly one per agent. */
  isMain: boolean;
}

export interface CronTask {
  id: string;
  userId: string;
  agentId: string;
  name: string;
  schedule: string;
  /** A cron schedule, as opposed to one run at a set time. */
  recurring: boolean;
  instruction: string | null;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** The conversation a one-off task continues in, if it continues one. */
  threadId: string | null;
  /** Where the result goes; a task that continues a conversation answers there. */
  deliverTo: DeliverTo;
  /** Linked channels of the target's channel to post to; empty = its default destination. */
  channelIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** The fields a person writes when they create or edit a scheduled task. */
export interface CronTaskInput {
  name: string;
  schedule: string;
  instruction: string;
  deliverTo: DeliverTo;
  channelIds: string[];
}

/** Where a webhook subscription or a scheduled task posts its message. */
export type DeliverTo = 'all' | 'chat' | 'slack' | 'teams' | 'none';

/**
 * Sender-verification scheme. Deliberately generic — no provider names: the
 * operator points `authHeader`/`authPrefix` at whatever the sender uses.
 */
export type WebhookAuthType = 'none' | 'token' | 'hmac';
export type WebhookAuthAlgorithm = 'sha256' | 'sha1' | 'sha512';
export type WebhookAuthEncoding = 'hex' | 'base64';

/** The inbound receiver: whether it is on, and where senders reach it. */
export interface WebhookReceiver {
  enabled: boolean;
  /** The port senders POST to, apart from the one serving this UI. */
  port: number;
  /** That port's public origin, when the deployment exposes one. */
  publicUrl: string | null;
}

export interface WebhookSubscription {
  id: string;
  agentId: string;
  name: string;
  description: string | null;
  /** Comma-separated event-type allowlist; null = accept all events. */
  events: string | null;
  /** Prompt template ({dot.path} / {__raw__}); null = raw payload dump. */
  prompt: string | null;
  deliverTo: DeliverTo;
  /** Linked Slack channel ids a Slack delivery posts to; empty = the DM, else the main channel. */
  slackChannelIds: string[];
  deliverOnly: boolean;
  isActive: boolean;
  authType: WebhookAuthType;
  /** Header carrying the token/signature; null when authType is 'none'. */
  authHeader: string | null;
  /** Literal stripped from the header value before comparing (e.g. 'sha256='). */
  authPrefix: string | null;
  authAlgorithm: WebhookAuthAlgorithm;
  authEncoding: WebhookAuthEncoding;
  /** HMAC only: the URL the sender signs after the body; null when it signs the body alone. */
  authSignedUrl: string | null;
  /** Whether a secret is stored. The secret itself is never returned. */
  hasSecret: boolean;
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
  /** The same window per model, most tokens first. */
  byModel: ModelUsage[];
}

export interface ModelUsage {
  model: string;
  calls: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
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

/** Mirrors `WEBHOOK_RUN_STATUSES` in src/services/webhook-run.service.ts. */
export type WebhookRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'budget_exceeded'
  | 'delivered'
  | 'suppressed';

/** One webhook event in the Activity feed (GET /agents/activity/webhook-runs). */
export interface WebhookRunSummary {
  id: string;
  name: string;
  event: string;
  status: WebhookRunStatus;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** The message the run delivered, if it delivered one. */
  message: {
    id: string;
    threadId: string;
    threadTitle: string | null;
    /** The thread is a web conversation, not a Slack or Teams destination's own thread. */
    inWebChat: boolean;
  } | null;
}

export interface WebhookRunPage {
  items: WebhookRunSummary[];
  nextCursor: string | null;
}

/** GET /agents/activity/webhook-runs/:id */
export interface WebhookRunDetail extends WebhookRunSummary {
  delivered: { content: string; toolCalls: ToolCallRecord[] } | null;
}
export interface ComputerHelp {
  type: 'computer_help';
  id: string;
  reason: string;
  tab?: number;
  /** A sign-in answered here rather than at the keyboard. */
  credentials?: boolean;
  /** What the page asks for. A second step of a sign-in asks for the password alone. */
  credentialFields?: 'both' | 'password';
  /** Where those are typed. */
  site?: string;
  /** The computer the work is blocked on; without one, the runtime's own. */
  computerId?: string;
  threadId?: string;
  status: 'waiting' | 'continued' | 'dismissed';
}

/** The id of the runtime's own computer. */
export const LOCAL_COMPUTER_ID = 'local';

/** The computer a help request is about. */
export function helpComputerId(help: Pick<ComputerHelp, 'computerId'>): string {
  return help.computerId ?? LOCAL_COMPUTER_ID;
}

/** One computer as `GET /agents/computers` lists it. */
export interface ComputerSummary {
  id: string;
  kind: 'local' | 'remote';
  name: string;
  connection: 'connected' | 'disconnected';
  platform: string | null;
  clientVersion: string | null;
  display: { width: number; height: number } | null;
  capabilities: string[];
  problems: { capability: string; message: string }[];
  lastConnectedAt: string | null;
  lastSeenAt: string | null;
  owner: { threadId?: string; mode: string } | null;
  controller: 'viewer' | 'local' | null;
}

export function computerHelpBlocks(message: ConversationMessage): ComputerHelp[] {
  return message.blocks?.filter(
    (block): block is ComputerHelp =>
      block !== null &&
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'computer_help',
  ) ?? [];
}

export interface ComputerStatus {
  /** Which computer this is. */
  computerId?: string;
  /** Set on a viewer socket's state, where a remote computer can be offline. */
  connection?: 'connected' | 'disconnected';
  /** Set on a viewer socket's state: whether the computer can send its screen now. */
  screen?: boolean;
  available: boolean;
  running: boolean;
  starting: boolean;
  paused: boolean;
  /** A takeover answering a help request: Prism is stopped for as long as it lasts. */
  secure: boolean;
  controller: string | null;
  owner: { id: string; threadId?: string; mode: string } | null;
  waiting: { id: string; threadId?: string; mode: string }[];
  help?: ComputerHelp[];
  /** On the chat socket's `computer` frame: every computer the agent has. */
  computers?: ComputerSummary[];
}

/** A coding agent a person can sign in to their own subscription. */
export type CodingAgentId = 'claude-code' | 'codex';

export type CodingAgentSignInStatus = 'waiting' | 'checking' | 'signed_in' | 'failed' | 'expired';

/** One sign-in to a coding agent's subscription, as the runtime reports it. */
export interface CodingAgentSignIn {
  id: string;
  agent: CodingAgentId;
  status: CodingAgentSignInStatus;
  /** The page the person signs in on. */
  url: string | null;
  /** The code the person enters on that page; Codex only. */
  userCode: string | null;
  expiresAt: string;
  error: string | null;
}

/** One row of `GET /agents/coding-agents`. */
export interface CodingAgentSummary {
  agent: CodingAgentId;
  name: string;
  /** The coding agent's CLI is installed where the agent's commands run. */
  available: boolean;
  /** Coding tasks run on the person's subscription, not on the deployment's models. */
  subscription: boolean;
  /** The deployment holds the subscription on, so a sign-out leaves it on. */
  forced: boolean;
  account: { plan: string; email: string } | null;
  /** A sign-in that is still open. */
  attempt: CodingAgentSignIn | null;
}

/** A chat message block: the agent asks the person to sign a coding agent in. */
export interface CodingAgentSignInBlock {
  type: 'coding_agent_sign_in';
  /** The request's id. */
  id: string;
  agent: CodingAgentId;
  status: 'waiting' | 'signed_in';
}

export interface QuestionCardOption {
  label: string;
  detail?: string;
}

export interface QuestionCardQuestion {
  text: string;
  header?: string;
  options: QuestionCardOption[];
  /** The label of the option the agent recommends. */
  recommended?: string;
  allowOther: boolean;
  multiSelect: boolean;
}

export interface QuestionCardAnswer {
  options: number[];
  other?: string;
}

/** A chat message block: the agent's questions, with answer options to choose from. */
export interface QuestionCardBlock {
  type: 'question_card';
  id: string;
  status: 'waiting' | 'answered' | 'answered_in_chat';
  /** One short line from the agent, in plain text. */
  intro?: string;
  questions: QuestionCardQuestion[];
  otherMaxLength: number;
  answers?: QuestionCardAnswer[];
  answeredBy?: { id: string; name: string } | null;
}

const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';

function isOption(value: unknown): value is QuestionCardOption {
  const option = value as QuestionCardOption | null;
  return typeof option?.label === 'string' && isOptionalString(option.detail);
}

function isQuestion(value: unknown): value is QuestionCardQuestion {
  const question = value as QuestionCardQuestion | null;
  return (
    typeof question?.text === 'string' &&
    isOptionalString(question.header) &&
    isOptionalString(question.recommended) &&
    typeof question.allowOther === 'boolean' &&
    typeof question.multiSelect === 'boolean' &&
    Array.isArray(question.options) &&
    question.options.every(isOption)
  );
}

function isAnswer(value: unknown): value is QuestionCardAnswer {
  const answer = value as QuestionCardAnswer | null;
  return Array.isArray(answer?.options) && answer.options.every(Number.isInteger) && isOptionalString(answer.other);
}

function isAnsweredBy(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const person = value as { id?: unknown; name?: unknown };
  return typeof person.id === 'string' && typeof person.name === 'string';
}

/** The whole shape is checked, so a malformed block falls back to the message text. */
export function isQuestionCard(value: unknown): value is QuestionCardBlock {
  const card = value as QuestionCardBlock | null;
  return (
    card?.type === 'question_card' &&
    typeof card.id === 'string' &&
    ['waiting', 'answered', 'answered_in_chat'].includes(card.status) &&
    typeof card.otherMaxLength === 'number' &&
    isOptionalString(card.intro) &&
    isAnsweredBy(card.answeredBy) &&
    Array.isArray(card.questions) &&
    card.questions.length > 0 &&
    card.questions.every(isQuestion) &&
    (card.answers === undefined ||
      (Array.isArray(card.answers) && card.answers.length === card.questions.length && card.answers.every(isAnswer)))
  );
}

export function questionCardBlocks(message: ConversationMessage): QuestionCardBlock[] {
  return message.blocks?.filter(isQuestionCard) ?? [];
}

export function codingAgentSignInBlocks(message: ConversationMessage): CodingAgentSignInBlock[] {
  return message.blocks?.filter(
    (block): block is CodingAgentSignInBlock =>
      block !== null &&
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'coding_agent_sign_in',
  ) ?? [];
}
