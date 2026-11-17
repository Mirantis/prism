/**
 * Exposes the agent's real tools to the Realtime model, and runs them.
 *
 * This is what makes the voice in the meeting the agent rather than a narrator:
 * the tools an ordinary chat turn gets — memory, cron, goals, shell, skills, plus
 * everything the Mirantis Agent Platform MCP endpoint serves — are offered to the Realtime session as
 * function tools and executed in this process when called. `filterToolsByMode` makes two
 * changes for `meeting`: it drops `share_file` and the message tools, because a meeting
 * runs neither the invoke loop nor the conversation engine that deliver and store what
 * they produce, and it adds
 * `read_meeting_chat`, which reads what people have typed in the call and which no other
 * mode gets, since every other mode stores its tool results.
 *
 * Executing them here (rather than via OpenAI's remote-MCP feature) is not a
 * choice: the tools are in-process closures over service singletons and a
 * single-writer SQLite handle, and OpenAI's servers could not dial into the
 * container anyway.
 *
 * Because the bridge runs tools on behalf of whoever is talking, everything a
 * meeting participant says is untrusted input with the agent's full tool authority
 * behind it — nothing destructive is withheld in `meeting` mode. The only guards
 * left in code are that one dropped tool and the size cap on results, and the cap
 * exists for a different reason (a model that has to *say* the answer should not be
 * handed a 100 kB dump). Behaviour around destructive requests is prompt-level; see
 * `prompts/meeting-prompt.ts`.
 */

import { config } from '../../config';
import { logger } from '../../logger';
import { collectTools } from '../../lib/tool-collection';
import { REALTIME_DEFERRED_TOOLS } from '../../lib/llm-providers/deferred-tools';
import { planToolSearch } from '../../lib/tool-search/plan';
import { prepareRealtimeTools, type PreparedTools } from '../voice/realtime-tools';

/**
 * The one part of the truncation notice that belongs to this channel: the call's chat
 * takes one short line, not a result of this size, so the model must speak a useful
 * subset instead of handing the rest over.
 */
const VOICE_TRUNCATION_GUIDANCE =
  'You cannot send the rest anywhere — the call chat takes one short line, not a result ' +
  'this size, so say the part that answers the question and offer to go into more of it ' +
  'out loud. If the answer needs something from the omitted middle, search the saved ' +
  'output with a pattern — never read it through, because everything you pull back stays ' +
  "in this call's context for the rest of it, and this session's context is small.";

export interface MeetingToolBridgeInput {
  userId: string;
  agentId: string;
  threadId?: string;
  /**
   * Locked-in mode, read from the same context the instructions were built
   * from. Declarations go out once in `session.update`, so the set is fixed for
   * the call. A lock turned on mid-call is still enforced by the refusal in the
   * tools; a lock turned off does not hand the writers back until the next call.
   */
  lockedIn: boolean;
}

/**
 * Collect the agent's tools in `meeting` mode and adapt them for the Realtime API.
 *
 * Everything executable is offered, Task included. Be aware of what that means for
 * pacing: `shell_spawn` and `coding_agent` do hand back a handle immediately, but
 * `Task` awaits the whole subagent run, so its result can take minutes. The session
 * stays alive and interruptible throughout — but the model is waiting on that
 * result, so the prompt's instruction to say something before a tool call is what
 * keeps the room from sitting in silence.
 */
export async function prepareMeetingTools(
  input: MeetingToolBridgeInput,
): Promise<PreparedTools> {
  const { tools, deferrable } = await collectTools({
    userId: input.userId,
    agentId: input.agentId,
    threadId: input.threadId,
    mode: 'meeting',
    // A meeting has no workspace: it is not launched from a repo checkout, so
    // only global skills apply — the same position autonomous runs are in.
    workspaceRoot: undefined,
    lockedIn: input.lockedIn,
    // Imported at call time, not at module load: the cycle
    // invoke -> tool-collection -> tools/meeting -> meeting-bot.service -> here is
    // real, and a top-level import would close it and leave one module
    // half-initialized.
    taskInvoker: async (request) => {
      const { invoke } = await import('../../invoke');
      return invoke(request);
    },
  });

  // The session context is small, so the MCP tools wait for a `load_tools` call
  // on the same terms as a chat turn's.
  const toolSearch = await planToolSearch({
    tools,
    deferrable,
    protocol: REALTIME_DEFERRED_TOOLS,
    modelId: config.openaiRealtimeModel,
    telemetry: { userId: input.userId, agentId: input.agentId, mode: 'meeting' },
  });
  const prepared = prepareRealtimeTools(toolSearch.tools, {
    label: 'Meeting',
    truncationGuidance: VOICE_TRUNCATION_GUIDANCE,
    deferred: new Set(toolSearch.deferred),
    catalog: toolSearch.catalog,
  });
  logger.info(
    `[Meeting] Collected ${prepared.count} tool(s) for a live session` +
      (toolSearch.active ? `, ${toolSearch.deferred.length} deferred` : ''),
  );
  return prepared;
}
