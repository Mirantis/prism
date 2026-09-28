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
  mockGetOrCreateLatestThread,
  mockGetThreadWorkspaceRoot,
  mockAddMessage,
  mockPublish,
  mockInvokeStream,
  mockCountAgentMessages,
  mockGenerateText,
  mockIsTelemetryEnabled,
  mockTrackEvent,
  mockLinkToMessage,
  mockOnFirstUserMessage,
  mockGetAgent,
  mockGetMetaByIds,
  mockShowInConversation,
  mockGetMetaByMessageIds,
} = vi.hoisted(() => ({
  mockGetOrCreateLatestThread: vi.fn(),
  mockGetThreadWorkspaceRoot: vi.fn(),
  mockAddMessage: vi.fn(),
  mockPublish: vi.fn(),
  mockInvokeStream: vi.fn(),
  mockCountAgentMessages: vi.fn(),
  mockGenerateText: vi.fn(),
  mockIsTelemetryEnabled: vi.fn(),
  mockTrackEvent: vi.fn(),
  mockLinkToMessage: vi.fn(),
  mockOnFirstUserMessage: vi.fn(),
  mockGetAgent: vi.fn(),
  mockGetMetaByIds: vi.fn(),
  mockShowInConversation: vi.fn(),
  mockGetMetaByMessageIds: vi.fn(),
}));

/**
 * Helper: turn an array of InvokeSteps into the async iterable that
 * invokeStream returns. Tests can call streamFromSteps([...]) and pass the
 * result to mockInvokeStream.mockReturnValue().
 */
function streamFromSteps(
  steps: Array<{ text: string; toolCalls: unknown[]; blocks?: unknown[] }>,
  /** Held open until this settles, for a test that needs two turns at once. */
  hold?: Promise<void>,
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const s of steps) yield s;
      if (hold) await hold;
    },
  };
}

vi.mock('../conversation.service', () => ({
  conversationService: {
    getOrCreateLatestThread: mockGetOrCreateLatestThread,
    getThreadWorkspaceRoot: mockGetThreadWorkspaceRoot,
    addMessage: mockAddMessage,
  },
}));

vi.mock('../message-delivery.service', () => ({
  messageDeliveryService: {
    publish: mockPublish,
    showInConversation: mockShowInConversation,
  },
}));

vi.mock('../thread-title.service', () => ({
  threadTitleService: {
    onFirstUserMessage: mockOnFirstUserMessage,
  },
}));

vi.mock('../attachment.service', () => ({
  attachmentService: {
    linkToMessage: mockLinkToMessage,
    getMetaByIds: mockGetMetaByIds,
    getMetaByMessageIds: mockGetMetaByMessageIds,
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
  getGateRequest: () => ({ model: {}, providerOptions: {} }),
}));

vi.mock('../../lib/langfuse', () => ({
  isLangfuseEnabled: () => false,
}));

vi.mock('../../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  isTelemetryEnabled: mockIsTelemetryEnabled,
  trackEvent: mockTrackEvent,
}));

vi.mock('../agent-workspace.service', () => ({
  agentWorkspaceService: {
    getAgent: mockGetAgent,
  },
}));

// Import after mocking. `threadTurnService` is the real per-thread primitive —
// turn ordering is part of what the steering scenarios assert.
import { conversationEngineService } from '../conversation-engine.service';
import { threadTurnService } from '../thread-turn.service';
import {
  conversationThreadActivityService,
  type ThreadActivityChange,
} from '../conversation-thread-activity.service';

describe('Requirement: Conversation Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetAgent.mockResolvedValue({ verbose: true });
    mockGetOrCreateLatestThread.mockResolvedValue({
      id: 'thread-123',
      userId: 'user-123',
    });
    mockGetThreadWorkspaceRoot.mockResolvedValue(null);
    mockAddMessage.mockImplementation(async (threadId: string, input: Record<string, unknown>) => ({
      message: { id: 'msg-123', threadId, ...input, createdAt: new Date() },
      titleSet: null,
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
    mockGetMetaByIds.mockResolvedValue([]);
    mockGetMetaByMessageIds.mockResolvedValue(new Map());
    mockShowInConversation.mockResolvedValue(undefined);
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
      let forwarded: AbortSignal | undefined;
      let finish!: () => void;
      mockInvokeStream.mockImplementationOnce(async function* (request: { abortSignal: AbortSignal }) {
        forwarded = request.abortSignal;
        await new Promise<void>((resolve) => { finish = resolve; });
      });

      const turn = conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'What pods are running?',
        abortSignal: controller.signal,
      });
      await vi.waitFor(() => expect(forwarded).toBeDefined());

      expect(forwarded?.aborted).toBe(false);
      controller.abort();
      expect(forwarded?.aborted).toBe(true);
      finish();
      await turn;
    });

    it('stops a running exchange when its thread is cancelled, whoever started it', async () => {
      let forwarded: AbortSignal | undefined;
      let finish!: () => void;
      mockInvokeStream.mockImplementationOnce(async function* (request: { abortSignal: AbortSignal }) {
        forwarded = request.abortSignal;
        await new Promise<void>((resolve) => { finish = resolve; });
      });

      const turn = conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        threadId: 'thread-123',
        message: 'a long job',
      });
      await vi.waitFor(() => expect(forwarded).toBeDefined());

      expect(conversationEngineService.cancel('thread-123')).toBe(true);
      expect(forwarded?.aborted).toBe(true);
      finish();
      await turn;

      expect(conversationEngineService.cancel('thread-123')).toBe(false);
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
      expect(mockGetOrCreateLatestThread).not.toHaveBeenCalled();
    });

    it("passes the active thread's workspaceRoot into invokeStream", async () => {
      mockGetOrCreateLatestThread.mockResolvedValue({
        id: 'thread-123',
        userId: 'user-123',
        workspaceRoot: '/home/me/project',
      });

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Hello',
      });

      expect(mockInvokeStream).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceRoot: '/home/me/project' }),
      );
    });

    it("resolves workspaceRoot for an explicit threadId via getThreadWorkspaceRoot", async () => {
      mockGetThreadWorkspaceRoot.mockResolvedValue('/srv/ws');

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Hello',
        threadId: 'thread-existing',
      });

      expect(mockGetThreadWorkspaceRoot).toHaveBeenCalledWith('thread-existing');
      expect(mockInvokeStream).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceRoot: '/srv/ws' }),
      );
    });

    it('should create new thread if not provided', async () => {
      const userId = 'user-123';

      await conversationEngineService.chat({
        agentId: 'agent-123',
        userId,
        message: 'Hello',
      });

      expect(mockGetOrCreateLatestThread).toHaveBeenCalledWith('agent-123', userId);
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

    it('should persist but not deliver intermediate steps when verbose is false', async () => {
      // Concise mode: only the final text step is delivered to the channel;
      // intermediate text steps are persisted (addMessage) but never published.
      mockGetAgent.mockResolvedValue({ verbose: false });
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

      // Only the final step is delivered to the channel.
      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-123',
        'Here are the results.',
        'USER_INPUT',
        expect.objectContaining({}),
      );

      // The intermediate step is persisted as its own AGENT row (with its tool
      // calls) and flagged internalStep so client history hides it while the
      // model-context read still replays it — persistence stays identical to
      // verbose mode, only delivery + client visibility differ.
      expect(mockAddMessage).toHaveBeenCalledWith(
        'thread-123',
        expect.objectContaining({
          role: 'AGENT',
          content: 'Let me check...',
          triggeredBy: 'USER_INPUT',
          internalStep: true,
          toolCalls: expect.arrayContaining([
            expect.objectContaining({ tool: 'kubectl' }),
          ]),
        }),
      );

      // The USER row is never marked internal.
      expect(mockAddMessage).toHaveBeenCalledWith(
        'thread-123',
        expect.objectContaining({ role: 'USER' }),
      );
      const userCall = mockAddMessage.mock.calls.find((c: unknown[]) => (c[1] as { role: string }).role === 'USER');
      expect((userCall?.[1] as { internalStep?: boolean }).internalStep).toBeUndefined();
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

    it('publishes nothing when the stream yields no steps (canceled before output)', async () => {
      // Cancel-before-any-step: the stream closes with zero steps, so there's
      // no text, no tool calls, and no blocks. We must NOT publish an empty
      // agent message (which would render an empty bubble in the UI).
      mockInvokeStream.mockReturnValue(streamFromSteps([]));

      const response = await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Hello',
      });

      expect(mockPublish).not.toHaveBeenCalled();
      // No message was published, so there is no id to point at — absent rather
      // than an empty string a caller could mistake for one.
      expect(response.messageId).toBeUndefined();
      expect(response.content).toBe('');
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
          senderExternalId: 'U123',
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

  describe('Scenario: A person\'s own message on every client', () => {
    it('shows the stored user message on every client of the chat socket', async () => {
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'hello from web',
        metadata: { channel: 'websocket' },
      });

      expect(mockShowInConversation).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ id: 'msg-123', role: 'USER', content: 'hello from web' }),
      );
      // The broadcast goes out before the agent's first message.
      expect(mockShowInConversation.mock.invocationCallOrder[0]).toBeLessThan(
        mockPublish.mock.invocationCallOrder[0],
      );
    });

    it('mirrors nothing for a message with no channel', async () => {
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'hello from the REST endpoint',
      });

      expect(mockShowInConversation).not.toHaveBeenCalled();
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
      senderExternalId: 'U123',
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

  describe('Scenario: Thread title trigger', () => {
    it('hands off to threadTitleService.onFirstUserMessage when the first message titles a DATABASE thread', async () => {
      mockAddMessage.mockResolvedValueOnce({
        message: { id: 'msg-123', threadId: 'thread-123' },
        titleSet: 'migrate the authentic...',
      });

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'migrate the authentication layer',
        metadata: { channel: 'websocket' },
      });

      expect(mockOnFirstUserMessage).toHaveBeenCalledWith(
        'agent-123',
        'user-123',
        'thread-123',
        'migrate the authentication layer',
        'migrate the authentic...',
      );
    });

    it('does not trigger title generation for a follow-up (no title set)', async () => {
      // Default mockAddMessage returns titleSet: null.
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'a follow-up question',
        metadata: { channel: 'websocket' },
      });

      expect(mockOnFirstUserMessage).not.toHaveBeenCalled();
    });

    it('does not generate a title for a Slack thread (never shown in Recents/resume)', async () => {
      mockAddMessage.mockResolvedValueOnce({
        message: { id: 'msg-123', threadId: 'thread-123' },
        titleSet: 'some placeholder',
      });

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'hello from slack',
        threadId: 'thread-123',
        metadata: { channel: 'slack', channelId: 'C123' },
      });

      expect(mockOnFirstUserMessage).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: Turn steering (mid-turn messages)', () => {
    // A message that arrives while a turn is running is handed to that turn
    // rather than starting a second one, and anything landing after the turn's
    // last step boundary is answered by exactly one coalesced follow-up.
    //
    // Each test gets its own thread id — steering state is per-thread, and a
    // test that leaves a turn held (never released) keeps that thread's state
    // alive past the test.
    let steerThread = '';
    let steerSeq = 0;

    beforeEach(() => {
      steerThread = `thread-steering-${++steerSeq}`;
    });

    /** A turn whose single step is released only when the test says so. */
    function heldTurn() {
      let release!: () => void;
      const released = new Promise<void>((r) => {
        release = r;
      });
      let started!: () => void;
      const running = new Promise<void>((r) => {
        started = r;
      });

      const requests: Array<{ steering?: () => string[]; prompt: string; appendPrompt?: boolean }> = [];
      const generator = async function* (request: { steering?: () => string[]; prompt: string }) {
        requests.push(request);
        started();
        await released;
        yield { text: 'done', toolCalls: [] };
      };

      return { generator, release, running, requests };
    }

    /** A turn that completes immediately. */
    async function* instantTurn() {
      yield { text: 'ok', toolCalls: [] };
    }

    function steerInput(message: string, overrides: Record<string, unknown> = {}) {
      return {
        userId: 'user-123',
        agentId: 'agent-123',
        threadId: steerThread,
        message,
        metadata: { channel: 'websocket' as const },
        ...overrides,
      };
    }

    it('hands a message to the live turn instead of starting a second one', async () => {
      const held = heldTurn();
      mockInvokeStream.mockImplementation(held.generator);

      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;

      const second = await conversationEngineService.chat(steerInput('no need to run tests'));

      expect(second.steered).toBe(true);
      expect(second.content).toBe('');
      // Both messages are stored — the second is real conversation history.
      expect(mockAddMessage).toHaveBeenCalledTimes(2);
      // But only one turn was ever invoked.
      expect(mockInvokeStream).toHaveBeenCalledTimes(1);

      held.release();
      await first;
    });

    it('exposes the handed-over message to the running turn as steering', async () => {
      const held = heldTurn();
      mockInvokeStream.mockImplementation(held.generator);

      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;
      await conversationEngineService.chat(steerInput('skip the tests'));

      // The turn's steering source is what invoke.ts awaits at each step boundary.
      await expect(held.requests[0].steering?.()).resolves.toEqual([
        { text: 'skip the tests', attachments: undefined },
      ]);

      held.release();
      await first;
    });

    it('withdraws a handed-over message when storing it fails', async () => {
      // The hand-over reaches the running turn's inbox before the message is
      // stored — it has to, so the decision is one synchronous act. If the write
      // then fails, leaving it there would have the turn answer text that never
      // became history, and the next turn would read a reply to nothing.
      const held = heldTurn();
      mockInvokeStream.mockImplementation(held.generator);

      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;

      mockAddMessage.mockRejectedValueOnce(new Error('disk is full'));
      await expect(
        conversationEngineService.chat(steerInput('no need to run tests')),
      ).rejects.toThrow('disk is full');

      // Nothing left for the running turn to inject.
      expect(threadTurnService.pendingCount(steerThread)).toBe(0);
      await expect(held.requests[0].steering?.()).resolves.toEqual([]);

      held.release();
      await first;
    });

    it('answers a late message with one coalesced follow-up turn', async () => {
      // Nothing drains the steering source here, standing in for a message that
      // lands after the turn's final step boundary.
      const held = heldTurn();
      mockInvokeStream.mockImplementationOnce(held.generator).mockImplementation(instantTurn);

      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;
      await conversationEngineService.chat(steerInput('and check CI too'));
      held.release();
      await first;

      expect(mockInvokeStream).toHaveBeenCalledTimes(2);
      const followUp = mockInvokeStream.mock.calls[1][0];
      expect(followUp.prompt).toBe('and check CI too');
      // Restated as the trailing user message: the prompt sits earlier in history
      // than the first turn's replies, so history alone would end on an assistant
      // turn — the shape the provider rejects as assistant prefill.
      expect(followUp.appendPrompt).toBe(true);
    });

    it('coalesces several late messages into a single follow-up', async () => {
      const held = heldTurn();
      mockInvokeStream.mockImplementationOnce(held.generator).mockImplementation(instantTurn);

      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;
      await conversationEngineService.chat(steerInput('wait'));
      await conversationEngineService.chat(steerInput('why do you not see my messages'));
      held.release();
      await first;

      expect(mockInvokeStream).toHaveBeenCalledTimes(2);
      expect(mockInvokeStream.mock.calls[1][0].prompt).toBe(
        'wait\n\nwhy do you not see my messages',
      );
    });

    it('does not start a follow-up turn after a cancel', async () => {
      const held = heldTurn();
      mockInvokeStream.mockImplementationOnce(held.generator).mockImplementation(instantTurn);

      const controller = new AbortController();
      const first = conversationEngineService.chat(
        steerInput('review the PR', { abortSignal: controller.signal }),
      );
      await held.running;
      await conversationEngineService.chat(steerInput('never mind'));

      controller.abort();
      held.release();
      await first;

      // The user asked to stop, so no follow-up runs.
      expect(mockInvokeStream).toHaveBeenCalledTimes(1);
      // The pending copy is discarded — the message is already stored, so the
      // next turn sees it from history rather than seeing it twice.
      expect(threadTurnService.pendingCount(steerThread)).toBe(0);
    });

    it('folds a mid-turn message\'s files into the running turn', async () => {
      // Files reach the running turn too: their metadata is loaded on the
      // consumer side, so a screenshot shared mid-work lands on the next step
      // as a stub rather than waiting for a turn of its own.
      const held = heldTurn();
      mockInvokeStream.mockImplementation(held.generator);
      mockGetMetaByIds.mockResolvedValue([
        { id: 'att-1', filename: 'run.log', mediaType: 'text/plain', category: 'text', sizeBytes: 4 },
      ]);

      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;
      await conversationEngineService.chat(
        steerInput('look at this log', { attachmentIds: ['att-1'] }),
      );

      await expect(held.requests[0].steering?.()).resolves.toEqual([
        {
          text: 'look at this log',
          attachments: [expect.objectContaining({ id: 'att-1', filename: 'run.log' })],
        },
      ]);
      expect(mockGetMetaByIds).toHaveBeenCalledWith(['att-1']);

      held.release();
      await first;

      // Handed over, so no second turn ran.
      expect(mockInvokeStream).toHaveBeenCalledTimes(1);
    });

    it('discards pending messages when the turn throws', async () => {
      // Reported in review: a throw out of streamTurn (a failed publish or
      // persist) used to skip both drains, leaving the handed-over message in the
      // inbox for the *next* turn to inject — on top of the copy already in
      // history, so the model saw it twice.
      const held = heldTurn();
      mockInvokeStream.mockImplementation(held.generator);
      mockPublish.mockRejectedValueOnce(new Error('publish blew up'));

      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;
      await conversationEngineService.chat(steerInput('skip the tests'));
      held.release();

      await expect(first).rejects.toThrow('publish blew up');
      expect(threadTurnService.pendingCount(steerThread)).toBe(0);

      // And the next turn on the thread has nothing left to inject. Held open so
      // its handle is still live when we ask — a released handle throws.
      mockPublish.mockResolvedValue({ id: 'msg-agent-123' });
      const second = heldTurn();
      mockInvokeStream.mockImplementation(second.generator);
      const nextTurn = conversationEngineService.chat(steerInput('what now?'));
      await second.running;

      await expect(second.requests[0].steering?.()).resolves.toEqual([]);

      second.release();
      await nextTurn;
    });

    it('steer-only stores nothing and invokes nothing when no turn is live', async () => {
      mockInvokeStream.mockImplementation(instantTurn);

      const result = await conversationEngineService.chat(
        steerInput('hello', { steerOnly: true }),
      );

      expect(result.steered).toBe(false);
      expect(mockAddMessage).not.toHaveBeenCalled();
      expect(mockInvokeStream).not.toHaveBeenCalled();
    });

    it('steer-only hands over when a turn is live', async () => {
      const held = heldTurn();
      mockInvokeStream.mockImplementation(held.generator);

      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;

      const result = await conversationEngineService.chat(
        steerInput('skip the tests', { steerOnly: true }),
      );

      expect(result.steered).toBe(true);
      expect(mockAddMessage).toHaveBeenCalledTimes(2);

      held.release();
      await first;
    });

    it('leaves the thread unlocked and clean after a turn', async () => {
      mockInvokeStream.mockImplementation(instantTurn);

      await conversationEngineService.chat(steerInput('hello'));

      expect(threadTurnService.isClaimed(steerThread)).toBe(false);
      expect(threadTurnService.pendingCount(steerThread)).toBe(0);
      // The per-thread mutex is released, so the next turn runs immediately.
      await expect(threadTurnService.run(steerThread, async () => 'free')).resolves.toBe('free');
    });

    it('hands over a message that arrives before the turn reaches the model', async () => {
      // The turn claims the thread synchronously, so the two DB round trips it
      // makes first (storing the message, reading the agent) are inside the window
      // where a hand-over works. A message landing there must not start a second
      // turn: that turn would queue behind this one and then run against a history
      // ending in its replies — the assistant prefill the provider rejects.
      let releaseStore!: () => void;
      const storing = new Promise<void>((r) => {
        releaseStore = r;
      });
      mockAddMessage.mockImplementationOnce(async () => {
        await storing;
        return { message: { id: 'msg-slow' }, titleSet: null };
      });
      mockInvokeStream.mockImplementation(instantTurn);

      const first = conversationEngineService.chat(steerInput('review the PR'));
      // The first turn is still inside storeUserMessage — it has not invoked
      // anything yet, and cannot have.
      expect(mockInvokeStream).not.toHaveBeenCalled();

      const second = await conversationEngineService.chat(steerInput('no need to run tests'));
      expect(second.steered).toBe(true);

      releaseStore();
      await first;

      // The second message never started a turn of its own. This exchange
      // answered it — here as the coalesced follow-up, because `instantTurn`
      // never drains the steering source, so the message arrives after the only
      // step boundary. It is restated as the trailing user message, which is what
      // keeps history from ending on the first turn's replies.
      expect(mockInvokeStream).toHaveBeenCalledTimes(2);
      const followUp = mockInvokeStream.mock.calls[1][0];
      expect(followUp.prompt).toBe('no need to run tests');
      expect(followUp.appendPrompt).toBe(true);
      expect(threadTurnService.pendingCount(steerThread)).toBe(0);
    });
  });

  /**
   * The engine marks the thread working for the whole exchange, so a turn the runtime
   * starts itself, such as the continuation after a computer help request, reports like
   * any other, and a turn that waits for the thread is part of the same work.
   */
  describe('Scenario: Thread activity', () => {
    function record(): { seen: ThreadActivityChange[]; off: () => void } {
      const seen: ThreadActivityChange[] = [];
      const listener = (event: ThreadActivityChange) => void seen.push(event);
      conversationThreadActivityService.events.on('change', listener);
      return {
        seen,
        off: () => void conversationThreadActivityService.events.off('change', listener),
      };
    }

    it('brackets an exchange, whoever asked for it', async () => {
      const { seen, off } = record();

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'I finished helping with the computer.',
      });
      off();

      expect(seen).toEqual([
        { threadId: 'thread-123', working: true, userId: 'user-123' },
        { threadId: 'thread-123', working: false, userId: 'user-123' },
      ]);
    });

    it('ends once, after the last exchange on the thread', async () => {
      const { seen, off } = record();
      let release!: () => void;
      mockInvokeStream.mockReturnValueOnce(
        streamFromSteps([{ text: 'first', toolCalls: [] }], new Promise<void>((done) => {
          release = done;
        })),
      );

      const first = conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'read the notes',
        threadId: 'thread-a',
      });
      // The second waits for the thread the first holds, and is reported as the same
      // stretch of work: the user is waiting either way.
      const second = conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'and the mail',
        threadId: 'thread-a',
      });
      await Promise.resolve();
      expect(seen.filter((event) => !event.working)).toEqual([]);

      release();
      await first;
      await second;
      off();

      expect(seen.filter((event) => event.working)).toHaveLength(1);
      expect(seen.filter((event) => !event.working)).toHaveLength(1);
    });

    it('ends the report when the turn throws', async () => {
      const { seen, off } = record();
      mockInvokeStream.mockImplementationOnce(() => {
        throw new Error('the provider refused');
      });

      await expect(
        conversationEngineService.chat({
          userId: 'user-123',
          agentId: 'agent-123',
          message: 'read the notes',
        }),
      ).rejects.toThrow('the provider refused');
      off();

      expect(seen.map((event) => event.working)).toEqual([true, false]);
    });
  });
});
