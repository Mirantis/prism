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
import { capToolNames } from './tool-names';
import { createTaskTool, type Invoker } from './task-tool';
import { getComputerTools } from '../tools/computer';
import { hasComputerForMode } from '../services/computer/supported';
import type { ComputerUse } from '../services/computer/computer-access';
import { getMemoryTools } from '../tools/memory';
import { getCronTools } from '../tools/cron';
import { getGoalTools } from '../tools/goals';
import { getAgentConfigTools } from '../tools/agent-config';
import { getShellTools } from '../tools/shell/index';
import { ensureCodingAgentsDetected } from './coding-agents/availability';
import { getShareFileTools, SHARE_FILE_TOOL_NAME } from '../tools/share-file';
import { getAttachmentTools } from '../tools/attachments';
import { getSkillTools } from '../tools/skills/index';
import { CALL_TOOL_NAMES, getCallTools, isCallSupported, JOIN_CALL_TOOL_NAME } from '../tools/call';
import { agentWorkspaceService } from '../services/agent-workspace.service';
import { pluginMcpService } from '../services/plugin-mcp.service';
import type { PendingFileWrites } from './pending-file-writes';

export interface CollectToolsInput {
  computerUse?: ComputerUse;
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
   * The current step's announced file writes, so `share_file` can wait for a write
   * to the file it is about to read instead of racing it. Optional: a caller that
   * passes none keeps today's unsequenced behaviour, which is what unit tests want.
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
  /** False for a run that must not use the computer; see `InvokeRequest.computer`. */
  computer?: boolean;
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
    ...(hasComputerForMode(input.mode) && input.computer !== false ? getComputerTools(input.computerUse) : {}),
    ...getCronTools(input.userId, input.agentId, input.threadId, originChannel, input.originChannelId),
    ...getGoalTools(input.userId, input.agentId, input.threadId, originChannel, input.originChannelId),
    ...getAgentConfigTools(),
    ...getShellTools(input.workspaceRoot, input.pendingFileWrites),
    // Same workspaceRoot as the shell tools: write-then-share has to agree on what
    // a relative path means, and the write/read sequencing compares resolved paths.
    ...getShareFileTools(input.workspaceRoot, input.pendingFileWrites),
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
    ...(await getSkillTools(input.workspaceRoot)),
    // A voice in a call on the computer. Empty unless the host has the computer's
    // desktop and a voice credential, both fixed at startup.
    ...(isCallSupported()
      ? getCallTools({ userId: input.userId, agentId: input.agentId, threadId: input.threadId })
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
  // compaction, and a voice session's runs.
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
 * The call tools follow who decided the run happens. A chat turn, a heartbeat, a
 * scheduled task and a goal all carry the user's own intent, so they keep them. A
 * webhook run is triggered from outside, and its payload could name any call, so it
 * drops them, as does a subagent, whose parent can join itself.
 *
 * - chat: All tools
 * - heartbeat: minus cron-management AND goal tools (no schedule/goal reshaping)
 * - cron: minus list/delete-task AND goal tools, but KEEPS schedule_task so a
 *   thread-bound "continue in this conversation" run can re-`wait` (poll in-thread)
 * - webhook: same as cron, minus the call tools — an event-triggered run keeps
 *   schedule_task for "check again later" follow-ups
 * - subagent: minus share_file (no user channel), goal tools (no user thread) and the
 *   call tools
 * - goal: minus create_goal (no nested goals) and cron-management; get_goal stays
 * - voice: chat's set minus share_file and join_call (see the function body)
 * - any other mode: everything except the call tools
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

  if (mode === 'chat') return tools;

  // A live call gets chat's surface except `share_file` and `join_call`, since it is the
  // call already.
  //
  // `share_file` is dropped for the same reason `subagent` drops it: the tool only
  // stores the file and hands back an id, and it is the *invoke loop* that carries
  // that id onto the step and the conversation engine that links it to a delivered
  // message. A call runs neither, so a shared file would be stored and then reach
  // nobody — while the tool's own description promises the user a download.
  //
  // Nothing else is withheld, though call audio is unauthenticated: anyone in the call
  // can speak, and their words drive a model holding real tools. The one guard is
  // `prompts/call-prompt.ts`'s confirmation rule, which covers self-configuration by
  // name; it is guidance, not enforcement, so a sentence agreed in a call can change the
  // agent for every future turn on every channel. `docs/voice-calls.md` says so plainly.
  if (mode === 'voice') {
    return omit(new Set([SHARE_FILE_TOOL_NAME, JOIN_CALL_TOOL_NAME]));
  }

  // Speaking in a call hands the agent's tools to everyone in it, so a run whose trigger
  // is outside input must not start one. The modes below that drop these are that kind.
  const callToolNames = new Set<string>(CALL_TOOL_NAMES);

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
        ...callToolNames,
      ]),
    );
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
    return omit(
      new Set([
        'list_scheduled_tasks',
        'delete_scheduled_task',
        ...goalToolNames,
        ...(mode === 'webhook' ? callToolNames : []),
      ]),
    );
  }

  // A goal turn does real work but must not create/nest a goal or reshape the
  // schedule.
  if (mode === 'goal') {
    return omit(new Set(['create_goal', ...cronToolNames]));
  }

  // A mode nothing above enumerates keeps every tool but the call tools. The permissive
  // fallback is deliberate for the rest — a caller passing a mode this function has not
  // heard of should not silently lose the shell.
  return omit(callToolNames);
}
