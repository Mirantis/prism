/**
 * Unified Agent Invocation
 *
 * Agent-runtime is self-sufficient: it builds its own context from the
 * shared database, connects to MCP servers for tools, calls
 * generateText(), and returns the response.
 */

import { generateText, ModelMessage, SystemModelMessage, Tool, stepCountIs } from 'ai';
import { config } from './config';
import { logger } from './logger';
import { createBedrockProvider, isBedrockConfigured } from './lib/bedrock-provider';
import { createNexusProvider } from './lib/nexus-provider';
import { getMCPTools } from './lib/mcp-client';
import { getMemoryTools } from './tools/memory';
import { getCronTools } from './tools/cron';
import { getAgentConfigTools } from './tools/agent-config';
import { getShellTools } from './tools/shell/index';
import { contextService } from './services/context.service';
import { agentWorkspaceService, resolveEffectiveModel } from './services/agent-workspace.service';
import { isLangfuseEnabled } from './lib/langfuse';
import { buildSystemPromptParts, buildConversationMessages } from './prompts/context-builder';
import { getChannelBehaviorInstructions } from './prompts/channel-prompt';
import { getTaskToolInstructions } from './prompts/task-tool-prompt';
import { createTaskTool } from './lib/task-tool';
import { withOutputLimits } from './lib/tool-output-limiter';
import { InvokeError, InvokeRequest, InvokeResponse, InvokeStep, ToolCallRecord, UIBlock } from './types';
import { STEP_LIMIT, MAX_OUTPUT_TOKENS } from './constants';
import { EARLY_STOPPING_PROMPT } from './prompts/early-stopping-prompt';
import { buildErrorStep } from './lib/llm-errors';
import { agentStatusService } from './services/agent-status.service';
import { AsyncChannel } from './utils/async-channel';

// Nexus MCP tools available to agents
const NEXUS_MCP_TOOLS = [
  'shell_exec', 'shell_write_file', 'shell_read_file', 'shell_edit_file',
  'shell_spawn', 'shell_stdin', 'shell_stdout', 'shell_kill', 'claude_code', 'claude_code_status',
  'list_clusters', 'get_cluster',
  'list_github_connections', 'get_github_connection',
  'list_aws_connections', 'get_aws_connection',
  'get_spending_limit_status', 'get_usage_cost_summary', 'get_usage_cost_timeseries',
  'query_audit_trail',
].join(',');

/**
 * Stream agent execution as a sequence of InvokeSteps.
 *
 * Owns preflight (Bedrock + agentId), agent-context fetch, tool collection,
 * generateText, and error formatting. Errors are yielded as friendly steps
 * (via buildErrorStep) rather than thrown, so consumers just iterate.
 *
 * 1. Preflight: short-circuit with a placeholder step if misconfigured
 * 2. Fetch agent context from the local database
 * 3. Fetch Nexus MCP token and connect to MCP servers for tools
 * 4. Build the system prompt + message history
 * 5. Call generateText() and yield each step as onStepFinish fires
 * 6. On step-limit, make a follow-up summary call and yield its result
 */
export async function* invokeStream(request: InvokeRequest): AsyncGenerator<InvokeStep> {
  // Preflight: short-circuit before any DB call.
  if (!isBedrockConfigured()) {
    logger.error('Bedrock not configured, returning placeholder response');
    yield {
      text: 'I apologize, but I am not fully configured yet. Please ensure the Bedrock credentials are set up.',
      toolCalls: [],
    };
    return;
  }

  if (!request.agentId) {
    logger.error('Agent ID is missing in the request');
    yield {
      text: 'I apologize, but I am not sure which agent to use. Please specify an agent ID.',
      toolCalls: [],
    };
    return;
  }

  // Fetch context. Failures become friendly error steps.
  let context;
  try {
    context = await contextService.getAgentContext(request.userId, {
      threadId: request.threadId,
      includeConversation: request.mode === 'chat',
      agentId: request.agentId,
    });
  } catch (error) {
    yield buildErrorStep(error);
    return;
  }

  try {
    await agentStatusService.setProcessing(request.agentId);

    // 1. For heartbeat mode, inject last alert
    if (request.mode === 'heartbeat') {
      context.lastHeartbeatAlert = request.lastHeartbeatAlert;
      context.lastHeartbeatAlertAt = request.lastHeartbeatAlertAt;
    }

    // 2. Get Nexus agent token
    const nexusAgentToken = await agentWorkspaceService.getNexusMcpAgentToken(request.agentId);

    const modelId = resolveEffectiveModel(context.model);
    const routeInfo = nexusAgentToken ? 'via Nexus' : 'direct';
    logger.info(`Invoking in ${request.mode} mode with model ${modelId} ${routeInfo} for agent ${context.agentName}`);

    // 3. Create provider and model — route through Nexus when agent has a token
    const provider = nexusAgentToken && config.nexusLlmBaseUrl
      ? createNexusProvider(config.nexusLlmBaseUrl, nexusAgentToken)
      : createBedrockProvider();
    const model = provider(modelId);

    // 4. Collect tools — built-ins are direct AI SDK tools (no MCP
    // round trip); only the Nexus MCP server (cross-process) still
    // goes via getMCPTools().
    const builtInTools = filterToolsByMode(
      {
        ...getMemoryTools(request.userId, request.agentId),
        ...getCronTools(request.userId, request.agentId),
        ...getAgentConfigTools(request.agentId),
        ...getShellTools(),
      },
      request.mode,
    );

    const nexusTools: Record<string, Tool> = config.nexusMcpUrl && nexusAgentToken
      ? await getMCPTools({
          url: config.nexusMcpUrl,
          token: nexusAgentToken,
          extraHeaders: { 'x-mcp-tools': NEXUS_MCP_TOOLS },
        })
      : {};

    const tools: Record<string, Tool> = { ...builtInTools, ...nexusTools };

    // Fetch subagents (skip for subagent invocations to prevent recursion)
    const subagents = request.mode === 'subagent'
      ? []
      : await agentWorkspaceService.getSubagents(request.agentId);

    logger.info(
      `Collected ${Object.keys(builtInTools).length} built-in + ${Object.keys(nexusTools).length} Nexus MCP tool(s); ${subagents.length} subagent(s)`,
    );

    // Add task tool if subagents are configured
    if (subagents.length > 0 && request.mode !== 'subagent') {
      logger.info(`Adding Task tool for ${subagents.length} subagent(s)`);
      tools['Task'] = createTaskTool(subagents, request.userId, invoke);
    }

    // 5. Wrap tools with output limits and cache control
    const limitedTools = withOutputLimits(tools);
    const cachedTools = withToolsCacheControl(limitedTools);

    // 6. Build system prompt parts (stable vs dynamic for granular caching)
    const systemParts = await buildSystemPromptParts(context, request.mode, request.slackMessages, request.prompt);

    // Append channel/task instructions to the stable (cacheable) part
    const stablePart = systemParts.find((p) => p.cacheable);
    if (request.isChannelMessage && request.mode !== 'subagent' && stablePart) {
      stablePart.text += '\n\n' + getChannelBehaviorInstructions();
    }

    if (subagents.length > 0 && request.mode !== 'subagent' && stablePart) {
      logger.info(`Adding task tool instructions for ${subagents.length} subagent(s)`);
      stablePart.text += '\n\n' + getTaskToolInstructions(
        subagents.map((s) => ({ name: s.name, description: s.description }))
      );
    }

    // 7. Build messages (already ModelMessage[] with structured tool call/result pairs)
    let messages: ModelMessage[] = buildConversationMessages(context);

    // Chat: prompt is already in history (conversation engine stores it before invoke).
    // Heartbeat/cron: prompt is NOT in history — always append it.
    if (request.mode !== 'chat' || messages.length === 0) {
      messages.push({ role: 'user' as const, content: request.prompt });
    }

    // Anthropic prompt caching: system prompt parts marked cacheable get cache breakpoints.
    // [0] stable prefix (identity, soul, memory, instructions) — cached across conversations
    // [1] recalled memories + timestamp — cached within multi-step invocations
    // Bedrock allows max 4 breakpoints: 2 system + last message (via prepareStep) + last tool.
    const anthropicCachePoint = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };
    const cachedSystem: SystemModelMessage[] = systemParts.map((part) => ({
      role: 'system' as const,
      content: part.text,
      ...(part.cacheable ? { providerOptions: anthropicCachePoint } : {}),
    }));
    // Last message breakpoint is handled by prepareStep below (re-applied each step
    // as messages grow during tool use). No need to set it here — that would leave a
    // stale breakpoint on the original last message, wasting a slot on step 2+.

    logger.info(
      `${context.agentName} in ${request.mode} mode: ${Object.keys(cachedTools).length} tool(s), ${messages.length} message(s)`
    );

    // Build Langfuse telemetry config (reused across generateText calls)
    const langfuseTelemetry = (functionId: string) =>
      isLangfuseEnabled()
        ? {
            experimental_telemetry: {
              isEnabled: true as const,
              functionId,
              metadata: {
                userId: request.userId,
                sessionId: request.threadId ?? '',
                agentName: context.agentName,
              },
            },
          }
        : {};

    // 8. Call generateText and yield steps as they complete
    const channel = new AsyncChannel<InvokeStep>();

    generateText({
      model,
      system: cachedSystem,
      messages,
      tools: Object.keys(cachedTools).length > 0 ? cachedTools : undefined,
      toolChoice: 'auto',
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      stopWhen: stepCountIs(STEP_LIMIT),
      ...langfuseTelemetry(`invoke-${request.mode}`),
      // Re-apply cache breakpoint on the latest last message each step so the
      // growing conversation prefix is cached between steps (Bedrock doesn't
      // support automatic caching — only direct Anthropic API does).
      prepareStep: ({ messages: stepMessages }) => {
        if (stepMessages.length > 0) {
          const lastIdx = stepMessages.length - 1;
          stepMessages[lastIdx] = {
            ...stepMessages[lastIdx],
            providerOptions: anthropicCachePoint,
          } as ModelMessage;
        }
        return { messages: stepMessages };
      },
      onStepFinish: (step) => {
        const details = step.usage?.inputTokenDetails;

        if (details) {
          logger.debug(
            `Token cache: read=${details.cacheReadTokens ?? 0}, write=${details.cacheWriteTokens ?? 0}, no-cache=${details.noCacheTokens ?? 0}`
          );
        }

        // Convert SDK step to InvokeStep and push to channel
        const stepToolCalls: ToolCallRecord[] = [];
        for (const tc of step.toolCalls) {
          const tr = step.toolResults.find((r) => r.toolCallId === tc.toolCallId);
          stepToolCalls.push({
            tool: tc.toolName,
            input: JSON.stringify(tc.input),
            output: tr ? JSON.stringify(tr.output) : '',
            success: !!tr,
            timestamp: new Date().toISOString(),
          });
        }

        const blocks = extractBlocks(step.text);
        channel.push({ text: step.text, toolCalls: stepToolCalls, blocks });
      },
   }).then(async (result) => {
      // 9. If the step limit was reached, make a follow-up call to get a final summary
      if (result.steps.length >= STEP_LIMIT) {
        const assistantText = summarizeSteps(result.steps);
        logger.info(`Step limit (${STEP_LIMIT}) reached, requesting final summary of (${assistantText.length} chars) from the agent`);

        const summaryResult = await generateText({
          model,
          system: cachedSystem,
          messages: [
            ...messages,
            { role: 'assistant' as const, content: assistantText },
            { role: 'user' as const, content: EARLY_STOPPING_PROMPT },
          ],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...langfuseTelemetry('invoke-early-stopping'),
        });

        const earlyStoppingBlocks = extractBlocks(summaryResult.text);
        channel.push({ text: summaryResult.text, toolCalls: [], blocks: earlyStoppingBlocks });
      }

       channel.close();
    }).catch((error) => {
      // Surface the error as a friendly step so consumers don't need a
      // separate error-handling path. buildErrorStep is the single
      // formatter for LLM/runtime errors (budget-aware).
      channel.push(buildErrorStep(error));
      channel.close();
    });

    // Yield steps as they arrive. Errors from generateText surface as a
    // final friendly step (with optional structured `error` metadata) via
    // buildErrorStep above — no exception is thrown.
    yield* channel;
  } finally {
    await agentStatusService.setDoneProcessing(request.agentId);
  }
}

/**
 * Aggregating wrapper around invokeStream(): drains the step stream into a
 * single InvokeResponse. Used by callers that need the full result before
 * acting (heartbeat, task tool, cron). Streaming callers should use
 * invokeStream() directly.
 *
 * All preflight, context fetch, and friendly error formatting live in
 * invokeStream() — this wrapper has no try/catch, since errors arrive as
 * yielded steps (with optional structured `error` metadata).
 */
export async function invoke(request: InvokeRequest): Promise<InvokeResponse> {
  // Best-effort lookup so the log line below carries the agent name.
  // invokeStream() does its own context fetch; we re-query here purely
  // for logging and tolerate failures (e.g. agent not found).
  let agentName = 'Agent';
  if (request.agentId) {
    try {
      const agent = await agentWorkspaceService.getAgentById(request.agentId);
      agentName = agent.name;
    } catch {
      // Leave default; the friendly error will come back through the stream.
    }
  }

  const steps: InvokeStep[] = [];
  let errorMeta: InvokeError | undefined;

  for await (const step of invokeStream(request)) {
    steps.push(step);
    if (step.error) errorMeta = step.error;
  }

  const allToolCalls = steps.flatMap((s) => s.toolCalls);
  const response = joinStepTexts(steps) || '';
  const allBlocks = steps.flatMap((s) => s.blocks ?? []);

  logger.info(
    `${agentName} responded: ${response.length} chars, ${allToolCalls.length} tool call(s)`
  );

  return {
    response,
    toolCalls: allToolCalls,
    ...(allBlocks.length > 0 ? { blocks: allBlocks } : {}),
    steps,
    ...(errorMeta ? { error: errorMeta } : {}),
  };
}

/**
 * Join non-empty step texts into a single string.
 */
function joinStepTexts(steps: Array<{ text: string }>): string {
  return steps.map((s) => s.text).filter(Boolean).join('\n\n');
}

/**
 * Summarize steps including tool calls and their results for context.
 */
function summarizeSteps(
  steps: Array<{
    text: string;
    toolCalls: Array<{ toolName: string; input: unknown }>;
    toolResults: Array<{ toolCallId: string; output: unknown }>;
  }>,
): string {
  const parts: string[] = [];
  for (const step of steps) {
    for (const tc of step.toolCalls) {
      const inputStr = JSON.stringify(tc.input);
      parts.push(`[Tool: ${tc.toolName}] Input: ${inputStr}`);
    }
    for (const tr of step.toolResults) {
      const outputStr = typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output);
      parts.push(`[Result] ${outputStr}`);
    }
    if (step.text) {
      parts.push(step.text);
    }
  }
  return parts.join('\n\n') || '(no output)';
}

/**
 * Mark the last tool with an Anthropic cache breakpoint so the entire tools
 * block is cached across requests. Tools are stable per agent, so this yields
 * near-100% cache hit rates after the first request.
 */
export function withToolsCacheControl(tools: Record<string, Tool>): Record<string, Tool> {
  const keys = Object.keys(tools);
  if (keys.length === 0) return tools;

  const cachePoint = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };
  const lastKey = keys[keys.length - 1];
  const result: Record<string, Tool> = {};

  for (const [name, tool] of Object.entries(tools)) {
    result[name] = name === lastKey
      ? { ...tool, providerOptions: cachePoint }
      : tool;
  }
  return result;
}

/**
 * Filter backend MCP tools by invocation mode.
 *
 * - chat: All tools
 * - heartbeat: All tools except cron tools
 * - cron: Memory tools + Nexus MCP (subset of backend MCP)
 */
function filterToolsByMode(tools: Record<string, Tool>, mode: string): Record<string, Tool> {
  if (mode === 'chat') {
    return tools;
  }

  const cronToolNames = new Set(['schedule_task', 'list_scheduled_tasks', 'delete_scheduled_task']);
  const memoryToolNames = new Set(['memory_search', 'memory_write', 'memory_delete']);

  if (mode === 'heartbeat') {
    // All tools except cron tools
    const filtered: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(tools)) {
      if (!cronToolNames.has(name)) {
        filtered[name] = tool;
      }
    }
    return filtered;
  }

  if (mode === 'cron') {
    // Memory tools only (no config, no cron)
    const filtered: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(tools)) {
      if (memoryToolNames.has(name)) {
        filtered[name] = tool;
      }
    }
    return filtered;
  }

  return tools;
}

/**
 * Extract UI blocks from response
 */
function extractBlocks(response: string): UIBlock[] | undefined {
  try {
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.blocks && Array.isArray(parsed.blocks)) {
        return parsed.blocks;
      }
    }
  } catch {
    // No blocks found
  }
  return undefined;
}
