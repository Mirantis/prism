/**
 * Invoke Tests
 *
 * Core invocation logic with heavy mocking of external dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestInvokeRequest, createTestAgentContext } from './test-utils/factories';

const {
  mockGenerateText,
  mockIsBedrockConfigured,
  mockCreateBedrockProvider,
  mockGetMCPTools,
  mockBuildSystemPromptParts,
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
} = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockIsBedrockConfigured: vi.fn(),
  mockCreateBedrockProvider: vi.fn(),
  mockGetMCPTools: vi.fn(),
  mockBuildSystemPromptParts: vi.fn(),
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

vi.mock('ai', () => ({
  generateText: (opts: Record<string, unknown>) => simulatingGenerateText(opts),
  stepCountIs: (limit: number) => ({ type: 'step-count', limit }),
  tool: <T,>(spec: T) => spec,
  jsonSchema: <T,>(spec: T) => spec,
}));

vi.mock('./lib/bedrock-provider', () => ({
  isBedrockConfigured: mockIsBedrockConfigured,
  createBedrockProvider: mockCreateBedrockProvider,
}));

vi.mock('./lib/mcp-client', () => ({
  getMCPTools: mockGetMCPTools,
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

vi.mock('./prompts/context-builder', () => ({
  buildSystemPromptParts: mockBuildSystemPromptParts,
  buildConversationMessages: mockBuildConversationMessages,
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

vi.mock('./services/agent-workspace.service', () => ({
  agentWorkspaceService: {
    getSubagents: mockGetSubagents,
  },
  resolveEffectiveModel: (stored: string | null | undefined) =>
    stored ?? 'anthropic.claude-3-sonnet-20240229-v1:0',
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
  trackEvent: mockTrackEvent,
}));


import { invoke, withToolsCacheControl, extractAttachmentIds } from './invoke';
import { config } from './config';
import { Tool } from 'ai';

describe('invoke', () => {
  beforeEach(() => {
    // Built-in tools are direct AI SDK now; only the Nexus MCP url
    // (cross-process) still matters here.
    config.nexusMcpUrl = 'http://localhost:3002/mcp';

    // Default empty built-in tool factories — individual tests
    // override per-describe.
    mockGetMemoryTools.mockReturnValue({});
    mockGetCronTools.mockReturnValue({});
    mockGetAgentConfigTools.mockReturnValue({});
    mockGetShellTools.mockReturnValue({});
    mockGetShareFileTools.mockReturnValue({});

    mockIsBedrockConfigured.mockReturnValue(true);
    mockCreateBedrockProvider.mockReturnValue(() => 'model-instance');
    mockGetMCPTools.mockResolvedValue({});
    mockBuildSystemPromptParts.mockResolvedValue([
      { text: 'stable system prompt', cacheable: true },
      { text: 'dynamic system prompt', cacheable: false },
    ]);
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

  it('returns placeholder response when Bedrock is not configured', async () => {
    mockIsBedrockConfigured.mockReturnValue(false);

    const result = await invoke(createTestInvokeRequest());

    expect(result.response).toContain('not fully configured');
    expect(result.toolCalls).toEqual([]);
    expect(result.steps).toEqual([
      {
        text: "I apologize, but I am not fully configured yet. Please ensure the Bedrock credentials are set up.",
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
    });

    it('chat mode gets all tools', async () => {
      await invoke(createTestInvokeRequest({ mode: 'chat' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      // 3 memory + 3 cron + 1 agent-config + 1 shell + 1 share_file
      expect(Object.keys(callArgs.tools)).toHaveLength(9);
      expect(Object.keys(callArgs.tools)).toContain('share_file');
    });

    it('subagent mode excludes share_file (no channel to the user)', async () => {
      await invoke(createTestInvokeRequest({ mode: 'subagent' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      const toolNames = Object.keys(callArgs.tools);
      expect(toolNames).not.toContain('share_file');
      expect(toolNames).toContain('shell_exec');
    });

    it('heartbeat mode excludes cron tools', async () => {
      await invoke(createTestInvokeRequest({ mode: 'heartbeat' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      const toolNames = Object.keys(callArgs.tools);
      expect(toolNames).not.toContain('schedule_task');
      expect(toolNames).not.toContain('list_scheduled_tasks');
      expect(toolNames).not.toContain('delete_scheduled_task');
      expect(toolNames).toContain('memory_search');
      expect(toolNames).toContain('update_soul');
      expect(toolNames).toContain('shell_exec');
    });

    it('cron mode excludes cron tools (mirrors heartbeat)', async () => {
      await invoke(createTestInvokeRequest({ mode: 'cron' }));

      const callArgs = mockGenerateText.mock.calls[0][0];
      const toolNames = Object.keys(callArgs.tools);
      expect(toolNames).not.toContain('schedule_task');
      expect(toolNames).not.toContain('list_scheduled_tasks');
      expect(toolNames).not.toContain('delete_scheduled_task');
      expect(toolNames).toContain('memory_search');
      expect(toolNames).toContain('update_soul');
      // The original regression: cron runs lost the built-in shell tools
      // (shell_exec etc.), so a scheduled task could not run shell commands.
      expect(toolNames).toContain('shell_exec');
    });
  });

  it('adds Nexus MCP tools when nexusMcpUrl is configured', async () => {
    mockGetMCPTools.mockResolvedValue({ kubectl: {} });

    await invoke(createTestInvokeRequest());

    // Only the Nexus MCP server is reached via getMCPTools now (built-ins are direct).
    expect(mockGetMCPTools).toHaveBeenCalledTimes(1);

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.tools).toHaveProperty('kubectl');
  });

  it('calls Nexus MCP with the configured URL and no tool allowlist', async () => {
    mockGetMCPTools.mockResolvedValue({});

    await invoke(createTestInvokeRequest());

    // The endpoint serves the full tool surface it chooses to expose, so the
    // runtime sends no x-mcp-tools allowlist — just the URL.
    const nexusCall = mockGetMCPTools.mock.calls[0][0];
    expect(nexusCall).toEqual({ url: 'http://localhost:3002/mcp' });
    expect(nexusCall.extraHeaders).toBeUndefined();
  });

  it('does not add Nexus MCP tools when nexusMcpUrl is unset', async () => {
    config.nexusMcpUrl = null;
    mockGetAgentContext.mockResolvedValue(createTestAgentContext({ isBootstrapPhase: false }));

    await invoke(createTestInvokeRequest());

    // No nexus URL → no MCP fetch at all (built-ins are direct).
    expect(mockGetMCPTools).not.toHaveBeenCalled();
  });

  it('appends channel instructions to the stable part when isChannelMessage is true', async () => {
    await invoke(createTestInvokeRequest({ isChannelMessage: true }));

    expect(mockGetChannelBehaviorInstructions).toHaveBeenCalled();
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
    it('threads the abortSignal into generateText', async () => {
      const controller = new AbortController();

      await invoke(createTestInvokeRequest({ abortSignal: controller.signal }));

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({ abortSignal: controller.signal }),
      );
    });

    it('swallows the abort error — no friendly error step — when the signal is aborted', async () => {
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

    it('returns generic error for non-budget 429', async () => {
      mockGenerateText.mockRejectedValue(Object.assign(new Error('Too Many Requests'), { status: 429 }));

      const result = await invoke(createTestInvokeRequest());

      expect(result.response).toContain('Too Many Requests');
      expect(result.error).toBeUndefined();
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
      expect(lastMessage.content).toContain('maximum number of iterations (100)');
      expect(lastMessage.content).toContain('Do not attempt to use any more tools');

      // Assistant message should summarize steps including tool calls
      const assistantMessage = secondCall.messages[secondCall.messages.length - 2];
      expect(assistantMessage.role).toBe('assistant');
      expect(assistantMessage.content).toContain('[Tool: shell_exec]');
      expect(assistantMessage.content).toContain('[Result] ok');
      expect(assistantMessage.content).toContain('Still working...');

      // Should not pass tools in the summary call
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
      const result = callArgs.prepareStep({ messages: testMessages });
      expect(result.messages[1].providerOptions).toEqual({
        anthropic: { cacheControl: { type: 'ephemeral' } },
      });
      // Earlier messages should be untouched
      expect(result.messages[0].providerOptions).toBeUndefined();
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

    it('should not set status when Bedrock is not configured', async () => {
      mockIsBedrockConfigured.mockReturnValue(false);

      await invoke(createTestInvokeRequest());

      expect(mockSetProcessing).not.toHaveBeenCalled();
      expect(mockSetDoneProcessing).not.toHaveBeenCalled();
    });
  });

  describe('telemetry', () => {
    it('emits "invocation completed" with agent, mode, and duration', async () => {
      await invoke(createTestInvokeRequest({ mode: 'chat' }));

      expect(mockTrackEvent).toHaveBeenCalledWith('invocation completed', 'user-test-456', {
        'agent.id': 'agent-test-123',
        'invoke.mode': 'chat',
        'invocation.duration_ms': expect.any(String),
      });
    });

    it('emits nothing when preflight short-circuits (Bedrock unconfigured)', async () => {
      mockIsBedrockConfigured.mockReturnValue(false);

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
  });

});

describe('withToolsCacheControl', () => {
  const cachePoint = { anthropic: { cacheControl: { type: 'ephemeral' } } };

  it('returns empty object for empty tools', () => {
    expect(withToolsCacheControl({})).toEqual({});
  });

  it('marks the only tool with cache control when there is one tool', () => {
    const tools = { search: { description: 'search' } };
    const result = withToolsCacheControl(tools as any as Record<string, Tool>);

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
    const result = withToolsCacheControl(tools as any as Record<string, Tool>);

    expect((result.alpha as Record<string, unknown>).providerOptions).toBeUndefined();
    expect((result.beta as Record<string, unknown>).providerOptions).toBeUndefined();
    expect((result.gamma as Record<string, unknown>).providerOptions).toEqual(cachePoint);
  });

  it('preserves all original tool properties', () => {
    const execute = async () => 'result';
    const tools = {
      myTool: { description: 'test', inputSchema: { type: 'object' }, execute },
    };
    const result = withToolsCacheControl(tools as any as Record<string, Tool>);

    expect((result.myTool as Record<string, unknown>).description).toBe('test');
    expect((result.myTool as Record<string, unknown>).execute).toBe(execute);
    expect((result.myTool as Record<string, unknown>).providerOptions).toEqual(cachePoint);
  });

  it('does not mutate the original tools object', () => {
    const tools = { a: { description: 'a' }, b: { description: 'b' } };
    const result = withToolsCacheControl(tools as any as Record<string, Tool>);

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
