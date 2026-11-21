/**
 * Records the tokens a Realtime session reports: on every `response.done`, and on
 * every finished input transcription.
 */

import { llmCallService, type CallTokens } from '../llm-call.service';

/** Where a session's calls are spent. */
export interface RealtimeSpend {
  purpose: 'voice-chat' | 'meeting' | 'dictation';
  /** One id for the whole session, so a session's spend reads as one request. */
  requestId: string;
  threadId?: string;
}

/** The `usage` object of a Realtime event. A duration-billed transcription reports seconds, not tokens. */
interface RealtimeUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    audio_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: { audio_tokens?: number };
  };
  output_token_details?: { audio_tokens?: number };
}

function tokensOf(usage: RealtimeUsage | undefined): CallTokens | undefined {
  if (typeof usage?.input_tokens !== 'number') return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens ?? 0;
  const cached = usage.input_token_details?.cached_tokens ?? 0;
  const audio = usage.input_token_details?.audio_tokens ?? 0;
  const cachedAudio = usage.input_token_details?.cached_tokens_details?.audio_tokens ?? 0;
  return {
    totalTokens: usage.total_tokens ?? input + output,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    noCacheTokens: Math.max(0, input - cached),
    audioInputTokens: Math.max(0, audio - cachedAudio),
    audioOutputTokens: usage.output_token_details?.audio_tokens ?? 0,
  };
}

/** Record one Realtime call of `model`. A call that reported no tokens is a row with no cost. */
export function recordRealtimeUsage(spend: RealtimeSpend, model: string, usage: unknown): void {
  llmCallService.recordTokens({
    purpose: spend.purpose,
    model,
    threadId: spend.threadId,
    requestId: spend.requestId,
    source: { kind: spend.purpose },
    tokens: tokensOf(usage as RealtimeUsage | undefined),
  });
}
