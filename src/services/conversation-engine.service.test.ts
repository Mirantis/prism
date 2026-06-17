/**
 * Conversation Engine Service Tests
 *
 * Focused coverage for the thread-title trigger: when the first user message
 * names a thread (addMessage returns titleSet), chat() hands off to the
 * channel-agnostic threadTitleService.onFirstUserMessage — and never does so
 * for a follow-up message (titleSet null). The rest of the engine (streaming,
 * delivery, feedback gate) is exercised by the e2e suites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetOrCreateLatestThread,
  mockAddMessage,
  mockOnFirstUserMessage,
  mockPublish,
} = vi.hoisted(() => ({
  mockGetOrCreateLatestThread: vi.fn(),
  mockAddMessage: vi.fn(),
  mockOnFirstUserMessage: vi.fn(),
  mockPublish: vi.fn(),
}));

// Empty stream — the loop body never runs, so no delivery / feedback path.
vi.mock('../invoke', () => ({
  invokeStream: vi.fn(() => (async function* () {})()),
}));

vi.mock('./message-delivery.service', () => ({
  messageDeliveryService: { publish: mockPublish },
}));

vi.mock('./conversation.service', () => ({
  conversationService: {
    getOrCreateLatestThread: mockGetOrCreateLatestThread,
    getThreadWorkspaceRoot: vi.fn(async () => null),
    addMessage: mockAddMessage,
  },
}));

vi.mock('./thread-title.service', () => ({
  threadTitleService: { onFirstUserMessage: mockOnFirstUserMessage },
}));

vi.mock('./attachment.service', () => ({
  attachmentService: { linkToMessage: vi.fn() },
}));

vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('../lib/classification', () => ({ getClassificationModel: vi.fn() }));
vi.mock('../lib/langfuse', () => ({ isLangfuseEnabled: () => false }));
vi.mock('../lib/telemetry', () => ({
  isTelemetryEnabled: () => false,
  trackEvent: vi.fn(),
}));
vi.mock('../lib/prisma', () => ({
  default: { conversationMessage: { count: vi.fn(async () => 0) } },
}));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { conversationEngineService } from './conversation-engine.service';

describe('ConversationEngineService thread-title trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateLatestThread.mockResolvedValue({ id: 't1', workspaceRoot: null });
  });

  it('triggers onFirstUserMessage when the message named the thread', async () => {
    mockAddMessage.mockResolvedValue({ message: { id: 'm1' }, titleSet: 'migrate the authentic...' });

    await conversationEngineService.chat({
      userId: 'u1',
      agentId: 'a1',
      message: 'migrate the authentication layer',
      metadata: { channel: 'websocket' },
    });

    expect(mockOnFirstUserMessage).toHaveBeenCalledWith(
      'a1', 'u1', 't1', 'migrate the authentication layer', 'migrate the authentic...',
    );
  });

  it('does not trigger onFirstUserMessage for a follow-up (no title set)', async () => {
    mockAddMessage.mockResolvedValue({ message: { id: 'm2' }, titleSet: null });

    await conversationEngineService.chat({
      userId: 'u1',
      agentId: 'a1',
      message: 'a follow-up question',
      metadata: { channel: 'websocket' },
    });

    expect(mockOnFirstUserMessage).not.toHaveBeenCalled();
  });
});
