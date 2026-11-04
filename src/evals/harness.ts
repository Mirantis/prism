/**
 * What a prompt eval scenario runs against: the agent a new install creates, the
 * system prompt and tools that `invokeStream` would send for the turn, and the
 * runtime's own gates. A prompt change on a branch is therefore what the eval
 * measures. Tools keep their real descriptions and schemas, but a scenario's stub
 * answers each call, so nothing the model asks for runs on the host.
 *
 * Loaded by `run.ts` after it has pointed the runtime at a scratch database.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { generateText, stepCountIs, type LanguageModelUsage, type Tool } from 'ai';
import { config } from '../config';
import { MAX_OUTPUT_TOKENS } from '../constants';
import { callModel } from '../lib/model-call';
import { getGateRequest } from '../lib/classification';
import { createProvider } from '../lib/llm-providers/create-provider';
import { cacheRequestOptions, cacheTtlFor } from '../lib/llm-providers/llm-provider';
import { collectTools, withToolsCacheControl } from '../lib/tool-collection';
import { withToolOutputCapture } from '../lib/tool-output-limiter';
import { evaluateToolRisk } from '../lib/tool-risk-gate';
import { selectTurnModel } from '../lib/model-routing';
import type { ModelTier } from '../lib/model-selection';
import { agentWorkspaceService, resolveEffectiveModel } from '../services/agent-workspace.service';
import type { AttachmentMeta } from '../services/attachment.service';
import { contextService } from '../services/context.service';
import type { PostingCeiling } from '../services/delivery-target.service';
import { llmCallService } from '../services/llm-call.service';
import { decideThreadAction, type GateAgent, type ThreadLine } from '../services/thread-reply-classifier.service';
import { buildTurnRequest } from '../invoke';
import { COMPUTER_INSTRUCTIONS } from '../prompts/computer-prompt';
import { getComputerTools } from '../tools/computer';
import {
  buildConversationHistory,
  buildSystemPromptParts,
  type ConversationMessage,
} from '../prompts/context-builder';
import { COMPACTION_PROMPT } from '../prompts/compaction-prompt';
import { scheduledRunPrompt } from '../prompts/scheduled-run-prompt';
import { HEARTBEAT_PROMPT } from '../services/heartbeat.service';
import { agentMessageColumns } from '../prompts/agent-message-prompt';
import { TASK_NOTIFICATION_COLUMNS } from '../prompts/task-notification-prompt';
import type { AgentContext, AgentMessageOrigin, HeartbeatTrigger, InvokeRequest, PromptSource, TaskLastSend } from '../types';
import type { ChatPlatform } from '../services/channel-adapter.interface';
import { slackChannelLabel } from '../utils/slack-formatter';
import { teamsChannelLabel } from '../utils/teams-formatter';
import { planToolSearch } from '../lib/tool-search/plan';
import { WEB_CHAT_LABEL } from '../services/web-chat-label';

export const EVAL_USER_ID = 'eval-user';
/** The agent every scenario runs as: the one `AGENT_ID` names, which `run.ts` sets. */
export const EVAL_AGENT_ID = config.agentId as string;
/** A second agent with one subagent, so only the scenarios that ask for it get the Task tool. */
const PARENT_AGENT_ID = '0e7a1000-0000-4000-8000-000000000002';
const SUBAGENT_ID = '0e7a1000-0000-4000-8000-000000000003';
export const SUBAGENT_NAME = 'investigator';
const EVAL_THREAD_ID = '0e7a1000-0000-4000-8000-000000000004';

/** How each chat platform's adapter names a channel in the system prompt. */
const CHANNEL_LABEL: Record<ChatPlatform, (channelName: string) => string> = {
  slack: slackChannelLabel,
  teams: teamsChannelLabel,
};

/** Create the agents the scenarios run as: default templates, onboarding finished. */
export async function createEvalAgents(): Promise<void> {
  const base = { userId: EVAL_USER_ID, teamName: 'Platform' };
  await agentWorkspaceService.createAgent({ ...base, id: EVAL_AGENT_ID, name: 'Atlas', agentType: 'AGENT' });
  await agentWorkspaceService.createAgent({ ...base, id: PARENT_AGENT_ID, name: 'Atlas', agentType: 'AGENT' });
  await agentWorkspaceService.createAgent({
    ...base,
    id: SUBAGENT_ID,
    name: SUBAGENT_NAME,
    agentType: 'SUBAGENT',
  });
  await agentWorkspaceService.addSubagent(
    PARENT_AGENT_ID,
    SUBAGENT_ID,
    'Investigates production incidents from logs, metrics and recent deploys.',
  );
  // A new agent starts in its onboarding script; the scenarios are about an agent in use.
  await agentWorkspaceService.writeWorkspaceDoc({
    agentId: EVAL_AGENT_ID,
    field: 'bootstrapMd',
    content: '',
    actor: 'agent',
    method: 'clear',
    reason: 'Onboarding finished.',
  });
}

/** The agent's context as `invokeStream` reads it, with `history` as its thread. */
export async function agentContext(history: HistoryEntry[] = []): Promise<AgentContext> {
  const context = await contextService.getAgentContext(EVAL_USER_ID, {
    agentId: EVAL_AGENT_ID,
    includeConversation: false,
  });
  context.recentMessages = history.map(toStoredMessage);
  return context;
}

// ---------------------------------------------------------------------------
// Per-sample accounting
// ---------------------------------------------------------------------------

interface SampleCalls {
  inputTokens: number;
  outputTokens: number;
}

const sampleCalls = new AsyncLocalStorage<SampleCalls>();

/**
 * Every runtime model call goes through `callModel`, which reports it to
 * `llmCallService`. The eval reads that report instead of writing it, and counts
 * each sample's tokens.
 */
llmCallService.record = (input) => {
  const calls = sampleCalls.getStore();
  if (!calls) return;
  addUsage(calls, input.usage);
};

function addUsage(calls: SampleCalls, usage: LanguageModelUsage | undefined): void {
  calls.inputTokens += usage?.inputTokens ?? 0;
  calls.outputTokens += usage?.outputTokens ?? 0;
}

/** Run one attempt at a sample with its own call accounting, which a failed attempt keeps too. */
export async function withSampleAccounting<T>(
  run: () => Promise<T>,
): Promise<{ outcome: { value: T } | { error: unknown }; inputTokens: number; outputTokens: number }> {
  const calls: SampleCalls = { inputTokens: 0, outputTokens: 0 };
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await sampleCalls.run(calls, run) };
  } catch (error) {
    outcome = { error };
  }
  return { outcome, inputTokens: calls.inputTokens, outputTokens: calls.outputTokens };
}

// ---------------------------------------------------------------------------
// A turn of the agent
// ---------------------------------------------------------------------------

/** One stored message of the thread a scenario starts from. */
export type HistoryEntry =
  | { user: string; attachments?: AttachmentMeta[]; sender?: { id: string; name: string } }
  /** A message from another agent of the project. */
  | { fromAgent: AgentMessageOrigin; text: string }
  /** The runtime's report that a coding task ended, as the engine stores it. */
  | { taskNotification: string }
  | {
      agent: string;
      toolCalls?: { tool: string; input: unknown; output: unknown }[];
      /** The webhook subscription that delivered the message. */
      webhook?: string;
    };

/** What a tool call returns in the eval. Gets the call's input. */
type ToolStub = (input: Record<string, unknown>) => unknown;

interface TurnInput {
  mode: 'chat' | 'heartbeat' | 'cron' | 'webhook';
  /** The thread so far. A chat thread ends with the user's message, as the engine stores it first. */
  history?: HistoryEntry[];
  /** The prompt of a heartbeat, cron or webhook run, appended as `invokeStream` appends it. */
  prompt?: string;
  /** A channel turn instead of a direct message. */
  channel?: { name: string; platform: ChatPlatform };
  /** A web chat turn in a conversation that several people wrote in. */
  webChat?: boolean;
  /** Run as the agent that has a subagent, so the Task tool and its block are sent. */
  withSubagent?: boolean;
  /** Results for named tools. Any other tool returns a plain success. */
  stubs?: Record<string, ToolStub>;
  /** Model steps before the turn stops. One step answers "what does the model do first". */
  maxSteps?: number;
  /** Give the agent its computer, tools and instructions, also on a host without a desktop. */
  computer?: boolean;
  /** Tools a host adds beside the built-ins, such as a connector's. Stubbed like the rest. */
  extraTools?: Record<string, Tool>;
  /** What a recurring task's earlier runs sent, as the scheduler gives an unbound cron run. */
  lastSend?: TaskLastSend;
  /** Fields a run's service sets on the agent's context, such as the heartbeat's checks. */
  context?: Partial<AgentContext>;
  /** Where a heartbeat, unbound scheduled-task or webhook run may post, as its service sets it. */
  postingCeiling?: PostingCeiling;  /** The channel messages that started a heartbeat. */
  heartbeatTriggers?: HeartbeatTrigger[];
  /** A turn bound to a stored conversation, for the tools only such a turn gets. */
  threadId?: string;
}

export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  step: number;
}

export interface TurnTrace {
  calls: ToolCallRecord[];
  /** The last step's text: what a concise-mode turn delivers. */
  text: string;
  /** False when the step cap ended the turn on a tool call, before the model replied. */
  finished: boolean;
}

/**
 * The reply a turn delivered. A turn cut off by its step cap has none, and grading
 * its empty text would pass a scenario on nothing, so it fails the attempt instead.
 */
export function replyOf(trace: TurnTrace): string {
  if (!trace.finished) throw new Error(`The turn was still calling tools at its step cap: ${trace.calls.length} call(s).`);
  return trace.text;
}

/**
 * Run one turn the way `invokeStream` builds it: the agent's context, the mode's
 * tools, and the system prompt and messages from `buildTurnRequest`.
 */
export async function runTurn(input: TurnInput): Promise<TurnTrace> {
  const context = await agentContext(input.history);
  context.lastSend = input.lastSend;
  context.postingCeiling = input.postingCeiling;
  Object.assign(context, input.context);
  const agentId = input.withSubagent ? PARENT_AGENT_ID : EVAL_AGENT_ID;
  const modelId = resolveEffectiveModel(context.model);
  const provider = createProvider();
  const cachePoint = provider.cachePoint(modelId, cacheTtlFor(input.mode));

  const collected = await collectTools({
    userId: EVAL_USER_ID,
    agentId,
    mode: input.mode,
    // A chat turn always has its conversation, which the chat-only tools report to.
    threadId: input.threadId ?? (input.mode === 'chat' ? EVAL_THREAD_ID : undefined),
    originChannel: input.channel?.platform ?? 'websocket',
    postingCeiling: input.postingCeiling,
    taskInvoker: async () => {
      throw new Error('The eval stubs the Task tool.');
    },
    lockedIn: context.lockedIn,
  });
  const { subagents } = collected;
  const toolSearch = await planToolSearch({
    tools: collected.tools,
    deferrable: collected.deferrable,
    protocol: provider.deferredTools?.(modelId),
    modelId,
    telemetry: { userId: EVAL_USER_ID, agentId, mode: input.mode },
  });
  const { tools } = toolSearch;

  const request: InvokeRequest = {
    userId: EVAL_USER_ID,
    agentId,
    mode: input.mode,
    prompt: input.prompt ?? '',
    ...(input.heartbeatTriggers ? { heartbeatTriggers: input.heartbeatTriggers } : {}),
    ...(input.channel ? { channelLabel: CHANNEL_LABEL[input.channel.platform](input.channel.name) } : {}),
    ...(input.webChat ? { channelLabel: WEB_CHAT_LABEL } : {}),
  };
  const { systemParts: parts, messages } = await buildTurnRequest(context, request, subagents, undefined, toolSearch);
  const systemParts =
    input.computer && !parts.some((part) => part.text.includes(COMPUTER_INSTRUCTIONS))
      ? [{ text: COMPUTER_INSTRUCTIONS, cacheable: false }, ...parts]
      : parts;
  const turnTools = { ...tools, ...(input.computer ? getComputerTools() : {}), ...input.extraTools };

  const result = await callModel(
    { purpose: input.mode, agentId },
    {
      model: provider(modelId),
      system: systemParts.map((part) => ({
        role: 'system' as const,
        content: part.text,
        ...(part.cacheable ? { providerOptions: cachePoint } : {}),
      })),
      messages,
      tools: withToolsCacheControl(withToolOutputCapture(stubTools(turnTools, input.stubs ?? {})), cachePoint),
      toolChoice: 'auto',
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      providerOptions: cacheRequestOptions(provider, modelId, cacheTtlFor(input.mode)),
      stopWhen: stepCountIs(input.maxSteps ?? 1),
    },
  );

  return {
    calls: result.steps.flatMap((step, index) =>
      step.toolCalls.map((call) => ({
        tool: call.toolName,
        input: (call.input ?? {}) as Record<string, unknown>,
        step: index + 1,
      })),
    ),
    text: result.text,
    finished: result.finishReason !== 'tool-calls',
  };
}

/** The real tools block, with each tool's execution replaced by a stub. */
function stubTools(tools: Record<string, Tool>, stubs: Record<string, ToolStub>): Record<string, Tool> {
  const stubbed: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const stub = stubs[name] ?? defaultStub(name);
    stubbed[name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (input: unknown) => stub((input ?? {}) as Record<string, unknown>),
    } as Tool;
  }
  return stubbed;
}

/** What a tool returns when its scenario names no result: the shape of a plain success. */
const DEFAULT_STUBS: Record<string, ToolStub> = {
  shell_exec: () => ({ stdout: '', stderr: '', exitCode: 0 }),
  memory_search: () => ({ success: true, count: 0, results: [] }),
  schedule_task: (input) => ({
    success: true,
    taskId: 'task-eval-1',
    message: `Scheduled "${String(input.name)}" with schedule: ${String(input.schedule)}`,
    schedule: input.schedule,
  }),
};

function defaultStub(name: string): ToolStub {
  return DEFAULT_STUBS[name] ?? (() => ({ success: true }));
}

/** A history entry as `contextService` reads it from the database. */
function toStoredMessage(entry: HistoryEntry, index: number): ConversationMessage {
  const id = `eval-message-${index + 1}`;
  if ('user' in entry) {
    return {
      id,
      role: 'USER',
      content: entry.user,
      attachments: entry.attachments,
      senderExternalId: entry.sender?.id ?? null,
      senderName: entry.sender?.name ?? null,
    };
  }
  if ('fromAgent' in entry) {
    return { id, role: 'USER', content: entry.text, ...agentMessageColumns(entry.fromAgent) };
  }
  if ('taskNotification' in entry) {
    return { id, role: 'USER', content: entry.taskNotification, ...TASK_NOTIFICATION_COLUMNS };
  }
  return {
    id,
    role: 'AGENT',
    content: entry.agent,
    triggerName: entry.webhook ?? null,
    toolCalls: entry.toolCalls?.map((call) => ({
      tool: call.tool,
      input: call.input,
      output: typeof call.output === 'string' ? call.output : JSON.stringify(call.output),
      rendered: true,
    })),
  };
}

// ---------------------------------------------------------------------------
// The tool risk gate
// ---------------------------------------------------------------------------

/**
 * The tool risk gate's decision on one call, with the tool's real description and
 * the agent's own guide as the policy.
 */
export async function toolRiskDecision(input: {
  mode: 'chat' | 'heartbeat';
  prompt: string;
  /** Who wrote the prompt, as a turn's engine sets it; absent is the person. */
  promptSource?: PromptSource;
  /** The person's earlier messages in the thread, oldest first. */
  earlier?: string[];
  tool: string;
  input: Record<string, unknown>;
}): Promise<'allow' | 'block'> {
  const context = await agentContext();
  const { tools } = await collectTools({
    userId: EVAL_USER_ID,
    agentId: EVAL_AGENT_ID,
    mode: input.mode,
    taskInvoker: async () => {
      throw new Error('The eval stubs the Task tool.');
    },
    lockedIn: context.lockedIn,
  });
  const tool = tools[input.tool];
  if (!tool) throw new Error(`No tool named ${input.tool} in ${input.mode} mode.`);

  const decision = await evaluateToolRisk({
    toolName: input.tool,
    toolDescription: typeof tool.description === 'string' ? tool.description : undefined,
    input: input.input,
    invocationMode: input.mode,
    initialPrompt: input.prompt,
    initialPromptSource: input.promptSource,
    messages: [...(input.earlier ?? []), input.prompt].map((content) => ({ role: 'user' as const, content })),
    agentGuide: context.agentMd,
    userId: EVAL_USER_ID,
    agentId: EVAL_AGENT_ID,
  });
  return decision.decision;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * The summary a compaction of `history` writes: the chat system prompt and the thread,
 * then the compaction prompt, as `compactionService` sends them. The tools block is
 * left out, since the summary call may not use a tool and the prefix cache is no
 * concern here. Throws on a summary cut off at the output budget, which the runtime
 * refuses too.
 */
export async function summarizeThread(history: HistoryEntry[]): Promise<string> {
  const context = await agentContext(history);
  const modelId = resolveEffectiveModel(context.model);
  const system = (await buildSystemPromptParts(context, 'chat')).map((part) => ({
    role: 'system' as const,
    content: part.text,
  }));
  const result = await callModel(
    { purpose: 'compaction', agentId: EVAL_AGENT_ID },
    {
      model: createProvider()(modelId),
      system,
      messages: [...buildConversationHistory(context).messages, { role: 'user', content: COMPACTION_PROMPT }],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  );
  if (result.finishReason === 'length') throw new Error('The summary was cut off at the output limit.');
  return result.text;
}

// ---------------------------------------------------------------------------
// The thread reply gate
// ---------------------------------------------------------------------------

const PLATFORM_NAME: Record<ChatPlatform, string> = { slack: 'Slack', teams: 'Microsoft Teams' };

/**
 * The thread reply classifier's verdict on the last of `lines`. Throws when the
 * call fails, since the adapters answer a failure with `respond`.
 */
export async function threadGateAction(
  platform: ChatPlatform,
  agent: GateAgent,
  lines: ThreadLine[],
): Promise<'respond' | 'ignore'> {
  const { action } = await decideThreadAction({
    platform: { channel: platform, name: PLATFORM_NAME[platform] },
    agentId: EVAL_AGENT_ID,
    agent,
    lines,
  });
  return action;
}

// ---------------------------------------------------------------------------
// The model grader
// ---------------------------------------------------------------------------

/**
 * Ask the classification model a yes-or-no question about a reply. Only for a
 * behaviour that no string check can grade; the rubric lives with its scenario.
 * The call is the eval's own, not runtime spend, so it does not go through
 * `callModel`. An answer that is neither YES nor NO fails the attempt.
 */
export async function judge(rubric: string, reply: string): Promise<boolean> {
  const { model, providerOptions, samplingParams } = getGateRequest();
  const result = await generateText({
    model,
    providerOptions,
    ...samplingParams,
    maxOutputTokens: 16,
    system: 'You grade a reply that an AI agent gave its user. Answer with one word: YES or NO.',
    // The question goes after the reply: asked in the system prompt instead, the
    // classification model answered NO to a reply that plainly said YES.
    messages: [{ role: 'user', content: `<reply>\n${reply}\n</reply>\n\n${rubric}` }],
  });
  const calls = sampleCalls.getStore();
  if (calls) addUsage(calls, result.usage);
  const answer = result.text.trim().toUpperCase().replace(/\.$/, '');
  if (answer !== 'YES' && answer !== 'NO') throw new Error(`The grader answered "${result.text.trim()}".`);
  return answer === 'YES';
}

/**
 * The tier Auto model selection picks for a request, offered `tiers`, with
 * `history` as the thread so far. A chat request is the prompt; a scheduled one
 * is wrapped as for a task without a thread; a heartbeat's is its checks,
 * which the classifier reads in place of the fixed heartbeat prompt. Throws
 * when the classifier call fails, since a failure runs the large tier and would
 * pass a scenario that expects it.
 */
export async function routeTier(
  request: string,
  options: { history?: HistoryEntry[]; tiers?: ModelTier[]; mode?: 'chat' | 'heartbeat' | 'cron' } = {},
): Promise<ModelTier> {
  const mode = options.mode ?? 'chat';
  const prompt =
    mode === 'heartbeat' ? HEARTBEAT_PROMPT : mode === 'cron' ? scheduledRunPrompt(request) : request;
  const context = await agentContext([...(options.history ?? []), ...(mode === 'chat' ? [{ user: prompt }] : [])]);
  if (mode === 'heartbeat') context.heartbeatMd = request;
  const offered = options.tiers ?? ['small', 'large'];
  const tierModel = (tier: ModelTier) => `eval-${tier}-model`;
  context.modelSelection = {
    mode: 'auto',
    tiers: {
      small: offered.includes('small') ? tierModel('small') : null,
      medium: offered.includes('medium') ? tierModel('medium') : null,
      large: offered.includes('large') ? tierModel('large') : null,
    },
  };
  const choice = await selectTurnModel(
    context,
    { mode, prompt, userId: EVAL_USER_ID, agentId: EVAL_AGENT_ID },
    createProvider(),
  );
  if (choice.reason !== 'classified' || !choice.tier) {
    throw new Error(`Routing did not classify the request (${choice.reason}).`);
  }
  return choice.tier;
}

/** The models a run uses, for the report. */
export function modelsInUse(): { provider: string; chat: string; classification: string } {
  return {
    provider: config.llmProvider,
    chat: resolveEffectiveModel(null),
    classification: config.classificationModelId,
  };
}
