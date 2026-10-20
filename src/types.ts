/**
 * Agent Runtime Types
 *
 * Request/response contracts for the agent runtime.
 */

import { ConversationMessage, SteeringMessage } from './prompts/context-builder';
import { ToolLifecycleListener } from './lib/tool-lifecycle';
import type { ChannelName } from './services/channel-adapter.interface';
import type { ModelSelection } from './lib/model-selection';

// ============================================================================
// Agent Status
// ============================================================================

export type AgentHeartbeatStatus = 'ENABLED' | 'STOPPED';

// ============================================================================
// Context (fetched from backend internal API)
// ============================================================================

export interface AgentContext {
  soulMd: string;
  userMd: string;
  memoryMd: string;
  heartbeatMd: string;
  bootstrapMd: string;
  visionMd: string;
  agentMd: string;
  agentName: string;
  agentId: string;
  userId: string;
  model: string | null;
  /** Heartbeat-specific model override; falls back to `model`, then env default. */
  heartbeatModel: string | null;
  /** Cron/scheduled-task model override; falls back to `model`, then env default. */
  cronModel: string | null;
  /** Fixed or Auto, with the Auto tiers; deployment defaults already applied. */
  modelSelection: ModelSelection;
  /** When false, only the final text step is delivered to the channel. */
  verbose: boolean;
  /**
   * When true, the workspace markdown files are read-only: the tools that write
   * them are withheld from the tool set and their writes refused. A snapshot for
   * prompt-building and tool collection; `agentWorkspaceService.isLockedIn()`
   * re-reads the flag at write time.
   */
  lockedIn: boolean;
  isBootstrapPhase: boolean;
  conversationSummary: string | null;
  recentMessages: ConversationMessage[];
  lastHeartbeatAlert?: string;
  lastHeartbeatAlertAt?: number;
  /** What a recurring task's runs sent and reported since, for a run that reads no history. */
  lastSend?: TaskLastSend;
  /** Per-turn runtime events surfaced authoritatively in the system prompt. */
  runtimeNotices?: string[];
}

// ============================================================================
// Invoke Request (used by queue worker, heartbeat, cron, subagent)
// ============================================================================

/** A message a channel queued to start the heartbeat. */
export interface ChannelTriggerMessage {
  sender: string;
  text: string;
  timestamp: string;
}

/** The messages one channel queued since the last heartbeat. */
export interface HeartbeatTrigger {
  /** How the prompt names the channel's platform. */
  platform: string;
  messages: ChannelTriggerMessage[];
}

export interface InvokeRequest {
  userId: string;
  agentId: string;
  mode: 'chat' | 'heartbeat' | 'cron' | 'subagent' | 'goal' | 'webhook';
  prompt: string;
  threadId?: string;
  /** Override the agent's persisted verbose flag for this invocation. */
  verbose?: boolean;
  /**
   * Optional per-thread workspace root for shell tools' cwd. When unset, shell
   * tools fall back to the global SHELL_WORKSPACE_ROOT (see `resolveWorkspace`).
   */
  workspaceRoot?: string;
  /**
   * Originating channel of this turn, threaded through so the `create_goal`
   * tool can record where to deliver a goal's autonomous turns. Defaults to
   * 'websocket' when unset.
   */
  originChannel?: ChannelName;
  originChannelId?: string;
  /**
   * The shared channel this turn's message was posted in, as the system prompt
   * names it, with what the agent sees and how it addresses people there. Set,
   * the prompt gets the channel participation guidelines.
   */
  channelLabel?: string;
  /**
   * The run's final message goes to the main channel and the user's DMs, so
   * `send_message` refuses those as targets.
   */
  broadcastsOutput?: boolean;
  /** The one conversation the run's final message goes to, so `send_message` refuses it as a target. */
  outputDestination?: { platform: ChannelName; conversationId: string };
  lastHeartbeatAlert?: string;
  lastHeartbeatAlertAt?: number;
  /** What a recurring task's runs sent and reported since, for a run that reads no history. */
  lastSend?: TaskLastSend;
  /** Messages that channels queued for this heartbeat, one entry per channel. */
  heartbeatTriggers?: HeartbeatTrigger[];
  /**
   * Transient, authoritative notices about events that occurred while
   * preparing this turn (e.g. an attachment that failed to download). Injected
   * into the system prompt — the model follows these far more reliably than
   * text embedded in the user message.
   */
  runtimeNotices?: string[];
  /**
   * When provided, aborting this signal stops the in-flight LLM generation
   * (the underlying Bedrock request is cancelled). Threaded into both
   * generateText() calls. On abort, invokeStream closes the step stream
   * without surfacing an error step — already-completed steps are preserved.
   */
  abortSignal?: AbortSignal;
  /**
   * Mid-turn steering source, awaited at every step boundary. Each message it
   * returns is appended to the message array as a user turn — text and any files
   * alike — so a message the user sent while this turn was running reaches the
   * model on its next step instead of waiting for a turn of its own (see
   * `threadTurnService`). Async so the source can load attachment bytes.
   */
  steering?: () => Promise<SteeringMessage[]>;
  /**
   * Called once the turn has read the thread's history, with the rows it read. A
   * message handed to the turn that is among them, with all of its files, reaches
   * the model through history, so it must not be injected again by `steering`.
   */
  onHistoryRead?: (rows: ReadonlyArray<ConversationMessage>) => void;
  /**
   * Fired around each tool execution (started/completed).
   * Purely observational; listener errors never affect the turn.
   */
  onToolEvent?: ToolLifecycleListener;
  /**
   * Append `prompt` as the final user message even in chat mode, where the
   * prompt normally arrives via history (the conversation engine stores it
   * before invoking).
   *
   * Set by the coalesced follow-up turn, whose prompt restates messages that
   * already sit *earlier* in history — before the previous turn's replies — so
   * history alone would leave the array ending on an assistant turn, which
   * Bedrock/Anthropic reject.
   */
  appendPrompt?: boolean;
  /**
   * The stored rows of an appended prompt's messages. A user row stored after
   * them and after the last agent row was handed to this turn and read as
   * history, so it is restated after the prompt, which keeps a newer correction last.
   */
  appendedMessageIds?: string[];
  /**
   * The stored row of a chat prompt. When the history ends on an agent row
   * stored after it, every user row from it on is restated after that row, as
   * history renders it: a turn that was stopped may store its last reply after
   * the next messages arrived, and history alone would then end on the assistant.
   */
  promptMessageId?: string;
  /**
   * The run starts work that a restart may have stopped part-way. The model is
   * told in a message after the prompt, so the cached prefix before it holds.
   */
  afterRestart?: boolean;
}

// ============================================================================
// Response Types
// ============================================================================

export interface UIBlock {
  type: string;
  [key: string]: unknown;
}

/**
 * What a cut did to a tool result. Structured on purpose: the
 * `[INCOMPLETE OUTPUT …]` notice inside `output` is written for the model, and a
 * consumer that needs to *know* a result was cut should not have to parse prose
 * that the notice's wording is free to change.
 */
export interface ToolOutputTruncation {
  /** Chars in the full rendering, before the cut. */
  totalChars: number;
  /** Head + tail chars kept, excluding the notice. */
  keptChars: number;
  /** Chars dropped, accumulated across every pass (see `tool-output-limiter`). */
  omittedChars: number;
  /**
   * Id of the saved copy holding the whole output, when one was written. Absent
   * when saving was off or failed — a cut still happened, there is just nothing to
   * read back.
   */
  spillId?: string;
}

/**
 * An exchange that continues one a restart interrupted. `messageIds` names every
 * stored message it owes an answer; `unsaved` is what the interrupted turn did
 * that history does not hold.
 */
export interface ResumedReply {
  messageIds: string[];
  unsaved: ToolCallRecord[];
  unsentAttachmentIds: string[];
}

/**
 * What a recurring task's runs sent and reported since, for a run that reads no
 * history: the messages of the last run that sent, and the newest result after it.
 */
export interface TaskLastSend {
  /** One line per message: where it went, then its text. */
  messages: string;
  at: number;
  latestReport?: { text: string; at: number };
}

export interface ToolCallRecord {
  tool: string;
  input: string;
  /**
   * The model-facing text for this result — the cut view when it was cut, not the
   * raw `execute()` return. `buildConversationHistory` replays it verbatim.
   */
  output: string;
  success: boolean;
  timestamp: string;
  /**
   * Marks `output` as the rendered model-facing view. Stamped on EVERY new record,
   * cut or not, because it is the replay discriminator: a row without it predates
   * this contract and holds `JSON.stringify(raw)`, which replay has to parse and
   * render instead.
   *
   * "Has truncation metadata" cannot serve as the discriminator. An untruncated new
   * row would fall through to the legacy path, and a rendered text that happens to
   * be valid JSON — an MCP tool whose text block *is* JSON — would be parsed and
   * re-stringified into different bytes.
   */
  rendered?: true;
  /** Present only when the model-facing view was cut. */
  truncated?: ToolOutputTruncation;
}

export interface InvokeError {
  type: 'budget_exceeded' | 'generic';
  detail?: string | null;
}

/**
 * Provider-reported token usage for one model call, or for several summed
 * together. `inputTokens` is the full prompt and already includes cache reads
 * and writes, so a cache hit rate divides `cacheReadTokens` by the sum of the
 * three details; a zero sum means the provider reported no breakdown. Summed
 * across steps this is spend, counting the prompt once per step as the provider
 * bills it; `services/context-usage.service.ts` measures context size instead.
 */
export interface StepUsage {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  noCacheTokens: number;
}

export interface InvokeStep {
  text: string;
  toolCalls: ToolCallRecord[];
  // What the provider reported for this step, absent when it reports nothing.
  // `invoke.ts` records each step against `llm_calls`; nothing writes usage onto
  // a message row.
  usage?: StepUsage;
  blocks?: UIBlock[];
  // Ids of MessageAttachment rows the agent shared during this step (via the
  // share_file tool). The delivery layer links these to the published message
  // and each channel adapter renders/uploads them.
  attachmentIds?: string[];
  // Set when this step represents a friendly error message produced by
  // invokeStream's error path (so invoke() can surface structured metadata
  // in InvokeResponse.error without needing its own try/catch).
  error?: InvokeError;
}

export interface InvokeResponse {
  response: string;
  toolCalls: ToolCallRecord[];
  blocks?: UIBlock[];
  // Aggregated across all steps — files the agent shared this invocation.
  attachmentIds?: string[];
  // Every step's usage summed, absent when no step reported any. The goal loop
  // meters its budget against `totalTokens`. Nothing persists this: each step
  // was already recorded against `llm_calls` as it finished.
  usage?: StepUsage;
  steps: InvokeStep[];
  error?: InvokeError;
}
