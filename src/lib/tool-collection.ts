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
import type { CachePointFragment } from './llm-providers/llm-provider';
import { config } from '../config';
import { logger } from '../logger';
import { getMCPTools } from './mcp-client';
import { createTaskTool, type Invoker } from './task-tool';
import { getMemoryTools } from '../tools/memory';
import { getCronTools } from '../tools/cron';
import { getGoalTools } from '../tools/goals';
import { getAgentConfigTools } from '../tools/agent-config';
import { getShellTools } from '../tools/shell/index';
import { getShareFileTools, SHARE_FILE_TOOL_NAME } from '../tools/share-file';
import { getAttachmentTools } from '../tools/attachments';
import { getSkillTools } from '../tools/skills/index';
import { getMeetingTools, MEETING_TOOL_NAMES, isMeetingSupported } from '../tools/meeting';
import { agentWorkspaceService } from '../services/agent-workspace.service';
import { pluginMcpService } from '../services/plugin-mcp.service';

export interface CollectToolsInput {
  userId: string;
  agentId: string;
  threadId?: string;
  mode: string;
  originChannel?: Parameters<typeof getCronTools>[3];
  originChannelId?: string;
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
   * Locked-in mode, taken from the caller's context. Not re-read here: two
   * requests built from the same context must produce a byte-identical tools
   * block, or they miss the shared prompt-cache prefix.
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
 * tools, no MCP round trip) filtered by mode, every tool the Nexus MCP
 * endpoint exposes, and the Task tool when subagents are configured.
 */
export async function collectTools(input: CollectToolsInput): Promise<CollectedTools> {
  const originChannel = input.originChannel ?? 'websocket';
  const builtInTools: Record<string, Tool> = {
    ...getMemoryTools(input.userId, input.agentId),
    ...getCronTools(input.userId, input.agentId, input.threadId, originChannel, input.originChannelId),
    ...getGoalTools(input.userId, input.agentId, input.threadId, originChannel, input.originChannelId),
    ...getAgentConfigTools(),
    ...getShellTools(input.workspaceRoot),
    ...getShareFileTools(),
    ...getAttachmentTools(
      input.userId,
      input.agentId,
      input.threadId,
      input.workspaceRoot,
      input.registerAttachmentInjection,
    ),
    // Progressive disclosure: the `skill` tool loads a skill's full SKILL.md
    // body on demand. workspaceRoot merges the repo's skills with the global
    // ones. Empty (and omitted) when no skills are available.
    ...getSkillTools(input.workspaceRoot),
    // Live voice meetings. Empty unless the host has the browser/audio
    // toolchain and an OpenAI key — see `meetingToolsAvailable`.
    ...(meetingToolsAvailable
      ? getMeetingTools({ userId: input.userId, agentId: input.agentId, threadId: input.threadId })
      : {}),
  };

  // Register every tool the Nexus MCP endpoint exposes. In the sandbox this
  // is the project-scoped endpoint, which already excludes first-party shell
  // tools by design (those are local built-ins above), so no tool allowlist
  // is sent — we want the full surface it serves.
  const nexusTools: Record<string, Tool> = config.nexusMcpUrl
    ? await getMCPTools({ url: config.nexusMcpUrl })
    : {};

  // Tools contributed by installed Agent Plugins, already namespaced by plugin
  // and server and in a stable order.
  const pluginTools = await pluginMcpService.getTools();

  const merged: Record<string, Tool> = { ...builtInTools, ...nexusTools };
  // Merged with an explicit guard rather than a spread, so "a plugin can never
  // replace a built-in" is a property of this code and not of a naming
  // convention that a future rename could quietly invalidate.
  for (const [name, tool] of Object.entries(pluginTools)) {
    if (name in merged) {
      logger.warn(`[Plugins] dropping tool "${name}" — a built-in or Nexus tool already owns it`);
      continue;
    }
    merged[name] = tool;
  }

  // Applied to everything, not just the built-ins: an MCP tool that shares a
  // name with a built-in the current mode removed must not survive either.
  const modeFilteredTools = filterToolsByMode(merged, input.mode);

  // Locked-in mode: withhold the workspace-markdown writers. Applied after the
  // mode filter so it holds for every mode, and over the merged map so a Nexus
  // MCP tool cannot answer to a withheld name — those names are un-namespaced.
  // A plugin tool is `<plugin>__<server>__<tool>`, so it never collides either
  // way. The refusal in agent-config.ts is what enforces the lock.
  const tools = input.lockedIn
    ? omitLockedWorkspaceTools(modeFilteredTools)
    : modeFilteredTools;

  // Fetch subagents (skip for subagent invocations to prevent recursion)
  const subagents = input.mode === 'subagent'
    ? []
    : await agentWorkspaceService.getSubagents(input.agentId);

  logger.info(
    `Collected ${Object.keys(builtInTools).length} built-in + ${Object.keys(nexusTools).length} Nexus MCP + ${Object.keys(pluginTools).length} plugin MCP tool(s); ${subagents.length} subagent(s)`,
  );

  // Add task tool if subagents are configured
  if (subagents.length > 0 && input.mode !== 'subagent') {
    logger.info(`Adding Task tool for ${subagents.length} subagent(s)`);
    tools['Task'] = createTaskTool(subagents, input.userId, input.taskInvoker);
  }

  return { tools, subagents };
}

/**
 * Mark the last tool with the provider's cache breakpoint so the entire tools
 * block is cached across requests. Tools are stable per agent, so this yields
 * near-100% cache hit rates after the first request.
 */
export function withToolsCacheControl(
  tools: Record<string, Tool>,
  cachePoint: CachePointFragment,
): Record<string, Tool> {
  const keys = Object.keys(tools);
  if (keys.length === 0) return tools;

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
 * Tools that write the locked workspace markdown fields. Withheld from the tool
 * set while locked-in mode is on. `rename_self` and `update_settings` are not in
 * the set: renames and behavioural settings (heartbeat interval, timezone,
 * verbose) stay editable while locked, and `update_settings` cannot reach
 * `lockedIn`.
 */
const LOCKED_WORKSPACE_TOOL_NAMES = new Set([
  'update_soul',
  'update_memory',
  'update_user_profile',
  'update_vision',
  'update_heartbeat_config',
  'clear_bootstrap',
]);

/** Drop the workspace-markdown writers while locked-in mode is on. */
function omitLockedWorkspaceTools(tools: Record<string, Tool>): Record<string, Tool> {
  const result: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!LOCKED_WORKSPACE_TOOL_NAMES.has(name)) result[name] = tool;
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
 * Joining a voice meeting is a chat-only act: every other mode drops the meeting
 * tools, because an autonomous run (a heartbeat, a cron tick, a subagent) dialling
 * into a live call with people in it is never what the operator asked for.
 *
 * - chat: All tools
 * - heartbeat: minus cron-management AND goal tools (no schedule/goal reshaping)
 * - cron: minus list/delete-task AND goal tools, but KEEPS schedule_task so a
 *   thread-bound "continue in this conversation" run can re-`wait` (poll in-thread)
 * - webhook: same as cron — an event-triggered run keeps schedule_task for
 *   "check again later" follow-ups
 * - subagent: minus share_file (no user channel) AND goal tools (no user thread)
 * - goal: minus create_goal (no nested goals) and cron-management; get_goal stays
 * - meeting: chat's full set minus share_file (see the note in the function body)
 */
export function filterToolsByMode(tools: Record<string, Tool>, mode: string): Record<string, Tool> {
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

  // A live voice meeting gets chat's full surface except `share_file`.
  //
  // `share_file` is dropped for the same reason `subagent` drops it: the tool only
  // stores the file and hands back an id, and it is the *invoke loop* that carries
  // that id onto the step and the conversation engine that links it to a delivered
  // message. A meeting runs neither, so a shared file would be stored and then
  // reach nobody — while the tool's own description promises the user a download.
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
    return omit(new Set([SHARE_FILE_TOOL_NAME]));
  }

  // Only a person in a conversation asks the agent into a call, so every mode
  // below drops the meeting tools. Folded in here rather than repeated per mode
  // so a new mode can't accidentally inherit the ability to join a meeting.
  const meetingToolNames = new Set<string>(MEETING_TOOL_NAMES);

  // Subagents return their result as text to the parent invocation (via the
  // Task tool) — they have no direct channel to the user, so a file they
  // "shared" would never be delivered. Drop share_file. They also don't own a
  // user thread, so drop goal tools and attachment tools.
  if (mode === 'subagent') {
    return omit(
      new Set([
        SHARE_FILE_TOOL_NAME,
        'hydrate_attachment',
        'view_attachment',
        ...goalToolNames,
        ...meetingToolNames,
      ]),
    );
  }

  // Heartbeat is an autonomous run: full tool access, minus the cron-management
  // and goal tools so it can't reshape the schedule or spawn goals.
  if (mode === 'heartbeat') {
    return omit(new Set([...cronToolNames, ...goalToolNames, ...meetingToolNames]));
  }

  // Cron keeps `schedule_task` so a thread-bound "continue in this conversation"
  // run can re-`wait` (schedule a follow-up) and keep polling in-thread, but
  // still can't enumerate/delete the whole schedule or create/nest goals.
  if (mode === 'cron' || mode === 'webhook') {
    return omit(
      new Set([
        'list_scheduled_tasks',
        'delete_scheduled_task',
        ...goalToolNames,
        ...meetingToolNames,
      ]),
    );
  }

  // A goal turn does real work but must not create/nest a goal or reshape the
  // schedule.
  if (mode === 'goal') {
    return omit(new Set(['create_goal', ...cronToolNames, ...meetingToolNames]));
  }

  return tools;
}
