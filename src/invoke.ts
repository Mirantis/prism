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
import { createProvider, isProviderConfigured } from './lib/llm-providers/create-provider';
import { getMCPTools } from './lib/mcp-client';
import { getMemoryTools } from './tools/memory';
import { getCronTools } from './tools/cron';
import { getGoalTools } from './tools/goals';
import { getAgentConfigTools } from './tools/agent-config';
import { getShellTools } from './tools/shell/index';
import { getShareFileTools, SHARE_FILE_TOOL_NAME } from './tools/share-file';
import { getSkillTools } from './tools/skills/index';
import { contextService } from './services/context.service';
import {
  agentWorkspaceService,
  resolveEffectiveModel,
  resolveScopedModel,
} from './services/agent-workspace.service';
import { isLangfuseEnabled } from './lib/langfuse';
import {
  buildSystemPromptParts,
  buildConversationMessages,
  buildSteeringMessage,
} from './prompts/context-builder';
import { getChannelBehaviorInstructions } from './prompts/channel-prompt';
import { getTaskToolInstructions } from './prompts/task-tool-prompt';
import { createTaskTool } from './lib/task-tool';
import { withOutputLimits } from './lib/tool-output-limiter';
import { InvokeError, InvokeRequest, InvokeResponse, InvokeStep, ToolCallRecord, UIBlock } from './types';
import { STEP_LIMIT, MAX_OUTPUT_TOKENS } from './constants';
import { EARLY_STOPPING_PROMPT } from './prompts/early-stopping-prompt';
import { buildErrorStep } from './lib/llm-errors';
import { agentStatusService } from './services/agent-status.service';
import { trackEvent } from './lib/telemetry';
import { AsyncChannel } from './utils/async-channel';

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
  const startTime = Date.now();

  // Preflight: short-circuit before any DB call.
  if (!isProviderConfigured()) {
    logger.error(`LLM provider (${config.llmProvider}) not configured, returning placeholder response`);
    yield {
      text: 'I apologize, but I am not fully configured yet. Please ensure the LLM credentials are set up.',
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
  const agentId = request.agentId;

  // Fetch context. Failures become friendly error steps.
  let context;
  try {
    context = await contextService.getAgentContext(request.userId, {
      threadId: request.threadId,
      // Chat always sees history. A thread-bound cron run ("continue in this
      // conversation") also needs it so the resumed agent remembers what it was
      // waiting for; plain cron/heartbeat/goal stay history-less by design (goal
      // turns intentionally restate their objective rather than replay history).
      includeConversation: request.mode === 'chat' || (request.mode === 'cron' && Boolean(request.threadId)),
      agentId: request.agentId,
      verbose: request.verbose,
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

    // Per-turn runtime notices → surfaced as an authoritative system-prompt
    // section (e.g. a Slack attachment that failed to download).
    context.runtimeNotices = request.runtimeNotices;

    // Heartbeat and cron runs honor their own optional model override,
    // falling back to the main per-agent model, then the env default. Chat
    // and every other mode use the main model directly.
    const modelId =
      request.mode === 'heartbeat'
        ? resolveScopedModel(context.heartbeatModel, context.model)
        : request.mode === 'cron'
          ? resolveScopedModel(context.cronModel, context.model)
          : resolveEffectiveModel(context.model);
    logger.info(`Invoking in ${request.mode} mode with model ${modelId} for agent ${context.agentName}`);

    // 3. Create provider and model — createProvider picks the configured
    // vendor (Bedrock/Azure) and routing (direct vs Nexus).
    const model = createProvider()(modelId);

    // 4. Collect tools — built-ins are direct AI SDK tools (no MCP
    // round trip); only the Nexus MCP server (cross-process) still
    // goes via getMCPTools().
    const builtInTools = filterToolsByMode(
      {
        ...getMemoryTools(request.userId, request.agentId),
        ...getCronTools(
          request.userId,
          request.agentId,
          request.threadId,
          request.originChannel ?? 'websocket',
          request.originChannelId,
        ),
        ...getGoalTools(
          request.userId,
          request.agentId,
          request.threadId,
          request.originChannel ?? 'websocket',
          request.originChannelId,
        ),
        ...getAgentConfigTools(),
        ...getShellTools(request.workspaceRoot),
        ...getShareFileTools(),
        // Progressive disclosure: the `skill` tool loads a skill's full SKILL.md
        // body on demand. workspaceRoot merges the repo's skills with the global
        // ones. Empty (and omitted) when no skills are available.
        ...getSkillTools(request.workspaceRoot),
      },
      request.mode,
    );

    // Register every tool the Nexus MCP endpoint exposes. In the sandbox this
    // is the project-scoped endpoint, which already excludes first-party shell
    // tools by design (those are local built-ins above), so no tool allowlist
    // is sent — we want the full surface it serves.
    const nexusTools: Record<string, Tool> = config.nexusMcpUrl
      ? await getMCPTools({ url: config.nexusMcpUrl })
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
    const systemParts = await buildSystemPromptParts(
      context,
      request.mode,
      request.slackMessages,
      request.prompt,
      request.workspaceRoot,
    );

    // Append channel/task instructions to the stable (cacheable) part
    const stablePart = systemParts.find((p) => p.cacheable);
    if (request.isChannelMessage && request.mode !== 'subagent' && stablePart) {
      stablePart.text += '\n\n' + getChannelBehaviorInstructions(request.channelName);
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
    // A coalesced steering follow-up sets `appendPrompt` because its prompt sits
    // earlier in history than the previous turn's replies (see InvokeRequest).
    if (request.mode !== 'chat' || request.appendPrompt || messages.length === 0) {
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
    let wasCanceled = false;
    const channel = new AsyncChannel<InvokeStep>();

    // Tripwire state: report an assistant-terminated request at most once per
    // invocation so a 100-step turn can't flood the metric.
    const guard = { reported: false };
    const guardContext = { agentId, userId: request.userId, mode: request.mode, guard };

    // Steering messages already folded into this turn, each pinned to the index
    // it was inserted at. `prepareStep` receives a freshly-built
    // `[...history, ...responseMessages]` every step — our injections are not
    // part of the SDK's own message list, so they must be re-spliced each step
    // to stay in the conversation at a stable position.
    const injections: Array<{ at: number; message: ModelMessage }> = [];

    warnOnTrailingAssistant(messages, { ...guardContext, stage: 'initial' });

    generateText({
      model,
      system: cachedSystem,
      messages,
      tools: Object.keys(cachedTools).length > 0 ? cachedTools : undefined,
      toolChoice: 'auto',
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      stopWhen: stepCountIs(STEP_LIMIT),
      abortSignal: request.abortSignal,
      ...langfuseTelemetry(`invoke-${request.mode}`),
      // Fold in any mid-turn steering messages, then re-apply the cache
      // breakpoint on the latest last message so the growing conversation
      // prefix is cached between steps (Bedrock doesn't support automatic
      // caching — only the direct Anthropic API does).
      prepareStep: async ({ messages: stepMessages }) => {
        // Async so the steering source can load a mid-turn message's files
        // before shaping it — the SDK awaits this hook.
        for (const pending of (await request.steering?.()) ?? []) {
          const files = pending.attachments?.length ? `, ${pending.attachments.length} file(s)` : '';
          logger.info(
            `Steering the in-flight turn with a mid-turn message (${pending.text.length} chars${files})`,
          );
          injections.push({
            at: stepMessages.length,
            message: buildSteeringMessage(pending),
          });
        }

        // Splice highest index first so each injection lands before the
        // step-message it was recorded against, unshifted by the others.
        const merged = [...stepMessages];
        for (let i = injections.length - 1; i >= 0; i--) {
          merged.splice(injections[i].at, 0, injections[i].message);
        }

        if (merged.length > 0) {
          const lastIdx = merged.length - 1;
          merged[lastIdx] = {
            ...merged[lastIdx],
            providerOptions: anthropicCachePoint,
          } as ModelMessage;
        }

        warnOnTrailingAssistant(merged, { ...guardContext, stage: 'step' });
        return { messages: merged };
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
            success: Boolean(tr),
            timestamp: new Date().toISOString(),
          });
        }

        const blocks = extractBlocks(step.text);
        const attachmentIds = extractAttachmentIds(step.toolCalls, step.toolResults);
        const totalTokens = step.usage?.totalTokens;
        channel.push({
          text: step.text,
          toolCalls: stepToolCalls,
          ...(typeof totalTokens === 'number' ? { usage: { totalTokens } } : {}),
          blocks,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        });
      },
   }).then(async (result) => {
      // 9. If the step limit was reached, make a follow-up call to get a final summary
      if (result.steps.length >= STEP_LIMIT) {
        const assistantText = summarizeSteps(result.steps);
        logger.info(`Step limit (${STEP_LIMIT}) reached, requesting final summary of (${assistantText.length} chars) from the agent`);

        // Mid-turn steering messages ride along in arrival order: they were
        // part of this turn's conversation, but `summarizeSteps` only collapses
        // the model's own steps, so without this the summary would answer the
        // original prompt and silently ignore what the user said since.
        const summaryMessages: ModelMessage[] = [
          ...messages,
          ...injections.map((i) => i.message),
          { role: 'assistant' as const, content: assistantText },
          { role: 'user' as const, content: EARLY_STOPPING_PROMPT },
        ];
        warnOnTrailingAssistant(summaryMessages, { ...guardContext, stage: 'early-stopping' });

        const summaryResult = await generateText({
          model,
          system: cachedSystem,
          messages: summaryMessages,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          abortSignal: request.abortSignal,
          ...langfuseTelemetry('invoke-early-stopping'),
        });

        const earlyStoppingBlocks = extractBlocks(summaryResult.text);
        const summaryTokens = summaryResult.usage?.totalTokens;
        channel.push({
          text: summaryResult.text,
          toolCalls: [],
          ...(typeof summaryTokens === 'number' ? { usage: { totalTokens: summaryTokens } } : {}),
          blocks: earlyStoppingBlocks,
        });
      }

       channel.close();
    }).catch((error) => {
      // User-initiated cancellation: the caller aborted our signal, so
      // generateText rejected with an AbortError. Close the stream quietly —
      // already-completed steps were already pushed and stay delivered; we
      // don't want a "I encountered an error…" bubble. We own the signal, so
      // `aborted` is the robust discriminator (no error-shape sniffing).
      if (request.abortSignal?.aborted) {
        wasCanceled = true;
        channel.close();
        return;
      }
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

    // A user-aborted turn is reported as a distinct event (not "completed") so
    // cancellations are measurable. invokeStream is the single convergence
    // point for every cancel path (WS cancel message + HTTP disconnect), so
    // it owns this event — callers don't emit their own.
    trackEvent(wasCanceled ? 'invocation canceled' : 'invocation completed', request.userId, {
      'agent.id': agentId,
      'invoke.mode': request.mode,
      'invocation.duration_ms': String(Date.now() - startTime),
    });
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
      const agent = await agentWorkspaceService.getAgent();
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
  const allAttachmentIds = steps.flatMap((s) => s.attachmentIds ?? []);
  const totalTokens = steps.reduce((sum, s) => sum + (s.usage?.totalTokens ?? 0), 0);

  logger.info(
    `${agentName} responded: ${response.length} chars, ${allToolCalls.length} tool call(s), ${totalTokens} token(s)`
  );

  return {
    response,
    toolCalls: allToolCalls,
    ...(allBlocks.length > 0 ? { blocks: allBlocks } : {}),
    ...(allAttachmentIds.length > 0 ? { attachmentIds: allAttachmentIds } : {}),
    usage: { totalTokens },
    steps,
    ...(errorMeta ? { error: errorMeta } : {}),
  };
}

/**
 * Pre-flight tripwire: warn when a request is about to go out with an
 * assistant-terminated message array.
 *
 * Bedrock/Anthropic reject those outright — "This model does not support
 * assistant message prefill. The conversation must end with a user message." —
 * and the user only ever sees the generic error bubble, with nothing in the
 * telemetry to say which turn shape produced it. This fires *before* the call so
 * the condition is attributable to a mode, stage, and agent.
 *
 * Flags an assistant tail and nothing else. A trailing `tool` message is fine —
 * both the Bedrock and Anthropic converters fold a run of `tool`/`user` messages
 * into one provider-level user turn, so tool results terminate the array as a
 * user turn on the wire.
 *
 * Detection only — deliberately does not repair the array. The whole point is to
 * confirm that turn steering keeps the trailing-user invariant on its own; a
 * silent fix-up here would hide a regression instead of reporting it.
 *
 * Emits the telemetry event at most once per invocation (via the shared
 * `guard`), so a multi-step turn can't report the same condition up to
 * `STEP_LIMIT` times. The log line is per call, which is bounded in practice: a
 * request the provider rejects never reaches a second step.
 */
export function warnOnTrailingAssistant(
  messages: ModelMessage[],
  context: {
    agentId: string;
    userId: string;
    mode: string;
    stage: 'initial' | 'step' | 'early-stopping';
    guard: { reported: boolean };
  },
): void {
  // An assistant tail is the one shape the provider rejects, so that is exactly
  // what this reports. Anything else — a `system` tail, an empty array — is not a
  // prefill risk, and reporting it under an event named for the assistant tail
  // would be a false positive.
  if (messages[messages.length - 1]?.role !== 'assistant') return;

  logger.warn(
    `LLM request ends on an assistant turn: ${messages.length} message(s) ` +
      `(mode=${context.mode}, stage=${context.stage}) — the provider will reject ` +
      `this as assistant prefill`,
  );

  if (!context.guard.reported) {
    context.guard.reported = true;
    trackEvent('invocation trailing assistant', context.userId, {
      'agent.id': context.agentId,
      'invoke.mode': context.mode,
      'invoke.stage': context.stage,
      'messages.count': String(messages.length),
    });
  }
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
 * Filter built-in tools by invocation mode.
 *
 * - chat: All tools
 * - heartbeat: minus cron-management AND goal tools (no schedule/goal reshaping)
 * - cron: minus list/delete-task AND goal tools, but KEEPS schedule_task so a
 *   thread-bound "continue in this conversation" run can re-`wait` (poll in-thread)
 * - webhook: same as cron — an event-triggered run keeps schedule_task for
 *   "check again later" follow-ups
 * - subagent: minus share_file (no user channel) AND goal tools (no user thread)
 * - goal: minus create_goal (no nested goals) and cron-management; get_goal stays
 */
function filterToolsByMode(tools: Record<string, Tool>, mode: string): Record<string, Tool> {
  // Goal-management tools are chat-only entry points; a goal turn keeps only
  // get_goal so it can introspect its own progress.
  const goalToolNames = new Set(['create_goal', 'get_goal']);
  const cronToolNames = new Set(['schedule_task', 'list_scheduled_tasks', 'delete_scheduled_task']);

  const omit = (names: Set<string>): Record<string, Tool> => {
    const result: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(tools)) {
      if (!names.has(name)) result[name] = tool;
    }
    return result;
  };

  if (mode === 'chat') {
    return tools;
  }

  // Subagents return their result as text to the parent invocation (via the
  // Task tool) — they have no direct channel to the user, so a file they
  // "shared" would never be delivered. Drop share_file. They also don't own a
  // user thread, so drop goal tools.
  if (mode === 'subagent') {
    return omit(new Set([SHARE_FILE_TOOL_NAME, ...goalToolNames]));
  }

  // Heartbeat is an autonomous run: full tool access, minus the cron-management
  // and goal tools so it can't reshape the schedule or spawn goals.
  if (mode === 'heartbeat') {
    return omit(new Set([...cronToolNames, ...goalToolNames]));
  }

  // Cron keeps `schedule_task` so a thread-bound "continue in this conversation"
  // run can re-`wait` (schedule a follow-up) and keep polling in-thread, but
  // still can't enumerate/delete the whole schedule or create/nest goals.
  if (mode === 'cron' || mode === 'webhook') {
    return omit(new Set(['list_scheduled_tasks', 'delete_scheduled_task', ...goalToolNames]));
  }

  // A goal turn does real work but must not create/nest a goal or reshape the
  // schedule.
  if (mode === 'goal') {
    return omit(new Set(['create_goal', ...cronToolNames]));
  }

  return tools;
}

/**
 * Collect attachment ids produced by `share_file` tool calls in a step.
 *
 * Reads the structured `execute()` return value (preserved on `toolResults`
 * even though the model-facing view is truncated by the output limiter), so
 * there's no fragile string parsing. Matches results to calls by toolCallId
 * and keeps only successful shares that returned an `attachmentId`.
 */
export function extractAttachmentIds(
  toolCalls: Array<{ toolName: string; toolCallId: string }>,
  toolResults: Array<{ toolCallId: string; output: unknown }>,
): string[] {
  // Index results once (O(n)) rather than scanning per share_file call.
  const outputById = new Map(toolResults.map((r) => [r.toolCallId, r.output]));
  const ids: string[] = [];
  for (const tc of toolCalls) {
    if (tc.toolName !== SHARE_FILE_TOOL_NAME) continue;
    const out = outputById.get(tc.toolCallId);
    if (
      out &&
      typeof out === 'object' &&
      (out as { success?: unknown }).success !== false &&
      typeof (out as { attachmentId?: unknown }).attachmentId === 'string'
    ) {
      ids.push((out as { attachmentId: string }).attachmentId);
    }
  }
  return ids;
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
