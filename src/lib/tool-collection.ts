/**
 * Tool assembly for model invocations.
 *
 * Kept in one place so every request that sends the agent's tool set builds a
 * byte-identical tools block — the provider's prompt-cache prefix hash covers
 * it, and any divergence misses the cache. The subagent Task invoker is
 * injected (the same pattern createTaskTool itself uses) so this module never
 * imports invoke.ts.
 */

import type { ModelMessage, Tool } from 'ai';
import { mergeProviderOptions, type CachePointFragment } from './llm-providers/llm-provider';
import { config } from '../config';
import { logger } from '../logger';
import { getMCPTools } from './mcp-client';
import { capToolNames } from './tool-names';
import { createTaskTool, type Invoker } from './task-tool';
import { getComputerTools } from '../tools/computer';
import { hasComputerForMode } from '../services/computer/supported';
import type { ComputerUse } from '../services/computer/computer-access';
import { getMemoryTools } from '../tools/memory';
import { getConversationHistoryTools } from '../tools/conversation-history';
import { conversationService } from '../services/conversation.service';
import { ThreadSource } from '@prisma/client';
import { getCronTools } from '../tools/cron';
import { getGoalTools } from '../tools/goals';
import { getAgentConfigTools } from '../tools/agent-config';
import { getShellTools } from '../tools/shell/index';
import { ensureCodingAgentsDetected } from './coding-agents/availability';
import { getShareFileTools, SHARE_FILE_TOOL_NAME } from '../tools/share-file';
import { getSendMessageTools } from '../tools/send-message';
import { SEND_MESSAGE_TOOL_NAME } from '../services/outbound-message.service';
import { getAttachmentTools } from '../tools/attachments';
import { getWebFetchTools } from '../tools/web/web-fetch';
import { getSkillTools } from '../tools/skills/index';
import {
  getMeetingTools,
  MEETING_MEMBERSHIP_TOOL_NAMES,
  MEETING_READ_TOOL_NAME,
  MEETING_SCREEN_TOOL_NAMES,
  isMeetingSupported,
} from '../tools/meeting';
import { agentWorkspaceService } from '../services/agent-workspace.service';
import { pluginMcpService } from '../services/plugin-mcp.service';
import type { PendingFileWrites } from './pending-file-writes';
import type { InvokeRequest } from '../types';

/** The tools that post a message, and list where it may go. */
const MESSAGE_TOOL_NAMES = [SEND_MESSAGE_TOOL_NAME, 'list_message_targets'];

export interface CollectToolsInput {
  computerUse?: ComputerUse;
  userId: string;
  agentId: string;
  threadId?: string;
  mode: string;
  originChannel?: Parameters<typeof getCronTools>[4];
  originChannelId?: string;
  postingCeiling?: InvokeRequest['postingCeiling'];
  workspaceRoot?: string;
  /** Runs a subagent Task; injected so this module never imports invoke.ts. */
  taskInvoker: Invoker;
  /**
   * Queues a message for injection into the running invocation at the next
   * step boundary (invoke.ts prepareStep). view_attachment uses it to attach
   * a PDF as a user-message document — the only placement Bedrock's Converse
   * converter accepts for file content.
   */
  registerAttachmentInjection?: (message: ModelMessage) => void;
  /**
   * The current step's announced file writes, so `share_file` can wait for a write
   * to the file it is about to read instead of racing it. Optional: a caller that
   * passes none keeps today's unsequenced behaviour, which is what the meeting
   * tool bridge (no invoke loop, no steps) and unit tests want.
   */
  pendingFileWrites?: PendingFileWrites;
  /**
   * Locked-in mode, taken from the caller's context. Withholds the
   * workspace-markdown writers and the long-term memory writers
   * (`memory_write`, `memory_delete`); `memory_search` stays. Not re-read here:
   * two requests built from the same context must produce a byte-identical
   * tools block, or they miss the shared prompt-cache prefix.
   *
   * Required, not optional: a caller that omits the flag would leave the
   * writers in its schema and lean on the runtime refusal alone.
   */
  lockedIn: boolean;
}

/**
 * Whether this host can host a voice meeting, resolved once at startup.
 *
 * Probed once rather than per turn because the answer involves filesystem checks
 * and, more importantly, because the tools block must be byte-identical across
 * requests for the provider's prompt cache to hit. Defaults to false so a runtime
 * that never calls `initMeetingToolAvailability()` (tests, an embedder) simply
 * doesn't offer the tools.
 */
let meetingToolsAvailable = false;

/**
 * Probe for the meeting toolchain and remember the answer.
 *
 * Called from the startup sequence. Never throws: a failed probe means "no voice
 * meetings here", which is the correct outcome for every host without the
 * container's browser and audio packages.
 */
export async function initMeetingToolAvailability(): Promise<boolean> {
  try {
    meetingToolsAvailable = await isMeetingSupported();
  } catch (err) {
    logger.warn(`[Tools] Meeting toolchain probe failed: ${String(err)}`);
    meetingToolsAvailable = false;
  }
  return meetingToolsAvailable;
}

export interface CollectedTools {
  tools: Record<string, Tool>;
  /** Returned so callers can also render the task-tool system instructions. */
  subagents: Awaited<ReturnType<typeof agentWorkspaceService.getSubagents>>;
}

/**
 * Collect the tools an invocation of `mode` sends: built-ins (direct AI SDK
 * tools, no MCP round trip) filtered by mode, every tool the Lens Agents MCP
 * endpoint exposes, and the Task tool when subagents are configured.
 */
export async function collectTools(input: CollectToolsInput): Promise<CollectedTools> {
  const originChannel = input.originChannel ?? 'websocket';
  // The shell tools name the available coding agents in their descriptions, and
  // the tools block has to be byte-identical from turn to turn for the prompt
  // cache. Memoized, so only a turn that beats boot to it pays anything.
  await ensureCodingAgentsDetected();
  const builtInTools: Record<string, Tool> = {
    ...getMemoryTools(input.userId, input.agentId),
    ...(hasComputerForMode(input.mode) ? getComputerTools(input.computerUse, undefined, input.mode) : {}),
    ...getCronTools(input.userId, input.agentId, input.mode, input.threadId, originChannel, input.originChannelId),
    ...getGoalTools(input.userId, input.agentId, input.threadId, originChannel, input.originChannelId),
    ...getAgentConfigTools(),
    ...getShellTools(input.workspaceRoot, input.pendingFileWrites),
    // Same workspaceRoot as the shell tools: write-then-share has to agree on what
    // a relative path means, and the write/read sequencing compares resolved paths.
    ...getShareFileTools(input.workspaceRoot, input.pendingFileWrites),
    // A run whose delivery setting reaches nowhere gets no tool to post with.
    ...(input.postingCeiling && !input.postingCeiling.webChat && input.postingCeiling.targets.length === 0
      ? {}
      : getSendMessageTools(
          input.userId,
          input.agentId,
          input.mode,
          input.threadId,
          originChannel,
          input.originChannelId,
          input.postingCeiling,
        )),
    ...getAttachmentTools(
      input.userId,
      input.agentId,
      input.threadId,
      input.workspaceRoot,
      input.registerAttachmentInjection,
    ),
    ...getWebFetchTools(input.userId, input.agentId),
    // Every run bound to a stored thread gets it, so the thread keeps one tool list across
    // its modes. A thread read live from a channel keeps its compacted messages there.
    ...(input.threadId && (await conversationService.getThreadSource(input.threadId)) === ThreadSource.DATABASE
      ? getConversationHistoryTools(input.threadId, input.workspaceRoot)
      : {}),
    // Progressive disclosure: the `skill` tool loads a skill's full SKILL.md
    // body on demand. workspaceRoot merges the repo's skills with the global
    // ones. Empty (and omitted) when no skills are available.
    ...(await getSkillTools(input.workspaceRoot)),
    // Live voice meetings. Empty unless the host has the browser/audio
    // toolchain and an OpenAI key — see `meetingToolsAvailable`.
    ...(meetingToolsAvailable
      ? getMeetingTools({
          userId: input.userId,
          agentId: input.agentId,
          threadId: input.threadId,
          // `see_screen` delivers its picture into the meeting's Realtime session, so it
          // has to know whether the model asking for it is the one in the call.
          inMeetingSession: input.mode === 'meeting',
        })
      : {}),
  };

  // Register every tool the Lens Agents MCP endpoint exposes. In the sandbox this
  // is the project-scoped endpoint, which already excludes first-party shell
  // tools by design (those are local built-ins above), so no tool allowlist
  // is sent — we want the full surface it serves.
  const nexusTools: Record<string, Tool> = config.nexusMcpUrl
    ? await getMCPTools({ url: config.nexusMcpUrl })
    : {};

  // Tools contributed by installed Agent Plugins, already namespaced by plugin
  // and server and in a stable order.
  const pluginTools = await pluginMcpService.getTools();

  // Merged with an explicit guard rather than a spread, so "nothing replaces a
  // built-in" is a property of this code and not of a naming convention that a
  // future rename could quietly invalidate. Platform tool names are
  // un-namespaced, so one answering to `memory_write` would otherwise inherit
  // that name's exemption from the risk gate, whose list matches bare names.
  const merged: Record<string, Tool> = { ...builtInTools };
  const mergeWithoutOverriding = (tools: Record<string, Tool>, source: string): void => {
    for (const [name, tool] of Object.entries(tools)) {
      if (name in merged) {
        logger.warn(`[${source}] dropping tool "${name}" — that name is already taken`);
        continue;
      }
      merged[name] = tool;
    }
  };
  mergeWithoutOverriding(nexusTools, 'Nexus');
  mergeWithoutOverriding(pluginTools, 'Plugins');

  // Applied to everything, not just the built-ins: an MCP tool that shares a
  // name with a built-in the current mode removed must not survive either.
  const modeFilteredTools = filterToolsByMode(merged, input.mode);
  // A run with a posting ceiling reaches people only through `send_message`,
  // which carries no file, so a file it shared would reach nobody.
  if (input.postingCeiling) delete modeFilteredTools[SHARE_FILE_TOOL_NAME];

  // Locked-in mode: withhold the workspace-markdown writers and the long-term
  // memory writers. Applied after the mode filter so it holds for every mode,
  // and over the merged map so a platform MCP tool cannot answer to a withheld
  // name — those names are un-namespaced. A plugin tool is namespaced by plugin
  // and server, so it never collides either way. The refusals in
  // agent-config.ts and memory.ts are what enforce the lock.
  const filteredTools = input.lockedIn
    ? omitLockedTools(modeFilteredTools)
    : modeFilteredTools;

  // Fetch subagents (skip for subagent invocations to prevent recursion)
  const subagents = input.mode === 'subagent'
    ? []
    : await agentWorkspaceService.getSubagents(input.agentId);

  // Add task tool if subagents are configured
  if (subagents.length > 0 && input.mode !== 'subagent') {
    logger.info(`Adding Task tool for ${subagents.length} subagent(s)`);
    filteredTools['Task'] = createTaskTool(subagents, input.userId, input.taskInvoker);
  }

  // Last word on what a tool may be called, and deliberately the last step
  // here: this is the only assembly point every request goes through — chat,
  // compaction, and the voice-meeting bridge, which re-declares these same keys
  // to the Realtime API under the same limit.
  //
  // Every built-in name is reserved, `Task` included, and the set is taken
  // before the filters rather than after: a mode that withheld `share_file`
  // leaves its name unclaimed, and a remote `share.file` sanitizing into that
  // slot would hand the model a tool the mode had just taken away.
  const reservedNames = new Set([...Object.keys(builtInTools), 'Task']);
  const tools = capToolNames(filteredTools, 'collect', reservedNames);

  logger.info(
    `Collected ${Object.keys(builtInTools).length} built-in + ${Object.keys(nexusTools).length} platform MCP + ${Object.keys(pluginTools).length} plugin MCP tool(s); ${subagents.length} subagent(s)`,
  );

  return { tools, subagents };
}

/**
 * Mark the last tool with the provider's cache breakpoint. Tools are stable per
 * agent, so a checkpoint here is the cheapest one to keep warm.
 *
 * A `deferred` tool is skipped: the API refuses a breakpoint on a tool that
 * loads only when a tool change names it. The breakpoint merges into the tool's
 * own `providerOptions`.
 *
 * It reaches the wire on the Anthropic Messages path only. Bedrock's Converse
 * conversion builds each `toolSpec` from the tool's name, description and
 * schema and never reads its `providerOptions`, so on that path this is a
 * no-op and the tools block carries no checkpoint of its own. AWS documents
 * the checkpoint order as tools → system → messages with the minimum measured
 * across all three, which implies a later `system` checkpoint still covers the
 * tools ahead of it — the loss is a separate cache segment for tools, not the
 * tokens going uncached. Worth re-checking against `cacheReadInputTokens` if
 * the Converse hit rate lands materially below the Messages one.
 */
export function withToolsCacheControl(
  tools: Record<string, Tool>,
  cachePoint: CachePointFragment,
  deferred: ReadonlySet<string> = new Set(),
): Record<string, Tool> {
  const lastKey = Object.keys(tools).filter((name) => !deferred.has(name)).at(-1);
  if (lastKey === undefined) return tools;

  const result: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    result[name] = name === lastKey
      ? { ...tool, providerOptions: mergeProviderOptions(tool.providerOptions, cachePoint) }
      : tool;
  }
  return result;
}

/**
 * Tools that write the locked workspace markdown fields or long-term memory.
 * Withheld from the tool set while locked-in mode is on. `memory_search` is not
 * in the set: a locked agent still reads its memories, it just cannot add or
 * remove them. `rename_self` and `update_settings` are not in the set either:
 * renames and behavioural settings (heartbeat interval, timezone, verbose) stay
 * editable while locked, and `update_settings` cannot reach `lockedIn`.
 */
const LOCKED_TOOL_NAMES = new Set([
  'update_soul',
  'update_memory',
  'update_user_profile',
  'update_vision',
  'update_heartbeat_config',
  'clear_bootstrap',
  'memory_write',
  'memory_delete',
]);

/** Drop the workspace-markdown and memory writers while locked-in mode is on. */
function omitLockedTools(tools: Record<string, Tool>): Record<string, Tool> {
  const result: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!LOCKED_TOOL_NAMES.has(name)) result[name] = tool;
  }
  return result;
}

/**
 * Filter the assembled tool set by invocation mode.
 *
 * Named for built-ins because that is what it omits, but it runs over every
 * tool — including MCP ones — so a remote tool cannot answer to a name the
 * mode has just taken away.
 *
 * Joining a voice meeting and leaving one are chat-only acts: every other mode drops
 * those two tools, because an autonomous run (a heartbeat, a cron tick, a subagent)
 * dialling into a live call with people in it — or hanging up on one — is never what the
 * operator asked for. Asking about a call and posting one line into it are available in
 * every mode, so a scheduled run started during a call can report back into the room.
 * Reading the call's chat goes the other way: only the model in the call gets it.
 *
 * - chat: All tools except `read_meeting_chat`
 * - heartbeat, cron, webhook: minus the goal tools; the schedule tools stay. A run with a
 *   posting ceiling also loses share_file (see collectTools)
 * - subagent: minus share_file (no user channel), goal tools and the message tools (no user thread)
 * - goal: minus create_goal (no nested goals) and the schedule tools; get_goal stays
 * - meeting: chat's set minus share_file and the message tools, plus read_meeting_chat (see the function body)
 * - any other mode: everything except the two tools that join or leave a call, and the
 *   chat read
 */
export function filterToolsByMode(tools: Record<string, Tool>, mode: string): Record<string, Tool> {
  // Goal-management tools are chat-only entry points; a goal turn keeps only
  // get_goal so it can introspect its own progress.
  const goalToolNames = new Set(['create_goal', 'get_goal']);
  const cronToolNames = new Set(['schedule_task', 'list_scheduled_tasks', 'update_scheduled_task', 'delete_scheduled_task']);

  const omit = (names: Set<string>): Record<string, Tool> => {
    const result: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(tools)) {
      if (!names.has(name)) result[name] = tool;
    }
    return result;
  };

  // Chat gets everything but the chat read. A chat turn persists its tool results as
  // conversation history and replays them into every later turn, so reading a call's chat
  // there would file words typed by unauthenticated third parties into the database for
  // good. The model in the call holds the reading for the length of the call instead.
  if (mode === 'chat') {
    return omit(new Set([MEETING_READ_TOOL_NAME]));
  }

  // A live voice meeting gets chat's surface except `share_file` and the message tools,
  // and the chat read on top.
  //
  // `share_file` is dropped for the same reason `subagent` drops it: the tool only
  // stores the file and hands back an id, and it is the *invoke loop* that carries
  // that id onto the step and the conversation engine that links it to a delivered
  // message. A meeting runs neither, so a shared file would be stored and then
  // reach nobody — while the tool's own description promises the user a download.
  // The message tools go for a like reason: a sent message has to be stored in the
  // history of the run that sent it, and nothing about a call is stored.
  //
  // Nothing else is withheld. Meeting mode used to also drop the tools whose
  // effects outlive the call (cron, self-configuration, memory writes), because
  // meeting audio is unauthenticated: anyone with the link can speak, and their
  // words drive a model holding real tools. That boundary was removed deliberately
  // — an agent that can only read is not much use in a working meeting, and the
  // filter also refused the agent's own user asking in a call. The one guard left is
  // `prompts/meeting-prompt.ts`'s confirmation rule, which covers self-configuration
  // by name; it is guidance, not enforcement, so a sentence agreed in a call can
  // change the agent for every future turn on every channel. Treat a meeting link as
  // conferring the agent's authority over itself and keep it private.
  // `docs/voice-meetings.md` says so plainly.
  if (mode === 'meeting') {
    return omit(new Set([SHARE_FILE_TOOL_NAME, ...MESSAGE_TOOL_NAMES]));
  }

  // Only a person in a conversation asks the agent into a call or out of one, so every
  // mode below drops those two tools. Folded in here rather than repeated per mode so a
  // new mode can't accidentally inherit the ability to join a meeting.
  const membershipToolNames = new Set<string>([
    ...MEETING_MEMBERSHIP_TOOL_NAMES,
    // The screen tools go with them: an autonomous run must not move what a room is
    // watching, or open a browser in front of one.
    ...MEETING_SCREEN_TOOL_NAMES,
    // And the chat read, for the reason the chat branch above drops it: every mode below
    // stores its tool results.
    MEETING_READ_TOOL_NAME,
  ]);

  // Subagents return their result as text to the parent invocation (via the
  // Task tool) — they have no direct channel to the user, so a file they
  // "shared" would never be delivered. Drop share_file. They also don't own a
  // user thread, so drop goal tools and attachment tools, and the message
  // tools, whose sends have to be stored in the history of the run that sent them.
  if (mode === 'subagent') {
    return omit(
      new Set([
        SHARE_FILE_TOOL_NAME,
        'hydrate_attachment',
        'view_attachment',
        ...MESSAGE_TOOL_NAMES,
        ...goalToolNames,
        ...membershipToolNames,
      ]),
    );
  }

  // An autonomous run reads, adds to and removes from the schedule as a chat turn does,
  // so it can retract a follow-up it scheduled itself. A webhook payload or a Slack trigger
  // message can therefore ask it to delete any of the owner's tasks; `shell_exec`, which
  // these modes hold, can already call the same REST route. Goals stay chat-only.
  if (mode === 'heartbeat' || mode === 'cron' || mode === 'webhook') {
    return omit(new Set([...goalToolNames, ...membershipToolNames]));
  }

  // A goal turn does real work but must not create/nest a goal or reshape the
  // schedule.
  if (mode === 'goal') {
    return omit(new Set(['create_goal', ...cronToolNames, ...membershipToolNames]));
  }

  // A mode nothing above enumerates keeps every other tool, and none of the ones that
  // change which call the agent is in, move what a room is watching, or read the call's
  // chat. The permissive fallback is deliberate for the rest — a caller passing a mode this
  // function has not heard of should not silently lose the shell — but `join_meeting` dials
  // into a live call with people in it, `leave_meeting` hangs up on one, and the chat read
  // would be stored, which is why every enumerated mode above drops them.
  return omit(membershipToolNames);
}
