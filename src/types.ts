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
  proactivity: number;
  verbosity: number;
  model: string | null;
  isBootstrapPhase: boolean;
  conversationSummary: string | null;
  recentMessages: ConversationMessage[];
  lastHeartbeatAlert?: string;
  lastHeartbeatAlertAt?: number;
}

// ============================================================================
// Invoke Request (used by queue worker, heartbeat, cron, subagent)
// ============================================================================

export interface SlackTriggerMessage {
  sender: string;
  text: string;
  timestamp: string;
}

export interface InvokeRequest {
  userId: string;
  agentId: string;
  mode: 'chat' | 'heartbeat' | 'cron' | 'subagent';
  prompt: string;
  threadId?: string;
  isChannelMessage?: boolean;
  lastHeartbeatAlert?: string;
  lastHeartbeatAlertAt?: number;
  slackMessages?: SlackTriggerMessage[];
}

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
  blocks?: UIBlock[];
  // Set when this step represents a friendly error message produced by
  // invokeStream's error path (so invoke() can surface structured metadata
  // in InvokeResponse.error without needing its own try/catch).
  error?: InvokeError;
}

export interface InvokeResponse {
  response: string;
  toolCalls: ToolCallRecord[];
  blocks?: UIBlock[];
  steps: InvokeStep[];
  error?: InvokeError;
}
