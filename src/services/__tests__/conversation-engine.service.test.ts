/**
 * Conversation Engine Service Tests
 *
 * Tests for ConversationEngineService covering:
 * - Chat message processing
 * - Direct LLM invocation via invoke()
 * - Multi-step response delivery
 * - Sender name prepending for Slack messages
 * - Channel context routing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetOrCreateActiveThread,
  mockAddMessage,
  mockPublish,
  mockInvokeStream,
  mockCountAgentMessages,
  mockGenerateText,
  mockIsTelemetryEnabled,
  mockTrackEvent,
  mockLinkToMessage,
} = vi.hoisted(() => ({
  mockGetOrCreateActiveThread: vi.fn(),
  mockAddMessage: vi.fn(),
  mockPublish: vi.fn(),
  mockInvokeStream: vi.fn(),
  mockCountAgentMessages: vi.fn(),
  mockGenerateText: vi.fn(),
  mockIsTelemetryEnabled: vi.fn(),
  mockTrackEvent: vi.fn(),
  mockLinkToMessage: vi.fn(),
}));

/**
 * Helper: turn an array of InvokeSteps into the async iterable that
 * invokeStream returns. Tests can call streamFromSteps([...]) and pass the
 * result to mockInvokeStream.mockReturnValue().
 */
function streamFromSteps(steps: Array<{ text: string; toolCalls: unknown[]; blocks?: unknown[] }>): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const s of steps) yield s;
    },
  };
}

vi.mock('../conversation.service', () => ({
  conversationService: {
    getOrCreateActiveThread: mockGetOrCreateActiveThread,
    addMessage: mockAddMessage,
  },
}));

vi.mock('../message-delivery.service', () => ({
  messageDeliveryService: {
    publish: mockPublish,
  },
}));

vi.mock('../attachment.service', () => ({
  attachmentService: {
    linkToMessage: mockLinkToMessage,
  },
}));

vi.mock('../../invoke', () => ({
  invokeStream: mockInvokeStream,
}));

vi.mock('../../lib/prisma', () => ({
  default: {
    conversationMessage: {
      count: mockCountAgentMessages,
    },
  },
}));

vi.mock('ai', () => ({
  generateText: mockGenerateText,
}));

vi.mock('../../lib/classification', () => ({
  getClassificationModel: () => ({}),
}));

vi.mock('../../lib/langfuse', () => ({
  isLangfuseEnabled: () => false,
}));

vi.mock('../../lib/telemetry', () => ({
  isTelemetryEnabled: mockIsTelemetryEnabled,
  trackEvent: mockTrackEvent,
}));

// Import after mocking
import { conversationEngineService } from '../conversation-engine.service';

describe('Requirement: Conversation Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetOrCreateActiveThread.mockResolvedValue({
      id: 'thread-123',
      userId: 'user-123',
    });
    mockAddMessage.mockImplementation(async (threadId: string, input: Record<string, unknown>) => ({
      id: 'msg-123',
      threadId,
      ...input,
      createdAt: new Date(),
    }));
    mockPublish.mockResolvedValue({
      id: 'msg-agent-123',
      threadId: 'thread-123',
      role: 'AGENT',
      content: 'I am a helpful AI assistant.',
      triggeredBy: 'USER_INPUT',
      createdAt: new Date(),
    });
    mockInvokeStream.mockReturnValue(streamFromSteps([
      { text: 'I am a helpful AI assistant.', toolCalls: [] },
    ]));
    mockCountAgentMessages.mockResolvedValue(0);
    // Default: telemetry off so unrelated scenarios don't exercise the classifier.
    mockIsTelemetryEnabled.mockReturnValue(false);
    mockGenerateText.mockResolvedValue({ text: 'WORTHY' });
  });

  describe('Scenario: Chat message processing', () => {
    it('should process chat message and return response', async () => {
      const userId = 'user-123';
      const message = 'What pods are running?';

      const response = await conversationEngineService.chat({
        userId,
        agentId: 'agent-123',
        message,
      });

      expect(response).toHaveProperty('threadId');
      expect(response).toHaveProperty('content');
      expect(response).toHaveProperty('toolCalls');
      expect(response).toHaveProperty('durationMs');

      // Should store user message
      expect(mockAddMessage).toHaveBeenCalledWith(
        'thread-123',
        expect.objectContaining({
          content: message,
          role: 'USER',
          triggeredBy: 'USER_INPUT',
        })
      );

      // Should call invokeStream() directly with mode: 'chat'
      expect(mockInvokeStream).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          agentId: 'agent-123',
          mode: 'chat',
          prompt: message,
        })
      );
    });

    it('forwards the abortSignal into invokeStream so a cancel stops generation', async () => {
      const controller = new AbortController();

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'What pods are running?',
        abortSignal: controller.signal,
      });

      expect(mockInvokeStream).toHaveBeenCalledWith(
        expect.objectContaining({ abortSignal: controller.signal }),
      );
    });

    it('emits a "chat message handled" telemetry event tagged with agent and thread ids', async () => {
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'What pods are running?',
        metadata: { channel: 'websocket' },
      });

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'chat message handled',
        'user-123',
        expect.objectContaining({
          'agent.id': 'agent-123',
          'thread.id': 'thread-123',
          'channel.type': 'websocket',
        }),
      );
    });

    it('should use provided threadId if specified', async () => {
      const userId = 'user-123';
      const threadId = 'thread-existing';

      const response = await conversationEngineService.chat({
        userId,
        agentId: 'agent-123',
        message: 'Hello',
        threadId,
      });

      expect(response.threadId).toBe(threadId);
      expect(mockGetOrCreateActiveThread).not.toHaveBeenCalled();
    });

    it('should create new thread if not provided', async () => {
      const userId = 'user-123';

      await conversationEngineService.chat({
        agentId: 'agent-123',
        userId,
        message: 'Hello',
      });

      expect(mockGetOrCreateActiveThread).toHaveBeenCalledWith('agent-123', userId);
    });
  });

  describe('Scenario: Attachments', () => {
    it('links provided attachmentIds to the stored user message', async () => {
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'check this file',
        attachmentIds: ['att-1', 'att-2'],
      });

      expect(mockLinkToMessage).toHaveBeenCalledWith(['att-1', 'att-2'], 'msg-123', 'thread-123');
    });

    it('does not link when no attachmentIds are provided', async () => {
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'no files',
      });

      expect(mockLinkToMessage).not.toHaveBeenCalled();
    });

    it('processes a file-only message (empty text) and still links attachments', async () => {
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: '',
        attachmentIds: ['att-9'],
      });

      // The engine never rejects empty text (the gateway guards that); it stores
      // the user message and links the file.
      expect(mockAddMessage).toHaveBeenCalledWith('thread-123', expect.objectContaining({ role: 'USER' }));
      expect(mockLinkToMessage).toHaveBeenCalledWith(['att-9'], 'msg-123', 'thread-123');
      expect(mockInvokeStream).toHaveBeenCalled();
    });
  });

  describe('Scenario: Multi-step response delivery', () => {
    it('should publish one message per text-producing step', async () => {
      mockInvokeStream.mockReturnValue(streamFromSteps([
        {
          text: 'Let me check...',
          toolCalls: [
            { tool: 'kubectl', input: '{}', output: 'pods', success: true, timestamp: '2025-01-01' },
          ],
        },
        {
          text: 'Here are the results.',
          toolCalls: [],
        },
      ]));

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Show me pods',
      });

      // Should publish two messages (one per text-producing step)
      expect(mockPublish).toHaveBeenCalledTimes(2);

      // First message should carry the tool calls from step 1
      expect(mockPublish).toHaveBeenNthCalledWith(
        1,
        'user-123',
        'thread-123',
        'Let me check...',
        'USER_INPUT',
        expect.objectContaining({
          toolCalls: expect.arrayContaining([
            expect.objectContaining({ tool: 'kubectl' }),
          ]),
        }),
      );

      // Second message should have no tool calls
      expect(mockPublish).toHaveBeenNthCalledWith(
        2,
        'user-123',
        'thread-123',
        'Here are the results.',
        'USER_INPUT',
        expect.objectContaining({
          toolCalls: undefined,
        }),
      );
    });

    it('should accumulate tool calls from tool-only steps onto the next text message', async () => {
      mockInvokeStream.mockReturnValue(streamFromSteps([
        {
          text: '',
          toolCalls: [
            { tool: 'tool_a', input: '{}', output: 'a', success: true, timestamp: '2025-01-01' },
          ],
        },
        {
          text: '',
          toolCalls: [
            { tool: 'tool_b', input: '{}', output: 'b', success: true, timestamp: '2025-01-01' },
          ],
        },
        {
          text: 'Done.',
          toolCalls: [],
        },
      ]));

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Do things',
      });

      // Only one message (only the last step has text)
      expect(mockPublish).toHaveBeenCalledTimes(1);

      // That message should carry both accumulated tool calls
      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-123',
        'Done.',
        'USER_INPUT',
        expect.objectContaining({
          toolCalls: expect.arrayContaining([
            expect.objectContaining({ tool: 'tool_a' }),
            expect.objectContaining({ tool: 'tool_b' }),
          ]),
        }),
      );
    });

    it('should fall back to a single publish when the stream yields no text-bearing steps', async () => {
      // Stream yields only a tool-call-only step (no text). With streaming
      // there's nothing to publish per-step, so the fallback at the end
      // ensures the caller still gets a single message + messageId.
      mockInvokeStream.mockReturnValue(streamFromSteps([
        { text: '', toolCalls: [{ tool: 't', input: '{}', output: '', success: true, timestamp: '2025-01-01' }] },
      ]));

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Hello',
      });

      expect(mockPublish).toHaveBeenCalledTimes(1);
      // Content is the joined non-empty step texts — empty here.
      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-123',
        '',
        'USER_INPUT',
        expect.objectContaining({}),
      );
    });
  });

  describe('Scenario: Channel context includes threadId', () => {
    it('should include threadId in channelContext when metadata has slack channel info', async () => {
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'hello from slack',
        metadata: {
          channel: 'slack',
          channelId: 'C123',
          slackThreadTs: '1000.2000',
          senderName: 'Alice',
          senderSlackUserId: 'U123',
        },
      });

      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-123',
        expect.any(String),
        'USER_INPUT',
        expect.objectContaining({
          channelContext: expect.objectContaining({
            channel: 'slack',
            channelId: 'C123',
            threadTs: '1000.2000',
            threadId: 'thread-123',
          }),
        }),
      );
    });

    it('should not include channelContext when no metadata', async () => {
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'hello from web',
      });

      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-123',
        expect.any(String),
        'USER_INPUT',
        expect.objectContaining({
          channelContext: undefined,
        }),
      );
    });
  });

  describe('Scenario: Error handling', () => {
    it('should publish a friendly error step when invokeStream yields one', async () => {
      // invokeStream catches errors internally (via buildErrorStep) and
      // yields a friendly text step rather than throwing.
      mockInvokeStream.mockReturnValue(streamFromSteps([
        {
          text: 'I encountered an error while processing your request: Connection refused',
          toolCalls: [],
        },
      ]));

      const response = await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Hello',
      });

      expect(response.content).toContain('error');
    });
  });

  describe('Scenario: Feedback button gating (channelContext.includeFeedback)', () => {
    const AGENT_TEXT = 'Here is a substantive answer.';
    const slackChannelMeta = {
      channel: 'slack' as const,
      channelId: 'C123',
      slackThreadTs: '1000.2000',
      senderName: 'Alice',
      senderSlackUserId: 'U123',
    };

    it('folds includeFeedback=true when telemetry is on, cadence hits, and classifier replies WORTHY', async () => {
      mockIsTelemetryEnabled.mockReturnValue(true);
      mockGenerateText.mockResolvedValue({ text: 'WORTHY' });
      mockCountAgentMessages.mockResolvedValue(1);
      mockInvokeStream.mockReturnValue(streamFromSteps([
        { text: AGENT_TEXT, toolCalls: [] },
      ]));

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Explain x in detail',
        metadata: slackChannelMeta,
      });

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-123',
        AGENT_TEXT,
        'USER_INPUT',
        expect.objectContaining({
          channelContext: expect.objectContaining({
            channel: 'slack',
            channelId: 'C123',
            threadTs: '1000.2000',
            threadId: 'thread-123',
            includeFeedback: true,
          }),
        }),
      );
    });

    it('builds a slack channelContext for DMs too (no channelId) and carries includeFeedback', async () => {
      mockIsTelemetryEnabled.mockReturnValue(true);
      mockGenerateText.mockResolvedValue({ text: 'WORTHY' });
      mockCountAgentMessages.mockResolvedValue(1);
      mockInvokeStream.mockReturnValue(streamFromSteps([
        { text: AGENT_TEXT, toolCalls: [] },
      ]));

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'DM substantive',
        metadata: { channel: 'slack' }, // DM — no channelId, no slackThreadTs
      });

      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-123',
        AGENT_TEXT,
        'USER_INPUT',
        expect.objectContaining({
          channelContext: {
            channel: 'slack',
            channelId: undefined,
            threadTs: undefined,
            threadId: 'thread-123',
            includeFeedback: true,
          },
        }),
      );
    });

    it('skips feedback (and skips the classifier call) when telemetry is disabled', async () => {
      mockIsTelemetryEnabled.mockReturnValue(false);
      mockCountAgentMessages.mockResolvedValue(1);
      mockInvokeStream.mockReturnValue(streamFromSteps([
        { text: AGENT_TEXT, toolCalls: [] },
      ]));

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Explain x in detail',
        metadata: slackChannelMeta,
      });

      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-123',
        AGENT_TEXT,
        'USER_INPUT',
        expect.objectContaining({
          channelContext: expect.objectContaining({ includeFeedback: false }),
        }),
      );
    });

    it('folds includeFeedback=false when the classifier replies SKIP', async () => {
      mockIsTelemetryEnabled.mockReturnValue(true);
      mockGenerateText.mockResolvedValue({ text: 'SKIP' });
      mockCountAgentMessages.mockResolvedValue(1);
      mockInvokeStream.mockReturnValue(streamFromSteps([
        { text: 'Got it!', toolCalls: [] },
      ]));

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Ack?',
        metadata: slackChannelMeta,
      });

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-123',
        'Got it!',
        'USER_INPUT',
        expect.objectContaining({
          channelContext: expect.objectContaining({ includeFeedback: false }),
        }),
      );
    });

    it('fails closed (feedback hidden) if the classifier call throws', async () => {
      mockIsTelemetryEnabled.mockReturnValue(true);
      mockGenerateText.mockRejectedValue(new Error('bedrock blew up'));
      mockCountAgentMessages.mockResolvedValue(1);
      mockInvokeStream.mockReturnValue(streamFromSteps([
        { text: AGENT_TEXT, toolCalls: [] },
      ]));

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Explain x in detail',
        metadata: slackChannelMeta,
      });

      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-123',
        AGENT_TEXT,
        'USER_INPUT',
        expect.objectContaining({
          channelContext: expect.objectContaining({ includeFeedback: false }),
        }),
      );
    });

    it('does not pass a channelContext when metadata is absent (heartbeat/cron-style invocation)', async () => {
      mockIsTelemetryEnabled.mockReturnValue(true);
      mockGenerateText.mockResolvedValue({ text: 'WORTHY' });
      mockCountAgentMessages.mockResolvedValue(1);
      mockInvokeStream.mockReturnValue(streamFromSteps([
        { text: AGENT_TEXT, toolCalls: [] },
      ]));

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'no metadata',
      });

      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-123',
        AGENT_TEXT,
        'USER_INPUT',
        expect.objectContaining({ channelContext: undefined }),
      );
    });

    it('honours the cadence gate: show on user turns 1/4/7, skip on 2/3/5/6, and does not call the classifier when cadence rejects', async () => {
      mockIsTelemetryEnabled.mockReturnValue(true);
      mockGenerateText.mockResolvedValue({ text: 'WORTHY' });
      mockInvokeStream.mockReturnValue(streamFromSteps([
        { text: AGENT_TEXT, toolCalls: [] },
      ]));

      const cases: Array<{ userCount: number; expected: boolean }> = [
        { userCount: 1, expected: true },
        { userCount: 2, expected: false },
        { userCount: 3, expected: false },
        { userCount: 4, expected: true },
        { userCount: 5, expected: false },
        { userCount: 6, expected: false },
        { userCount: 7, expected: true },
      ];

      let classifierCalls = 0;
      for (const { userCount, expected } of cases) {
        mockPublish.mockClear();
        mockGenerateText.mockClear();
        mockCountAgentMessages.mockResolvedValueOnce(userCount);

        await conversationEngineService.chat({
          userId: 'user-123',
          agentId: 'agent-123',
          message: 'Explain x in detail',
          metadata: slackChannelMeta,
        });

        expect(mockPublish, `userCount=${userCount}`).toHaveBeenCalledWith(
          'user-123',
          'thread-123',
          AGENT_TEXT,
          'USER_INPUT',
          expect.objectContaining({
            channelContext: expect.objectContaining({ includeFeedback: expected }),
          }),
        );
        // Cost guardrail: classifier only runs on turns where cadence allows.
        expect(mockGenerateText, `userCount=${userCount}`).toHaveBeenCalledTimes(expected ? 1 : 0);
        if (expected) classifierCalls++;
      }
      expect(classifierCalls).toBe(3);
    });

    it('only calls the classifier (and only folds includeFeedback=true) on the terminal step of a multi-step response', async () => {
      mockIsTelemetryEnabled.mockReturnValue(true);
      mockGenerateText.mockResolvedValue({ text: 'WORTHY' });
      mockCountAgentMessages.mockResolvedValue(1);
      mockInvokeStream.mockReturnValue(streamFromSteps([
        { text: AGENT_TEXT, toolCalls: [] },
        { text: AGENT_TEXT, toolCalls: [] },
      ]));

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Multi step',
        metadata: slackChannelMeta,
      });

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenNthCalledWith(
        1,
        'user-123',
        'thread-123',
        AGENT_TEXT,
        'USER_INPUT',
        expect.objectContaining({
          channelContext: expect.objectContaining({ includeFeedback: false }),
        }),
      );
      expect(mockPublish).toHaveBeenNthCalledWith(
        2,
        'user-123',
        'thread-123',
        AGENT_TEXT,
        'USER_INPUT',
        expect.objectContaining({
          channelContext: expect.objectContaining({ includeFeedback: true }),
        }),
      );
    });
  });
});
