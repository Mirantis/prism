/**
 * What a prompt eval scenario runs against: the agent a new install creates, the
 * system prompt and tools the backend would send for the turn, and the backend's own
 * gates, all through `prism-server eval` (see `backend.ts`). A prompt change on a
 * branch is therefore what the eval measures. Tools keep their real descriptions and
 * schemas, but a scenario's stub answers each call, so nothing the model asks for runs
 * on the host.
 *
 * `run.ts` connects the backend with `connect` before any scenario runs.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Backend, Usage } from './backend';
import type {
  AgentMessageOrigin,
  AttachmentMeta,
  ChatPlatform,
  CodingTaskOutcome,
  GateAgent,
  HeartbeatTrigger,
  LinkedTarget,
  ModelTier,
  PostingCeiling,
  PromptSize,
  PromptSource,
  TaskLastSend,
  ThreadLine,
  ToolDefinition,
} from './types';

export const EVAL_USER_ID = 'eval-user';
/** The agent every scenario runs as, set as `AGENT_ID`. */
export const EVAL_AGENT_ID = '0e7a1000-0000-4000-8000-000000000001';
export const SUBAGENT_NAME = 'investigator';
const EVAL_THREAD_ID = '0e7a1000-0000-4000-8000-000000000004';

/** Texts of the backend that the scenarios quote. */
export interface BackendTexts {
  heartbeatPrompt: string;
  alertTheUser: string;
  defaultHeartbeatMd: string;
  /** What `ask_questions` answers once the card is posted. */
  askQuestionsResult: Record<string, unknown>;
  /** What `show_ui` answers once the UI passed every check. */
  showUiResult: Record<string, unknown>;
  /** The component reference `ui_reference` returns. */
  uiReference: string;
  /** What `coding_agent` tells the agent to do after it starts a task in a chat conversation. */
  notifiedTaskNext: string;
  monitorNext: string;
}

interface BackendInfo {
  provider: string;
  chatModel: string;
  classificationModel: string;
  texts: BackendTexts;
}

let backend: Backend | undefined;
let info: BackendInfo | undefined;

/** Use `connected` for every call, and read the run's models and texts. */
export async function connect(connected: Backend): Promise<void> {
  backend = connected;
  info = (await connected.request<BackendInfo>('info')).result;
}

function backendOf(): Backend {
  if (!backend) throw new Error('The eval backend is not connected.');
  return backend;
}

/** The texts the scenarios quote, read once `connect` has run. */
export function texts(): BackendTexts {
  if (!info) throw new Error('The eval backend is not connected.');
  return info.texts;
}

/** The models a run uses, for the report. */
export function modelsInUse(): { provider: string; chat: string; classification: string } {
  if (!info) throw new Error('The eval backend is not connected.');
  return { provider: info.provider, chat: info.chatModel, classification: info.classificationModel };
}

// ---------------------------------------------------------------------------
// Per-sample accounting
// ---------------------------------------------------------------------------

const sampleCalls = new AsyncLocalStorage<Usage>();

function addUsage(usage: Usage | undefined): void {
  const calls = sampleCalls.getStore();
  if (!calls || !usage) return;
  calls.inputTokens += usage.inputTokens;
  calls.outputTokens += usage.outputTokens;
}

/** One backend operation, its model calls counted toward the running sample. */
async function call<T>(op: string, params: unknown = {}, onTool?: (tool: string, input: Record<string, unknown>) => unknown): Promise<T> {
  try {
    const { result, usage } = await backendOf().request<T>(op, params, onTool);
    addUsage(usage);
    return result;
  } catch (error) {
    addUsage((error as { usage?: Usage }).usage);
    throw error;
  }
}

/** Run one attempt at a sample with its own call accounting, which a failed attempt keeps too. */
export async function withSampleAccounting<T>(
  run: () => Promise<T>,
): Promise<{ outcome: { value: T } | { error: unknown }; inputTokens: number; outputTokens: number }> {
  const calls: Usage = { inputTokens: 0, outputTokens: 0 };
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await sampleCalls.run(calls, run) };
  } catch (error) {
    outcome = { error };
  }
  return { outcome, inputTokens: calls.inputTokens, outputTokens: calls.outputTokens };
}

/** Create the agents the scenarios run as: default templates, onboarding finished. */
export async function createEvalAgents(): Promise<void> {
  await call('setup');
}

/** The size of the chat system prompt and of the built-in tools' descriptions. */
export async function measurePromptSize(): Promise<PromptSize> {
  return call<PromptSize>('promptSize');
}

// ---------------------------------------------------------------------------
// The backend's prompt texts and delivery rule
// ---------------------------------------------------------------------------

/** A scheduled task's run prompt, with what the task's earlier runs sent. */
export function scheduledRunPrompt(instruction: string, lastSend?: TaskLastSend): Promise<string> {
  return call<string>('render', { kind: 'scheduledRun', instruction, lastSend });
}

/** Another agent's message as the model reads it. */
export function renderAgentMessage(origin: AgentMessageOrigin, text: string): Promise<string> {
  return call<string>('render', { kind: 'agentMessage', origin, text });
}

/** The runtime's report that a coding task ended, as the engine stores it. */
export function renderCodingTaskNotification(outcome: CodingTaskOutcome): Promise<string> {
  return call<string>('render', { kind: 'codingTaskNotification', outcome });
}

/** A heartbeat's run prompt, with the channel messages that started it. */
export function heartbeatRunPrompt(triggers?: HeartbeatTrigger[]): Promise<string> {
  return call<string>('render', { kind: 'heartbeat', triggers });
}

/** A webhook event's run prompt. */
export function webhookRunPrompt(
  instruction: string,
  payload: Record<string, unknown>,
  eventType: string,
  route: string,
): Promise<string> {
  return call<string>('render', { kind: 'webhook', instruction, payload, eventType, route });
}

/** The places a delivery setting allows over the given linked targets. */
export function postingCeiling(
  target: { deliverTo: string; channelIds: string[] },
  linked: LinkedTarget[],
): Promise<PostingCeiling> {
  return call<PostingCeiling>('ceiling', { target, linked });
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
  /** The prompt of a heartbeat, cron or webhook run, appended as a run appends it. */
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
  extraTools?: Record<string, ToolDefinition>;
  /** What a recurring task's earlier runs sent, as the scheduler gives an unbound cron run. */
  lastSend?: TaskLastSend;
  /** Fields a run's service sets on the agent's context, such as the heartbeat's checks. */
  context?: { heartbeatMd?: string };
  /** Where a heartbeat, unbound scheduled-task or webhook run may post, as its service sets it. */
  postingCeiling?: PostingCeiling;
  /** The channel messages that started a heartbeat. */
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

/** A history entry as the backend reads it from the database. */
function toStoredMessage(entry: HistoryEntry, index: number): Record<string, unknown> {
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
    return {
      id,
      role: 'USER',
      content: entry.text,
      triggeredBy: 'AGENT_MESSAGE',
      triggerName: entry.fromAgent.kind,
      senderExternalId: entry.fromAgent.senderId,
      senderName: entry.fromAgent.senderName,
      externalMessageId: entry.fromAgent.messageId,
    };
  }
  if ('taskNotification' in entry) {
    return { id, role: 'USER', content: entry.taskNotification, triggeredBy: 'TASK_NOTIFICATION', internalStep: true };
  }
  return {
    id,
    role: 'AGENT',
    content: entry.agent,
    triggerName: entry.webhook ?? null,
    toolCalls: entry.toolCalls?.map((toolCall) => ({
      tool: toolCall.tool,
      input: toolCall.input,
      output: typeof toolCall.output === 'string' ? toolCall.output : JSON.stringify(toolCall.output),
      rendered: true,
    })),
  };
}

/**
 * Run one turn the way the backend builds it: the agent's context, the mode's tools,
 * and the system prompt and messages. Each tool call is answered by the scenario's stub.
 */
export async function runTurn(input: TurnInput): Promise<TurnTrace> {
  const stubs = input.stubs ?? {};
  const extraTools = Object.entries(input.extraTools ?? {}).map(([name, definition]) => ({
    name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  }));
  return call<TurnTrace>(
    'turn',
    {
      mode: input.mode,
      history: (input.history ?? []).map(toStoredMessage),
      prompt: input.prompt ?? '',
      channel: input.channel,
      webChat: input.webChat ?? false,
      withSubagent: input.withSubagent ?? false,
      maxSteps: input.maxSteps,
      computer: input.computer ?? false,
      extraTools,
      lastSend: input.lastSend,
      context: input.context ?? {},
      postingCeiling: input.postingCeiling,
      heartbeatTriggers: input.heartbeatTriggers,
      // A chat turn always has its conversation, which the chat-only tools report to.
      threadId: input.threadId ?? (input.mode === 'chat' ? EVAL_THREAD_ID : undefined),
    },
    (tool, toolInput) => (stubs[tool] ?? DEFAULT_STUBS[tool] ?? (() => ({ success: true })))(toolInput),
  );
}

// ---------------------------------------------------------------------------
// The gates and the compaction
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
  return call<'allow' | 'block'>('riskGate', input);
}

/**
 * The summary a compaction of `history` writes: the chat system prompt and the thread,
 * then the compaction prompt. Throws on a summary cut off at the output budget, which
 * the backend refuses too.
 */
export async function summarizeThread(history: HistoryEntry[]): Promise<string> {
  return call<string>('summarize', { history: history.map(toStoredMessage) });
}

/**
 * The thread reply classifier's verdict on the last of `lines`. Throws when the
 * call fails, since the adapters answer a failure with `respond`.
 */
export async function threadGateAction(
  platform: ChatPlatform,
  agent: GateAgent,
  lines: ThreadLine[],
): Promise<'respond' | 'ignore'> {
  return call<'respond' | 'ignore'>('threadGate', { platform, agent, lines });
}

/**
 * Ask the classification model a yes-or-no question about a reply. Only for a
 * behaviour that no string check can grade; the rubric lives with its scenario.
 * An answer that is neither YES nor NO fails the attempt.
 */
export async function judge(rubric: string, reply: string): Promise<boolean> {
  const text = await call<string>('judge', { rubric, reply });
  const answer = text.trim().toUpperCase().replace(/\.$/, '');
  if (answer !== 'YES' && answer !== 'NO') throw new Error(`The grader answered "${text.trim()}".`);
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
  return call<ModelTier>('route', {
    request,
    history: (options.history ?? []).map(toStoredMessage),
    tiers: options.tiers,
    mode: options.mode,
  });
}

/** `text` on one line, cut to `max` characters for a detail line. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
