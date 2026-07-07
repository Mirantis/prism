/**
 * Agent Runtime Types
 *
 * Request/response contracts for the agent runtime.
 */

import { ConversationMessage } from './prompts/context-builder';

// ============================================================================
// Agent Status
// ============================================================================

export type AgentHeartbeatStatus = 'ENABLED' | 'STOPPED';

// ============================================================================
// Context (fetched from backend internal API)
// ============================================================================

export interface AgentContext {
  soulMd: string;
  userMd: string;
  memoryMd: string;
  heartbeatMd: string;
  bootstrapMd: string;
  visionMd: string;
  agentMd: string;
  agentName: string;
  agentId: string;
  userId: string;
  model: string | null;
  /** Heartbeat-specific model override; falls back to `model`, then env default. */
  heartbeatModel: string | null;
  /** Cron/scheduled-task model override; falls back to `model`, then env default. */
  cronModel: string | null;
  isBootstrapPhase: boolean;
  conversationSummary: string | null;
  recentMessages: ConversationMessage[];
  lastHeartbeatAlert?: string;
  lastHeartbeatAlertAt?: number;
  /** Per-turn runtime events surfaced authoritatively in the system prompt. */
  runtimeNotices?: string[];
}

// ============================================================================
// Invoke Request (used by queue worker, heartbeat, cron, subagent)
// ============================================================================

export interface SlackTriggerMessage {
  sender: string;
  text: string;
  timestamp: string;
}

interface InvokeRequestBase {
  userId: string;
  agentId: string;
  mode: 'chat' | 'heartbeat' | 'cron' | 'subagent' | 'goal' | 'webhook';
  prompt: string;
  threadId?: string;
  /**
   * Optional per-thread workspace root for shell tools' cwd. When unset, shell
   * tools fall back to the global SHELL_WORKSPACE_ROOT (see `resolveWorkspace`).
   */
  workspaceRoot?: string;
  /**
   * Originating channel of this turn, threaded through so the `create_goal`
   * tool can record where to deliver a goal's autonomous turns. Defaults to
   * 'websocket' when unset.
   */
  originChannel?: 'slack' | 'websocket';
  originChannelId?: string;
  lastHeartbeatAlert?: string;
  lastHeartbeatAlertAt?: number;
  slackMessages?: SlackTriggerMessage[];
  /**
   * Transient, authoritative notices about events that occurred while
   * preparing this turn (e.g. an attachment that failed to download). Injected
   * into the system prompt — the model follows these far more reliably than
   * text embedded in the user message.
   */
  runtimeNotices?: string[];
  /**
   * When provided, aborting this signal stops the in-flight LLM generation
   * (the underlying Bedrock request is cancelled). Threaded into both
   * generateText() calls. On abort, invokeStream closes the step stream
   * without surfacing an error step — already-completed steps are preserved.
   */
  abortSignal?: AbortSignal;
}

/**
 * Whether this turn originates from a Slack *channel* message. When it does,
 * the channel's human-readable name (no `#`) travels with it so the
 * channel-participation system prompt can name it. The two are coupled as a
 * discriminated union: wherever `isChannelMessage` is true, `channelName` is
 * guaranteed to be a `string` (no null-checking needed downstream).
 */
export type ChannelOrigin =
  | { isChannelMessage: true; channelName: string }
  | { isChannelMessage?: false; channelName?: undefined };

export type InvokeRequest = InvokeRequestBase & ChannelOrigin;

// ============================================================================
// Response Types
// ============================================================================

export interface UIBlock {
  type: string;
  [key: string]: unknown;
}

export interface ToolCallRecord {
  tool: string;
  input: string;
  output: string;
  success: boolean;
  timestamp: string;
}

export interface InvokeError {
  type: 'budget_exceeded';
  detail?: string | null;
}

export interface InvokeStep {
  text: string;
  toolCalls: ToolCallRecord[];
  // Total tokens (input + output) the model reported for this step, when the
  // provider returns usage. Aggregated by invoke() into InvokeResponse.usage so
  // callers (e.g. the goal loop's per-goal token budget) can meter spend.
  usage?: { totalTokens: number };
  blocks?: UIBlock[];
  // Ids of MessageAttachment rows the agent shared during this step (via the
  // share_file tool). The delivery layer links these to the published message
  // and each channel adapter renders/uploads them.
  attachmentIds?: string[];
  // Set when this step represents a friendly error message produced by
  // invokeStream's error path (so invoke() can surface structured metadata
  // in InvokeResponse.error without needing its own try/catch).
  error?: InvokeError;
}

export interface InvokeResponse {
  response: string;
  toolCalls: ToolCallRecord[];
  blocks?: UIBlock[];
  // Aggregated across all steps — files the agent shared this invocation.
  attachmentIds?: string[];
  // Sum of per-step totalTokens across the invocation (0 when the provider
  // reported no usage). Used by the goal loop to meter per-goal token budgets.
  usage?: { totalTokens: number };
  steps: InvokeStep[];
  error?: InvokeError;
}
