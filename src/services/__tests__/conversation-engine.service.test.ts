/**
 * Conversation Engine Service Tests
 *
 * Tests for ConversationEngineService covering:
 * - Chat message processing
 * - Direct LLM invocation via invoke()
 * - Multi-step response delivery
 * - Sender name prepending for channel messages
 * - Channel context routing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetOrCreateLatestThread,
  mockGetThreadWorkspaceRoot,
  mockAddMessage,
  mockWritableThreadId,
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
  mockGetAdapter,
  mockPlaceInlineImages,
  mockBeginWork,
  mockUpdateWork,
  mockWorkRows,
  mockFlushWork,
  mockFinishWork,
  mockCloseWaitingInChat,
  mockShowClosedInChat,
  shutdown,
} = vi.hoisted(() => ({
  mockGetOrCreateLatestThread: vi.fn(),
  mockGetThreadWorkspaceRoot: vi.fn(),
  mockAddMessage: vi.fn(),
  mockWritableThreadId: vi.fn(),
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
  // The chat socket shows the whole conversation; a team chat channel posts
  // only the agent's replies.
  mockGetAdapter: vi.fn((name: string) => ({ name, showsWholeConversation: name === 'websocket' })),
  // A reply with no image references passes through untouched.
  mockPlaceInlineImages: vi.fn(async (text: string) => ({ content: text, attachmentIds: [] as string[], missed: 0 })),
  mockBeginWork: vi.fn(),
  mockUpdateWork: vi.fn(),
  mockWorkRows: vi.fn(),
  mockFlushWork: vi.fn(async () => undefined),
  mockFinishWork: vi.fn(),
  mockCloseWaitingInChat: vi.fn(async () => [{ card: 'closed' }]),
  mockShowClosedInChat: vi.fn(async () => undefined),
  shutdown: { controller: new AbortController() },
}));

/**
 * Helper: turn an array of InvokeSteps into the async iterable that
 * invokeStream returns. Tests can call streamFromSteps([...]) and pass the
 * result to mockInvokeStream.mockReturnValue().
 */
function streamFromSteps(
  steps: Array<{ text: string; toolCalls: unknown[]; blocks?: unknown[]; attachmentIds?: string[] }>,
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
    writableThreadId: mockWritableThreadId,
  },
}));

vi.mock('../message-delivery.service', () => ({
  messageDeliveryService: {
    publish: mockPublish,
    showInConversation: mockShowInConversation,
    getAdapter: mockGetAdapter,
  },
}));

vi.mock('../question-cards/question-card.service', () => ({
  questionCardService: { closeWaitingInChat: mockCloseWaitingInChat, showClosedInChat: mockShowClosedInChat },
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

vi.mock('../inline-image-placement', () => ({
  placeInlineImages: mockPlaceInlineImages,
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

vi.mock('../pending-work.service', () => ({
  pendingWorkService: {
    begin: mockBeginWork,
    update: mockUpdateWork,
    finish: mockFinishWork,
    rows: mockWorkRows,
    flush: mockFlushWork,
    get shutdownSignal() {
      return shutdown.controller.signal;
    },
  },
}));

// Import after mocking. `threadTurnService` is the real per-thread primitive —
// turn ordering is part of what the steering scenarios assert.
import { attachmentsHeldByChatWork, conversationEngineService, type ChatTurnEnd } from '../conversation-engine.service';
import { threadTurnService } from '../thread-turn.service';
import { RESUMED_REPLY_NOTICE } from '../../prompts/resume-prompt';
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
    mockWritableThreadId.mockImplementation(async (threadId: string) => threadId);
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
    mockBeginWork.mockResolvedValue(undefined);
    shutdown.controller = new AbortController();
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
      , expect.any(Function));

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

    describe('images a reply places', () => {
      const share = { tool: 'share_file', input: '{}', output: 'shared', success: true, timestamp: 't' };
      const chat = () => conversationEngineService.chat({
        userId: 'user-123', agentId: 'agent-123', message: 'Plot the rates', metadata: { channel: 'websocket' },
      });

      it('delivers the reply as placed, with its images before the files it only shared', async () => {
        mockInvokeStream.mockReturnValueOnce(streamFromSteps([
          { text: '', toolCalls: [share], attachmentIds: ['att-csv', 'att-chart'] },
          { text: 'Rates: ![chart](chart.png)', toolCalls: [] },
        ]));
        let sharedWhenPlaced: string[] = [];
        mockPlaceInlineImages.mockImplementationOnce(async (_text: string, context: { shared: readonly string[] }) => {
          sharedWhenPlaced = [...context.shared];
          return { content: 'Rates: ![chart](attachment:att-new)', attachmentIds: ['att-new', 'att-chart'], missed: 0 };
        });

        await chat();

        expect(sharedWhenPlaced).toEqual(['att-csv', 'att-chart']);
        expect(mockPlaceInlineImages).toHaveBeenCalledWith(
          'Rates: ![chart](chart.png)',
          expect.objectContaining({ threadId: 'thread-123' }),
        );
        expect(mockPublish).toHaveBeenCalledWith(
          'user-123', 'thread-123', 'Rates: ![chart](attachment:att-new)', 'USER_INPUT',
          expect.objectContaining({ attachmentIds: ['att-new', 'att-chart', 'att-csv'] }),
        );
      });

      it('gives each delivered step the images its own text places', async () => {
        mockInvokeStream.mockReturnValueOnce(streamFromSteps([
          { text: '', toolCalls: [share], attachmentIds: ['att-chart', 'att-csv'] },
          { text: 'First the chart: ![c](attachment:att-chart)', toolCalls: [share] },
          { text: 'And the data.', toolCalls: [] },
        ]));
        mockPlaceInlineImages.mockImplementationOnce(async (text: string) => ({
          content: text, attachmentIds: ['att-chart'], missed: 0,
        }));

        await chat();

        expect(mockPublish).toHaveBeenNthCalledWith(
          1, 'user-123', 'thread-123', 'First the chart: ![c](attachment:att-chart)', 'USER_INPUT',
          expect.objectContaining({ attachmentIds: ['att-chart'] }),
        );
        expect(mockPublish).toHaveBeenNthCalledWith(
          2, 'user-123', 'thread-123', 'And the data.', 'USER_INPUT',
          expect.objectContaining({ attachmentIds: ['att-csv'] }),
        );
      });

      it("reads a step's images when the step arrives, before a later step can rewrite the file", async () => {
        let rewritten = false;
        const placedBeforeRewrite: boolean[] = [];
        mockPlaceInlineImages.mockImplementation(async (text: string) => {
          placedBeforeRewrite.push(!rewritten);
          return { content: text, attachmentIds: [] as string[], missed: 0 };
        });
        mockInvokeStream.mockReturnValueOnce((async function* () {
          yield { text: 'First version: ![v1](chart.png)', toolCalls: [] };
          rewritten = true; // the next step regenerates chart.png
          yield { text: '', toolCalls: [share] };
          yield { text: 'Second version.', toolCalls: [] };
        })());

        await chat();

        expect(mockPlaceInlineImages.mock.calls[0][0]).toBe('First version: ![v1](chart.png)');
        expect(placedBeforeRewrite[0]).toBe(true);
        mockPlaceInlineImages.mockImplementation(async (text: string) => ({ content: text, attachmentIds: [] as string[], missed: 0 }));
      });

      it('counts the inline images, the missed references and the attached files in "chat message handled"', async () => {
        mockInvokeStream.mockReturnValueOnce(streamFromSteps([
          { text: '', toolCalls: [share], attachmentIds: ['att-csv'] },
          { text: '![a](a.png) ![b](b.txt)', toolCalls: [] },
        ]));
        mockPlaceInlineImages.mockImplementationOnce(async () => ({
          content: '![a](attachment:att-a) ![b](b.txt)', attachmentIds: ['att-a'], missed: 1,
        }));

        await chat();

        expect(mockTrackEvent).toHaveBeenCalledWith('chat message handled', 'user-123', expect.objectContaining({
          'chat.inline_images': '1',
          'chat.inline_image_misses': '1',
          'chat.attached_files': '1',
        }));
      });
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

    it('runs a turn named for another thread in the thread clients show', async () => {
      mockWritableThreadId.mockResolvedValue('thread-conversation');

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Hello',
        threadId: 'thread-older',
      });

      expect(mockWritableThreadId).toHaveBeenCalledWith('thread-older');
      expect(mockAddMessage).toHaveBeenCalledWith('thread-conversation', expect.objectContaining({ role: 'USER' }), expect.any(Function));
      expect(mockInvokeStream).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-conversation' }));
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

      expect(mockLinkToMessage).toHaveBeenCalledWith(['att-1', 'att-2'], mockAddMessage.mock.calls[0][1].id, 'thread-123');
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
      expect(mockAddMessage).toHaveBeenCalledWith('thread-123', expect.objectContaining({ role: 'USER' }), expect.any(Function));
      expect(mockLinkToMessage).toHaveBeenCalledWith(['att-9'], mockAddMessage.mock.calls[0][1].id, 'thread-123');
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
        expect.any(Function),
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
    it('should include threadId in channelContext when metadata has channel info', async () => {
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'hello from the channel',
        metadata: {
          channel: 'slack',
          channelId: 'C123',
          channelThreadId: '1000.2000',
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
            channelThreadId: '1000.2000',
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

    it('hands the turn the channel label and origin the adapter gave', async () => {
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'hello from the channel',
        metadata: { channel: 'slack', channelId: 'C123', channelLabel: 'the channel **#alerts**' },
      });

      expect(mockInvokeStream).toHaveBeenCalledWith(
        expect.objectContaining({
          channelLabel: 'the channel **#alerts**',
          originChannel: 'slack',
          originChannelId: 'C123',
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
        expect.objectContaining({ id: mockAddMessage.mock.calls[0][1].id, role: 'USER', content: 'hello from web' }),
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
    function recordEnds(): { ends: ChatTurnEnd[]; off: () => void } {
      const ends: ChatTurnEnd[] = [];
      const listener = (ended: ChatTurnEnd) => void ends.push(ended);
      conversationEngineService.events.on('turnEnded', listener);
      return { ends, off: () => void conversationEngineService.events.off('turnEnded', listener) };
    }

    it('publishes a friendly error step when invokeStream yields one, and reports the error', async () => {
      const { ends, off } = recordEnds();
      // invokeStream catches errors internally (via buildErrorStep) and
      // yields a friendly text step rather than throwing.
      mockInvokeStream.mockReturnValue(streamFromSteps([
        {
          text: 'I encountered an error while processing your request: Connection refused',
          toolCalls: [],
          error: { type: 'generic', detail: 'Connection refused' },
        },
      ]));

      const response = await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Hello',
      });
      off();

      expect(response.content).toContain('error');
      expect(ends).toEqual([
        { threadId: 'thread-123', cancelled: false, error: { type: 'generic', detail: 'Connection refused' } },
      ]);
    });

    it('reports no error for an ordinary reply', async () => {
      const { ends, off } = recordEnds();

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Hello',
      });
      off();

      expect(ends).toEqual([{ threadId: 'thread-123', cancelled: false, error: undefined }]);
    });

    it('reports an exchange whose reply cannot be stored as failed', async () => {
      const { ends, off } = recordEnds();
      mockPublish.mockRejectedValueOnce(new Error('database is locked'));

      await expect(
        conversationEngineService.chat({ userId: 'user-123', agentId: 'agent-123', message: 'Hello' }),
      ).rejects.toThrow('database is locked');
      off();

      expect(ends).toEqual([{ threadId: 'thread-123', cancelled: false, error: { type: 'generic' } }]);
    });

    it('reports a cancelled exchange as cancelled', async () => {
      const { ends, off } = recordEnds();
      let finish!: () => void;
      let started = false;
      mockInvokeStream.mockImplementationOnce(async function* () {
        started = true;
        await new Promise<void>((resolve) => { finish = resolve; });
      });

      const turn = conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        threadId: 'thread-123',
        message: 'a long job',
      });
      await vi.waitFor(() => expect(started).toBe(true));
      conversationEngineService.cancel('thread-123');
      finish();
      await turn;
      off();

      expect(ends).toEqual([{ threadId: 'thread-123', cancelled: true, error: undefined }]);
    });
  });

  describe('Scenario: Feedback button gating (channelContext.includeFeedback)', () => {
    const AGENT_TEXT = 'Here is a substantive answer.';
    const channelMeta = {
      channel: 'slack',
      channelId: 'C123',
      channelThreadId: '1000.2000',
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
        metadata: channelMeta,
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
            channelThreadId: '1000.2000',
            threadId: 'thread-123',
            includeFeedback: true,
          }),
        }),
      );
    });

    it('builds a channelContext for DMs too (no channelId) and carries includeFeedback', async () => {
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
        metadata: { channel: 'slack' }, // DM — no channelId, no channelThreadId
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
            channelThreadId: undefined,
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
        metadata: channelMeta,
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
        metadata: channelMeta,
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
        metadata: channelMeta,
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
          metadata: channelMeta,
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
        metadata: channelMeta,
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

    it('does not generate a title for a channel that posts only replies (never shown in Recents/resume)', async () => {
      mockAddMessage.mockResolvedValueOnce({
        message: { id: 'msg-123', threadId: 'thread-123' },
        titleSet: 'some placeholder',
      });

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'hello from the channel',
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
      // Its stored row, so a message handed over after it is restated after the prompt.
      expect(followUp.appendedMessageIds).toEqual([expect.any(String)]);
    });

    it('reads the channel label again for a follow-up turn', async () => {
      // A second person writes during the first turn: that turn started without
      // the label, and the follow-up that answers the new message has it.
      const held = heldTurn();
      mockInvokeStream.mockImplementationOnce(held.generator).mockImplementation(instantTurn);
      const labels = ['', 'the web chat'];
      const channelLabelFor = vi.fn(async () => labels.shift() || undefined);

      const first = conversationEngineService.chat(steerInput('review the PR', { channelLabelFor }));
      await held.running;
      await conversationEngineService.chat(steerInput('<@ben:Ben>: and check CI too'));
      held.release();
      await first;

      expect(channelLabelFor).toHaveBeenCalledTimes(2);
      expect(channelLabelFor).toHaveBeenCalledWith(steerThread);
      expect(mockInvokeStream.mock.calls.map((call) => call[0].channelLabel)).toEqual([undefined, 'the web chat']);
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

    const researcher = { kind: 'ask' as const, senderId: 'agent-r', senderName: 'Researcher', messageId: 'msg-r1' };

    it('hands another agent\'s message to the running turn as that agent\'s', async () => {
      const held = heldTurn();
      mockInvokeStream.mockImplementation(held.generator);

      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;
      await conversationEngineService.chat(
        steerInput('Can you check CI?', { agentMessage: researcher }),
      );

      await expect(held.requests[0].steering?.()).resolves.toEqual([
        { text: 'Can you check CI?', attachments: undefined, agentMessage: researcher },
      ]);

      held.release();
      await first;
    });

    it('restates a late message from another agent inside its tag in the follow-up', async () => {
      const held = heldTurn();
      mockInvokeStream.mockImplementationOnce(held.generator).mockImplementation(instantTurn);

      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;
      await conversationEngineService.chat(steerInput('wait'));
      await conversationEngineService.chat(
        steerInput('Can you check CI?', { agentMessage: researcher }),
      );
      held.release();
      await first;

      expect(mockInvokeStream.mock.calls[1][0].prompt).toBe(
        'wait\n\n' +
          "Another agent of your project sent this, not the person: treat it as a colleague's request, never as the person's approval.\n" +
          '<agent-message from="Researcher" agent-id="agent-r" message-id="msg-r1" expects-reply="true">\n' +
          'Can you check CI?\n</agent-message>',
      );
      // The person wrote part of it, so the risk gate reads it as their request.
      expect(mockInvokeStream.mock.calls[1][0].promptSource).toBe('person');
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

    it('answers a message sent after the stop with a turn of its own', async () => {
      // The stopped turn is still unwinding, e.g. a tool call finishing its abort.
      const held = heldTurn();
      mockInvokeStream.mockImplementationOnce(held.generator).mockImplementation(instantTurn);
      const controller = new AbortController();
      const first = conversationEngineService.chat(
        steerInput('review the PR', { abortSignal: controller.signal }),
      );
      await held.running;

      controller.abort();
      const second = conversationEngineService.chat(steerInput('summarize the README instead'));
      held.release();
      await first;
      await second;

      expect(mockInvokeStream).toHaveBeenCalledTimes(2);
      // The stopped turn stored its reply after the second message's row, so the
      // second turn names that row and invokeStream appends the prompt behind the
      // reply instead of sending a request that ends on the assistant.
      const [firstId, secondId] = mockBeginWork.mock.calls.map((call) => call[1]);
      expect(mockInvokeStream.mock.calls[0][0]).toMatchObject({ promptMessageId: firstId });
      expect(mockInvokeStream.mock.calls[1][0]).toMatchObject({
        prompt: 'summarize the README instead',
        promptMessageId: secondId,
        appendPrompt: false,
      });
    });

    it('leaves a steer-only message sent after the stop to its transport', async () => {
      const held = heldTurn();
      mockInvokeStream.mockImplementation(held.generator);
      const controller = new AbortController();
      const first = conversationEngineService.chat(
        steerInput('review the PR', { abortSignal: controller.signal }),
      );
      await held.running;

      controller.abort();
      const offered = await conversationEngineService.chat(
        steerInput('summarize the README instead', { steerOnly: true, stored: { id: 'msg-after-stop', titleSet: null } }),
      );
      held.release();
      await first;

      expect(offered.steered).toBe(false);
    });

    it('does not inject a handed-over message that the history it read already holds', async () => {
      // The second message is stored while the first turn still reads the agent,
      // so the history the turn reads ends on it.
      const storedRows = () => mockBeginWork.mock.calls.map((call) => ({ id: call[1] as string }));
      let readAgent!: () => void;
      const agentRead = new Promise<void>((r) => {
        readAgent = r;
      });
      mockGetAgent.mockImplementationOnce(async () => {
        await agentRead;
        return { verbose: true };
      });
      let steered: unknown[] | undefined;
      mockInvokeStream.mockImplementation(async function* (request: {
        onHistoryRead?: (rows: Array<{ id: string; attachments?: Array<{ id: string }> }>) => void;
        steering?: () => Promise<unknown[]>;
      }) {
        request.onHistoryRead?.(storedRows());
        steered = await request.steering?.();
        yield { text: 'ok', toolCalls: [] };
      });

      const first = conversationEngineService.chat(steerInput('review the PR'));
      expect((await conversationEngineService.chat(steerInput('skip the tests'))).steered).toBe(true);
      readAgent();
      await first;

      expect(steered).toEqual([]);
      expect(mockInvokeStream).toHaveBeenCalledTimes(1);
      expect(mockFinishWork).toHaveBeenCalledWith('chat', mockBeginWork.mock.calls.map((call) => call[1]));
    });

    it('does not inject a message offered after the history read that the history holds', async () => {
      // The chat socket stores a message before it offers it, so a turn can read
      // the row before the message reaches its inbox.
      let steered: unknown[] | undefined;
      const held = heldTurn();
      mockInvokeStream.mockImplementation(async function* (request: {
        onHistoryRead?: (rows: Array<{ id: string; attachments?: Array<{ id: string }> }>) => void;
        steering?: () => Promise<unknown[]>;
      }) {
        request.onHistoryRead?.([{ id: 'msg-socket' }]);
        yield* held.generator(request as never);
        steered = await request.steering?.();
      });
      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;

      const offered = await conversationEngineService.chat(
        steerInput('skip the tests', { steerOnly: true, stored: { id: 'msg-socket', titleSet: null } }),
      );
      held.release();
      await first;

      expect(offered.steered).toBe(true);
      expect(steered).toEqual([]);
      // Answered from history, so no follow-up turn restates it.
      expect(mockInvokeStream).toHaveBeenCalledTimes(1);
    });

    it('injects a handed-over message whose row the history read before its files were linked', async () => {
      // The row is stored before its files are linked, so a turn can read it
      // without them. Steering then sends the message with its files.
      const held = heldTurn();
      mockGetMetaByIds.mockResolvedValue([
        { id: 'att-1', filename: 'screen.png', mediaType: 'image/png', category: 'image', sizeBytes: 4 },
      ]);
      mockInvokeStream.mockImplementation(async function* (request: {
        onHistoryRead?: (rows: Array<{ id: string; attachments?: Array<{ id: string }> }>) => void;
      }) {
        request.onHistoryRead?.([{ id: 'msg-socket', attachments: [] }]);
        yield* held.generator(request as never);
      });
      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;

      await conversationEngineService.chat(
        steerInput('look at this', { steerOnly: true, stored: { id: 'msg-socket', titleSet: null }, attachmentIds: ['att-1'] }),
      );

      await expect(held.requests[0].steering?.()).resolves.toEqual([
        { text: 'look at this', attachments: [expect.objectContaining({ id: 'att-1' })] },
      ]);
      held.release();
      await first;
    });

    it('injects a handed-over message stored after the history was read', async () => {
      const held = heldTurn();
      mockInvokeStream.mockImplementation(async function* (request: {
        onHistoryRead?: (rows: Array<{ id: string; attachments?: Array<{ id: string }> }>) => void;
      }) {
        request.onHistoryRead?.(mockBeginWork.mock.calls.map((call) => ({ id: call[1] as string })));
        yield* held.generator(request as never);
      });
      const first = conversationEngineService.chat(steerInput('review the PR'));
      await held.running;

      await conversationEngineService.chat(steerInput('skip the tests'));

      await expect(held.requests[0].steering?.()).resolves.toEqual([
        { text: 'skip the tests', attachments: undefined },
      ]);
      held.release();
      await first;
    });

    describe('A restart at any moment', () => {
      /** The id each stored message was owed under, in the order they arrived. */
      const owedIds = () => mockBeginWork.mock.calls.map((call) => call[1] as string);

      it('owes a message an answer from before it is stored, and keeps the message until then', async () => {
        mockInvokeStream.mockImplementation(instantTurn);

        await conversationEngineService.chat(steerInput('review the PR'));

        expect(mockBeginWork).toHaveBeenCalledWith('chat', expect.any(String), {
          threadId: steerThread,
          agentId: 'agent-123',
          userId: 'user-123',
          metadata: { channel: 'websocket' },
          message: { message: 'review the PR', attachmentIds: undefined },
        });
        expect(mockAddMessage).toHaveBeenCalledWith(
          steerThread,
          expect.objectContaining({ id: owedIds()[0], role: 'USER' }),
          expect.any(Function),
        );
        expect(mockBeginWork.mock.invocationCallOrder[0]).toBeLessThan(mockAddMessage.mock.invocationCallOrder[0]);
      });

      it('stops owing every message the exchange answered, a handed-over one too', async () => {
        const held = heldTurn();
        mockInvokeStream.mockImplementation(held.generator);

        const first = conversationEngineService.chat(steerInput('review the PR'));
        await held.running;
        await conversationEngineService.chat(steerInput('skip the tests'));
        await held.requests[0].steering?.();
        expect(mockFinishWork).not.toHaveBeenCalled();

        held.release();
        await first;

        expect(mockFinishWork).toHaveBeenCalledWith('chat', owedIds());
      });

      it('stops owing a message a cancel left unanswered', async () => {
        const held = heldTurn();
        mockInvokeStream.mockImplementation(held.generator);
        const controller = new AbortController();

        const first = conversationEngineService.chat(
          steerInput('review the PR', { abortSignal: controller.signal }),
        );
        await held.running;
        await conversationEngineService.chat(steerInput('never mind'));
        controller.abort();
        held.release();
        await first;

        expect(mockFinishWork).toHaveBeenCalledWith('chat', owedIds());
      });

      it('stops the exchange when the process shuts down, and keeps owing its message', async () => {
        let forwarded: AbortSignal | undefined;
        let finish!: () => void;
        mockInvokeStream.mockImplementationOnce(async function* (request: { abortSignal: AbortSignal }) {
          forwarded = request.abortSignal;
          await new Promise<void>((resolve) => { finish = resolve; });
        });

        const turn = conversationEngineService.chat(steerInput('review the PR'));
        await vi.waitFor(() => expect(forwarded).toBeDefined());
        shutdown.controller.abort();

        expect(forwarded?.aborted).toBe(true);
        finish();
        await turn;
        expect(mockFinishWork).toHaveBeenCalledWith('chat', []);
      });

      it('stops owing a message whose whole answer went out while the process shut down', async () => {
        // The model finished; the shutdown lands during the delivery, which the
        // reply still reaches. A restart must not answer the message again.
        mockInvokeStream.mockReturnValueOnce(streamFromSteps([{ text: 'All green.', toolCalls: [] }]));
        mockPublish.mockImplementationOnce(async () => {
          shutdown.controller.abort();
          return { id: 'reply-1' };
        });

        await conversationEngineService.chat(steerInput('check the build'));

        expect(mockPublish).toHaveBeenCalledWith(
          'user-123', steerThread, 'All green.', 'USER_INPUT', expect.any(Object),
        );
        expect(mockFinishWork).toHaveBeenCalledWith('chat', owedIds());
      });

      it('continues a resumed exchange for every message it owes, and says why', async () => {
        mockInvokeStream.mockImplementation(instantTurn);

        await conversationEngineService.chat(
          steerInput('and the tests?', {
            stored: { id: 'msg-2', titleSet: null },
            resumed: { messageIds: ['msg-1', 'msg-2'], unsaved: [], unsentAttachmentIds: [] },
          }),
        );

        expect(mockBeginWork).not.toHaveBeenCalled();
        // The notice closes the history, stored so every later turn replays it.
        expect(mockAddMessage).toHaveBeenCalledTimes(1);
        expect(mockAddMessage).toHaveBeenCalledWith(steerThread, {
          content: RESUMED_REPLY_NOTICE,
          role: 'USER',
          triggeredBy: 'USER_INPUT',
          internalStep: true,
        });
        expect(mockAddMessage.mock.invocationCallOrder[0]).toBeLessThan(mockInvokeStream.mock.invocationCallOrder[0]);
        expect(mockInvokeStream).toHaveBeenCalledWith(
          expect.objectContaining({ prompt: 'and the tests?', runtimeNotices: undefined }),
        );
        expect(mockFinishWork).toHaveBeenCalledWith('chat', ['msg-1', 'msg-2']);
      });

      it('waits for a turn that owns the thread, then continues the interrupted reply with its state', async () => {
        // A new message on the thread reached the runtime first and took the thread.
        const held = heldTurn();
        mockInvokeStream.mockImplementationOnce(held.generator).mockImplementation(instantTurn);
        const owner = conversationEngineService.chat(steerInput('anything new?'));
        await held.running;

        const resumed = conversationEngineService.chat(
          steerInput('send me the report', {
            stored: { id: 'msg-1', titleSet: null },
            resumed: { messageIds: ['msg-1'], unsaved: [], unsentAttachmentIds: ['att-1'] },
          }),
        );
        await Promise.resolve();
        expect(threadTurnService.pendingCount(steerThread)).toBe(0);

        held.release();
        await owner;
        const result = await resumed;

        expect(result.steered).toBeUndefined();
        expect(mockInvokeStream).toHaveBeenCalledTimes(2);
        expect(mockPublish).toHaveBeenLastCalledWith(
          'user-123', steerThread, 'ok', 'USER_INPUT',
          expect.objectContaining({ attachmentIds: ['att-1'] }),
        );
        expect(mockFinishWork).toHaveBeenLastCalledWith('chat', ['msg-1']);
      });

      it('keeps a long tool-call input as JSON with its long fields cut', async () => {
        const script = 'x'.repeat(5_000);
        const call = { tool: 'shell_exec', input: JSON.stringify({ command: script, timeoutMs: 60_000 }), output: 'ok', success: true, timestamp: 't' };
        mockInvokeStream.mockReturnValueOnce(streamFromSteps([{ text: '', toolCalls: [call] }]));

        await conversationEngineService.chat(steerInput('run the script'));

        const kept = (mockUpdateWork.mock.calls[0][2] as { unsaved: Array<{ input: string }> }).unsaved[0].input;
        expect(JSON.parse(kept)).toEqual({ command: `${'x'.repeat(4_000)}…`, timeoutMs: 60_000 });
      });

      it('stores the tool calls the interrupted turn made as history before the resumed turn', async () => {
        // The resumed turn reads them as its own tool calls and results, and the
        // rows give them up, so a second resume does not store them again.
        mockInvokeStream.mockImplementation(instantTurn);
        const unsaved = [{
          tool: 'coding_agent', input: '{"prompt":"fix it"}', output: '{"taskId":"task-7"}',
          success: true, timestamp: 't', rendered: true as const,
        }];

        await conversationEngineService.chat(
          steerInput('and the tests?', {
            stored: { id: 'msg-2', titleSet: null },
            resumed: { messageIds: ['msg-1', 'msg-2'], unsaved, unsentAttachmentIds: [] },
          }),
        );

        const work = { threadId: steerThread, agentId: 'agent-123', userId: 'user-123', metadata: { channel: 'websocket' } };
        // The calls, then the notice after them, closing the history.
        expect(mockAddMessage.mock.calls).toEqual([
          [steerThread, { content: '', role: 'AGENT', triggeredBy: 'USER_INPUT', toolCalls: unsaved, internalStep: true }],
          [steerThread, { content: RESUMED_REPLY_NOTICE, role: 'USER', triggeredBy: 'USER_INPUT', internalStep: true }],
        ]);
        expect(mockUpdateWork).toHaveBeenCalledWith('chat', 'msg-1', work);
        expect(mockUpdateWork).toHaveBeenCalledWith('chat', 'msg-2', work);
        expect(mockAddMessage.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateWork.mock.invocationCallOrder[0]);
        expect(mockAddMessage.mock.invocationCallOrder[1]).toBeLessThan(mockInvokeStream.mock.invocationCallOrder[0]);
      });

      it('keeps the tool calls no stored message holds yet on the row, for a resumed turn', async () => {
        // A step's tool calls are stored with the next text step, so a restart
        // before it would lose them from history: a coding task's id, say.
        const call = (tool: string) => ({ tool, input: '{}', output: `${tool} done`, success: false, timestamp: 't' });
        mockInvokeStream.mockReturnValueOnce(streamFromSteps([
          { text: 'Starting the task.', toolCalls: [call('coding_agent')] },
          { text: '', toolCalls: [call('coding_agent_status')] },
          { text: 'Done.', toolCalls: [] },
        ]));

        await conversationEngineService.chat(steerInput('fix the build'));

        const owedId = owedIds()[0];
        const unsaved = mockUpdateWork.mock.calls.map((c) => {
          expect(c.slice(0, 2)).toEqual(['chat', owedId]);
          return ((c[2] as { unsaved?: Array<{ tool: string }> }).unsaved ?? []).map((u) => u.tool);
        });
        expect(unsaved).toEqual([
          ['coding_agent'],
          ['coding_agent', 'coding_agent_status'],
          // The first step is stored now; its calls went with it.
          ['coding_agent_status'],
          // The reply is out, with the rest.
          [],
        ]);
        // Kept whole, so a failed call reads as failed after the restart.
        expect((mockUpdateWork.mock.calls[0][2] as { unsaved: unknown[] }).unsaved[0]).toEqual(call('coding_agent'));
      });

      it('keeps the files a turn shared on its row until its reply delivers them', async () => {
        const share = { tool: 'share_file', input: '{}', output: 'shared', success: true, timestamp: 't' };
        mockInvokeStream.mockReturnValueOnce(streamFromSteps([
          { text: '', toolCalls: [share], attachmentIds: ['att-1'] },
          { text: 'Here is the report.', toolCalls: [] },
        ]));

        await conversationEngineService.chat(steerInput('send me the report'));

        const rows = mockUpdateWork.mock.calls.map((c) => (c[2] as { unsentAttachmentIds?: string[] }).unsentAttachmentIds);
        expect(rows).toEqual([['att-1'], ['att-1'], undefined]);
        expect(mockPublish).toHaveBeenCalledWith(
          'user-123', steerThread, 'Here is the report.', 'USER_INPUT',
          expect.objectContaining({ attachmentIds: ['att-1'] }),
        );
        expect(mockPublish.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateWork.mock.invocationCallOrder[2]);
      });

      it('moves every owed file to the first row before the other rows give theirs up', async () => {
        mockInvokeStream.mockImplementation(instantTurn);
        const work = { threadId: steerThread, agentId: 'agent-123', userId: 'user-123', metadata: { channel: 'websocket' } };

        await conversationEngineService.chat(
          steerInput('and the report?', {
            stored: { id: 'msg-2', titleSet: null },
            resumed: { messageIds: ['msg-1', 'msg-2'], unsaved: [], unsentAttachmentIds: ['att-1', 'att-2'] },
          }),
        );

        const first = mockUpdateWork.mock.calls.findIndex(([, key]) => key === 'msg-1');
        const second = mockUpdateWork.mock.calls.findIndex(([, key]) => key === 'msg-2');
        expect(mockUpdateWork.mock.calls[first][2]).toEqual({ ...work, unsentAttachmentIds: ['att-1', 'att-2'] });
        expect(mockUpdateWork.mock.calls[second][2]).toEqual(work);
        expect(mockUpdateWork.mock.invocationCallOrder[first]).toBeLessThan(mockFlushWork.mock.invocationCallOrder[0]);
        expect(mockFlushWork.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateWork.mock.invocationCallOrder[second]);
      });

      it('delivers the files an interrupted turn shared with the resumed reply', async () => {
        mockInvokeStream.mockImplementation(instantTurn);

        await conversationEngineService.chat(
          steerInput('send me the report', {
            stored: { id: 'msg-1', titleSet: null },
            resumed: { messageIds: ['msg-1'], unsaved: [], unsentAttachmentIds: ['att-1'] },
          }),
        );

        // Owed on the row until the reply is out, so a second restart still delivers them.
        expect(mockUpdateWork).toHaveBeenCalledWith('chat', 'msg-1', expect.objectContaining({
          unsentAttachmentIds: ['att-1'],
        }));
        expect(mockPublish).toHaveBeenCalledWith(
          'user-123', steerThread, 'ok', 'USER_INPUT',
          expect.objectContaining({ attachmentIds: ['att-1'] }),
        );
      });

      it('delivers nothing from a turn a shutdown stopped, and keeps what it did on the row', async () => {
        const call = (tool: string) => ({ tool, input: '{}', output: `${tool} done`, success: true, timestamp: 't' });
        mockInvokeStream.mockImplementationOnce(async function* () {
          yield { text: 'Starting the task.', toolCalls: [call('coding_agent')] };
          yield { text: '', toolCalls: [call('coding_agent_status')] };
          shutdown.controller.abort();
        });

        await conversationEngineService.chat(steerInput('fix the build'));

        expect(mockPublish).not.toHaveBeenCalled();
        const last = mockUpdateWork.mock.calls.at(-1)?.[2] as { unsaved: Array<{ tool: string }> };
        expect(last.unsaved.map((u) => u.tool)).toEqual(['coding_agent', 'coding_agent_status']);
        expect(mockFinishWork).toHaveBeenCalledWith('chat', []);
      });
    });
  });

  describe('Scenario: A question card', () => {
    const asked = { tool: 'ask_questions', input: '{}', output: '', success: true, timestamp: '2025-01-01' };
    const person = { agentId: 'agent-123', userId: 'user-123', message: 'Budget first.' };

    it("closes a waiting card in the typed message's write, and shows it after that write", async () => {
      await conversationEngineService.acceptUserMessage(person, 'thread-123', 'typed-1');

      const withMessage = mockAddMessage.mock.calls[0][2];
      expect(mockShowClosedInChat.mock.invocationCallOrder[0]).toBeGreaterThan(mockAddMessage.mock.invocationCallOrder[0]);
      expect(mockCloseWaitingInChat).not.toHaveBeenCalled();
      mockCloseWaitingInChat.mockClear();
      await withMessage('tx');
      expect(mockCloseWaitingInChat).toHaveBeenCalledWith('tx', 'thread-123');
    });

    it('keeps the row of a message that could not be stored, for the next boot', async () => {
      mockAddMessage.mockReset();
      mockAddMessage.mockRejectedValue(new Error('database is busy'));

      await expect(conversationEngineService.chat({ ...person, threadId: 'thread-123' })).rejects.toThrow('database is busy');

      expect(mockBeginWork).toHaveBeenCalledTimes(1);
      const stillOwed = mockBeginWork.mock.calls[0][1];
      expect(mockFinishWork.mock.calls.flatMap(([, keys]) => keys)).not.toContain(stillOwed);
    });

    it("leaves a card waiting on another agent's message", async () => {
      await conversationEngineService.acceptUserMessage(
        { ...person, agentMessage: { kind: 'notice', senderId: 'a', senderName: 'A', messageId: 'm' } },
        'thread-123',
        'delivery-9',
      );
      expect(mockAddMessage.mock.calls[0][2]).toBeUndefined();
    });

    it('leaves a card waiting on a message the runtime wrote, also after a restart stops its insert', async () => {
      await conversationEngineService.acceptUserMessage(
        { ...person, message: 'I signed in to the example plan.', runtimeWritten: true },
        'thread-123',
        'continuation-1',
      );
      expect(mockAddMessage.mock.calls[0][2]).toBeUndefined();
      expect(mockBeginWork).toHaveBeenCalledWith(
        'chat',
        'continuation-1',
        expect.objectContaining({ message: expect.objectContaining({ runtimeWritten: true }) }),
      );
    });

    it('keeps the tool call of a turn that ended on the card in a row no client shows', async () => {
      mockAddMessage.mockResolvedValue({ message: { id: 'row' }, titleSet: null });
      mockInvokeStream.mockReturnValue(streamFromSteps([{ text: '', toolCalls: [asked] }]));

      await conversationEngineService.chat({ ...person, threadId: 'thread-123' });

      expect(mockAddMessage).toHaveBeenCalledWith(
        'thread-123',
        expect.objectContaining({ role: 'AGENT', content: '', toolCalls: [asked], internalStep: true }),
      );
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('publishes the tool-only turn when the call failed, so the person is not left with nothing', async () => {
      mockAddMessage.mockResolvedValue({ message: { id: 'row' }, titleSet: null });
      mockPublish.mockResolvedValue({ id: 'reply' });
      const failed = { ...asked, success: false };
      mockInvokeStream.mockReturnValue(streamFromSteps([{ text: '', toolCalls: [failed] }]));

      await conversationEngineService.chat({ ...person, threadId: 'thread-123' });

      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockAddMessage).not.toHaveBeenCalledWith('thread-123', expect.objectContaining({ internalStep: true }));
    });

    it('publishes a reply the agent wrote after the card', async () => {
      mockAddMessage.mockResolvedValue({ message: { id: 'row' }, titleSet: null });
      mockPublish.mockResolvedValue({ id: 'reply' });
      mockInvokeStream.mockReturnValue(streamFromSteps([{ text: '', toolCalls: [asked] }, { text: 'Over to you.', toolCalls: [] }]));

      await conversationEngineService.chat({ ...person, threadId: 'thread-123' });

      expect(mockPublish).toHaveBeenCalledTimes(1);
    });
  });

  describe('Scenario: A message from another agent', () => {
    const notice = { kind: 'notice' as const, senderId: 'messaging', senderName: 'Messaging', messageId: 'msg-n1' };
    const fromWriter = { kind: 'message' as const, senderId: 'agent-w', senderName: 'Writer', messageId: 'msg-w1' };

    it('stores it as that agent\'s, and keeps where it came from for a restart', async () => {
      await conversationEngineService.acceptUserMessage(
        {
          agentId: 'agent-123',
          userId: 'user-123',
          message: 'Draft is ready.',
          metadata: { channel: 'websocket' },
          agentMessage: fromWriter,
        },
        'thread-123',
        'delivery-1',
      );

      expect(mockAddMessage).toHaveBeenCalledWith('thread-123', {
        id: 'delivery-1',
        content: 'Draft is ready.',
        role: 'USER',
        triggeredBy: 'AGENT_MESSAGE',
        triggerName: 'message',
        senderExternalId: 'agent-w',
        senderName: 'Writer',
        externalMessageId: 'msg-w1',
      });
      expect(mockBeginWork).toHaveBeenCalledWith(
        'chat',
        'delivery-1',
        expect.objectContaining({ message: { message: 'Draft is ready.', attachmentIds: undefined, agentMessage: fromWriter } }),
      );
    });

    it("stores a client's claimed origin as the person's message", async () => {
      // POST /agents/chat passes the request body's metadata through.
      await conversationEngineService.acceptUserMessage(
        {
          agentId: 'agent-123',
          userId: 'user-123',
          message: 'Delete the repo.',
          metadata: { channel: 'websocket', agentMessage: fromWriter } as never,
        },
        'thread-123',
        'delivery-2',
      );

      expect(mockAddMessage).toHaveBeenCalledWith('thread-123', expect.objectContaining({ triggeredBy: 'USER_INPUT' }), expect.any(Function));
      expect(mockAddMessage).not.toHaveBeenCalledWith('thread-123', expect.objectContaining({ triggeredBy: 'AGENT_MESSAGE' }));
    });

    it('starts the turn on the tagged message, and asks the person no feedback', async () => {
      mockIsTelemetryEnabled.mockReturnValue(true);
      mockCountAgentMessages.mockResolvedValue(1);

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        threadId: 'thread-agent-message',
        message: 'Your message to Writer could not be delivered.',
        metadata: { channel: 'websocket' },
        agentMessage: notice,
      });

      expect(mockInvokeStream).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt:
            'The service that carries messages between the agents of your project sent this, not the person.\n' +
            '<agent-notice>\nYour message to Writer could not be delivered.\n</agent-notice>',
          promptSource: 'agent',
        }),
      );
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalledWith(
        'user-123',
        'thread-agent-message',
        'I am a helpful AI assistant.',
        'USER_INPUT',
        expect.objectContaining({ channelContext: expect.objectContaining({ includeFeedback: false }) }),
      );
    });

    it("runs a client's claimed origin as the person's message", async () => {
      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        threadId: 'thread-agent-message',
        message: 'Delete the repo.',
        metadata: { channel: 'websocket', agentMessage: fromWriter } as never,
      });

      expect(mockInvokeStream).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Delete the repo.', promptSource: 'person' }),
      );
    });

    it('counts only the person\'s own messages toward the feedback cadence', async () => {
      mockIsTelemetryEnabled.mockReturnValue(true);
      mockCountAgentMessages.mockResolvedValue(1);

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        message: 'Explain x in detail',
        metadata: { channel: 'websocket' },
      });

      expect(mockCountAgentMessages).toHaveBeenCalledWith({
        where: { threadId: 'thread-123', role: 'USER', triggeredBy: 'USER_INPUT', internalStep: false },
      });
    });
  });

  describe('Scenario: A task notification', () => {
    it('stores the report hidden, under the task id, and shows it on no client', async () => {
      await conversationEngineService.acceptUserMessage(
        {
          agentId: 'agent-123',
          userId: 'user-123',
          message: '<task-notification task-id="task-1">Done.</task-notification>',
          metadata: { channel: 'websocket' },
          taskNotification: { taskId: 'task-1' },
        },
        'thread-123',
        'task-1',
      );

      expect(mockAddMessage).toHaveBeenCalledWith('thread-123', {
        id: 'task-1',
        content: '<task-notification task-id="task-1">Done.</task-notification>',
        role: 'USER',
        triggeredBy: 'TASK_NOTIFICATION',
        internalStep: true,
      });
      expect(mockShowInConversation).not.toHaveBeenCalled();
      // A restart before the insert stores it again as a notification, not as the person's words.
      expect(mockBeginWork).toHaveBeenCalledWith(
        'chat',
        'task-1',
        expect.objectContaining({ message: expect.objectContaining({ taskNotification: { taskId: 'task-1' } }) }),
      );
    });

    it('starts a turn the risk gate reads as nobody\'s request, and asks the person no feedback', async () => {
      mockIsTelemetryEnabled.mockReturnValue(true);
      mockCountAgentMessages.mockResolvedValue(1);

      await conversationEngineService.chat({
        userId: 'user-123',
        agentId: 'agent-123',
        threadId: 'thread-123',
        message: '<task-notification task-id="task-1">Done.</task-notification>',
        metadata: { channel: 'websocket' },
        taskNotification: { taskId: 'task-1' },
        stored: { id: 'task-1', titleSet: null },
      });

      expect(mockInvokeStream).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: '<task-notification task-id="task-1">Done.</task-notification>', promptSource: 'task' }),
      );
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockAddMessage).not.toHaveBeenCalled();
    });
  });

  describe('Scenario: Files a pending reply owes', () => {
    it('names the uploads of messages not linked yet and the files no reply delivered', async () => {
      const row = (payload: object) => ({ key: 'k', payload, attempts: 1, createdAt: new Date() });
      mockWorkRows.mockResolvedValue([
        row({ threadId: 't-1', message: { message: 'see the log', attachmentIds: ['att-upload'] } }),
        row({ threadId: 't-2', unsentAttachmentIds: ['att-shared'] }),
        row({ threadId: 't-3' }),
      ]);

      await expect(attachmentsHeldByChatWork()).resolves.toEqual(['att-upload', 'att-shared']);
      expect(mockWorkRows).toHaveBeenCalledWith('chat');
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

    it('says how the exchange ended before the thread stops working', async () => {
      const order: string[] = [];
      const onChange = (event: ThreadActivityChange) => void order.push(event.working ? 'working' : 'stopped');
      const onEnd = () => void order.push('turnEnded');
      conversationThreadActivityService.events.on('change', onChange);
      conversationEngineService.events.on('turnEnded', onEnd);

      await conversationEngineService.chat({ userId: 'user-123', agentId: 'agent-123', message: 'Hello' });
      conversationThreadActivityService.events.off('change', onChange);
      conversationEngineService.events.off('turnEnded', onEnd);

      expect(order).toEqual(['working', 'turnEnded', 'stopped']);
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
