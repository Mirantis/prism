/**
 * Realtime Usage Tests
 *
 * How a Realtime `usage` object becomes the token columns: the audio and the cached
 * parts are kept apart, so each is priced at its own rate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRecordTokens } = vi.hoisted(() => ({ mockRecordTokens: vi.fn() }));
vi.mock('../../llm-call.service', () => ({ llmCallService: { recordTokens: mockRecordTokens } }));

import { recordRealtimeUsage } from '../realtime-usage';

const SPEND = { purpose: 'voice-chat', requestId: 'call-1', threadId: 'thread-1' } as const;

beforeEach(() => mockRecordTokens.mockClear());

describe('recordRealtimeUsage', () => {
  it('splits the audio and the cached tokens of a response', () => {
    recordRealtimeUsage(SPEND, 'gpt-realtime-2.1', {
      total_tokens: 1300,
      input_tokens: 1000,
      output_tokens: 300,
      input_token_details: {
        text_tokens: 300,
        audio_tokens: 700,
        cached_tokens: 200,
        cached_tokens_details: { text_tokens: 100, audio_tokens: 100 },
      },
      output_token_details: { text_tokens: 50, audio_tokens: 250 },
    });

    expect(mockRecordTokens).toHaveBeenCalledWith({
      purpose: 'voice-chat',
      model: 'gpt-realtime-2.1',
      threadId: 'thread-1',
      requestId: 'call-1',
      source: { kind: 'voice-chat' },
      tokens: {
        totalTokens: 1300,
        inputTokens: 1000,
        outputTokens: 300,
        cacheReadTokens: 200,
        cacheWriteTokens: 0,
        noCacheTokens: 800,
        audioInputTokens: 600,
        audioOutputTokens: 250,
      },
    });
  });

  it('records a transcription billed by duration as a call with no tokens', () => {
    recordRealtimeUsage({ purpose: 'dictation', requestId: 'dictation-1' }, 'gpt-live-transcribe', { type: 'duration', seconds: 4 });

    expect(mockRecordTokens).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'dictation', tokens: undefined }));
  });
});
