import { computerHelpNotices } from './prompts/computer-prompt';
import { computerHelpService, waitsForAnswer } from './services/computer/computer-help.service';
import { hasComputerForMode } from './services/computer/supported';
import { computerService } from './services/computer/computer.service';
/**
 * Unified Agent Invocation
 *
 * Agent-runtime is self-sufficient: it builds its own context from the
 * shared database, connects to MCP servers for tools, calls
 * generateText(), and returns the response.
 */

import { ModelMessage, SystemModelMessage, stepCountIs } from 'ai';
import { callModel } from './lib/model-call';
import { config } from './config';
import { logger } from './logger';
import { createProvider, missingProviderSettings } from './lib/llm-providers/create-provider';
import { mergeProviderOptions } from './lib/llm-providers/llm-provider';
import { collectTools, withToolsCacheControl } from './lib/tool-collection';
import { summaryToolOptions, toolLedgerService, type AnchoredToolChange } from './services/tool-ledger.service';
import { createPendingFileWrites } from './lib/pending-file-writes';
import { SHARE_FILE_TOOL_NAME } from './tools/share-file';
import { contextService } from './services/context.service';
import { contextUsageService, type ContextUsageSnapshot } from './services/context-usage.service';
import { compactionService } from './services/compaction.service';
import { conversationService } from './services/conversation.service';
import { agentWorkspaceService } from './services/agent-workspace.service';
import { selectTurnModel } from './lib/model-routing';

import {
  type SystemPromptPart,
  buildSystemPromptParts,
  buildRecalledMemories,
  recalledMemoryContent,
  buildRecentMemories,
  recentMemoryContent,
  buildConversationHistory,
  buildSteeringMessage,
  buildUserMessage,
} from './prompts/context-builder';
import { getChannelBehaviorInstructions } from './prompts/channel-prompt';
import { getTaskToolInstructions } from './prompts/task-tool-prompt';
import {
  withToolOutputCapture,
  renderToolResult,
  renderToolResultDetailed,
  isSpilledToolOutput,
  unwrapToolOutput,
} from './lib/tool-output-limiter';
import { withToolLifecycleEvents } from './lib/tool-lifecycle';
import {
  isToolRiskGateError,
  withToolRiskGate,
} from './lib/tool-risk-gate';
import { AgentContext, InvokeError, InvokeRequest, InvokeResponse, InvokeStep, ToolCallRecord, UIBlock } from './types';
import { foldStepUsage, toStepUsage } from './lib/step-usage';
import { STEP_LIMIT, MAX_OUTPUT_TOKENS, COMPACTION_FALLBACK_WINDOW_TOKENS } from './constants';
import { EARLY_STOPPING_PROMPT } from './prompts/early-stopping-prompt';
import { buildErrorStep, buildRefusalStep, isContextOverflowError } from './lib/llm-errors';
import { agentStatusService } from './services/agent-status.service';
import { programStatusService, type TurnEnding } from './services/program-status.service';
import { TURN_FAILED, turnError } from './protocol/chat-protocol';
import {
  conversationThreadActivityService,
  type ThreadActivity,
} from './services/conversation-thread-activity.service';
import { trackEvent, langfuseTelemetry } from './lib/telemetry';
import { AsyncChannel } from './utils/async-channel';
import { RESUMED_RUN_NOTICE } from './prompts/resume-prompt';

/**
 * The system prompt parts and the opening messages of a turn: the context's
 * parts, with the channel and Task-tool blocks appended to the cached part, and
 * the thread, with the prompt appended where the thread does not hold it.
 * `toolChangeMessages` are the tool-change announcements that go last on the
 * turn's first step: the API takes one only after a user turn and before an
 * assistant turn.
 */
export async function buildTurnRequest(
  context: AgentContext,
  request: InvokeRequest,
  subagents: ReadonlyArray<{ name: string; description: string }>,
  toolChanges?: AnchoredToolChange[],
): Promise<{ systemParts: SystemPromptPart[]; messages: ModelMessage[]; toolChangeMessages: ModelMessage[] }> {
  // Stable vs dynamic parts, for granular caching
  const systemParts = await buildSystemPromptParts(
    context,
    request.mode,
    request.heartbeatTriggers,
    request.workspaceRoot,
  );

  // Append channel/task instructions to the stable (cacheable) part
  const stablePart = systemParts.find((p) => p.cacheable);
  if (request.channelLabel && request.mode !== 'subagent' && stablePart) {
    stablePart.text += '\n\n' + getChannelBehaviorInstructions(request.channelLabel);
  }

  if (subagents.length > 0 && request.mode !== 'subagent' && stablePart) {
    logger.info(`Adding task tool instructions for ${subagents.length} subagent(s)`);
    stablePart.text += '\n\n' + getTaskToolInstructions(
      subagents.map((s) => ({ name: s.name, description: s.description }))
    );
  }

  // Messages are already ModelMessage[] with structured tool call/result pairs
  const history = buildConversationHistory(context, toolChanges);
  const messages: ModelMessage[] = history.messages;

  // Chat: prompt is already in history (conversation engine stores it before invoke).
  // Heartbeat/cron: prompt is NOT in history — always append it.
  // A coalesced steering follow-up sets `appendPrompt` because its prompt sits
  // earlier in history than the previous turn's replies. A stopped turn can store
  // its last reply after this prompt's row and the ones handed over with it, so
  // those are restated in order, files included (see InvokeRequest).
  // A follow-up also restates the messages handed to it after the previous reply,
  // which it reads as history, so the newest instruction stays last.
  const restated = request.mode === 'chat' && !request.appendPrompt ? restatedAfterReply(context, request.promptMessageId) : [];
  if (restated.length > 0) {
    messages.push(...restated);
  } else if (request.mode !== 'chat' || request.appendPrompt || messages.length === 0) {
    messages.push({ role: 'user' as const, content: request.prompt });
  }
  if (request.mode === 'chat' && request.appendPrompt) {
    messages.push(...restatedAfterFollowUp(context, request.appendedMessageIds ?? []));
  }
  if (request.afterRestart) messages.push({ role: 'user' as const, content: RESUMED_RUN_NOTICE });

  return { systemParts, messages, toolChangeMessages: history.trailingToolChanges };
}

/**
 * The user rows from the prompt's row on, as history renders them, when the
 * history ends on an agent row stored after the prompt's row; otherwise none.
 */
function restatedAfterReply(context: AgentContext, promptMessageId: string | undefined): ModelMessage[] {
  if (!promptMessageId) return [];
  const rows = context.recentMessages;
  const at = rows.findIndex((row) => row.id === promptMessageId);
  if (at === -1 || at === rows.length - 1 || rows[rows.length - 1].role !== 'AGENT') return [];
  return rows
    .slice(at)
    .filter((row) => row.role === 'USER')
    .flatMap((row) => buildUserMessage(row) ?? []);
}

/**
 * The user rows stored after both the last agent row and the rows of a
 * follow-up's appended prompt, as history renders them; none when history
 * has none of those rows, as a thread provider that gives rows its own ids reads it.
 */
function restatedAfterFollowUp(context: AgentContext, appendedMessageIds: ReadonlyArray<string>): ModelMessage[] {
  const rows = context.recentMessages;
  if (!rows.some((row) => appendedMessageIds.includes(row.id))) return [];
  let after = rows.length;
  while (after > 0 && rows[after - 1].role !== 'AGENT' && !appendedMessageIds.includes(rows[after - 1].id)) after--;
  return rows
    .slice(after)
    .filter((row) => row.role === 'USER')
    .flatMap((row) => buildUserMessage(row) ?? []);
}

/**
 * Stream agent execution as a sequence of InvokeSteps.
 *
 * Owns preflight (Bedrock + agentId), agent-context fetch, tool collection,
 * generateText, and error formatting. Errors are yielded as friendly steps
 * (via buildErrorStep) rather than thrown, so consumers just iterate.
 *
 * 1. Preflight: short-circuit with a placeholder step if misconfigured
 * 2. Fetch agent context from the local database
 * 3. Fetch the external MCP token and connect to MCP servers for tools
 * 4. Build the system prompt + message history
 * 5. Call generateText() and yield each step as onStepFinish fires
 * 6. On step-limit, make a follow-up summary call and yield its result
 */
export async function* invokeStream(request: InvokeRequest): AsyncGenerator<InvokeStep> {
  // A subagent runs inside its parent's turn, which reports for both.
  if (request.mode === 'subagent') {
    yield* streamInvocation(request);
    return;
  }
  // Report how every turn ended to the agent's state, whichever exit the turn took.
  const turn = programStatusService.beginTurn();
  const ending: TurnEnding = {};
  try {
    for await (const step of streamInvocation(request, ending)) {
      if (step.error) ending.error = turnError(step.error);
      yield step;
    }
  } catch (error) {
    ending.error = TURN_FAILED;
    throw error;
  } finally {
    turn.end(ending);
  }
}

/** `ending.cancelled` is set when a stop ends the turn: the caller's, or the computer's. */
async function* streamInvocation(request: InvokeRequest, ending: TurnEnding = {}): AsyncGenerator<InvokeStep> {
  const startTime = Date.now();

  // Preflight: short-circuit before any DB call.
  const missingSettings = missingProviderSettings();
  if (missingSettings.length > 0) {
    logger.error(
      { provider: config.llmProvider, missingSettings },
      'LLM provider not configured, returning placeholder response',
    );
    yield {
      text:
        `I am not fully configured yet: the ${config.llmProvider} LLM provider needs ` +
        `${missingSettings.join(' and ')}.`,
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
  const computerUse = computerService.createUse(request, request.abortSignal);
  request = { ...request, abortSignal: computerUse.signal };

  // Chat always sees history. A thread-bound cron run ("continue in this
  // conversation") also needs it so the resumed agent remembers what it was
  // waiting for; plain cron/heartbeat/goal stay history-less by design (goal
  // turns intentionally restate their objective rather than replay history).
  const includeConversation =
    request.mode === 'chat' || (request.mode === 'cron' && Boolean(request.threadId));

  // Fetch context. Failures become friendly error steps.
  let context;
  try {
    context = await contextService.getAgentContext(request.userId, {
      threadId: request.threadId,
      includeConversation,
      agentId: request.agentId,
      verbose: request.verbose,
    });
  } catch (error) {
    computerUse.failed = true;
    computerService.finish(computerUse);
    yield buildErrorStep(error);
    return;
  }
  request.onHistoryRead?.(context.recentMessages);

  let activity: ThreadActivity | undefined;
  try {
    await agentStatusService.setProcessing(request.agentId);
    activity = await conversationThreadActivityService.begin(request);
    computerUse.idle = activity.idle;

    // 1. For heartbeat mode, inject last alert
    if (request.mode === 'heartbeat') {
      context.lastHeartbeatAlert = request.lastHeartbeatAlert;
      context.lastHeartbeatAlertAt = request.lastHeartbeatAlertAt;
    }

    // Per-turn runtime notices → surfaced as an authoritative system-prompt
    // section (e.g. an attachment that failed to download).
    context.runtimeNotices = request.runtimeNotices;
    if (hasComputerForMode(request.mode)) {
      const help = await computerHelpService.forTurn(request);
      const computers = computerService.notice(request.mode);
      context.runtimeNotices = [
        ...(request.runtimeNotices ?? []),
        ...(computers ? [computers] : []),
        ...computerHelpNotices(help, waitsForAnswer(request.mode)),
      ];
    }

    // 3. Create provider and model — createProvider picks the configured
    // vendor (Bedrock/Azure) and routing (direct vs the Lens Agents gateway).
    const provider = createProvider();
    const turnModel = await selectTurnModel(context, request, provider);
    const { modelId } = turnModel;
    logger.info(
      `Invoking in ${request.mode} mode with model ${modelId}` +
        (turnModel.tier ? ` (${turnModel.tier} tier, ${turnModel.reason})` : '') +
        ` for agent ${context.agentName}`,
    );

    const model = provider(modelId);
    const cachePoint = provider.cachePoint(modelId);
    const toolChangeProtocol = provider.toolChanges?.(modelId);

    // Queue for messages a tool asks to append to the running conversation,
    // for content a tool result cannot carry and that must arrive as a user
    // message of its own. A tool pushes here while its step runs; `prepareStep`
    // (below) drains the queue at the next step boundary into `injections`,
    // which pins each message right after the tool result that asked for it.
    const pendingAttachmentInjections: ModelMessage[] = [];

    // The current step's file writes, so `share_file` can wait for a write to the
    // file it is about to read rather than racing it — a step's tool calls run
    // concurrently, and reading first captures the file as it was before the edit.
    // Scoped to one step by the `clear()` in `prepareStep` below.
    const pendingFileWrites = createPendingFileWrites();

    // 4. Collect tools (see lib/tool-collection.ts).
    const { tools, subagents } = await collectTools({
      userId: request.userId,
      agentId: request.agentId,
      threadId: request.threadId,
      mode: request.mode,
      originChannel: request.originChannel,
      originChannelId: request.originChannelId,
      workspaceRoot: request.workspaceRoot,
      taskInvoker: invoke,
      registerAttachmentInjection: (message) => pendingAttachmentInjections.push(message),
      pendingFileWrites,
      computerUse,
      // While locked in, the workspace-markdown writers are withheld.
      lockedIn: context.lockedIn,
    });

    // 5. Wrap tools with lifecycle events, output capture, the optional
    // pre-execution risk gate, and cache control. The order carries two
    // invariants that have to hold together:
    //
    //  - lifecycle innermost, so the "is running <tool>…" indicator clears when
    //    the tool itself finishes rather than after the saved copy is written;
    //  - the gate outside lifecycle, so a rejected call never claims the
    //    underlying tool started running.
    //
    // The gate sits outside the capture too, which needs no argument: a rejected
    // call produces no result, so there is nothing to cut or save.
    const observedTools = withToolLifecycleEvents(tools, request.onToolEvent);
    const limitedTools = withToolOutputCapture(observedTools, {
      workspaceRoot: request.workspaceRoot,
    });
    const gatedTools = withToolRiskGate(limitedTools, {
      mode: config.toolRiskGateMode,
      invocationMode: request.mode,
      initialPrompt: request.prompt,
      // Read as policy by the classifier, not as evidence — see the gate.
      agentGuide: context.agentMd,
      userId: request.userId,
      agentId: request.agentId,
    });
    // A request that replays the conversation sends the conversation's declared
    // tool list, so the tools block stays the same when the tool set changes
    // (see tool-ledger.service.ts).
    const declared = toolChangeProtocol && request.threadId && includeConversation
      ? await toolLedgerService.declare({
          threadId: request.threadId,
          modelId,
          protocol: toolChangeProtocol,
          available: gatedTools,
          rowIds: context.recentMessages.map((row) => row.id),
        })
      : undefined;
    const cachedTools = withToolsCacheControl(
      declared?.tools ?? gatedTools,
      cachePoint,
      declared?.deferred,
    );

    // 6-7. Build the system prompt parts and the messages
    const { systemParts, messages, toolChangeMessages } = await buildTurnRequest(
      context,
      request,
      subagents,
      declared?.toolChanges,
    );

    // `guard` is shared by every `warnOnTrailingAssistant` call in this invocation, and
    // the function sets it once it has reported. A 100-step turn checks the array at
    // each step, so without it one bad turn would emit a hundred identical events.
    const guard = { reported: false };
    const guardContext = { agentId, userId: request.userId, mode: request.mode, guard };

    // Checked before the recall is appended, so it judges the history the thread
    // actually has. The recall is an unconditional trailing user turn, which makes any
    // assistant-terminated array provider-valid — checking after it would be the
    // silent fix-up this function exists to refuse.
    warnOnTrailingAssistant(messages, { ...guardContext, stage: 'initial' });

    // A new conversation opens with what the agent recorded in the hours before it,
    // then every turn gets what its message matched in the memory store. Each block is
    // a user turn that follows the question. A run of user messages merges into one
    // provider turn, so the model sees the blocks and the question together.
    //
    // They go after the question rather than before it, because that is where the
    // stored rows sort: the engine writes the user's message before the turn runs.
    // Matching that order is what lets a replayed thread rebuild the prompt that ran.
    //
    // Recorded on chat turns only. The row lets a replayed thread rebuild the prompt
    // that produced its stored answers, which needs the question stored too — and
    // only chat stores it. A goal or a thread-bound cron task appends its prompt at
    // invoke time and never writes it down, so a row there is an orphan block with
    // no question, once per run: one a goal turn, around 288 a day for a
    // five-minute cron task, each replaying into every later chat turn.
    const recordingThreadId = request.mode === 'chat' ? request.threadId : undefined;
    const recent = recordingThreadId ? await buildRecentMemories(context) : null;
    const recalled = await buildRecalledMemories(context, request.prompt, recent?.entryIds);
    const memoryBlocks = [
      ...(recent ? [recentMemoryContent(recent.text)] : []),
      ...(recalled ? [recalledMemoryContent(recalled)] : []),
    ];
    for (const content of memoryBlocks) {
      messages.push({ role: 'user', content });
      if (!recordingThreadId) continue;
      // Best effort: a turn must not fail because a block could not be recorded.
      // The block is in this request either way; only the replay is lost.
      await conversationService
        .addMessage(recordingThreadId, {
          content,
          role: 'USER',
          triggeredBy: 'USER_INPUT',
          internalStep: true,
        })
        .catch((err) => logger.warn({ err }, 'Failed to record a memory block of the turn'));
    }

    // Prompt caching: system prompt parts marked cacheable get cache breakpoints.
    // [0] stable prefix — identity, soul, important memories, instructions. The one
    // system breakpoint: the dynamic part behind it carries only the date, and a
    // change there still hits this one.
    //
    // Bedrock allows 4. The Anthropic Messages path spends 3: this, the last message
    // (via prepareStep) and the last tool. On Converse the fragment is empty for
    // every model, so it spends 0.
    const cachedSystem: SystemModelMessage[] = systemParts.map((part) => ({
      role: 'system' as const,
      content: part.text,
      ...(part.cacheable ? { providerOptions: cachePoint } : {}),
    }));
    // Last message breakpoint is handled by prepareStep below (re-applied each step
    // as messages grow during tool use). No need to set it here — that would leave a
    // stale breakpoint on the original last message, wasting a slot on step 2+.

    logger.info(
      `${context.agentName} in ${request.mode} mode: ${Object.keys(cachedTools).length} tool(s), ${messages.length} message(s)`
    );

    // LLM-call tracing; one metadata set reused across this turn's calls.
    const turnTelemetry = (functionId: string) =>
      langfuseTelemetry(functionId, {
        userId: request.userId,
        sessionId: request.threadId ?? '',
        agentName: context.agentName,
      });

    // 8. Call generateText and yield steps as they complete
    let wasCanceled = false;
    const channel = new AsyncChannel<InvokeStep>();

    // The turn's latest occupancy snapshot and raw token count — `finalize()`
    // drops the service's tracked entry, so these locals are the only
    // post-turn copies. When the model's window is unknown, `record()` returns
    // null (nothing renders) while the raw count is still kept.
    let lastSnapshot: ContextUsageSnapshot | null = null;
    let lastMeasuredTokens: number | null = null;

    // Steering messages already folded into this turn, each pinned to the index
    // it was inserted at. Our injections are not part of the SDK's own message
    // list, so they must be re-spliced each step to stay in the conversation at
    // a stable position.
    const injections: Array<{ at: number; message: ModelMessage }> = [];

    // The turn's request ingredients as a compaction fork (see
    // compaction.service.ts). Shared by the success hook (threshold trigger)
    // and the error hook (overflow recovery), which extend it differently.
    const compactionForkBase = (threadId: string) => ({
      userId: request.userId,
      agentId,
      threadId,
      modelId,
      model,
      cachePoint,
      system: cachedSystem,
      tools: cachedTools,
      declaredTools: Boolean(declared),
      messages,
      injections: injections.map((i) => i.message),
      contextRows: context.recentMessages.map((m) => ({
        id: m.id,
        externalMessageId: m.externalMessageId ?? null,
        internalStep: m.internalStep ?? false,
        contentChars: m.content.length,
      })),
    });


    callModel({ purpose: request.mode, threadId: request.threadId, agentId: request.agentId }, {
      model,
      system: cachedSystem,
      messages: [...messages, ...toolChangeMessages],
      // The SDK refuses a system message inside `messages` without this.
      ...(declared ? { allowSystemInMessages: true } : {}),
      tools: Object.keys(cachedTools).length > 0 ? cachedTools : undefined,
      toolChoice: 'auto',
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      stopWhen: stepCountIs(STEP_LIMIT),
      abortSignal: request.abortSignal,
      ...turnTelemetry(`invoke-${request.mode}`),
      // Fold in any mid-turn steering messages, then re-apply the cache
      // breakpoint on the latest last message so the growing conversation
      // prefix is cached between steps (Bedrock doesn't support automatic
      // caching — only the direct Anthropic API does).
      prepareStep: async ({ initialMessages, responseMessages }) => {
        // Rebuilt from the SDK's discrete pieces, not from the hook's own
        // `messages`: a returned `messages` override is the base for later
        // steps, so `messages` already carries the previous step's injections
        // and cache breakpoint. Splicing onto it duplicates each injection per
        // remaining step and spends a cache block per step.
        const base: ModelMessage[] = [...initialMessages, ...responseMessages];
        // On the first step the turn's tool-change announcements close the
        // array, and no user turn may follow one, so an injection goes before them.
        const insertAt = responseMessages.length === 0
          ? base.length - toolChangeMessages.length
          : base.length;

        // Async so the steering source can load a mid-turn message's files
        // before shaping it — the SDK awaits this hook.
        for (const pending of (await request.steering?.()) ?? []) {
          const files = pending.attachments?.length ? `, ${pending.attachments.length} file(s)` : '';
          logger.info(
            `Steering the in-flight turn with a mid-turn message (${pending.text.length} chars${files})`,
          );
          injections.push({
            at: insertAt,
            message: buildSteeringMessage(pending),
          });
        }

        // Documents view_attachment registered since the last step boundary —
        // pinned at this step's tail so each lands right after the tool
        // result that attached it, then re-spliced every later step like any
        // other injection.
        for (const message of pendingAttachmentInjections.splice(0)) {
          injections.push({ at: insertAt, message });
        }

        // A step boundary is the exact scope: the previous step's tools have all
        // settled and the next step's calls do not exist yet, so nothing can be
        // waiting and nothing can leak across steps.
        pendingFileWrites.clear();

        // Splice highest index first so each injection lands before the
        // step-message it was recorded against, unshifted by the others.
        const merged = [...base];
        for (let i = injections.length - 1; i >= 0; i--) {
          merged.splice(injections[i].at, 0, injections[i].message);
        }

        // The breakpoint goes on the last message that is not a tool-change
        // announcement: the provider sends an announcement without the text
        // block a breakpoint would sit on.
        let stampIdx = merged.length - 1;
        while (stampIdx >= 0 && merged[stampIdx].role === 'system') stampIdx--;
        if (stampIdx >= 0) {
          merged[stampIdx] = {
            ...merged[stampIdx],
            providerOptions: mergeProviderOptions(merged[stampIdx].providerOptions, cachePoint),
          } as ModelMessage;
        }

        warnOnTrailingAssistant(merged, { ...guardContext, stage: 'step' });
        return { messages: merged };
      },
      onStepFinish: (step) => {
        // Convert SDK step to InvokeStep and push to channel.
        //
        // What is stored is the *model-facing* view, not the raw execute() return:
        // the same rendering and the same cut the model saw this turn, so replaying
        // it costs what the live turn cost. Storing raw made the cap a one-turn
        // measure — the whole payload came back uncapped on every later turn — and
        // made replay a different rendering besides, since JSON.stringify keeps an
        // MCP envelope and its escaping while the model was shown the joined text.
        const stepToolCalls: ToolCallRecord[] = [];
        for (const tc of step.toolCalls) {
          const tr = step.toolResults.find((r) => r.toolCallId === tc.toolCallId);
          const riskErrorPart = step.content?.find(
            (part) =>
              part.type === 'tool-error' &&
              part.toolCallId === tc.toolCallId &&
              isToolRiskGateError(part.error),
          );
          const riskError =
            riskErrorPart?.type === 'tool-error' && isToolRiskGateError(riskErrorPart.error)
              ? riskErrorPart.error
              : undefined;
          // An oversized result was already rendered and saved at execute time —
          // reuse that, so the id the model was given is the id on the record.
          const rendered = !tr
            ? undefined
            : isSpilledToolOutput(tr.output)
              ? { text: tr.output.text, truncation: tr.output.truncation }
              : renderToolResultDetailed(tr.output, { toolName: tc.toolName });
          stepToolCalls.push({
            tool: tc.toolName,
            input: JSON.stringify(tc.input),
            // A gate refusal has no tool result to render — the summary of *why*
            // is what the record carries, and it is already small.
            output: rendered
              ? rendered.text
              : riskError
                ? JSON.stringify({
                    error: riskError.message,
                    code: riskError.code,
                    risk: riskError.risk,
                    category: riskError.category,
                  })
                : '',
            success: Boolean(tr),
            timestamp: new Date().toISOString(),
            // Only where a render produced the string. On a gate refusal the output
            // is a hand-built summary and on a failed call it is empty, and neither
            // is a model-facing view — flagging them would have `parseToolCalls`
            // skip the cap on replay if either shape ever grew.
            ...(rendered ? { rendered: true as const } : {}),
            ...(rendered?.truncation ? { truncated: rendered.truncation } : {}),
          });
        }

        const blocks = extractBlocks(step.text);
        const attachmentIds = extractAttachmentIds(step.toolCalls, step.toolResults);
        const usage = toStepUsage(modelId, step.usage);
        const inputTokens = step.usage?.inputTokens;
        const outputTokens = step.usage?.outputTokens;

        // Context occupancy for the context-window indicator. Only for turns
        // bound to a thread: heartbeat, webhook and subagent runs pass no
        // threadId, and their prompt is not any thread's history, so a snapshot
        // would be meaningless. Cheap and synchronous — no I/O here.
        if (request.threadId) {
          lastSnapshot =
            contextUsageService.record({
              userId: request.userId,
              threadId: request.threadId,
              modelId,
              inputTokens,
              outputTokens,
            }) ?? lastSnapshot;
          if (typeof inputTokens === 'number') {
            lastMeasuredTokens = inputTokens + (outputTokens ?? 0);
          }
        }

        channel.push({
          text: step.text,
          toolCalls: stepToolCalls,
          ...(usage ? { usage } : {}),
          blocks,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        });
      },
   }).then(async (result) => {
      // A refusal ends the turn with no text, no tool calls and no error, so
      // nothing downstream has anything to publish. Checked across every step
      // rather than on the final one: a turn that spoke before it declined has
      // already told the user something, and a second message adds nothing.
      if (result.finishReason === 'content-filter'
        && !result.steps.some((step) => step.text.trim().length > 0)) {
        logger.info(`Model declined the request in ${request.mode} mode`);
        trackEvent('invocation refused', request.userId, {
          'invoke.mode': request.mode,
          'agent.id': request.agentId,
        });
        channel.push(buildRefusalStep());
      }

      let earlyStoppingText: string | undefined;

      // 9. If the step limit was reached, make a follow-up call to get a final summary
      if (result.steps.length >= STEP_LIMIT) {
        const assistantText = summarizeSteps(result.steps);
        logger.info(`Step limit (${STEP_LIMIT}) reached, requesting final summary of (${assistantText.length} chars) from the agent`);

        // Mid-turn steering messages ride along in arrival order: they were
        // part of this turn's conversation, but `summarizeSteps` only collapses
        // the model's own steps, so without this the summary would answer the
        // original prompt and silently ignore what the user said since. The
        // pending-injection drain covers a document viewed on the very step
        // that hit the limit — no prepareStep ran after it, so it would
        // otherwise vanish from the summary call.
        const summaryMessages: ModelMessage[] = [
          ...messages,
          ...injections.map((i) => i.message),
          ...pendingAttachmentInjections.splice(0),
          { role: 'assistant' as const, content: assistantText },
          { role: 'user' as const, content: EARLY_STOPPING_PROMPT },
        ];
        warnOnTrailingAssistant(summaryMessages, { ...guardContext, stage: 'early-stopping' });

        const summaryResult = await callModel(
          { purpose: 'early-stopping', threadId: request.threadId, agentId: request.agentId },
          {
          model,
          system: cachedSystem,
          messages: summaryMessages,
          ...(declared ? summaryToolOptions(cachedTools) : {}),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          abortSignal: request.abortSignal,
          ...turnTelemetry('invoke-early-stopping'),
          },
        );

        const earlyStoppingBlocks = extractBlocks(summaryResult.text);
        const summaryUsage = toStepUsage(modelId, summaryResult.usage);
        earlyStoppingText = summaryResult.text;
        channel.push({
          text: summaryResult.text,
          toolCalls: [],
          ...(summaryUsage ? { usage: summaryUsage } : {}),
          blocks: earlyStoppingBlocks,
        });
      }

      // 10. Auto-compaction fork: hand this turn's request ingredients to the
      // compaction service so its summarize call reuses the cached
      // tools+system+history prefix. All trigger policy (threshold, enabled,
      // window plausibility, tail, once-per-exchange) lives in the service —
      // this only fires for thread-bound turns that completed with a
      // measurement and real history. Goal turns are history-less by design
      // (empty recentMessages), and heartbeat/webhook/subagent runs pass no
      // threadId, so both skip here. When the model's window is unknown, a
      // trigger-only fallback window stands in — the meter shows nothing for
      // such models, but the thread must still compact eventually rather than
      // grow until the provider hard-rejects it.
      const triggerSnapshot =
        lastSnapshot ??
        (request.threadId && lastMeasuredTokens !== null
          ? {
              threadId: request.threadId,
              modelId,
              usedTokens: lastMeasuredTokens,
              windowTokens: COMPACTION_FALLBACK_WINDOW_TOKENS,
              usedPercent: Math.min(
                100,
                Math.round((100 * lastMeasuredTokens) / COMPACTION_FALLBACK_WINDOW_TOKENS),
              ),
            }
          : null);
      if (request.threadId && triggerSnapshot && context.recentMessages.length > 0) {
        compactionService.maybeAutoCompact({
          ...compactionForkBase(request.threadId),
          finalAssistantText: [summarizeSteps(result.steps), earlyStoppingText ?? '']
            .filter(Boolean)
            .join('\n\n'),
          snapshot: triggerSnapshot,
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
        ending.cancelled = true;
        channel.close();
        return;
      }
      // Overflow recovery: a turn that outgrew the window never reaches the
      // success hook above, and every later turn rebuilds the same oversized
      // context and rejects again — so this one error class triggers
      // compaction directly. The service shrinks the summarize input until it
      // fits; the friendly error step below still delivers as usual.
      if (request.threadId && context.recentMessages.length > 0 && isContextOverflowError(error)) {
        logger.warn(
          `[Compaction] turn overflowed the context window for thread ${request.threadId}; triggering recovery compaction`,
        );
        compactionService.maybeCompactAfterOverflow(compactionForkBase(request.threadId));
      }
      // Surface the error as a friendly step so consumers don't need a
      // separate error-handling path. buildErrorStep is the single
      // formatter for LLM/runtime errors (budget-aware).
      computerUse.failed = true;
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
      'llm.model': modelId,
      'llm.model_mode': context.modelSelection.mode,
      // A stop during routing reads as a fallback, so a canceled turn reports no reason.
      ...(wasCanceled ? {} : { 'llm.tier_reason': turnModel.reason }),
      ...(turnModel.tier ? { 'llm.tier': turnModel.tier } : {}),
    });

  } finally {
    activity?.end();
    computerService.finish(computerUse);
    // Persist the turn's final context measurement — one write per turn rather
    // than per step. Runs for canceled turns too: the prompt was still built and
    // sent, so the reading is real.
    //
    // In the `finally` so no exit path can leak the service's tracked entry. A
    // consumer that breaks out of the `for await` triggers the generator's
    // return(), which skips everything after `yield* channel` but still runs this
    // block; error and abort paths reach it either way, since both close the
    // channel. finalize() swallows its own persistence failures, so it cannot
    // mask whatever brought us here.
    if (request.threadId) {
      await contextUsageService.finalize({ threadId: request.threadId });
    }
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
  const usage = foldStepUsage(steps.flatMap((s) => (s.usage ? [s.usage] : [])));
  const totalTokens = usage?.totalTokens ?? 0;

  logger.info(
    `${agentName} responded: ${response.length} chars, ${allToolCalls.length} tool call(s), ${totalTokens} token(s)`
  );

  return {
    response,
    toolCalls: allToolCalls,
    ...(allBlocks.length > 0 ? { blocks: allBlocks } : {}),
    ...(allAttachmentIds.length > 0 ? { attachmentIds: allAttachmentIds } : {}),
    ...(usage ? { usage } : {}),
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
 *
 * Every result goes through the limiter, because this text is interpolated into a
 * prompt — the early-stopping summary. `JSON.stringify` on a raw result was already
 * the one path into a model that the cap did not cover, and once an oversized result
 * arrives wrapped, stringifying it would serialize the envelope *and the untouched
 * original inside it*: the whole payload the cut just removed, in a prompt.
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
      const outputStr = isSpilledToolOutput(tr.output)
        ? tr.output.text
        : renderToolResult(tr.output);
      parts.push(`[Result] ${outputStr}`);
    }
    if (step.text) {
      parts.push(step.text);
    }
  }
  return parts.join('\n\n') || '(no output)';
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
  // `unwrapToolOutput` because an oversized result arrives wrapped — the tool's own
  // return travels inside it, which is the whole reason the wrapper keeps it.
  const outputById = new Map(toolResults.map((r) => [r.toolCallId, unwrapToolOutput(r.output)]));
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
