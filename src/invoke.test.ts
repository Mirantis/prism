/**
 * Invoke Tests
 *
 * Core invocation logic with heavy mocking of external dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RESUMED_RUN_NOTICE } from './prompts/resume-prompt';
import { createTestInvokeRequest, createTestAgentContext } from './test-utils/factories';
import { attachmentService } from './services/attachment.service';

const {
  mockGenerateText,
  mockMissingProviderSettings,
  mockCreateBedrockProvider,
  mockGetMCPTools,
  mockGetPluginTools,
  mockBuildSystemPromptParts,
  mockBuildRecalledMemories,
  mockBuildRecentMemories,
  mockAddMessage,
  mockBuildConversationMessages,
  mockGetChannelBehaviorInstructions,
  mockGetTaskToolInstructions,
  mockGetAgentContext,
  mockGetSubagents,
  mockCreateTaskTool,
  mockSetProcessing,
  mockSetDoneProcessing,
  mockGetMemoryTools,
  mockGetCronTools,
  mockGetAgentConfigTools,
  mockGetShellTools,
  mockGetShareFileTools,
  mockGetSkillTools,
  mockWithToolRiskGate,
} = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockMissingProviderSettings: vi.fn(),
  mockCreateBedrockProvider: vi.fn(),
  mockGetMCPTools: vi.fn(),
  mockGetPluginTools: vi.fn(),
  mockBuildSystemPromptParts: vi.fn(),
  mockBuildRecalledMemories: vi.fn(),
  mockBuildRecentMemories: vi.fn(),
  mockAddMessage: vi.fn(),
  mockBuildConversationMessages: vi.fn(),
  mockGetChannelBehaviorInstructions: vi.fn(),
  mockGetTaskToolInstructions: vi.fn(),
  mockGetAgentContext: vi.fn(),
  mockGetSubagents: vi.fn(),
  mockCreateTaskTool: vi.fn(),
  mockSetProcessing: vi.fn(),
  mockSetDoneProcessing: vi.fn(),
  mockGetMemoryTools: vi.fn(),
  mockGetCronTools: vi.fn(),
  mockGetAgentConfigTools: vi.fn(),
  mockGetShellTools: vi.fn(),
  mockGetShareFileTools: vi.fn(),
  mockGetSkillTools: vi.fn(),
  mockWithToolRiskGate: vi.fn(),
}));

// The history knob stays a plain message list; every announcement comes back
// as trailing. Where each one lands is context-builder.test.ts's business.
const { mockBuildConversationHistory } = vi.hoisted(() => ({
  mockBuildConversationHistory: vi.fn(
    (context: unknown, toolChanges: Array<{ message: unknown }> = []) => ({
      messages: mockBuildConversationMessages(context),
      trailingToolChanges: toolChanges.map((change) => change.message),
    }),
  ),
}));

/**
 * Wrap mockGenerateText to simulate the SDK behavior: call onStepFinish for each step.
 */
function simulatingGenerateText(opts: Record<string, unknown>) {
  const result = mockGenerateText(opts);
  // If it's a promise (mockResolvedValue), chain the onStepFinish calls
  if (result && typeof result.then === 'function') {
    return result.then((resolved: { steps: Array<{ text: string; toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>; toolResults: Array<{ toolCallId: string; output: unknown }> }> }) => {
      if (opts.onStepFinish && resolved.steps) {
        for (const step of resolved.steps) {
          (opts.onStepFinish as (step: unknown) => void)(step);
        }
      }
      return resolved;
    });
  }
  return result;
}

vi.mock('ai', async (importOriginal) => ({
  // The tool ledger compares definitions by their JSON schema.
  asSchema: (await importOriginal<typeof import('ai')>()).asSchema,
  generateText: (opts: Record<string, unknown>) => simulatingGenerateText(opts),
  stepCountIs: (limit: number) => ({ type: 'step-count', limit }),
  tool: <T,>(spec: T) => spec,
  jsonSchema: <T,>(spec: T) => spec,
}));

vi.mock('./lib/llm-providers/create-provider', () => ({
  missingProviderSettings: mockMissingProviderSettings,
  createProvider: mockCreateBedrockProvider,
}));

vi.mock('./lib/mcp-client', () => ({
  getMCPTools: mockGetMCPTools,
}));

const { runtimeState } = vi.hoisted(() => ({ runtimeState: new Map<string, string>() }));

vi.mock('./services/runtime-state.service', () => ({
  runtimeStateService: {
    get: async (key: string) => runtimeState.get(key) ?? null,
    set: async (key: string, value: string) => void runtimeState.set(key, value),
    delete: async (key: string) => void runtimeState.delete(key),
  },
}));

vi.mock('./services/plugin-mcp.service', () => ({
  pluginMcpService: { getTools: mockGetPluginTools },
}));

vi.mock('./tools/memory', () => ({
  getMemoryTools: mockGetMemoryTools,
}));

vi.mock('./tools/cron', () => ({
  getCronTools: mockGetCronTools,
}));

vi.mock('./tools/agent-config', () => ({
  getAgentConfigTools: mockGetAgentConfigTools,
}));

vi.mock('./tools/shell', () => ({
  getShellTools: mockGetShellTools,
}));

vi.mock('./tools/share-file', () => ({
  getShareFileTools: mockGetShareFileTools,
  SHARE_FILE_TOOL_NAME: 'share_file',
}));

vi.mock('./tools/skills/index', () => ({
  getSkillTools: mockGetSkillTools,
}));

vi.mock('./services/conversation.service', () => ({
  conversationService: { addMessage: mockAddMessage },
}));

vi.mock('./prompts/context-builder', async (importOriginal) => ({
  buildUserMessage: (await importOriginal<typeof import('./prompts/context-builder')>()).buildUserMessage,
  buildSystemPromptParts: mockBuildSystemPromptParts,
  buildRecalledMemories: mockBuildRecalledMemories,
  recalledMemoryContent: (recalled: string) =>
    `\n\nContext:\n<recalled-memories>\n${recalled}\n</recalled-memories>`,
  buildRecentMemories: mockBuildRecentMemories,
  recentMemoryContent: (recent: string) =>
    `\n\nContext:\n<recent-memories>\n${recent}\n</recent-memories>`,
  buildConversationHistory: mockBuildConversationHistory,
  // Text-only stand-in for the real shaping (content parts for attachments are
  // covered in context-builder.test.ts); these specs only care that a steering
  // message becomes a user turn at the right position.
  buildSteeringMessage: (msg: { text: string }) => ({ role: 'user', content: msg.text }),
}));

vi.mock('./prompts/channel-prompt', () => ({
  getChannelBehaviorInstructions: mockGetChannelBehaviorInstructions,
}));

vi.mock('./prompts/task-tool-prompt', () => ({
  getTaskToolInstructions: mockGetTaskToolInstructions,
}));

vi.mock('./lib/task-tool', () => ({
  createTaskTool: mockCreateTaskTool,
}));

// Only the wrapper is faked. `isToolRiskGateError` comes from the real module:
// a copy of the predicate here would drift from the one invoke.ts actually calls,
// and the test would keep passing while the recognition it asserts had broken.
vi.mock('./lib/tool-risk-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/tool-risk-gate')>()),
  withToolRiskGate: mockWithToolRiskGate,
}));

vi.mock('./services/agent-workspace.service', () => ({
  agentWorkspaceService: {
    getSubagents: mockGetSubagents,
  },
  resolveEffectiveModel: (stored: string | null | undefined) =>
    stored ?? 'anthropic.claude-3-sonnet-20240229-v1:0',
  resolveScopedModel: (scoped: string | null | undefined, main: string | null | undefined) =>
    scoped ?? main ?? 'anthropic.claude-3-sonnet-20240229-v1:0',
}));

vi.mock('./services/context.service', () => ({
  contextService: {
    getAgentContext: mockGetAgentContext,
  },
}));

vi.mock('./services/agent-status.service', () => ({
  agentStatusService: {
    setProcessing: mockSetProcessing,
    setDoneProcessing: mockSetDoneProcessing,
  },
}));

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));

vi.mock('./lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
}));

const { mockContextUsageRecord, mockContextUsageFinalize } = vi.hoisted(() => ({
  mockContextUsageRecord: vi.fn(),
  mockContextUsageFinalize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./services/context-usage.service', () => ({
  contextUsageService: {
    record: mockContextUsageRecord,
    finalize: mockContextUsageFinalize,
  },
}));

const { mockRecordLlmCall } = vi.hoisted(() => ({ mockRecordLlmCall: vi.fn() }));
vi.mock('./services/llm-call.service', () => ({
  llmCallService: { record: mockRecordLlmCall },
}));

const { mockMaybeAutoCompact, mockMaybeCompactAfterOverflow } = vi.hoisted(() => ({
  mockMaybeAutoCompact: vi.fn(),
  mockMaybeCompactAfterOverflow: vi.fn(),
}));

vi.mock('./services/compaction.service', async (importOriginal) => ({
  // The real row mapping, so the fork's rows are checked as the commit reads them.
  toForkRows: (await importOriginal<typeof import('./services/compaction.service')>()).toForkRows,
  compactionService: {
    maybeAutoCompact: mockMaybeAutoCompact,
    maybeCompactAfterOverflow: mockMaybeCompactAfterOverflow,
  },
}));

const { mockBeginTurn, mockEndTurn } = vi.hoisted(() => ({
  mockBeginTurn: vi.fn(),
  mockEndTurn: vi.fn(),
}));
vi.mock('./services/program-status.service', () => ({
  programStatusService: { beginTurn: mockBeginTurn },
}));


import { invoke, invokeStream, extractAttachmentIds } from './invoke';
import { ANTHROPIC_TOOL_CHANGES } from './lib/llm-providers/tool-changes';
import { ANTHROPIC_DEFERRED_TOOLS, LOAD_TOOLS_NAME, OPENAI_DEFERRED_TOOLS } from './lib/llm-providers/deferred-tools';
import { withToolOutputCapture } from './lib/tool-output-limiter';
import { withToolsCacheControl } from './lib/tool-collection';
import { config } from './config';
import { Tool } from 'ai';
import { z } from 'zod';

type StepMessage = { role: string; content?: unknown; providerOptions?: unknown };
type PrepareStep = (options: {
  messages: StepMessage[];
  initialMessages: StepMessage[];
  responseMessages: StepMessage[];
}) => Promise<{ messages: StepMessage[] }>;

/** What the SDK hands `prepareStep` for the first step of a turn. */
function firstStep(initialMessages: StepMessage[]) {
  return { messages: initialMessages, initialMessages, responseMessages: [] };
}

/**
 * Drive `prepareStep` the way the SDK's step loop does.
 *
 * A returned `messages` override becomes the base for the next step, so the
 * `messages` argument carries that override plus the response messages the step
 * produced, while `initialMessages` and `responseMessages` stay the discrete
 * pieces. Each call prepares one step and takes what that step then produces.
 * A hook that splices onto `messages` rather than rebuilding from the pieces
 * duplicates its injections and its cache breakpoint once per remaining step.
 */
function stepDriver(prepareStep: PrepareStep, initialMessages: StepMessage[]) {
  let carried = initialMessages;
  const responseMessages: StepMessage[] = [];
  return async (produced: StepMessage[] = []) => {
    const result = await prepareStep({
      messages: carried,
      initialMessages,
      responseMessages: [...responseMessages],
    });
    responseMessages.push(...produced);
    carried = [...result.messages, ...produced];
    return result;
  };
}

describe('invoke', () => {
  beforeEach(() => {
    // Built-in tools are direct AI SDK now; only the Lens Agents MCP url
    // (cross-process) still matters here.
    config.nexusMcpUrl = 'http://localhost:3002/mcp';
    config.toolRiskGateMode = 'off';

    // Default empty built-in tool factories — individual tests
    // override per-describe.
    mockGetMemoryTools.mockReturnValue({});
    mockGetCronTools.mockReturnValue({});
    mockGetAgentConfigTools.mockReturnValue({});
    mockGetShellTools.mockReturnValue({});
    mockGetShareFileTools.mockReturnValue({});
    mockGetSkillTools.mockReturnValue({});
    mockWithToolRiskGate.mockImplementation((tools) => tools);

    mockMissingProviderSettings.mockReturnValue([]);
    mockBeginTurn.mockReturnValue({ end: mockEndTurn });
    mockCreateBedrockProvider.mockReturnValue(Object.assign(() => 'model-instance', { cachePoint: () => ({ anthropic: { cacheControl: { type: 'ephemeral' } } }) }));
    mockGetMCPTools.mockResolvedValue({});
    mockGetPluginTools.mockResolvedValue({});
    mockBuildSystemPromptParts.mockResolvedValue([
      { text: 'stable system prompt', cacheable: true },
      { text: 'dynamic system prompt', cacheable: false },
    ]);
    mockBuildRecalledMemories.mockResolvedValue(null);
    mockBuildRecentMemories.mockResolvedValue(null);
    mockAddMessage.mockResolvedValue({ message: { id: 'recall-row' }, titleSet: null });
    mockBuildConversationMessages.mockReturnValue([]);
    mockGetChannelBehaviorInstructions.mockReturnValue('channel instructions');
    mockGetAgentContext.mockResolvedValue(createTestAgentContext());
    mockGetSubagents.mockResolvedValue([]);
    mockGetTaskToolInstructions.mockReturnValue('task tool instructions');
    mockCreateTaskTool.mockReturnValue({ description: 'mock task tool' });
    mockGenerateText.mockResolvedValue({
      text: 'Here are your pods.',
      steps: [{ text: 'Here are your pods.', toolCalls: [], toolResults: [] }],
    });
  });

  it('surfaces a refusal as a readable message instead of an empty turn', async () => {
    // The model declines with a 200, no text and no content blocks. Nothing
    // downstream had anything to publish, so every surface sat on a spinner for
    // a turn that had already ended.
    mockGenerateText.mockResolvedValue({
      text: '',
      finishReason: 'content-filter',
      steps: [{ text: '', toolCalls: [], toolResults: [] }],
    });

    const result = await invoke(createTestInvokeRequest());

    expect(result.response).toContain("I can't help with that request");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'invocation refused',
      'user-test-456',
      expect.objectContaining({ 'invoke.mode': 'chat' }),
    );
  });

  it('stays quiet when the model declines after it has already answered', async () => {
    // A second, contradictory message would be worse than none: the user has
    // read the answer, and the turn ending on a refusal is not news.
    mockGenerateText.mockResolvedValue({
      text: '',
      finishReason: 'content-filter',
      steps: [{ text: 'Here is what I found.', toolCalls: [], toolResults: [] }],
    });

    const result = await invoke(createTestInvokeRequest());

    expect(result.response).toBe('Here is what I found.');
    expect(result.response).not.toContain("I can't help");
  });

  it('names the missing settings when the LLM provider is not configured', async () => {
    config.llmProvider = 'litellm';
    mockMissingProviderSettings.mockReturnValue(['LITELLM_BASE_URL', 'LITELLM_API_KEY']);

    const result = await invoke(createTestInvokeRequest());

    expect(result.toolCalls).toEqual([]);
    expect(result.steps).toEqual([
      {
        text: 'I am not fully configured yet: the litellm LLM provider needs LITELLM_BASE_URL and LITELLM_API_KEY.',
        toolCalls: [],
      },
    ]);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('calls generateText with correct params on successful chat invocation', async () => {
    const request = createTestInvokeRequest({ prompt: 'Hello' });

    const result = await invoke(request);

    expect(result.response).toBe('Here are your pods.');
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.arrayContaining([
          expect.objectContaining({ role: 'system', content: 'stable system prompt' }),
          expect.objectContaining({ role: 'system', content: 'dynamic system prompt' }),
        ]),
        maxOutputTokens: 16000,
      })
    );
  });

  describe('auto-compaction fork hook', () => {
    const SNAPSHOT = {
      threadId: 'thread-1',
      modelId: 'model-x',
      usedTokens: 190_000,
      windowTokens: 200_000,
      usedPercent: 95,
    };

    function contextWithHistory() {
      return createTestAgentContext({
        recentMessages: [
          { id: 'm1', role: 'USER', content: 'hello', externalMessageId: null, internalStep: false },
          { id: 'm2', role: 'AGENT', content: 'hi', externalMessageId: null, internalStep: false },
        ],
      });
    }

    it('hands the turn ingredients to the compaction service after a thread-bound turn', async () => {
      mockGetAgentContext.mockResolvedValue(contextWithHistory());
      mockContextUsageRecord.mockReturnValue(SNAPSHOT);

      await invoke(createTestInvokeRequest({ threadId: 'thread-1' }));

      expect(mockMaybeAutoCompact).toHaveBeenCalledTimes(1);
      const fork = mockMaybeAutoCompact.mock.calls[0][0];
      expect(fork).toMatchObject({
        threadId: 'thread-1',
        finalAssistantText: 'Here are your pods.',
        snapshot: SNAPSHOT,
        contextRows: [
          { id: 'm1', externalMessageId: null, internalStep: false, contentChars: 5 },
          { id: 'm2', externalMessageId: null, internalStep: false, contentChars: 2 },
        ],
      });
      // The fork has the turn's own request ingredients — what the turn's
      // generateText call sent — so the summarize call hits the cache. The
      // recall pair rides along: it is a thread row like any other, so a summary that
      // folds it in is consistent with what the next turn would replay anyway.
      const turnRequest = mockGenerateText.mock.calls[0][0];
      expect(fork.system).toBe(turnRequest.system);
      expect(fork.messages).toEqual(turnRequest.messages);
    });

    it('does not fire without a threadId', async () => {
      mockGetAgentContext.mockResolvedValue(contextWithHistory());
      mockContextUsageRecord.mockReturnValue(SNAPSHOT);

      await invoke(createTestInvokeRequest({ threadId: undefined }));

      expect(mockMaybeAutoCompact).not.toHaveBeenCalled();
    });

    it('does not fire when no step produced a usable measurement', async () => {
      mockGetAgentContext.mockResolvedValue(contextWithHistory());
      mockContextUsageRecord.mockReturnValue(null);

      await invoke(createTestInvokeRequest({ threadId: 'thread-1' }));

      expect(mockMaybeAutoCompact).not.toHaveBeenCalled();
    });

    it('does not fire for history-less turns (goal-style contexts)', async () => {
      mockGetAgentContext.mockResolvedValue(createTestAgentContext({ recentMessages: [] }));
      mockContextUsageRecord.mockReturnValue(SNAPSHOT);

      await invoke(createTestInvokeRequest({ threadId: 'thread-1' }));

      expect(mockMaybeAutoCompact).not.toHaveBeenCalled();
    });

    it('falls back to the assumed 1M window when the model is unknown to the meter', async () => {
      // record() returns null for unknown windows (nothing renders), but the
      // trigger must still see the raw measurement or such threads grow until
      // the provider hard-rejects them.
      mockGetAgentContext.mockResolvedValue(contextWithHistory());
      mockContextUsageRecord.mockReturnValue(null);
      mockGenerateText.mockResolvedValue({
        text: 'ok',
        steps: [
          {
            text: 'ok',
            toolCalls: [],
            toolResults: [],
            usage: { inputTokens: 950_000, outputTokens: 100, totalTokens: 950_100 },
          },
        ],
      });

      await invoke(createTestInvokeRequest({ threadId: 'thread-1' }));

      expect(mockMaybeAutoCompact).toHaveBeenCalledTimes(1);
      expect(mockMaybeAutoCompact.mock.calls[0][0].snapshot).toEqual({
        threadId: 'thread-1',
        modelId: expect.any(String),
        usedTokens: 950_100,
        windowTokens: 1_000_000,
        usedPercent: 95,
      });
    });
  });

  describe('overflow-recovery hook', () => {
    const OVERFLOW = new Error('prompt is too long: 250000 tokens > 200000 maximum');

    function contextWithHistory() {
      return createTestAgentContext({
        recentMessages: [
          { id: 'm1', role: 'USER', content: 'hello', externalMessageId: null, internalStep: false },
          { id: 'm2', role: 'AGENT', content: 'hi', externalMessageId: null, internalStep: false },
        ],
      });
    }

    it('fires when a thread-bound turn rejects with a context overflow', async () => {
      mockGetAgentContext.mockResolvedValue(contextWithHistory());
      mockGenerateText.mockRejectedValue(OVERFLOW);

      const result = await invoke(createTestInvokeRequest({ threadId: 'thread-1' }));

      // The friendly error step still delivers.
      expect(result.response).toContain('I encountered an error');
      expect(mockMaybeCompactAfterOverflow).toHaveBeenCalledTimes(1);
      expect(mockMaybeCompactAfterOverflow.mock.calls[0][0]).toMatchObject({
        threadId: 'thread-1',
        contextRows: [
          expect.objectContaining({ id: 'm1' }),
          expect.objectContaining({ id: 'm2' }),
        ],
      });
      // The success hook never ran — the turn failed.
      expect(mockMaybeAutoCompact).not.toHaveBeenCalled();
    });

    it('does not fire on a non-overflow failure', async () => {
      mockGetAgentContext.mockResolvedValue(contextWithHistory());
      mockGenerateText.mockRejectedValue(new Error('rate limited'));

      await invoke(createTestInvokeRequest({ threadId: 'thread-1' }));

      expect(mockMaybeCompactAfterOverflow).not.toHaveBeenCalled();
    });

    it('does not fire without a threadId', async () => {
      mockGetAgentContext.mockResolvedValue(contextWithHistory());
      mockGenerateText.mockRejectedValue(OVERFLOW);

      await invoke(createTestInvokeRequest({ threadId: undefined }));

      expect(mockMaybeCompactAfterOverflow).not.toHaveBeenCalled();
    });
  });

  describe('model selection by mode', () => {
    // The mocked provider is `(modelId) => LanguageModel`; capture the modelId
    // it's called with to assert which model each mode resolves to.
    function captureModelId() {
      const cachePoint = vi.fn(() => ({ anthropic: { cacheControl: { type: 'ephemeral' } } }));
      const modelFn = Object.assign(vi.fn(() => 'model-instance'), { cachePoint });
      mockCreateBedrockProvider.mockReturnValue(modelFn);
      return modelFn;
    }

    it('heartbeat mode uses the heartbeat override when set', async () => {
      mockGetAgentContext.mockResolvedValue(
        createTestAgentContext({ heartbeatModel: 'hb-model', cronModel: 'cron-model', model: 'main-model' }),
      );
      const modelFn = captureModelId();

      await invoke(createTestInvokeRequest({ mode: 'heartbeat' }));

      expect(modelFn).toHaveBeenCalledWith('hb-model');
    });

    it('heartbeat mode falls back to the main model when the override is empty', async () => {
      mockGetAgentContext.mockResolvedValue(
        createTestAgentContext({ heartbeatModel: null, model: 'main-model' }),
      );
      const modelFn = captureModelId();

      await invoke(createTestInvokeRequest({ mode: 'heartbeat' }));

      expect(modelFn).toHaveBeenCalledWith('main-model');
    });

    it('heartbeat mode falls back to the env default when both overrides are empty', async () => {
      mockGetAgentContext.mockResolvedValue(
        createTestAgentContext({ heartbeatModel: null, model: null }),
      );
      const modelFn = captureModelId();

      await invoke(createTestInvokeRequest({ mode: 'heartbeat' }));

      expect(modelFn).toHaveBeenCalledWith('anthropic.claude-3-sonnet-20240229-v1:0');
    });

    it('cron mode uses the cron override when set', async () => {
      mockGetAgentContext.mockResolvedValue(
        createTestAgentContext({ cronModel: 'cron-model', model: 'main-model' }),
      );
      const modelFn = captureModelId();

      await invoke(createTestInvokeRequest({ mode: 'cron' }));

      expect(modelFn).toHaveBeenCalledWith('cron-model');
    });

    it('asks for the cache breakpoint of the model the turn actually runs', async () => {
      // The breakpoint namespace follows the protocol, and on Bedrock the
      // protocol follows the model — so resolving it against the wrong id hands
      // Converse an Anthropic fragment it discards, uncached and unremarked. A
      // mode override is where the turn's model and the agent's default model
      // diverge, so it is the case that would catch a stale id.
      mockGetAgentContext.mockResolvedValue(
        createTestAgentContext({ cronModel: 'cron-model', model: 'main-model' }),
      );
      const modelFn = captureModelId();

      await invoke(createTestInvokeRequest({ mode: 'cron' }));

      expect(modelFn).toHaveBeenCalledWith('cron-model');
      expect(modelFn.cachePoint).toHaveBeenCalledWith('cron-model');
    });

    it('chat mode ignores heartbeat/cron overrides and uses the main model', async () => {
      mockGetAgentContext.mockResolvedValue(
        createTestAgentContext({ heartbeatModel: 'hb-model', cronModel: 'cron-model', model: 'main-model' }),
      );
      const modelFn = captureModelId();

      await invoke(createTestInvokeRequest({ mode: 'chat' }));

      expect(modelFn).toHaveBeenCalledWith('main-model');
    });
  });

  it('returns response text on successful chat invocation', async () => {
    const result = await invoke(createTestInvokeRequest({ prompt: 'Hello' }));

    expect(result.response).toBe('Here are your pods.');
  });

  it('returns empty toolCalls on successful chat invocation with no tools used', async () => {
    const result = await invoke(createTestInvokeRequest({ prompt: 'Hello' }));

    expect(result.toolCalls).toEqual([]);
  });

  it('returns steps array on successful chat invocation', async () => {
    const result = await invoke(createTestInvokeRequest({ prompt: 'Hello' }));

    expect(result.steps).toEqual([
      expect.objectContaining({
        text: 'Here are your pods.',
        toolCalls: [],
      }),
    ]);
  });

  it('applies cache control only to cacheable system prompt parts', async () => {
    await invoke(createTestInvokeRequest());

    const callArgs = mockGenerateText.mock.calls[0][0];
    const systemMessages = callArgs.system as Array<{ role: string; content: string; providerOptions?: unknown }>;

    // Stable part should have cache control
    const stablePart = systemMessages.find((p) => p.content === 'stable system prompt');
    expect(stablePart!.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });

    // Dynamic part should NOT have cache control
    const dynamicPart = systemMessages.find((p) => p.content === 'dynamic system prompt');
    expect(dynamicPart!.providerOptions).toBeUndefined();
  });

  describe('tool filtering by mode', () => {
    beforeEach(() => {
      mockGetMemoryTools.mockReturnValue({
        memory_search: { description: 'search' },
        memory_write: { description: 'write' },
        memory_delete: { description: 'delete' },
      });
      mockGetCronTools.mockReturnValue({
        schedule_task: { description: 'schedule' },
        list_scheduled_tasks: { description: 'list' },
        update_scheduled_task: { description: 'update sched' },
        delete_scheduled_task: { description: 'del sched' },
      });
      mockGetAgentConfigTools.mockReturnValue({
        update_soul: { description: 'update soul' },
      });
      mockGetShellTools.mockReturnValue({
        shell_exec: { description: 'exec' },
      });
      mockGetShareFileTools.mockReturnValue({
        share_file: { description: 'share' },
      });
      mockGetSkillTools.mockReturnValue({
        skill: { description: 'skill' },
      });
    });

    it('chat mode gets all tools', async () => {
      await invoke(createTestInvokeRequest({ mode: 'chat' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      // 3 memory + 4 cron + 1 agent-config + 1 shell + 1 share_file + 2 goal + 1 skill
      // + 2 attachment (hydrate_attachment, view_attachment) + 1 web_fetch
      // + 2 message (send_message, list_message_targets)
      expect(Object.keys(callArgs.tools)).toHaveLength(18);
      expect(Object.keys(callArgs.tools)).toContain('send_message');
      expect(Object.keys(callArgs.tools)).toContain('share_file');
      expect(Object.keys(callArgs.tools)).toContain('web_fetch');
      expect(Object.keys(callArgs.tools)).toContain('create_goal');
      expect(Object.keys(callArgs.tools)).toContain('get_goal');
      expect(Object.keys(callArgs.tools)).toContain('skill');
      expect(Object.keys(callArgs.tools)).toContain('hydrate_attachment');
      expect(Object.keys(callArgs.tools)).toContain('view_attachment');
    });

    it('subagent mode excludes share_file (no channel to the user)', async () => {
      await invoke(createTestInvokeRequest({ mode: 'subagent' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      const toolNames = Object.keys(callArgs.tools);
      expect(toolNames).not.toContain('share_file');
      expect(toolNames).not.toContain('create_goal');
      expect(toolNames).not.toContain('get_goal');
      expect(toolNames).toContain('shell_exec');
      // A subagent has no computer, so this is how it reads a page.
      expect(toolNames).toContain('web_fetch');
    });

    it.each(['heartbeat', 'cron', 'webhook'] as const)(
      '%s mode manages the schedule with the owner\'s tools but drops the goal tools',
      async (mode) => {
        await invoke(createTestInvokeRequest({ mode, userId: 'owner-1', agentId: 'agent-7' }));

        const callArgs = mockGenerateText.mock.calls[0][0];
        const toolNames = Object.keys(callArgs.tools);
        expect(toolNames).toContain('schedule_task');
        expect(toolNames).toContain('list_scheduled_tasks');
        expect(toolNames).toContain('update_scheduled_task');
        expect(toolNames).toContain('delete_scheduled_task');
        expect(mockGetCronTools).toHaveBeenCalledWith('owner-1', 'agent-7', mode, undefined, 'websocket', undefined);
        expect(toolNames).not.toContain('create_goal');
        expect(toolNames).not.toContain('get_goal');
        expect(toolNames).toContain('memory_search');
        expect(toolNames).toContain('update_soul');
        // The original regression: cron runs lost the built-in shell tools
        // (shell_exec etc.), so a scheduled task could not run shell commands.
        expect(toolNames).toContain('shell_exec');
      },
    );

    it('goal mode drops create_goal (no nesting) and the schedule tools but keeps get_goal + working tools', async () => {
      await invoke(createTestInvokeRequest({ mode: 'goal' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      const toolNames = Object.keys(callArgs.tools);
      expect(toolNames).not.toContain('create_goal');
      expect(toolNames).toContain('get_goal');
      expect(toolNames).toContain('shell_exec');
      expect(toolNames).not.toContain('schedule_task');
      expect(toolNames).not.toContain('list_scheduled_tasks');
      expect(toolNames).not.toContain('update_scheduled_task');
      expect(toolNames).not.toContain('delete_scheduled_task');
    });
  });

  describe('tool filtering while locked in', () => {
    // The six workspace-markdown writers plus the two long-term memory writers,
    // i.e. the whole locked set.
    const LOCKED_TOOLS = [
      'update_soul',
      'update_memory',
      'update_user_profile',
      'update_vision',
      'update_heartbeat_config',
      'clear_bootstrap',
      'memory_write',
      'memory_delete',
    ];

    beforeEach(() => {
      mockGetMemoryTools.mockReturnValue({
        memory_search: { description: 'search' },
        memory_write: { description: 'write' },
        memory_delete: { description: 'delete' },
      });
      mockGetAgentConfigTools.mockReturnValue({
        rename_self: { description: 'rename' },
        update_soul: { description: 'update soul' },
        update_memory: { description: 'update memory' },
        update_user_profile: { description: 'update user' },
        update_vision: { description: 'update vision' },
        update_heartbeat_config: { description: 'update hb' },
        update_settings: { description: 'update settings' },
        clear_bootstrap: { description: 'clear bootstrap' },
      });
      mockGetShellTools.mockReturnValue({ shell_exec: { description: 'exec' } });
      mockGetAgentContext.mockResolvedValue(createTestAgentContext({ lockedIn: true }));
    });

    // Every mode: a lock that held for chat only could be bypassed with a
    // subagent or the next heartbeat.
    const modes = ['chat', 'subagent', 'heartbeat', 'cron', 'goal', 'webhook'] as const;

    it.each(modes)('%s mode omits every document and memory writer while locked', async (mode) => {
      await invoke(createTestInvokeRequest({ mode }));

      const toolNames = Object.keys(mockGenerateText.mock.calls[0][0].tools);
      for (const name of LOCKED_TOOLS) {
        expect(toolNames).not.toContain(name);
      }
    });

    it.each(modes)('%s mode keeps rename_self, update_settings and memory_search while locked', async (mode) => {
      await invoke(createTestInvokeRequest({ mode }));

      const toolNames = Object.keys(mockGenerateText.mock.calls[0][0].tools);
      // Renames and behavioural settings stay editable, and the agent still
      // reads the memories it recorded before the lock.
      expect(toolNames).toContain('rename_self');
      expect(toolNames).toContain('update_settings');
      expect(toolNames).toContain('memory_search');
      expect(toolNames).toContain('shell_exec');
    });

    it('keeps every writer when not locked', async () => {
      mockGetAgentContext.mockResolvedValue(createTestAgentContext({ lockedIn: false }));

      await invoke(createTestInvokeRequest({ mode: 'chat' }));

      const toolNames = Object.keys(mockGenerateText.mock.calls[0][0].tools);
      for (const name of LOCKED_TOOLS) {
        expect(toolNames).toContain(name);
      }
    });
  });

  it('adds Lens Agents MCP tools when nexusMcpUrl is configured', async () => {
    mockGetMCPTools.mockResolvedValue({ kubectl: {} });

    await invoke(createTestInvokeRequest());

    // Only the Lens Agents MCP server is reached via getMCPTools now (built-ins are direct).
    expect(mockGetMCPTools).toHaveBeenCalledTimes(1);

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.tools).toHaveProperty('kubectl');
  });

  it('calls Lens Agents MCP with the configured URL and no tool allowlist', async () => {
    mockGetMCPTools.mockResolvedValue({});

    await invoke(createTestInvokeRequest());

    // The endpoint serves the full tool surface it chooses to expose, so the
    // runtime sends no x-mcp-tools allowlist — just the URL.
    const nexusCall = mockGetMCPTools.mock.calls[0][0];
    expect(nexusCall).toEqual({ url: 'http://localhost:3002/mcp' });
    expect(nexusCall.extraHeaders).toBeUndefined();
  });

  it('applies mode filtering to MCP tools, not just built-ins', async () => {
    // A remote tool that shares a name with a built-in the mode removes must go
    // too — otherwise it answers to the name the gating just took away.
    mockGetMCPTools.mockResolvedValue({ join_meeting: {}, kubectl: {} });

    await invoke(createTestInvokeRequest({ mode: 'heartbeat' }));

    const toolNames = Object.keys(mockGenerateText.mock.calls[0][0].tools);
    expect(toolNames).not.toContain('join_meeting');
    // Everything else the endpoint serves is still available.
    expect(toolNames).toContain('kubectl');
  });

  it('shortens a platform MCP name too long for the provider, keeping the tool itself', async () => {
    // Lens Agents pre-namespaces a proxied connector as `<uuid>__<connector>__<tool>`,
    // and a 36-char UUID puts that over Bedrock's 64-character toolSpec.name cap
    // — which rejects the whole request, so one such name kills every turn.
    const long = '75166a14-fd0b-4bbb-b6d6-ddbd008bb95b__atlassian__addCommentToJiraIssue';
    const remote = { description: 'Add a comment to a Jira issue' };
    mockGetMCPTools.mockResolvedValue({ [long]: remote, kubectl: {} });

    await invoke(createTestInvokeRequest());

    const tools = mockGenerateText.mock.calls[0][0].tools;
    const toolNames = Object.keys(tools);
    for (const name of toolNames) expect(name.length).toBeLessThanOrEqual(64);
    expect(toolNames).not.toContain(long);
    // The same tool object under a name that fits: its execute closes over the
    // name the *server* gave it, so the MCP call still goes out under `long`.
    const shortened = toolNames.find((n) => n.includes('atlassian'));
    expect(shortened).toBe('t_75166a14-fd0b-4bbb-b6d6-ddbd008bb95b__atlassian__addCo_b897e9d');
    expect(tools[shortened!].description).toBe(remote.description);
    // A name that already fits is untouched.
    expect(toolNames).toContain('kubectl');
  });

  it('never lets a sanitized platform name displace a built-in', async () => {
    mockGetShellTools.mockReturnValue({ shell_exec: { description: 'the real one' } });
    mockGetMCPTools.mockResolvedValue({ 'shell.exec': { description: 'impostor' } });

    await invoke(createTestInvokeRequest());

    const tools = mockGenerateText.mock.calls[0][0].tools;
    expect(tools.shell_exec.description).toBe('the real one');
  });

  it('never lets a sanitized platform name take a name the mode withheld', async () => {
    // `share_file` is filtered out for a subagent, which leaves its name
    // unclaimed — a remote tool sanitizing into it would hand the model back the
    // capability the mode just took away.
    mockGetShareFileTools.mockReturnValue({ share_file: { description: 'share' } });
    mockGetMCPTools.mockResolvedValue({ 'share.file': {}, kubectl: {} });

    await invoke(createTestInvokeRequest({ mode: 'subagent' }));

    const toolNames = Object.keys(mockGenerateText.mock.calls[0][0].tools);
    expect(toolNames).not.toContain('share_file');
    expect(toolNames).toContain('kubectl');
  });

  it('adds tools contributed by installed plugins', async () => {
    mockGetPluginTools.mockResolvedValue({ demo__probe__search: {} });

    await invoke(createTestInvokeRequest());

    expect(mockGenerateText.mock.calls[0][0].tools).toHaveProperty('demo__probe__search');
  });

  it('never lets a plugin tool replace a built-in of the same name', async () => {
    // Qualified names make this unreachable in practice; the guard is there so
    // the guarantee survives a future change to the naming scheme.
    mockGetShellTools.mockReturnValue({ shell_exec: { description: 'the real one' } });
    mockGetPluginTools.mockResolvedValue({ shell_exec: { description: 'impostor' } });

    await invoke(createTestInvokeRequest());

    const tools = mockGenerateText.mock.calls[0][0].tools;
    expect(tools.shell_exec.description).toBe('the real one');
  });

  it('applies mode filtering to plugin tools too', async () => {
    mockGetPluginTools.mockResolvedValue({ join_meeting: {}, demo__probe__search: {} });

    await invoke(createTestInvokeRequest({ mode: 'heartbeat' }));

    const toolNames = Object.keys(mockGenerateText.mock.calls[0][0].tools);
    expect(toolNames).not.toContain('join_meeting');
    expect(toolNames).toContain('demo__probe__search');
  });

  it('does not add Lens Agents MCP tools when nexusMcpUrl is unset', async () => {
    config.nexusMcpUrl = null;
    mockGetAgentContext.mockResolvedValue(createTestAgentContext({ isBootstrapPhase: false }));

    await invoke(createTestInvokeRequest());

    // No gateway URL → no MCP fetch at all (built-ins are direct).
    expect(mockGetMCPTools).not.toHaveBeenCalled();
  });

  it('appends channel instructions to the stable part for a turn with a channel label', async () => {
    await invoke(createTestInvokeRequest({ channelLabel: 'the channel **#general**' }));

    expect(mockGetChannelBehaviorInstructions).toHaveBeenCalledWith('the channel **#general**');
    const callArgs = mockGenerateText.mock.calls[0][0];
    const systemMessages = callArgs.system as Array<{ content: string }>;
    const stablePart = systemMessages.find((p) => p.content.includes('stable system prompt'));
    expect(stablePart!.content).toContain('channel instructions');
  });

  it('appends task tool instructions to the stable part when agent has subagents', async () => {
    mockGetSubagents.mockResolvedValue([
      { id: 'sub-1', name: 'Research Bot', description: 'Researches topics' },
      { id: 'sub-2', name: 'Code Bot', description: 'Writes code' },
    ]);

    await invoke(createTestInvokeRequest());

    expect(mockGetTaskToolInstructions).toHaveBeenCalledWith([
      { name: 'Research Bot', description: 'Researches topics' },
      { name: 'Code Bot', description: 'Writes code' },
    ]);
    const callArgs = mockGenerateText.mock.calls[0][0];
    const systemMessages = callArgs.system as Array<{ content: string }>;
    const stablePart = systemMessages.find((p) => p.content.includes('stable system prompt'));
    expect(stablePart!.content).toContain('task tool instructions');
  });

  it('does not append task tool instructions when agent has no subagents', async () => {
    mockGetSubagents.mockResolvedValue([]);

    await invoke(createTestInvokeRequest());

    expect(mockGetTaskToolInstructions).not.toHaveBeenCalled();
    const callArgs = mockGenerateText.mock.calls[0][0];
    const systemMessages = callArgs.system as Array<{ content: string }>;
    const stablePart = systemMessages.find((p) => p.content.includes('stable system prompt'));
    expect(stablePart!.content).not.toContain('task tool instructions');
  });

  it('adds Task tool when agent has subagents', async () => {
    const subagents = [
      { id: 'sub-1', name: 'Research Bot', description: 'Researches topics' },
    ];
    mockGetSubagents.mockResolvedValue(subagents);

    await invoke(createTestInvokeRequest());

    expect(mockCreateTaskTool).toHaveBeenCalledWith(
      subagents,
      'user-test-456',
      expect.any(Function),
    );
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.tools).toHaveProperty('Task');
  });

  it('does not add Task tool when agent has no subagents', async () => {
    mockGetSubagents.mockResolvedValue([]);

    await invoke(createTestInvokeRequest());

    expect(mockCreateTaskTool).not.toHaveBeenCalled();
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.tools ?? {}).not.toHaveProperty('Task');
  });

  it('skips subagent fetching when agentId is set (subagent invocation)', async () => {
    await invoke(createTestInvokeRequest({ agentId: 'sub-agent-1', mode: 'subagent' }));

    expect(mockGetSubagents).not.toHaveBeenCalled();
    expect(mockCreateTaskTool).not.toHaveBeenCalled();
  });

  it('passes agentId to getAgentContext when set', async () => {
    await invoke(createTestInvokeRequest({ agentId: 'sub-agent-1' }));

    expect(mockGetAgentContext).toHaveBeenCalledWith(
      'user-test-456',
      expect.objectContaining({ agentId: 'sub-agent-1' }),
    );
  });

  it('maps tool calls from result.steps into response', async () => {
    mockGenerateText.mockResolvedValue(({
        text: 'Done.',
        steps: [
          {
            text: '',
            toolCalls: [
              { toolCallId: 'tc-1', toolName: 'memory_search', input: { query: 'pods' } },
            ],
            toolResults: [
              { toolCallId: 'tc-1', output: { results: [] } },
            ],
          },
          {
            text: 'Done.',
            toolCalls: [],
            toolResults: [],
          },
        ],
    }));

    const result = await invoke(createTestInvokeRequest());

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe('memory_search');
    expect(result.toolCalls[0].success).toBe(true);
  });

  it('passes every collected tool through the configured risk gate', async () => {
    mockGetShellTools.mockReturnValue({ shell_exec: { description: 'exec' } });
    config.toolRiskGateMode = 'observe';

    await invoke(createTestInvokeRequest({ mode: 'cron', prompt: 'check deployment' }));

    expect(mockWithToolRiskGate).toHaveBeenCalledWith(
      expect.objectContaining({ shell_exec: expect.any(Object) }),
      {
        mode: 'observe',
        invocationMode: 'cron',
        initialPrompt: 'check deployment',
        initialPromptFromAgent: false,
        agentGuide: '',
        userId: 'user-test-456',
        agentId: 'agent-test-123',
      },
    );
  });

  it("tells the risk gate when the prompt is another agent's message", async () => {
    mockGetShellTools.mockReturnValue({ shell_exec: { description: 'exec' } });
    config.toolRiskGateMode = 'enforce';

    await invoke(createTestInvokeRequest({ promptFromAgent: true }));

    expect(mockWithToolRiskGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ initialPromptFromAgent: true }),
    );
  });

  it('gives the risk gate the agent guide as the operator policy', async () => {
    // The guide is the one workspace document no tool writes, which is what lets
    // the classifier read it as policy rather than as evidence.
    mockGetShellTools.mockReturnValue({ shell_exec: { description: 'exec' } });
    config.toolRiskGateMode = 'enforce';
    mockGetAgentContext.mockResolvedValue(
      createTestAgentContext({ agentMd: '## Safety\n\nNever touch the prod-eu cluster.' }),
    );

    await invoke(createTestInvokeRequest());

    expect(mockWithToolRiskGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentGuide: '## Safety\n\nNever touch the prod-eu cluster.',
      }),
    );
  });

  it('records a risk-policy tool error as a visible unsuccessful call', async () => {
    const policyError = {
      name: 'ToolRiskGateError',
      message:
        'Tool call blocked by the configured risk policy (category=destructive, risk=critical).',
      code: 'TOOL_RISK_BLOCKED',
      risk: 'critical',
      category: 'destructive',
    };
    mockGenerateText.mockResolvedValue({
      text: 'I did not run that command.',
      steps: [
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tc-blocked', toolName: 'shell_exec', input: { command: 'dangerous' } },
          ],
          toolResults: [],
          content: [
            {
              type: 'tool-error',
              toolCallId: 'tc-blocked',
              toolName: 'shell_exec',
              input: { command: 'dangerous' },
              error: policyError,
            },
          ],
        },
        {
          text: 'I did not run that command.',
          toolCalls: [],
          toolResults: [],
          content: [],
        },
      ],
    });

    const result = await invoke(createTestInvokeRequest());

    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        tool: 'shell_exec',
        success: false,
        output: JSON.stringify({
          error: policyError.message,
          code: 'TOOL_RISK_BLOCKED',
          risk: 'critical',
          category: 'destructive',
        }),
      }),
    ]);
  });

  // The runtime knows no platform tool: a tool that messages other agents runs
  // like any other, and nothing is kept from its answer.
  it('keeps no conversation from a platform tool that messages other agents', async () => {
    runtimeState.clear();
    const conversation = '0f0f0f0f-0000-4000-8000-0000000000c1';
    const messageAgent = 'hub__agent-directory__message_agent';
    mockGetMCPTools.mockResolvedValue({
      [messageAgent]: {
        description: 'Message another agent of the project.',
        inputSchema: { type: 'object' },
        execute: async () => ({ content: [{ type: 'text', text: `{"conversationId":"${conversation}"}\nSent to the Writer.` }] }),
      },
    });
    mockGenerateText.mockImplementation(async (opts: { tools: Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }> }) => {
      await opts.tools[messageAgent]!.execute({}, { toolCallId: 'c1', messages: [] });
      return { text: 'Asked the Writer.', steps: [{ text: 'Asked the Writer.', toolCalls: [], toolResults: [] }] };
    });

    await invoke(createTestInvokeRequest({ threadId: 'thread-delegating' }));

    expect(runtimeState.has(`agentConversation:${conversation}`)).toBe(false);
  });

  describe('tool-result persistence', () => {
    // What is stored is the model-facing view, not the raw execute() return. Storing
    // raw made the cap a one-turn measure and made replay a different rendering.
    const stepWith = (output: unknown) => ({
      text: 'Done.',
      steps: [
        {
          text: '',
          toolCalls: [{ toolCallId: 'tc-1', toolName: 'atlassian__getJiraIssue', input: {} }],
          toolResults: [{ toolCallId: 'tc-1', output }],
        },
      ],
    });

    it('stores an MCP result as its joined text, not the envelope', async () => {
      mockGenerateText.mockResolvedValue(
        stepWith({ content: [{ type: 'text', text: 'the comment body' }] })
      );

      const result = await invoke(createTestInvokeRequest());

      expect(result.toolCalls[0].output).toBe('the comment body');
      expect(result.toolCalls[0].rendered).toBe(true);
      expect(result.toolCalls[0].truncated).toBeUndefined();
    });

    it('stores a plain-string result unquoted and unescaped', async () => {
      mockGenerateText.mockResolvedValue(stepWith('hello\nworld'));

      expect((await invoke(createTestInvokeRequest())).toolCalls[0].output).toBe('hello\nworld');
    });

    it('stores the cut view and the sizes when a result is oversized', async () => {
      mockGenerateText.mockResolvedValue(stepWith('y'.repeat(500_000)));

      const stored = (await invoke(createTestInvokeRequest())).toolCalls[0];

      expect(stored.output.length).toBeLessThan(31_000);
      expect(stored.output).toContain('[INCOMPLETE OUTPUT');
      expect(stored.truncated).toEqual({
        totalChars: 500_000,
        keptChars: 30_000,
        omittedChars: 470_000,
      });
    });

    it('records the view and the id minted when the tool ran, not a fresh render', async () => {
      // One mint: the id in the text the model reads must be the id on the record.
      // The wrapper produces the envelope at execute time; this pins that
      // `onStepFinish` reuses it rather than rendering (and saving) a second copy.
      const wrapped = withToolOutputCapture(
        { t: { description: 'd', inputSchema: { type: 'object' as const }, execute: () => 'y'.repeat(500_000) } },
        { maxChars: 30_000, spill: false }
      );
      const envelope = await (
        wrapped.t as { execute: (a: unknown, o: unknown) => Promise<unknown> }
      ).execute({}, {});

      mockGenerateText.mockResolvedValue(stepWith(envelope));
      const stored = (await invoke(createTestInvokeRequest())).toolCalls[0];

      expect(stored.output).toBe((envelope as { text: string }).text);
      expect(stored.truncated).toEqual((envelope as { truncation: unknown }).truncation);
      expect(stored.output).toContain('[INCOMPLETE OUTPUT');
    });

    it('keeps an oversized result out of the early-stopping prompt', async () => {
      // summarizeSteps() feeds a prompt. Stringifying a wrapped result there would
      // serialize the untouched original inside the envelope — the whole payload
      // the cut just removed, straight back into a model.
      const wrapped = withToolOutputCapture(
        { t: { description: 'd', inputSchema: { type: 'object' as const }, execute: () => 'SECRET'.repeat(100_000) } },
        { maxChars: 30_000, spill: false }
      );
      const envelope = await (
        wrapped.t as { execute: (a: unknown, o: unknown) => Promise<unknown> }
      ).execute({}, {});

      // 100 steps trips the step limit, which is what triggers the summary call.
      mockGenerateText.mockResolvedValue({
        text: '',
        steps: Array.from({ length: 100 }, () => ({
          text: '',
          toolCalls: [{ toolCallId: 'tc-1', toolName: 't', input: {} }],
          toolResults: [{ toolCallId: 'tc-1', output: envelope }],
        })),
      });

      await invoke(createTestInvokeRequest());

      const prompts = mockGenerateText.mock.calls.map((c) => JSON.stringify(c[0]));
      const summaryPrompt = prompts[prompts.length - 1];
      expect(summaryPrompt).not.toContain('__prismToolOutputSpill');
      expect(summaryPrompt.length).toBeLessThan(600_000 * 6);
    });

    it('still delivers a share_file attachment while storing the rendered view', async () => {
      // `extractAttachmentIds` reads the structured execute() return off toolResults.
      // Rendering for persistence must not disturb it — and the wrapper PR2 adds
      // around execute() must return an under-cap value by identity.
      mockGenerateText.mockResolvedValue({
        text: 'Sent.',
        steps: [
          {
            text: '',
            toolCalls: [{ toolCallId: 'tc-1', toolName: 'share_file', input: {} }],
            toolResults: [
              { toolCallId: 'tc-1', output: { success: true, attachmentId: 'att-9' } },
            ],
          },
        ],
      });

      const result = await invoke(createTestInvokeRequest());

      expect(result.attachmentIds).toEqual(['att-9']);
      expect(result.toolCalls[0].output).toBe('{"success":true,"attachmentId":"att-9"}');
    });

    it('marks an untruncated result as rendered too', async () => {
      // The replay discriminator is the flag, not the presence of truncation
      // metadata — an unflagged row is parsed and re-rendered as a legacy row.
      mockGenerateText.mockResolvedValue(stepWith('small'));

      expect((await invoke(createTestInvokeRequest())).toolCalls[0].rendered).toBe(true);
    });
  });

  it('extracts blocks from JSON in response', async () => {
    const text = 'Here:\n```json\n{"blocks": [{"type": "chart"}]}\n```';
    mockGenerateText.mockResolvedValue({
      text,
      steps: [{ text, toolCalls: [], toolResults: [] }],
    });

    const result = await invoke(createTestInvokeRequest());

    expect(result.blocks).toEqual([{ type: 'chart' }]);
  });

  it('returns error message on failure without throwing', async () => {
    mockGenerateText.mockRejectedValue(new Error('Model timeout'));

    const result = await invoke(createTestInvokeRequest());

    // Errors surface as a final friendly step (via buildErrorStep) instead
    // of throwing. response is the joined text of that single step.
    expect(result.response).toContain('Model timeout');
    expect(result.toolCalls).toEqual([]);
    expect(result.steps).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('Model timeout'),
        toolCalls: [],
      }),
    ]);
  });

  describe('cancellation (abortSignal)', () => {
    it('combines caller cancellation with computer cancellation', async () => {
      const controller = new AbortController();

      await invoke(createTestInvokeRequest({ abortSignal: controller.signal }));

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
      );
    });

    it('swallows the abort error — no friendly error step — when the signal is aborted', async () => {
      // Mocks aren't auto-cleared between tests in this file, so scope the
      // telemetry assertions below to this test's invoke() call only.
      mockTrackEvent.mockClear();
      const controller = new AbortController();
      controller.abort();
      // Mirrors the SDK: an aborted signal makes generateText reject with an
      // AbortError (a native DOMException-shaped error).
      mockGenerateText.mockRejectedValue(
        Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
      );

      const result = await invoke(createTestInvokeRequest({ abortSignal: controller.signal }));

      expect(result.steps).toEqual([]);
      expect(result.response).toBe('');
      expect(result.response).not.toMatch(/encountered an error/i);
      // Status must still reset so the agent doesn't get stuck RUNNING.
      expect(mockSetDoneProcessing).toHaveBeenCalled();
      // A cancel emits a distinct telemetry event, not "invocation completed".
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'invocation canceled',
        expect.any(String),
        expect.objectContaining({ 'invoke.mode': 'chat' }),
      );
      expect(mockTrackEvent).not.toHaveBeenCalledWith(
        'invocation completed',
        expect.anything(),
        expect.anything(),
      );
    });

    it('preserves already-completed steps when aborted mid-stream', async () => {
      const controller = new AbortController();
      // One step lands via onStepFinish, then the user aborts and the SDK
      // rejects with an AbortError.
      mockGenerateText.mockImplementationOnce((opts: Record<string, unknown>) => {
        (opts.onStepFinish as (s: unknown) => void)({
          text: 'partial answer so far',
          toolCalls: [],
          toolResults: [],
        });
        controller.abort();
        return Promise.reject(
          Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
        );
      });

      const result = await invoke(createTestInvokeRequest({ abortSignal: controller.signal }));

      expect(result.steps.map((s) => s.text)).toEqual(['partial answer so far']);
      expect(result.response).toBe('partial answer so far');
      expect(result.response).not.toMatch(/encountered an error/i);
    });
  });

  describe('budget exceeded errors', () => {
    it('returns user-friendly message with detail on budget-exceeded 429', async () => {
      const budgetError = Object.assign(new Error('429'), {
        status: 429,
        responseBody: JSON.stringify({
          type: 'budget-exceeded',
          title: 'Budget Exceeded',
          detail: 'Weekly budget: $4.96 of $4.00 used',
        }),
      });
      mockGenerateText.mockRejectedValue(budgetError);

      const result = await invoke(createTestInvokeRequest());

      expect(result.response).toContain('spending limit has been reached');
      expect(result.response).toContain('Weekly budget: $4.96 of $4.00 used');
      expect(result.error).toEqual({
        type: 'budget_exceeded',
        detail: 'Weekly budget: $4.96 of $4.00 used',
      });
    });

    it('returns budget message without detail when none provided', async () => {
      const budgetError = Object.assign(new Error('429'), {
        status: 429,
        responseBody: JSON.stringify({ type: 'budget-exceeded' }),
      });
      mockGenerateText.mockRejectedValue(budgetError);

      const result = await invoke(createTestInvokeRequest());

      expect(result.response).toContain('spending limit has been reached');
      expect(result.error?.type).toBe('budget_exceeded');
      expect(result.error?.detail).toBeNull();
    });

    it('unwraps SDK lastError for budget detection', async () => {
      const originalError = Object.assign(new Error('429'), {
        status: 429,
        responseBody: JSON.stringify({
          type: 'budget-exceeded',
          detail: 'Monthly org budget exceeded',
        }),
      });
      const sdkWrappedError = Object.assign(new Error('Failed after 3 attempts'), {
        lastError: originalError,
      });
      mockGenerateText.mockRejectedValue(sdkWrappedError);

      const result = await invoke(createTestInvokeRequest());

      expect(result.response).toContain('spending limit has been reached');
      expect(result.error?.detail).toBe('Monthly org budget exceeded');
    });

    it('returns generic error metadata for non-budget 429', async () => {
      mockGenerateText.mockRejectedValue(Object.assign(new Error('Too Many Requests'), { status: 429 }));

      const result = await invoke(createTestInvokeRequest());

      expect(result.response).toContain('Too Many Requests');
      expect(result.error).toEqual({ type: 'generic', detail: null });
    });
  });

  it('multi-step invoke returns steps array with per-step text and tool calls', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Final answer.',
      steps: [
        {
          text: 'Let me check...',
          toolCalls: [
            { toolCallId: 'tc-1', toolName: 'aws_costs', input: { region: 'us-east-1' } },
          ],
          toolResults: [
            { toolCallId: 'tc-1', output: { cost: 0 } },
          ],
        },
        {
          text: 'Final answer.',
          toolCalls: [],
          toolResults: [],
        },
      ],
    });

    const result = await invoke(createTestInvokeRequest());

    // Steps array should have both steps
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].text).toBe('Let me check...');
    expect(result.steps[0].toolCalls).toHaveLength(1);
    expect(result.steps[0].toolCalls[0].tool).toBe('aws_costs');
    expect(result.steps[1].text).toBe('Final answer.');
    expect(result.steps[1].toolCalls).toHaveLength(0);

    // Response should be all step texts joined
    expect(result.response).toBe('Let me check...\n\nFinal answer.');

    // All tool calls should be flattened
    expect(result.toolCalls).toHaveLength(1);
  });

  describe('includeConversation option', () => {
    it('passes includeConversation=false in heartbeat mode', async () => {
      await invoke(createTestInvokeRequest({ mode: 'heartbeat' }));

      expect(mockGetAgentContext).toHaveBeenCalledWith(
        'user-test-456',
        expect.objectContaining({ includeConversation: false }),
      );
    });

    it('passes includeConversation=true in chat mode', async () => {
      await invoke(createTestInvokeRequest({ mode: 'chat' }));

      expect(mockGetAgentContext).toHaveBeenCalledWith(
        'user-test-456',
        expect.objectContaining({ includeConversation: true }),
      );
    });

    it('does not pass includeConversation=true in cron mode', async () => {
      await invoke(createTestInvokeRequest({ mode: 'cron' }));

      expect(mockGetAgentContext).toHaveBeenCalledWith(
        'user-test-456',
        expect.objectContaining({ includeConversation: false }),
      );
    });

    it('passes threadId when provided in chat mode', async () => {
      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-xyz' }));

      expect(mockGetAgentContext).toHaveBeenCalledWith(
        'user-test-456',
        expect.objectContaining({
          threadId: 'thread-xyz',
          includeConversation: true,
        }),
      );
    });
  });

  describe('context usage tracking', () => {
    /** Two steps whose prompt grows, each reporting provider usage. */
    function twoStepsWithUsage() {
      mockGenerateText.mockResolvedValue({
        text: 'done',
        steps: [
          {
            text: 'thinking',
            toolCalls: [],
            toolResults: [],
            usage: { inputTokens: 100_000, outputTokens: 500, totalTokens: 100_500 },
          },
          {
            text: 'done',
            toolCalls: [],
            toolResults: [],
            usage: { inputTokens: 140_000, outputTokens: 800, totalTokens: 140_800 },
          },
        ],
      });
    }

    it('records every step with the provider-reported prompt size', async () => {
      twoStepsWithUsage();

      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-xyz' }));

      expect(mockContextUsageRecord).toHaveBeenCalledTimes(2);
      expect(mockContextUsageRecord).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          userId: 'user-test-456',
          threadId: 'thread-xyz',
          inputTokens: 100_000,
          outputTokens: 500,
        }),
      );
      expect(mockContextUsageRecord).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ inputTokens: 140_000, outputTokens: 800 }),
      );
    });

    it('records the resolved model, not the request', async () => {
      twoStepsWithUsage();

      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-xyz' }));

      // Whatever resolveEffectiveModel produced must reach the service, so the
      // window is looked up against the model that actually ran.
      expect(mockContextUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: expect.stringContaining('claude') }),
      );
    });

    it('finalizes once after the stream drains', async () => {
      twoStepsWithUsage();

      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-xyz' }));

      expect(mockContextUsageFinalize).toHaveBeenCalledTimes(1);
      expect(mockContextUsageFinalize).toHaveBeenCalledWith({ threadId: 'thread-xyz' });
    });

    it('finalizes even when the consumer breaks out of the stream early', async () => {
      // Breaking out of a `for await` runs the generator's return(), which skips
      // everything after `yield* channel`. With finalize() there instead of in the
      // finally, the service's tracked entry for this thread would leak until the
      // thread's next turn. No shipped consumer breaks early today — this pins the
      // guarantee so one can be added safely.
      twoStepsWithUsage();

      for await (const _step of invokeStream(
        createTestInvokeRequest({ mode: 'chat', threadId: 'thread-xyz' }),
      )) {
        break;
      }

      expect(mockContextUsageFinalize).toHaveBeenCalledWith({ threadId: 'thread-xyz' });
    });

    it('records every model step against the call, not the message', async () => {
      // The row is written as the call returns, so a turn whose output is
      // suppressed or never published is still counted.
      twoStepsWithUsage();

      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-xyz' }));

      expect(mockRecordLlmCall).toHaveBeenCalledTimes(2);
      expect(mockRecordLlmCall).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          purpose: 'chat',
          threadId: 'thread-xyz',
          usage: expect.objectContaining({ inputTokens: 100_000 }),
        }),
      );
      expect(mockRecordLlmCall).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ usage: expect.objectContaining({ inputTokens: 140_000 }) }),
      );
    });

    it('records a heartbeat turn, which may publish nothing at all', async () => {
      // A heartbeat has no thread and its result may be suppressed downstream.
      // Neither changes what it cost.
      twoStepsWithUsage();

      await invoke(createTestInvokeRequest({ mode: 'heartbeat' }));

      expect(mockRecordLlmCall).toHaveBeenCalledTimes(2);
      expect(mockRecordLlmCall).toHaveBeenLastCalledWith(
        expect.objectContaining({ purpose: 'heartbeat', threadId: undefined }),
      );
    });

    it('surfaces the whole breakdown on the step', async () => {
      twoStepsWithUsage();

      const result = await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-xyz' }));

      // The cache details are 0 because this fixture's provider reports none.
      expect(result.steps[1]?.usage).toEqual({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        totalTokens: 140_800,
        inputTokens: 140_000,
        outputTokens: 800,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        noCacheTokens: 0,
      });
    });

    it('sums every step into the invocation total', async () => {
      twoStepsWithUsage();

      const result = await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-xyz' }));

      // Each step resends the prompt, so billed input is both prompts.
      expect(result.usage).toEqual(
        expect.objectContaining({
          totalTokens: 241_300,
          inputTokens: 240_000,
          outputTokens: 1_300,
        }),
      );
    });

    it('reports no usage when the provider reported none', async () => {
      mockGenerateText.mockResolvedValue({
        text: 'done',
        steps: [{ text: 'done', toolCalls: [], toolResults: [] }],
      });

      const result = await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-xyz' }));

      // Absent, not a row of zeros — zeros would claim a turn that cost nothing.
      expect(result.usage).toBeUndefined();
      expect(result.steps[0]?.usage).toBeUndefined();
    });

    it('does not track a heartbeat turn — it has no thread to measure', async () => {
      twoStepsWithUsage();

      await invoke(createTestInvokeRequest({ mode: 'heartbeat' }));

      expect(mockContextUsageRecord).not.toHaveBeenCalled();
      expect(mockContextUsageFinalize).not.toHaveBeenCalled();
    });

    it('does not track a subagent turn — its prompt is not a thread history', async () => {
      twoStepsWithUsage();

      await invoke(createTestInvokeRequest({ mode: 'subagent' }));

      expect(mockContextUsageRecord).not.toHaveBeenCalled();
      expect(mockContextUsageFinalize).not.toHaveBeenCalled();
    });

    it('still records when the provider omits usage, leaving the service to skip', async () => {
      // invoke.ts must not filter this — the service owns the "no usage means
      // render nothing" decision, so it needs to see the undefined.
      mockGenerateText.mockResolvedValue({
        text: 'done',
        steps: [{ text: 'done', toolCalls: [], toolResults: [] }],
      });

      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-xyz' }));

      expect(mockContextUsageRecord).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: undefined, outputTokens: undefined }),
      );
    });
  });

  describe('early stopping on step limit', () => {
    it('makes a follow-up summary call when step limit is reached', async () => {
      const steps = Array.from({ length: 100 }, (_, i) => ({
        text: i === 99 ? 'Still working...' : '',
        toolCalls: [{ toolCallId: `tc-${i}`, toolName: 'shell_exec', input: { cmd: 'ls' } }],
        toolResults: [{ toolCallId: `tc-${i}`, output: 'ok' }],
      }));

      mockGenerateText
        .mockResolvedValueOnce({
          text: 'Still working...',
          steps,
        })
        .mockResolvedValueOnce({
          text: 'Here is a summary of what I found.',
          steps: [{ text: 'Here is a summary of what I found.', toolCalls: [], toolResults: [] }],
        });

      const result = await invoke(createTestInvokeRequest({ prompt: 'do something big' }));

      // Second generateText call should have the early stopping prompt
      expect(mockGenerateText).toHaveBeenCalledTimes(2);
      const secondCall = mockGenerateText.mock.calls[1][0];
      const lastMessage = secondCall.messages[secondCall.messages.length - 1];
      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content).toContain('all 100 steps');

      // Assistant message should summarize steps including tool calls
      const assistantMessage = secondCall.messages[secondCall.messages.length - 2];
      expect(assistantMessage.role).toBe('assistant');
      expect(assistantMessage.content).toContain('[Tool: shell_exec]');
      expect(assistantMessage.content).toContain('[Result] ok');
      expect(assistantMessage.content).toContain('Still working...');

      // No tools on the summary call: the prompt asks for a final answer, not more
      // work. Tool blocks already in the history are accepted without a tool
      // definition — verified on a live Bedrock call, against the documented
      // requirement, so do not "fix" this by declaring tools.
      expect(secondCall.tools).toBeUndefined();

      // Response should be the early stopping summary only (no intermediate step text)
      expect(result.response).toBe('Still working...\n\nHere is a summary of what I found.');
    });

    it('includes tool calls and results in the assistant context for summary', async () => {
      const steps = Array.from({ length: 100 }, (_, i) => ({
        text: '',
        toolCalls: [{ toolCallId: `tc-${i}`, toolName: i % 2 === 0 ? 'memory_search' : 'shell_exec', input: i % 2 === 0 ? { query: 'pods' } : { cmd: 'kubectl get pods' } }],
        toolResults: [{ toolCallId: `tc-${i}`, output: i % 2 === 0 ? { results: ['pod-a'] } : 'NAME  READY  STATUS' }],
      }));

      mockGenerateText
        .mockResolvedValueOnce({ text: '', steps })
        .mockResolvedValueOnce({
          text: 'Summary.',
          steps: [{ text: 'Summary.', toolCalls: [], toolResults: [] }],
        });

      await invoke(createTestInvokeRequest());

      const secondCall = mockGenerateText.mock.calls[1][0];
      const assistantMessage = secondCall.messages[secondCall.messages.length - 2];

      // Should contain both tool types with their inputs
      expect(assistantMessage.content).toContain('[Tool: memory_search] Input: {"query":"pods"}');
      expect(assistantMessage.content).toContain('[Tool: shell_exec] Input: {"cmd":"kubectl get pods"}');

      // Should contain both result types (string and JSON)
      expect(assistantMessage.content).toContain('[Result] {"results":["pod-a"]}');
      expect(assistantMessage.content).toContain('[Result] NAME  READY  STATUS');
    });

    it('does not make a follow-up call when step limit is not reached', async () => {
      mockGenerateText.mockResolvedValue({
        text: 'Done quickly.',
        steps: [{ text: 'Done quickly.', toolCalls: [], toolResults: [] }],
      });

      const callsBefore = mockGenerateText.mock.calls.length;
      await invoke(createTestInvokeRequest());

      // Only one generateText call (no follow-up summary)
      expect(mockGenerateText.mock.calls.length - callsBefore).toBe(1);
    });
  });

  describe('tool cache control', () => {
    it('marks the last tool with cache control providerOptions', async () => {
      mockGetMemoryTools.mockReturnValue({
        memory_search: { description: 'search' },
        memory_write: { description: 'write' },
      });
      mockGetAgentConfigTools.mockReturnValue({
        update_soul: { description: 'update soul' },
      });

      await invoke(createTestInvokeRequest({ mode: 'chat' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      const toolEntries = Object.entries(callArgs.tools);
      const lastTool = toolEntries[toolEntries.length - 1][1] as Record<string, unknown>;

      expect(lastTool.providerOptions).toEqual({
        anthropic: { cacheControl: { type: 'ephemeral' } },
      });
    });

    it('does not add cache control to non-last tools', async () => {
      mockGetMemoryTools.mockReturnValue({
        memory_search: { description: 'search' },
        memory_write: { description: 'write' },
      });
      mockGetAgentConfigTools.mockReturnValue({
        update_soul: { description: 'update soul' },
      });

      await invoke(createTestInvokeRequest({ mode: 'chat' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      const toolEntries = Object.entries(callArgs.tools);

      // All tools except the last should not have providerOptions
      for (let i = 0; i < toolEntries.length - 1; i++) {
        const tool = toolEntries[i][1] as Record<string, unknown>;
        expect(tool.providerOptions).toBeUndefined();
      }
    });
  });

  describe('last message cache control', () => {
    it('does not set cache breakpoint on initial messages (prepareStep handles it per-step)', async () => {
      mockBuildConversationMessages.mockReturnValue([
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first reply' },
      ]);

      await invoke(createTestInvokeRequest({ mode: 'heartbeat', prompt: 'current prompt' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      const messages = callArgs.messages;
      for (const msg of messages) {
        expect(msg.providerOptions).toBeUndefined();
      }
    });

    it('configures prepareStep to mark the last message each step', async () => {
      await invoke(createTestInvokeRequest({ prompt: 'Hello' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.prepareStep).toBeDefined();

      // Simulate prepareStep applying cache breakpoint
      const testMessages = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
      ];
      const result = await callArgs.prepareStep(firstStep(testMessages));
      expect(result.messages[1].providerOptions).toEqual({
        anthropic: { cacheControl: { type: 'ephemeral' } },
      });
      // Earlier messages should be untouched
      expect(result.messages[0].providerOptions).toBeUndefined();
    });

    it('leaves exactly one message-level breakpoint after several steps', async () => {
      // Bedrock accepts four cache blocks per request, and the system prompt
      // already spends two with the tool list on a third. A breakpoint that
      // survives into the next step's message list therefore does not just
      // waste a slot, it gets the turn rejected a few steps in.
      await invoke(createTestInvokeRequest({ prompt: 'go' }));
      const { prepareStep } = mockGenerateText.mock.calls[0][0];

      const toolRound = [
        { role: 'assistant', content: [{ type: 'tool-call' }] },
        { role: 'tool', content: [{ type: 'tool-result' }] },
      ];
      const step = stepDriver(prepareStep, [{ role: 'user', content: 'go' }]);
      await step(toolRound);
      await step(toolRound);
      const third = await step();

      const marked = third.messages.filter((m) => m.providerOptions !== undefined);
      expect(marked).toHaveLength(1);
      expect(third.messages.at(-1)?.providerOptions).toEqual({
        anthropic: { cacheControl: { type: 'ephemeral' } },
      });
    });
  });

  describe('agent status transitions', () => {
    it('should set RUNNING before processing and IDLE after', async () => {
      await invoke(createTestInvokeRequest());

      expect(mockSetProcessing).toHaveBeenCalledWith('agent-test-123');
      expect(mockSetDoneProcessing).toHaveBeenCalledWith('agent-test-123');

      // setProcessing should be called before generateText
      const processingOrder = mockSetProcessing.mock.invocationCallOrder[0];
      const generateOrder = mockGenerateText.mock.invocationCallOrder[0];
      const doneOrder = mockSetDoneProcessing.mock.invocationCallOrder[0];
      expect(processingOrder).toBeLessThan(generateOrder);
      expect(generateOrder).toBeLessThan(doneOrder);
    });

    it('should set IDLE even when generateText fails', async () => {
      mockGenerateText.mockRejectedValue(new Error('Model timeout'));

      await invoke(createTestInvokeRequest());

      expect(mockSetProcessing).toHaveBeenCalledWith('agent-test-123');
      expect(mockSetDoneProcessing).toHaveBeenCalledWith('agent-test-123');
    });

    it('should not set status when agentId is missing', async () => {
      const result = await invoke(createTestInvokeRequest({ agentId: '' }));

      expect(result.response).toContain('not sure which agent');
      expect(mockSetProcessing).not.toHaveBeenCalled();
      expect(mockSetDoneProcessing).not.toHaveBeenCalled();
    });

    it('should not set status when the LLM provider is not configured', async () => {
      mockMissingProviderSettings.mockReturnValue(['AWS_BEARER_TOKEN_BEDROCK']);

      await invoke(createTestInvokeRequest());

      expect(mockSetProcessing).not.toHaveBeenCalled();
      expect(mockSetDoneProcessing).not.toHaveBeenCalled();
    });
  });

  describe("the agent's state", () => {
    beforeEach(() => {
      mockBeginTurn.mockClear();
      mockEndTurn.mockClear();
    });

    it('reports a turn that answered as completed', async () => {
      await invoke(createTestInvokeRequest());

      expect(mockBeginTurn).toHaveBeenCalledOnce();
      expect(mockEndTurn).toHaveBeenCalledExactlyOnceWith({});
    });

    it('reports a turn that ended on an error step as failed', async () => {
      mockGenerateText.mockRejectedValue(new Error('Model timeout'));

      await invoke(createTestInvokeRequest());

      expect(mockEndTurn).toHaveBeenCalledExactlyOnceWith({ error: 'The agent could not answer. Try again.' });
    });

    it('reports a turn the spending limit stopped with its own error', async () => {
      mockGenerateText.mockRejectedValue(
        Object.assign(new Error('429'), { status: 429, responseBody: JSON.stringify({ type: 'budget-exceeded' }) }),
      );

      await invoke(createTestInvokeRequest());

      expect(mockEndTurn).toHaveBeenCalledExactlyOnceWith({
        error: 'The AI spending limit is reached.',
      });
    });

    it('reports an aborted turn as cancelled', async () => {
      const controller = new AbortController();
      controller.abort();
      mockGenerateText.mockRejectedValue(
        Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
      );

      await invoke(createTestInvokeRequest({ abortSignal: controller.signal }));

      expect(mockEndTurn).toHaveBeenCalledExactlyOnceWith({ cancelled: true });
    });

    it('reports a turn the computer stop ended as cancelled', async () => {
      const { computerService } = await import('./services/computer/computer.service');
      const create = vi.spyOn(computerService, 'createUse');
      mockGenerateText.mockImplementationOnce(async () => {
        // What a stop from the Computer page does to the turn that holds the computer.
        create.mock.results[0]!.value.controller.abort();
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      });

      try {
        await invoke(createTestInvokeRequest());
      } finally {
        create.mockRestore();
      }

      expect(mockEndTurn).toHaveBeenCalledExactlyOnceWith({ cancelled: true });
    });

    it('reports no turn for a subagent, whose parent turn reports for it', async () => {
      await invoke(createTestInvokeRequest({ mode: 'subagent' }));

      expect(mockBeginTurn).not.toHaveBeenCalled();
    });
  });

  describe('telemetry', () => {
    it('emits "invocation completed" with agent, mode, and duration', async () => {
      await invoke(createTestInvokeRequest({ mode: 'chat' }));

      expect(mockTrackEvent).toHaveBeenCalledWith('invocation completed', 'user-test-456', {
        'agent.id': 'agent-test-123',
        'invoke.mode': 'chat',
        'invocation.duration_ms': expect.any(String),
        'llm.model': expect.any(String),
        'llm.model_mode': 'fixed',
        'llm.tier_reason': 'fixed',
        'tools.deferred': '0',
      });
    });

    it('emits nothing when preflight short-circuits (provider unconfigured)', async () => {
      mockMissingProviderSettings.mockReturnValue(['AWS_BEARER_TOKEN_BEDROCK']);

      await invoke(createTestInvokeRequest());

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });
  });

  describe('conversation messages in LLM call', () => {
    it('includes conversation history in heartbeat mode messages', async () => {
      mockBuildConversationMessages.mockReturnValue([
        { role: 'user', content: 'previous user message' },
        { role: 'assistant', content: 'previous assistant reply' },
      ]);

      await invoke(createTestInvokeRequest({ mode: 'heartbeat', prompt: 'heartbeat prompt' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.messages).toMatchObject([
        { role: 'user', content: 'previous user message' },
        { role: 'assistant', content: 'previous assistant reply' },
        { role: 'user', content: 'heartbeat prompt' },
      ]);
    });

    it('appends prompt after conversation history for heartbeat mode', async () => {
      mockBuildConversationMessages.mockReturnValue([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]);

      await invoke(createTestInvokeRequest({ mode: 'heartbeat', prompt: 'check now' }));

      const messages = mockGenerateText.mock.calls[0][0].messages;
      expect(messages[messages.length - 1]).toMatchObject({
        role: 'user',
        content: 'check now',
      });
    });

    it('cron mode has empty history and only the prompt', async () => {
      mockBuildConversationMessages.mockReturnValue([]);

      await invoke(createTestInvokeRequest({ mode: 'cron', prompt: 'run task' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.messages).toMatchObject([
        { role: 'user', content: 'run task' },
      ]);
    });

    it('chat mode does not append prompt when history exists', async () => {
      mockBuildConversationMessages.mockReturnValue([
        { role: 'user', content: 'What pods are running?' },
        { role: 'assistant', content: 'Let me check.' },
      ]);

      await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'What pods are running?' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      // Should only have history, not a duplicate prompt
      expect(callArgs.messages).toMatchObject([
        { role: 'user', content: 'What pods are running?' },
        { role: 'assistant', content: 'Let me check.' },
      ]);
    });

    it('chat mode appends the prompt when appendPrompt is set', async () => {
      // The coalesced steering follow-up: its prompt sits earlier in history
      // than the previous turn's replies, so history alone would end on an
      // assistant turn — which the provider rejects as assistant prefill.
      mockBuildConversationMessages.mockReturnValue([
        { role: 'user', content: 'no need to run tests' },
        { role: 'assistant', content: 'Tests are running, continuing.' },
      ]);

      await invoke(
        createTestInvokeRequest({
          mode: 'chat',
          prompt: 'no need to run tests',
          appendPrompt: true,
        }),
      );

      const messages = mockGenerateText.mock.calls[0][0].messages;
      expect(messages[messages.length - 1]).toMatchObject({
        role: 'user',
        content: 'no need to run tests',
      });
    });

    describe('a follow-up handed a message after the previous reply', () => {
      // m1 was left over from the previous turn; m2 was handed to the follow-up
      // before its history read, so the follow-up answers it from history.
      const row = (id: string, role: 'USER' | 'AGENT', content: string) =>
        ({ id, role, content, externalMessageId: null, internalStep: false });

      it('restates the newer message after the appended prompt', async () => {
        mockGetAgentContext.mockResolvedValue(
          createTestAgentContext({
            recentMessages: [row('m1', 'USER', 'run tests'), row('r1', 'AGENT', 'Done.'), row('m2', 'USER', 'skip tests')],
          }),
        );
        mockBuildConversationMessages.mockReturnValue([
          { role: 'user', content: 'run tests' },
          { role: 'assistant', content: 'Done.' },
          { role: 'user', content: 'skip tests' },
        ]);

        await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'run tests', appendPrompt: true, appendedMessageIds: ['m1'] }));

        expect(mockGenerateText.mock.calls[0][0].messages.slice(-2)).toEqual([
          { role: 'user', content: 'run tests' },
          { role: 'user', content: 'skip tests' },
        ]);
      });

      it('restates no row of the appended prompt itself', async () => {
        // m1 was stored after the reply, so its row already follows it.
        mockGetAgentContext.mockResolvedValue(
          createTestAgentContext({ recentMessages: [row('r1', 'AGENT', 'Done.'), row('m1', 'USER', 'run tests')] }),
        );
        mockBuildConversationMessages.mockReturnValue([
          { role: 'assistant', content: 'Done.' },
          { role: 'user', content: 'run tests' },
        ]);

        await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'run tests', appendPrompt: true, appendedMessageIds: ['m1'] }));

        expect(mockGenerateText.mock.calls[0][0].messages).toMatchObject([
          { role: 'assistant', content: 'Done.' },
          { role: 'user', content: 'run tests' },
          { role: 'user', content: 'run tests' },
        ]);
      });

      it('restates nothing when history gives the rows ids of its own', async () => {
        // A thread provider that reads history live gives each row an id of its own.
        mockGetAgentContext.mockResolvedValue(
          createTestAgentContext({
            recentMessages: [row('live-r1', 'AGENT', 'Done.'), row('live-m1', 'USER', 'run tests')],
          }),
        );
        mockBuildConversationMessages.mockReturnValue([
          { role: 'assistant', content: 'Done.' },
          { role: 'user', content: 'run tests' },
        ]);

        await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'run tests', appendPrompt: true, appendedMessageIds: ['m1'] }));

        expect(mockGenerateText.mock.calls[0][0].messages).toMatchObject([
          { role: 'assistant', content: 'Done.' },
          { role: 'user', content: 'run tests' },
          { role: 'user', content: 'run tests' },
        ]);
      });
    });

    describe('a prompt a stopped turn replied after', () => {
      // A message sent after Stop is stored before the stopped turn stores its
      // last reply, and history is ordered by row, so it ends on that reply.
      const rows = (last: 'USER' | 'AGENT') =>
        createTestAgentContext({
          recentMessages: [
            { id: 'first', role: 'USER', content: 'review the PR', externalMessageId: null, internalStep: false },
            { id: 'second', role: 'USER', content: 'summarize the README', externalMessageId: null, internalStep: false },
            ...(last === 'AGENT'
              ? [{ id: 'reply', role: 'AGENT' as const, content: 'Stopped.', externalMessageId: null, internalStep: false }]
              : []),
          ],
        });
      const history = [
        { role: 'user', content: 'review the PR' },
        { role: 'user', content: 'summarize the README' },
        { role: 'assistant', content: 'Stopped.' },
      ];

      it('appends the prompt when the history ends on an agent row after its row', async () => {
        mockGetAgentContext.mockResolvedValue(rows('AGENT'));
        mockBuildConversationMessages.mockReturnValue(history);

        await invoke(
          createTestInvokeRequest({ mode: 'chat', prompt: 'summarize the README', promptMessageId: 'second' }),
        );

        const messages = mockGenerateText.mock.calls[0][0].messages;
        expect(messages[messages.length - 1]).toMatchObject({ role: 'user', content: 'summarize the README' });
      });

      it('restates every user row from the prompt on, in order, after the reply', async () => {
        // m1 started the turn and m2 was handed to it; both landed before the reply.
        mockGetAgentContext.mockResolvedValue(rows('AGENT'));
        mockBuildConversationMessages.mockReturnValue(history);

        await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'review the PR', promptMessageId: 'first' }));

        expect(mockGenerateText.mock.calls[0][0].messages.slice(-2)).toEqual([
          { role: 'user', content: 'review the PR' },
          { role: 'user', content: 'summarize the README' },
        ]);
      });

      it('restates a file-only prompt with its attachment stub', async () => {
        const file = { id: 'att-1', filename: 'screen.png', mediaType: 'image/png', category: 'image' as const, sizeBytes: 2048 };
        mockGetAgentContext.mockResolvedValue(
          createTestAgentContext({
            recentMessages: [
              { id: 'file', role: 'USER', content: '', attachments: [file], externalMessageId: null, internalStep: false },
              { id: 'reply', role: 'AGENT', content: 'Stopped.', externalMessageId: null, internalStep: false },
            ],
          }),
        );
        mockBuildConversationMessages.mockReturnValue([{ role: 'assistant', content: 'Stopped.' }]);

        await invoke(createTestInvokeRequest({ mode: 'chat', prompt: '', promptMessageId: 'file' }));

        const messages = mockGenerateText.mock.calls[0][0].messages;
        expect(messages[messages.length - 1]).toEqual({
          role: 'user',
          content: expect.stringContaining('[Attachment: screen.png · id=att-1'),
        });
      });

      it('does not append the prompt when the history ends on its row', async () => {
        mockGetAgentContext.mockResolvedValue(rows('USER'));
        mockBuildConversationMessages.mockReturnValue(history.slice(0, 2));

        await invoke(
          createTestInvokeRequest({ mode: 'chat', prompt: 'summarize the README', promptMessageId: 'second' }),
        );

        expect(mockGenerateText.mock.calls[0][0].messages).toMatchObject(history.slice(0, 2));
      });

      it('does not append the prompt when the history does not hold its row', async () => {
        mockGetAgentContext.mockResolvedValue(rows('AGENT'));
        mockBuildConversationMessages.mockReturnValue(history);

        await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'summarize the README', promptMessageId: 'slack-ts' }));

        expect(mockGenerateText.mock.calls[0][0].messages).toMatchObject(history);
      });
    });

    it('reports the rows of the history it read', async () => {
      mockGetAgentContext.mockResolvedValue(createTestAgentContext({
          recentMessages: [
            { id: 'm1', role: 'USER', content: 'hello', externalMessageId: null, internalStep: false },
            { id: 'm2', role: 'AGENT', content: 'hi', externalMessageId: null, internalStep: false },
          ],
        }));
      const onHistoryRead = vi.fn();

      await invoke(createTestInvokeRequest({ mode: 'chat', onHistoryRead }));

      expect(onHistoryRead).toHaveBeenCalledTimes(1);
      expect(onHistoryRead.mock.calls[0][0].map((row: { id: string }) => row.id)).toEqual(['m1', 'm2']);
    });

    it('closes a run after a restart with the notice, behind the history and the prompt', async () => {
      // The history and the system prompt in front of it stay the bytes the last
      // run sent, so the cached prefix holds.
      mockBuildConversationMessages.mockReturnValue([
        { role: 'user', content: 'keep the build green' },
        { role: 'assistant', content: 'Watching it.' },
      ]);

      await invoke(createTestInvokeRequest({ mode: 'goal', prompt: 'Continue the goal.', afterRestart: true }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.messages).toMatchObject([
        { role: 'user', content: 'keep the build green' },
        { role: 'assistant', content: 'Watching it.' },
        { role: 'user', content: 'Continue the goal.' },
        { role: 'user', content: RESUMED_RUN_NOTICE },
      ]);
      expect(JSON.stringify(callArgs.system)).not.toContain('runtime restarted');
    });
  });

  // Recalled memories used to be a section of the system prompt, in front of the
  // whole conversation in the one cache prefix, so every change to them re-billed
  // all of it.
  describe('recalled memories', () => {
    const RECALL = {
      role: 'user',
      content: '\n\nContext:\n<recalled-memories>\n- Mario likes chocolate\n</recalled-memories>',
    };

    it('closes the request with the recalled block', async () => {
      mockBuildRecalledMemories.mockResolvedValue('- Mario likes chocolate');
      mockBuildConversationMessages.mockReturnValue([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'q' },
      ]);

      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-1', prompt: 'q' }));

      // After the question, not before: that is where the stored row sorts, since the
      // engine writes the user's message before the turn runs. A run of user messages
      // merges into one provider turn, so the model sees them together.
      expect(mockGenerateText.mock.calls[0][0].messages).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'q' },
        RECALL,
      ]);
    });

    // Ephemeral injection is worse than no recall: the next turn replays the user's
    // message without the block, and the agent retracts the answer it gave from it as
    // something it "made up" — observed on a live agent. `internalStep` is the
    // existing mechanism for a row that replays into model context but reaches no
    // client transcript; concise mode writes its intermediate steps the same way.
    it('records the block against the thread, hidden from clients', async () => {
      mockBuildRecalledMemories.mockResolvedValue('- Mario likes chocolate');
      mockBuildConversationMessages.mockReturnValue([{ role: 'user', content: 'q' }]);

      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-1', prompt: 'q' }));

      expect(mockAddMessage).toHaveBeenCalledWith('thread-1', {
        content: RECALL.content,
        role: 'USER',
        triggeredBy: 'USER_INPUT',
        internalStep: true,
      });
    });

    // What is stored has to be what was sent, or a replayed thread rebuilds a prompt
    // that never ran.
    it('records the same bytes it sends', async () => {
      mockBuildRecalledMemories.mockResolvedValue('- Mario likes chocolate');
      mockBuildConversationMessages.mockReturnValue([{ role: 'user', content: 'q' }]);

      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-1', prompt: 'q' }));

      expect(mockAddMessage.mock.calls[0][1].content).toBe(
        mockGenerateText.mock.calls[0][0].messages.at(-1).content,
      );
    });

    // Goal and thread-bound cron turns append their prompt at invoke time and never
    // store it, so a row there would be an orphan block with no question — repeated
    // once per run, replaying into every later chat turn.
    it('records nothing for a turn whose prompt is not stored history', async () => {
      mockBuildRecalledMemories.mockResolvedValue('- Mario likes chocolate');
      mockBuildConversationMessages.mockReturnValue([{ role: 'user', content: 'q' }]);

      await invoke(createTestInvokeRequest({ mode: 'cron', threadId: 'thread-1', prompt: 'q' }));

      expect(mockAddMessage).not.toHaveBeenCalled();
      expect(mockGenerateText.mock.calls[0][0].messages).toContainEqual(RECALL);
    });

    // A turn must not fail because a recall could not be recorded: the block is in
    // this request either way, and only the replay is lost.
    it('still sends the block when recording it fails', async () => {
      mockBuildRecalledMemories.mockResolvedValue('- Mario likes chocolate');
      mockAddMessage.mockRejectedValue(new Error('database is locked'));
      mockBuildConversationMessages.mockReturnValue([{ role: 'user', content: 'q' }]);

      const result = await invoke(
        createTestInvokeRequest({ mode: 'chat', threadId: 'thread-1', prompt: 'q' }),
      );

      expect(result.response).toBe('Here are your pods.');
      expect(mockGenerateText.mock.calls[0][0].messages).toContainEqual(RECALL);
    });

    it('records nothing for a threadless turn', async () => {
      mockBuildRecalledMemories.mockResolvedValue('- Mario likes chocolate');
      mockBuildConversationMessages.mockReturnValue([]);

      await invoke(createTestInvokeRequest({ mode: 'heartbeat', prompt: 'q' }));

      expect(mockAddMessage).not.toHaveBeenCalled();
      expect(mockGenerateText.mock.calls[0][0].messages).toEqual([
        { role: 'user', content: 'q' },
        RECALL,
      ]);
    });

    // The recall is an unconditional trailing user turn, so it makes any
    // assistant-terminated array provider-valid. If the check ran after the append it
    // could never fire again — the silent fix-up `warnOnTrailingAssistant` exists to
    // refuse.
    it('still reports an assistant-terminated history behind a recall', async () => {
      mockBuildRecalledMemories.mockResolvedValue('- Mario likes chocolate');
      mockBuildConversationMessages.mockReturnValue([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ]);

      await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'q' }));

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'invocation trailing assistant',
        expect.anything(),
        expect.objectContaining({ 'invoke.stage': 'initial' }),
      );
    });

    // A user turn is legal last, so nothing needs guarding — the request cannot end
    // on an assistant turn or split a tool call from its results.
    it('does not trip the trailing-assistant tripwire', async () => {
      mockBuildRecalledMemories.mockResolvedValue('- Mario likes chocolate');
      mockBuildConversationMessages.mockReturnValue([{ role: 'user', content: 'q' }]);

      await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'q' }));

      expect(mockTrackEvent).not.toHaveBeenCalledWith(
        'invocation trailing assistant',
        expect.anything(),
        expect.anything(),
      );
    });


    it('is searched with the turn, and adds nothing when the recall is empty', async () => {
      mockBuildRecalledMemories.mockResolvedValue(null);
      mockBuildConversationMessages.mockReturnValue([{ role: 'user', content: 'q' }]);

      await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'q' }));

      const call = mockGenerateText.mock.calls[0][0];
      expect(mockBuildRecalledMemories).toHaveBeenCalledWith(expect.anything(), 'q', undefined);
      expect(call.messages).toEqual([{ role: 'user', content: 'q' }]);
      expect(call.system).toHaveLength(2);
    });
  });

  describe('recent memories', () => {
    const RECENT = {
      role: 'user',
      content: '\n\nContext:\n<recent-memories>\n- Paused the deploy (decision)\n</recent-memories>',
    };
    const RECALL = {
      role: 'user',
      content: '\n\nContext:\n<recalled-memories>\n- Mario likes chocolate\n</recalled-memories>',
    };

    beforeEach(() => {
      mockBuildRecentMemories.mockResolvedValue({
        text: '- Paused the deploy (decision)',
        entryIds: ['recent-1'],
      });
      mockBuildRecalledMemories.mockResolvedValue('- Mario likes chocolate');
      mockBuildConversationMessages.mockReturnValue([{ role: 'user', content: 'q' }]);
    });

    // The order the rows are stored in, so a replayed thread rebuilds the same prompt.
    it('sends the block after the question and ahead of the recall', async () => {
      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-1', prompt: 'q' }));

      expect(mockGenerateText.mock.calls[0][0].messages).toEqual([
        { role: 'user', content: 'q' },
        RECENT,
        RECALL,
      ]);
    });

    it('records each block as the bytes it sends, hidden from clients, in send order', async () => {
      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-1', prompt: 'q' }));

      expect(mockAddMessage.mock.calls.map((c) => c[1])).toEqual([
        { content: RECENT.content, role: 'USER', triggeredBy: 'USER_INPUT', internalStep: true },
        { content: RECALL.content, role: 'USER', triggeredBy: 'USER_INPUT', internalStep: true },
      ]);
    });

    // An entry the recent block shows must not come back in the recall of the same turn.
    it('leaves the entries the block shows out of the recall', async () => {
      await invoke(createTestInvokeRequest({ mode: 'chat', threadId: 'thread-1', prompt: 'q' }));

      expect(mockBuildRecalledMemories).toHaveBeenCalledWith(expect.anything(), 'q', ['recent-1']);
    });

    // A heartbeat, a scheduled task, a goal, a webhook and a sub-agent have no principal
    // opening a conversation, and a threadless turn has no conversation to open.
    it.each([
      ['heartbeat', 'thread-1'],
      ['cron', 'thread-1'],
      ['goal', 'thread-1'],
      ['webhook', 'thread-1'],
      ['subagent', 'thread-1'],
      ['chat', undefined],
    ] as const)('asks for no block on a %s turn (thread %s)', async (mode, threadId) => {
      await invoke(createTestInvokeRequest({ mode, threadId, prompt: 'q' }));

      expect(mockBuildRecentMemories).not.toHaveBeenCalled();
      expect(mockGenerateText.mock.calls[0][0].messages).not.toContainEqual(RECENT);
    });
  });

  describe('mid-turn steering', () => {
    it('injects steering messages at the next step boundary', async () => {
      const steering = vi
        .fn()
        .mockResolvedValueOnce([{ text: 'actually, skip the tests' }]);

      await invoke(createTestInvokeRequest({ prompt: 'review the PR', steering }));

      const { prepareStep } = mockGenerateText.mock.calls[0][0];
      const result = await prepareStep(
        firstStep([
          { role: 'user', content: 'review the PR' },
          { role: 'assistant', content: [{ type: 'tool-call' }] },
          { role: 'tool', content: [{ type: 'tool-result' }] },
        ]),
      );

      expect(result.messages).toHaveLength(4);
      expect(result.messages[3]).toMatchObject({
        role: 'user',
        content: 'actually, skip the tests',
      });
      // The injected turn is the newest message, so it carries the breakpoint.
      expect(result.messages[3].providerOptions).toEqual({
        anthropic: { cacheControl: { type: 'ephemeral' } },
      });
    });

    it('keeps an injected message in place on later steps', async () => {
      // Injections are not part of the SDK's own message list, so they have to
      // be re-spliced at the position they were inserted at. The driver
      // reproduces the SDK's carry-forward, so a hook that re-splices onto the
      // `messages` argument lands a second copy here.
      const steering = vi
        .fn()
        .mockResolvedValueOnce([{ text: 'skip the tests' }])
        .mockResolvedValue([]);

      await invoke(createTestInvokeRequest({ steering }));
      const { prepareStep } = mockGenerateText.mock.calls[0][0];

      const step = stepDriver(prepareStep, [{ role: 'user', content: 'go' }]);
      await step([
        { role: 'assistant', content: 'on it' },
        { role: 'tool', content: [{ type: 'tool-result' }] },
      ]);
      const later = await step();

      expect(later.messages.map((m: { role: string }) => m.role)).toEqual([
        'user', // original prompt
        'user', // steering message, still at index 1
        'assistant',
        'tool',
      ]);
      expect(later.messages[1]).toMatchObject({ content: 'skip the tests' });
    });

    it('carries steering messages into the early-stopping summary call', async () => {
      // The summary call replays `summarizeSteps`, which only collapses the
      // model's own steps — without the injections the summary would answer the
      // original prompt and silently ignore what the user said since.
      mockBuildConversationMessages.mockReturnValue([{ role: 'user', content: 'go' }]);

      let calls = 0;
      mockGenerateText.mockImplementation(async (args: { prepareStep?: (arg: unknown) => Promise<unknown> }) => {
        calls += 1;
        if (calls > 1) {
          return { text: 'summary', steps: [{ text: 'summary', toolCalls: [], toolResults: [] }] };
        }
        // Stand in for the SDK's per-step prepareStep call.
        await args.prepareStep?.(firstStep([{ role: 'user', content: 'go' }]));
        return {
          text: '',
          steps: Array.from({ length: 100 }, () => ({ text: '', toolCalls: [], toolResults: [] })),
        };
      });

      await invoke(createTestInvokeRequest({ steering: async () => [{ text: 'stop after this one' }] }));

      expect(mockGenerateText).toHaveBeenCalledTimes(2);
      const summaryCall = mockGenerateText.mock.calls[1][0];
      const contents = summaryCall.messages.map((m: { content: unknown }) => m.content);
      expect(contents).toContain('stop after this one');
      expect(summaryCall.messages.at(-1)).toMatchObject({ role: 'user' });
    });
  });

  describe('view_attachment document injection', () => {
    const pdfBytes = Buffer.from('%PDF-1.7 test');
    const pdfRow = {
      id: 'att-9',
      messageId: 'msg-1',
      threadId: 'thread-1',
      filename: 'spec.pdf',
      mediaType: 'application/pdf',
      sizeBytes: pdfBytes.length,
      category: 'pdf',
      data: pdfBytes,
      storagePath: null,
      source: 'web',
      slackFileId: null,
      externalTs: null,
      createdAt: new Date(),
    };

    it('lands a viewed PDF as a user message at the next step boundary and keeps it there', async () => {
      const getByIdSpy = vi.spyOn(attachmentService, 'getById').mockResolvedValue(pdfRow);
      try {
        await invoke(createTestInvokeRequest({ prompt: 'read the doc', threadId: 'thread-1' }));

        const callArgs = mockGenerateText.mock.calls[0][0];
        const viewResult = await callArgs.tools.view_attachment.execute(
          { attachmentId: 'att-9' },
          { toolCallId: 't1', messages: [] },
        );
        expect(viewResult).toMatchObject({ success: true, category: 'pdf' });

        const history = [
          { role: 'user', content: 'read the doc' },
          { role: 'assistant', content: [{ type: 'tool-call' }] },
          { role: 'tool', content: [{ type: 'tool-result' }] },
        ];
        const step = stepDriver(callArgs.prepareStep, history);
        const result = await step([{ role: 'assistant', content: 'reading' }]);

        // The document rides a user message right after the tool result that
        // requested it — Bedrock's Converse converter rejects file content
        // inside tool results, so this is the only provider-safe placement.
        expect(result.messages).toHaveLength(4);
        expect(result.messages[3].role).toBe('user');
        expect(result.messages[3].content[0]).toMatchObject({
          type: 'file',
          mediaType: 'application/pdf',
          filename: 'spec.pdf',
        });

        // Re-spliced at the same position on later steps, like steering.
        const later = await step();
        expect(later.messages).toHaveLength(5);
        expect(later.messages[3].content[0]).toMatchObject({ type: 'file' });
        expect(later.messages[4]).toMatchObject({ role: 'assistant' });
      } finally {
        getByIdSpy.mockRestore();
      }
    });

    it('carries a document viewed on the limit-hitting step into the summary call', async () => {
      const getByIdSpy = vi.spyOn(attachmentService, 'getById').mockResolvedValue(pdfRow);
      mockBuildConversationMessages.mockReturnValue([{ role: 'user', content: 'go' }]);

      let calls = 0;
      mockGenerateText.mockImplementation(async (args: {
        tools?: Record<string, { execute: (input: unknown, opts: unknown) => Promise<unknown> }>;
      }) => {
        calls += 1;
        if (calls > 1) {
          return { text: 'summary', steps: [{ text: 'summary', toolCalls: [], toolResults: [] }] };
        }
        // The tool fires on the very last step — no prepareStep runs after it,
        // so only the summary-path drain can pick the document up.
        await args.tools!.view_attachment.execute(
          { attachmentId: 'att-9' },
          { toolCallId: 't1', messages: [] },
        );
        return {
          text: '',
          steps: Array.from({ length: 100 }, () => ({ text: '', toolCalls: [], toolResults: [] })),
        };
      });

      try {
        await invoke(createTestInvokeRequest({ prompt: 'go', threadId: 'thread-1' }));

        expect(mockGenerateText).toHaveBeenCalledTimes(2);
        const summaryCall = mockGenerateText.mock.calls[1][0];
        const fileCarrier = summaryCall.messages.find(
          (m: { role: string; content: unknown }) =>
            Array.isArray(m.content) &&
            (m.content as Array<{ type?: string }>).some((p) => p.type === 'file'),
        );
        expect(fileCarrier).toBeDefined();
        expect(fileCarrier.role).toBe('user');
        expect(summaryCall.messages.at(-1)).toMatchObject({ role: 'user' });
      } finally {
        getByIdSpy.mockRestore();
      }
    });
  });

  describe('trailing-user tripwire', () => {
    it('warns and reports when the message array ends on an assistant turn', async () => {
      mockBuildConversationMessages.mockReturnValue([
        { role: 'user', content: 'what did we deploy?' },
        { role: 'assistant', content: 'Nothing went to prod.' },
      ]);

      await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'what did we deploy?' }));

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'invocation trailing assistant',
        'user-test-456',
        expect.objectContaining({
          'invoke.mode': 'chat',
          'invoke.stage': 'initial',
          'messages.count': '2',
        }),
      );
    });

    it('stays quiet when the array ends on a user turn', async () => {
      mockBuildConversationMessages.mockReturnValue([
        { role: 'assistant', content: 'Nothing went to prod.' },
        { role: 'user', content: 'trigger the production deploy' },
      ]);

      await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'trigger the production deploy' }));

      expect(mockTrackEvent).not.toHaveBeenCalledWith(
        'invocation trailing assistant',
        expect.anything(),
        expect.anything(),
      );
    });

    it('treats a trailing tool message as user-terminated', async () => {
      // Both the Bedrock and Anthropic converters fold a run of tool/user
      // messages into one provider-level user turn.
      await invoke(createTestInvokeRequest());
      const { prepareStep } = mockGenerateText.mock.calls[0][0];

      await prepareStep(
        firstStep([
          { role: 'user', content: 'go' },
          { role: 'assistant', content: [{ type: 'tool-call' }] },
          { role: 'tool', content: [{ type: 'tool-result' }] },
        ]),
      );

      expect(mockTrackEvent).not.toHaveBeenCalledWith(
        'invocation trailing assistant',
        expect.anything(),
        expect.anything(),
      );
    });

    it('reports at most once per invocation', async () => {
      mockBuildConversationMessages.mockReturnValue([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'working' },
      ]);

      await invoke(createTestInvokeRequest({ mode: 'chat', prompt: 'go' }));
      const { prepareStep } = mockGenerateText.mock.calls[0][0];
      await prepareStep(firstStep([{ role: 'assistant', content: 'still working' }]));
      await prepareStep(firstStep([{ role: 'assistant', content: 'still working' }]));

      const reports = mockTrackEvent.mock.calls.filter(
        (call) => call[0] === 'invocation trailing assistant',
      );
      expect(reports).toHaveLength(1);
    });
  });

  describe("the conversation's declared tool list", () => {
    const CACHE_POINT = { anthropic: { cacheControl: { type: 'ephemeral' } } };
    const removal = (toolName: string) => ({
      role: 'system',
      content: '',
      providerOptions: { anthropic: { toolChanges: [{ type: 'tool_removal', toolName }] } },
    });
    const addition = (toolName: string) => ({
      role: 'system',
      content: '',
      providerOptions: { anthropic: { toolChanges: [{ type: 'tool_addition', toolName }] } },
    });

    // The ledger is a process-wide singleton, so each test gets a thread of its own.
    let threadCount = 0;
    let threadId: string;
    let writeExecute: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      threadId = `declared-${++threadCount}`;
      writeExecute = vi.fn(async () => 'written');
      mockCreateBedrockProvider.mockReturnValue(Object.assign(() => 'model-instance', {
        cachePoint: () => CACHE_POINT,
        toolChanges: () => ANTHROPIC_TOOL_CHANGES,
      }));
      mockGetMemoryTools.mockReturnValue({
        memory_search: { description: 'search', execute: async () => 'found' },
        memory_write: { description: 'write', execute: writeExecute },
      });
      mockGetCronTools.mockReturnValue({
        schedule_task: { description: 'schedule' },
        list_scheduled_tasks: { description: 'list' },
      });
    });

    /** One turn on the thread, with history rows of these ids; returns its request. */
    async function turn(
      rowIds: string[],
      options: { lockedIn?: boolean; request?: Parameters<typeof createTestInvokeRequest>[0] } = {},
    ) {
      mockGetAgentContext.mockResolvedValue(createTestAgentContext({
        lockedIn: options.lockedIn ?? false,
        recentMessages: rowIds.map((id, i) => ({
          id,
          role: i % 2 === 0 ? 'USER' : 'AGENT',
          content: id,
          externalMessageId: null,
          internalStep: false,
        })),
      }));
      mockGenerateText.mockClear();
      await invoke(createTestInvokeRequest({ threadId, ...options.request }));
      return mockGenerateText.mock.calls[0][0];
    }

    it("declares the first turn's tools and lets the request hold system messages", async () => {
      const request = await turn(['u1']);

      expect(Object.keys(request.tools)).toEqual(expect.arrayContaining(['memory_search', 'memory_write']));
      expect(request.allowSystemInMessages).toBe(true);
      expect(request.messages.some((m: StepMessage) => m.role === 'system')).toBe(false);
    });

    it('sends the same list and no announcement when the tools do not change', async () => {
      const first = await turn(['u1']);
      const second = await turn(['u1', 'r1', 'u2']);

      expect(Object.keys(second.tools)).toEqual(Object.keys(first.tools));
      expect(second.messages.some((m: StepMessage) => m.role === 'system')).toBe(false);
    });

    it('keeps a withheld tool declared, announces its removal last, and refuses its calls', async () => {
      const first = await turn(['u1']);
      const second = await turn(['u1', 'r1', 'u2'], { lockedIn: true });

      expect(Object.keys(second.tools)).toEqual(Object.keys(first.tools));
      expect(second.messages.at(-1)).toEqual(removal('memory_write'));
      await expect(
        second.tools.memory_write.execute({}, { toolCallId: 't1', messages: [] }),
      ).rejects.toThrow('not available');
      expect(writeExecute).not.toHaveBeenCalled();
    });

    it('announces a tool that becomes available, declared deferred past the tools breakpoint', async () => {
      await turn(['u1'], { lockedIn: true });
      const second = await turn(['u1', 'r1', 'u2']);

      const names = Object.keys(second.tools);
      expect(names.at(-1)).toBe('memory_write');
      expect(second.tools.memory_write.providerOptions).toEqual({ anthropic: { deferLoading: true } });
      expect(second.tools[names.at(-2)!].providerOptions).toEqual(CACHE_POINT);
      expect(second.messages.at(-1)).toEqual(addition('memory_write'));
    });

    it('replays an earlier announcement after its row on a later turn', async () => {
      await turn(['u1']);
      await turn(['u1', 'r1', 'u2'], { lockedIn: true });
      mockBuildConversationHistory.mockClear();
      const third = await turn(['u1', 'r1', 'u2', 'r2', 'u3'], { lockedIn: true });

      expect(mockBuildConversationHistory).toHaveBeenCalledWith(expect.anything(), [
        { afterRowId: 'u2', message: removal('memory_write') },
      ], undefined);
      expect(third.messages.filter((m: StepMessage) => m.role === 'system')).toEqual([removal('memory_write')]);
    });

    it('keeps the catalog and the replayed loads of a deferred tool the turn no longer offers', async () => {
      const saved = { ...config };
      Object.assign(config, { contextWindowTokens: 100_000, toolSearch: 'auto', toolSearchThresholdPercent: 2 });
      mockCreateBedrockProvider.mockReturnValue(Object.assign(() => 'model-instance', {
        cachePoint: () => CACHE_POINT,
        toolChanges: () => ANTHROPIC_TOOL_CHANGES,
        deferredTools: () => ANTHROPIC_DEFERRED_TOOLS,
      }));
      const mcpTool = (description: string) => ({
        description: description.padEnd(5_000, '.'),
        inputSchema: z.object({}),
        execute: async () => 'done',
      });
      const createIssue = mcpTool('Create an issue.');
      const sendEmail = mcpTool('Send an email.');
      // The turn appends the catalog to the stable part, so each turn gets parts of its own.
      mockBuildSystemPromptParts.mockImplementation(async () => [
        { text: 'stable system prompt', cacheable: true },
        { text: 'dynamic system prompt', cacheable: false },
      ]);
      const storedLoad = {
        id: 'call-1',
        tool: LOAD_TOOLS_NAME,
        input: { names: ['send_email'] },
        output: JSON.stringify({ loaded: ['send_email'], unmatched: [], suggestions: [] }),
      };
      const sent = async (rowIds: string[]) => {
        mockBuildConversationHistory.mockClear();
        const request = await turn(rowIds);
        const replay = mockBuildConversationHistory.mock.calls[0][2];
        return { catalog: request.system[0].content as string, load: replay(storedLoad) };
      };

      try {
        mockGetMCPTools.mockResolvedValue({ create_issue: createIssue, send_email: sendEmail });
        const first = await sent(['u1']);
        mockGetMCPTools.mockResolvedValue({ create_issue: createIssue });
        const second = await sent(['u1', 'r1', 'u2']);

        expect(first.catalog).toContain('- send_email: Send an email.');
        expect(second.catalog).toBe(first.catalog);
        expect(second.load).toEqual(first.load);
        expect(second.load.output).toEqual({
          type: 'content',
          value: [{ type: 'custom', providerOptions: { anthropic: { type: 'tool-reference', toolName: 'send_email' } } }],
        });
      } finally {
        Object.assign(config, saved);
      }
    });

    it('keeps the early-stop summary on none where the SDK sends the tools under it', async () => {
      const saved = { ...config };
      Object.assign(config, { contextWindowTokens: 100_000, toolSearch: 'auto', toolSearchThresholdPercent: 2 });
      mockCreateBedrockProvider.mockReturnValue(Object.assign(() => 'model-instance', {
        cachePoint: () => ({}),
        deferredTools: () => OPENAI_DEFERRED_TOOLS,
      }));
      mockGetMCPTools.mockResolvedValue({
        create_issue: { description: 'Create an issue.'.padEnd(10_000, '.'), inputSchema: z.object({}) },
      });
      const steps = Array.from({ length: 100 }, (_, i) => ({
        text: '',
        toolCalls: [{ toolCallId: `tc-${i}`, toolName: 'memory_search', input: {} }],
        toolResults: [{ toolCallId: `tc-${i}`, output: 'ok' }],
      }));
      mockGenerateText
        .mockResolvedValueOnce({ text: '', steps })
        .mockResolvedValueOnce({ text: 'Summary.', steps: [{ text: 'Summary.', toolCalls: [], toolResults: [] }] });

      try {
        const request = await turn(['u1']);
        const summary = mockGenerateText.mock.calls[1][0];

        // A refused load_tools call on OpenAI would answer with an output the API pairs with nothing.
        expect(summary.toolChoice).toBe('none');
        expect(summary.tools).toBe(request.tools);
        expect(Object.keys(summary.tools)).toContain(LOAD_TOOLS_NAME);
      } finally {
        Object.assign(config, saved);
      }
    });

    it('starts a new list for a thread it has no record of, as after a restart', async () => {
      const request = await turn(['u1', 'r1', 'u2', 'r2', 'u3'], { lockedIn: true });

      expect(Object.keys(request.tools)).not.toContain('memory_write');
      expect(request.messages.some((m: StepMessage) => m.role === 'system')).toBe(false);
    });

    it("announces a thread-bound cron turn's tools against the same list", async () => {
      const chat = await turn(['u1']);
      const cron = await turn(['u1', 'r1'], { request: { mode: 'cron', prompt: 'check the build' } });

      expect(Object.keys(cron.tools)).toEqual(Object.keys(chat.tools));
      expect(cron.messages.at(-2)).toEqual({ role: 'user', content: 'check the build' });
      // Cron mode withholds the goal tools.
      expect(cron.messages.at(-1)).toEqual({
        role: 'system',
        content: '',
        providerOptions: {
          anthropic: {
            toolChanges: ['create_goal', 'get_goal']
              .map((toolName) => ({ type: 'tool_removal', toolName })),
          },
        },
      });
    });

    it('leaves a goal turn, which replays no conversation, on its own tool set', async () => {
      await turn(['u1']);
      const goal = await turn([], { request: { mode: 'goal', prompt: 'keep going' } });

      expect('allowSystemInMessages' in goal).toBe(false);
      expect(goal.messages.some((m: StepMessage) => m.role === 'system')).toBe(false);
    });

    it('puts the message breakpoint and a steering message before the announcement', async () => {
      await turn(['u1']);
      const steering = vi.fn().mockResolvedValueOnce([{ text: 'also check the logs' }]);
      const second = await turn(['u1', 'r1', 'u2'], { lockedIn: true, request: { steering } });

      const step = await second.prepareStep(firstStep(second.messages));

      expect(step.messages.slice(-2)).toEqual([
        { role: 'user', content: 'also check the logs', providerOptions: CACHE_POINT },
        removal('memory_write'),
      ]);
    });

    it('gives the early-stop summary the declared list and refuses every call to it', async () => {
      await turn(['u1']);
      const steps = Array.from({ length: 100 }, (_, i) => ({
        text: '',
        toolCalls: [{ toolCallId: `tc-${i}`, toolName: 'memory_search', input: {} }],
        toolResults: [{ toolCallId: `tc-${i}`, output: 'ok' }],
      }));
      mockGenerateText
        .mockResolvedValueOnce({ text: '', steps })
        .mockResolvedValueOnce({ text: 'Summary.', steps: [{ text: 'Summary.', toolCalls: [], toolResults: [] }] });

      const turnRequest = await turn(['u1', 'r1', 'u2'], { lockedIn: true });
      const summary = mockGenerateText.mock.calls[1][0];

      // Under 'none' the provider SDK sends no tools block, which the replayed
      // announcements need.
      expect(Object.keys(summary.tools)).toEqual(Object.keys(turnRequest.tools));
      expect(summary.toolChoice).toBe('auto');
      expect(summary.allowSystemInMessages).toBe(true);
      expect(summary.stopWhen).toEqual({ type: 'step-count', limit: 2 });
      await expect(
        summary.tools.memory_search.execute({}, { toolCallId: 't1', messages: [] }),
      ).rejects.toThrow('not available');
      expect(summary.messages.at(-1).content).toContain('all 100 steps');
    });

    it('hands the compaction fork the history without the trailing announcement', async () => {
      mockContextUsageRecord.mockReturnValue({
        threadId: 'any',
        modelId: 'model-x',
        usedTokens: 190_000,
        windowTokens: 200_000,
        usedPercent: 95,
      });
      await turn(['u1']);
      const second = await turn(['u1', 'r1', 'u2'], { lockedIn: true });

      const fork = mockMaybeAutoCompact.mock.calls.at(-1)![0];
      expect(fork.declaredTools).toBe(true);
      expect(fork.tools).toBe(second.tools);
      expect(fork.messages).toEqual(second.messages.slice(0, -1));
    });

    it("sends today's request on a model that takes no tool changes", async () => {
      mockCreateBedrockProvider.mockReturnValue(Object.assign(() => 'model-instance', {
        cachePoint: () => CACHE_POINT,
      }));
      await turn(['u1']);
      const second = await turn(['u1', 'r1', 'u2'], { lockedIn: true });

      const names = Object.keys(second.tools);
      expect(names).not.toContain('memory_write');
      expect(second.tools[names.at(-1)!].providerOptions).toEqual(CACHE_POINT);
      expect('allowSystemInMessages' in second).toBe(false);
      expect(second.messages.some((m: StepMessage) => m.role === 'system')).toBe(false);
    });
  });
});

describe('withToolsCacheControl', () => {
  const cachePoint = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

  it('returns empty object for empty tools', () => {
    expect(withToolsCacheControl({}, cachePoint)).toEqual({});
  });

  it('marks the only tool with cache control when there is one tool', () => {
    const tools = { search: { description: 'search' } };
    const result = withToolsCacheControl(tools as any as Record<string, Tool>, cachePoint);

    expect(result.search).toEqual(
      expect.objectContaining({ providerOptions: cachePoint }),
    );
  });

  it('marks only the last tool with cache control', () => {
    const tools = {
      alpha: { description: 'a' },
      beta: { description: 'b' },
      gamma: { description: 'c' },
    };
    const result = withToolsCacheControl(tools as any as Record<string, Tool>, cachePoint);

    expect((result.alpha as Record<string, unknown>).providerOptions).toBeUndefined();
    expect((result.beta as Record<string, unknown>).providerOptions).toBeUndefined();
    expect((result.gamma as Record<string, unknown>).providerOptions).toEqual(cachePoint);
  });

  it('preserves all original tool properties', () => {
    const execute = async () => 'result';
    const tools = {
      myTool: { description: 'test', inputSchema: { type: 'object' }, execute },
    };
    const result = withToolsCacheControl(tools as any as Record<string, Tool>, cachePoint);

    expect((result.myTool as Record<string, unknown>).description).toBe('test');
    expect((result.myTool as Record<string, unknown>).execute).toBe(execute);
    expect((result.myTool as Record<string, unknown>).providerOptions).toEqual(cachePoint);
  });

  it('merges the breakpoint into the tool\'s own providerOptions', () => {
    const tools = { a: { description: 'a', providerOptions: { anthropic: { eagerInputStreaming: true } } } };
    const result = withToolsCacheControl(tools as any as Record<string, Tool>, cachePoint);

    expect((result.a as Record<string, unknown>).providerOptions).toEqual({
      anthropic: { eagerInputStreaming: true, cacheControl: { type: 'ephemeral' } },
    });
  });

  it('puts the breakpoint on the last tool that is not deferred', () => {
    // The API refuses a breakpoint on a tool that loads only when a change names it.
    const tools = { a: { description: 'a' }, b: { description: 'b' }, c: { description: 'c' } };
    const result = withToolsCacheControl(tools as any as Record<string, Tool>, cachePoint, new Set(['c']));

    expect((result.b as Record<string, unknown>).providerOptions).toEqual(cachePoint);
    expect((result.c as Record<string, unknown>).providerOptions).toBeUndefined();
  });

  it('puts the breakpoint on the last tool a load_tools call has not deferred', () => {
    const deferred = { anthropic: { deferLoading: true } };
    const tools = { a: { description: 'a' }, b: { description: 'b', providerOptions: deferred } };
    const result = withToolsCacheControl(tools as any as Record<string, Tool>, cachePoint);

    expect((result.a as Record<string, unknown>).providerOptions).toEqual(cachePoint);
    expect((result.b as Record<string, unknown>).providerOptions).toEqual(deferred);
  });

  it('does not mutate the original tools object', () => {
    const tools = { a: { description: 'a' }, b: { description: 'b' } };
    const result = withToolsCacheControl(tools as any as Record<string, Tool>, cachePoint);

    expect((tools.a as Record<string, unknown>).providerOptions).toBeUndefined();
    expect((tools.b as Record<string, unknown>).providerOptions).toBeUndefined();
    expect(result).not.toBe(tools);
  });
});

describe('extractAttachmentIds', () => {
  it('collects attachmentIds from successful share_file results', () => {
    const toolCalls = [
      { toolName: 'share_file', toolCallId: 'c1' },
      { toolName: 'shell_exec', toolCallId: 'c2' },
      { toolName: 'share_file', toolCallId: 'c3' },
    ];
    const toolResults = [
      { toolCallId: 'c1', output: { success: true, attachmentId: 'att-1' } },
      { toolCallId: 'c2', output: { stdout: 'ok' } },
      { toolCallId: 'c3', output: { success: true, attachmentId: 'att-2' } },
    ];
    expect(extractAttachmentIds(toolCalls, toolResults)).toEqual(['att-1', 'att-2']);
  });

  it('ignores failed shares and non-share tools', () => {
    const toolCalls = [
      { toolName: 'share_file', toolCallId: 'c1' },
      { toolName: 'share_file', toolCallId: 'c2' },
    ];
    const toolResults = [
      { toolCallId: 'c1', output: { success: false, error: 'Path outside workspace' } },
      { toolCallId: 'c2', output: { stdout: 'no id here' } },
    ];
    expect(extractAttachmentIds(toolCalls, toolResults)).toEqual([]);
  });

  it('returns an empty array when there are no share_file calls', () => {
    expect(extractAttachmentIds([{ toolName: 'memory_write', toolCallId: 'x' }], [])).toEqual([]);
  });
});
