export type { SubscriptionModel as CodexModel, CallOptions, GenerateResult, StreamPart, ToolResult } from '../subscription-types';
export interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string; code?: number };
}

export interface ToolCallParams {
  callId: string;
  tool: string;
  arguments: unknown;
}

export interface UsageParams {
  tokenUsage: { last: {
    inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number;
    outputTokens: number; reasoningOutputTokens: number;
  } };
}

export type SessionEvent =
  | { type: 'text'; id: string; delta: string }
  | { type: 'tool'; id: number; callId: string; name: string; input: unknown }
  | { type: 'complete' };
