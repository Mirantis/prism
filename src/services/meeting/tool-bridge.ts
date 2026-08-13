/**
 * Exposes the agent's real tools to the Realtime model, and runs them.
 *
 * This is what makes the voice in the meeting the agent rather than a narrator:
 * the tools an ordinary chat turn gets — memory, cron, goals, shell, skills, plus
 * everything the Lens Agents MCP endpoint serves — are offered to the Realtime session as
 * function tools and executed in this process when called. `share_file` is the one
 * exception, dropped by `filterToolsByMode` because a meeting runs neither the
 * invoke loop nor the conversation engine that deliver what it stores.
 *
 * Executing them here (rather than via OpenAI's remote-MCP feature) is not a
 * choice: the tools are in-process closures over service singletons and a
 * single-writer SQLite handle, and OpenAI's servers could not dial into the
 * container anyway.
 *
 * `MEETING_TOOL_MODE=delegate` (or a per-join `toolMode`) changes what the Realtime
 * model is *shown* — one delegation tool instead of the catalog, see
 * `delegation-tool.ts` — and almost nothing about what the agent can ultimately do:
 * the delegated turn holds the same tools bar the goal tools, which `subagent` mode
 * has never had. It is an experiment in who does the choosing, not a restriction, so
 * everything below applies to it unchanged.
 *
 * Because the bridge runs tools on behalf of whoever is talking, everything a
 * meeting participant says is untrusted input with the agent's full tool authority
 * behind it — nothing destructive is withheld in `meeting` mode. The only guards
 * left in code are that one dropped tool and the size cap on results, and the cap
 * exists for a different reason (a model that has to *say* the answer should not be
 * handed a 100 kB dump). Behaviour around destructive requests is prompt-level; see
 * `prompts/meeting-prompt.ts`.
 */

import { asSchema, type Tool } from 'ai';
import { logger } from '../../logger';
import type { MeetingToolMode } from '../../config';
import { collectTools } from '../../lib/tool-collection';
import { renderToolResult } from '../../lib/tool-output-limiter';
import type { Invoker } from '../../lib/task-tool';
import {
  createDelegationTool,
  DELEGATION_TOOL_NAME,
  type DelegationOutcome,
} from './delegation-tool';
import type { RealtimeFunctionTool } from './realtime-session';

/**
 * Cap on a tool result handed back to the Realtime model.
 *
 * Smaller than the chat-path budget (`lib/tool-output-limiter.ts`) on purpose, and
 * for a reason particular to this transport: a tool result stays in the Realtime
 * session's context for the rest of the call, and that context is far smaller than
 * the chat model's window. This model also *speaks* its answer, so a 100 kB
 * `kubectl get` dump only produces a monologue nobody wants.
 *
 * It used to be 4,000, which cut a single Jira issue's description in half and beheaded
 * a PR listing — so the agent stated the count it could see as the total. 12,000
 * (~3k tokens) holds a long issue or a few dozen listed items while staying a modest
 * share of the session. The *shape* of the cut is chat's, not this file's: shared
 * head+tail, and a notice that says outright the result is incomplete.
 */
export const MEETING_MAX_RESULT_CHARS = 12_000;

/**
 * The one part of the truncation notice that belongs to this channel: nothing here
 * can hand the rest over in text, so the model must speak a useful subset.
 */
const VOICE_TRUNCATION_GUIDANCE =
  'You cannot send the rest anywhere — this call is your only channel, so say the part ' +
  'that answers the question and offer to go into more of it out loud.';

/**
 * The two tools that stay in `delegate` mode alongside the delegation tool.
 *
 * They are the call's own controls, not work: `leave_meeting` is how the agent hangs
 * up when asked, and `meeting_status` is how it answers "how long have you been
 * here". Delegating either is impossible — a delegated turn runs in `subagent` mode,
 * which drops the meeting tools precisely so it cannot end the call that spawned it.
 * So "single tool" is really one delegation tool plus these two.
 *
 * `join_meeting` is not among them: the agent is already in a call, one call at a
 * time is the rule, and it has nothing to do with answering a request.
 */
const DELEGATE_MODE_CONTROL_TOOLS = ['leave_meeting', 'meeting_status'] as const;

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
  /**
   * `full` (the default) offers the model everything; `delegate` offers one tool
   * that hands the request to an ordinary agent turn. See `delegation-tool.ts`.
   */
  toolMode?: MeetingToolMode;
}

/**
 * What the delegated turns of one call added up to.
 *
 * The whole point of the experiment is a comparison, and it is a comparison about
 * latency and reliability — so the numbers have to come off real calls rather than a
 * reviewer's impression of them. `failures` is the room's view: an errored turn and
 * one that produced nothing sayable are the same event to a participant, so they are
 * counted together; a `timeout` is separate because it is a *latency* result, and
 * `truncated` says how often the delegate wrote for a reader instead of a listener.
 *
 * `msTotal` is the wall-clock the room waited, summed — averaged at the end rather
 * than kept per-call, since a per-request event would flood the metric.
 */
export interface DelegationStats {
  total: number;
  failures: number;
  timeouts: number;
  truncated: number;
  msTotal: number;
}

export interface PreparedMeetingTools {
  /** Declarations for `session.update`. */
  declarations: RealtimeFunctionTool[];
  /**
   * Executes a call by name; never throws — errors come back as text.
   *
   * `abortSignal` is the call's, not the tool call's: it is aborted when the
   * meeting ends, so work started for a room that no longer exists stops instead
   * of running to completion against a closed session. Required rather than
   * optional so there is no way to reach a tool without one.
   */
  execute: (name: string, argumentsJson: string, abortSignal: AbortSignal) => Promise<string>;
  /** Tool count, for logging and telemetry. */
  count: number;
  /**
   * The running delegation tally, or `null` in `full` mode where there are none.
   *
   * A snapshot, read at teardown: `null` and all-zero mean different things (the mode
   * was off vs. the model never delegated), and only the first is uninteresting.
   */
  delegationStats: () => DelegationStats | null;
}

/**
 * Collect the agent's tools in `meeting` mode and adapt them for the Realtime API.
 *
 * In `full` mode everything executable is offered, Task included. Be aware of what
 * that means for pacing: `shell_spawn` and `claude_code` do hand back a handle
 * immediately, but `Task` awaits the whole subagent run, so its result can take
 * minutes. The session stays alive and interruptible throughout — but the model is
 * waiting on that result, so the prompt's instruction to say something before a tool
 * call is what keeps the room from sitting in silence.
 *
 * In `delegate` mode the same collection still happens — the delegated turn needs the
 * agent's real tools, it just gets them through `invoke()` instead — and what changes
 * is only what the *Realtime* model is shown: one delegation tool plus the call's own
 * controls.
 */
export async function prepareMeetingTools(
  input: MeetingToolBridgeInput,
): Promise<PreparedMeetingTools> {
  const toolMode = input.toolMode ?? 'full';

  // Imported at call time, not at module load: the cycle
  // invoke -> tool-collection -> tools/meeting -> meeting-bot.service -> here is
  // real, and a top-level import would close it and leave one module
  // half-initialized.
  const invoker = async (request: Parameters<Invoker>[0]) => {
    const { invoke } = await import('../../invoke');
    return invoke(request);
  };

  const { tools } = await collectTools({
    userId: input.userId,
    agentId: input.agentId,
    threadId: input.threadId,
    mode: 'meeting',
    // A meeting has no workspace: it is not launched from a repo checkout, so
    // only global skills apply — the same position autonomous runs are in.
    workspaceRoot: undefined,
    lockedIn: input.lockedIn,
    taskInvoker: invoker,
  });

  const usable: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (typeof tool.execute !== 'function') {
      // Provider-executed or client-side tools have no local implementation to
      // call; offering them would produce a call the bridge can't answer.
      logger.debug(`[Meeting] Skipping non-executable tool ${name}`);
      continue;
    }
    usable[name] = tool;
  }

  // Owned here rather than in the tool, which is rebuilt per call and has no notion
  // of the call it belongs to. Stays null in `full` mode so a reader can tell "the
  // experiment was off" from "it was on and nothing was delegated".
  const delegation: DelegationStats | null =
    toolMode === 'delegate' ? { total: 0, failures: 0, timeouts: 0, truncated: 0, msTotal: 0 } : null;
  const recordDelegation = (outcome: DelegationOutcome): void => {
    if (!delegation) return;
    delegation.total += 1;
    delegation.msTotal += outcome.ms;
    if (outcome.status === 'timeout') delegation.timeouts += 1;
    if (outcome.status === 'error' || outcome.status === 'empty') delegation.failures += 1;
    if (outcome.truncated) delegation.truncated += 1;
  };

  // Narrow to the experiment's surface. Deliberately done here rather than in
  // `filterToolsByMode`: MCP tools arrive already merged into one opaque dict, so
  // this is the only point that sees the whole catalog the model would otherwise be
  // handed. Replacing rather than filtering, so a newly-added tool cannot leak in.
  const offered: Record<string, Tool> =
    toolMode === 'delegate'
      ? {
          [DELEGATION_TOOL_NAME]: createDelegationTool({
            userId: input.userId,
            agentId: input.agentId,
            invoker,
            onOutcome: recordDelegation,
          }),
          ...Object.fromEntries(
            DELEGATE_MODE_CONTROL_TOOLS.filter((name) => {
              // Loud, because the prompt tells the model to use `leave_meeting` when
              // asked to leave: renaming one of these would silently leave a delegating
              // call unable to hang up, which nobody would connect back to a rename.
              if (!usable[name]) logger.warn(`[Meeting] Control tool ${name} is missing`);
              return usable[name];
            }).map((name) => [name, usable[name]]),
          ),
        }
      : usable;

  const declarations: RealtimeFunctionTool[] = Object.entries(offered).map(([name, tool]) => ({
    name,
    description: describeTool(tool) ?? name,
    // asSchema normalizes both shapes the codebase produces: zod schemas from the
    // built-in tools and pre-wrapped JSON Schema from MCP and the task tool.
    parameters: asSchema(tool.inputSchema).jsonSchema as Record<string, unknown>,
  }));

  logger.info(
    `[Meeting] Offering ${declarations.length} tool(s) to the Realtime model (${toolMode} mode)`,
  );

  return {
    declarations,
    count: declarations.length,
    execute: (name, argumentsJson, abortSignal) =>
      executeTool(offered, name, argumentsJson, abortSignal),
    // Copied on read: the caller reads this at teardown and must not be handed a
    // reference a still-resolving delegation can mutate underneath it.
    delegationStats: () => (delegation ? { ...delegation } : null),
  };
}

/**
 * A tool's description as plain text, or undefined when it declares none.
 *
 * The SDK allows a description to be a function of the tool's execution
 * context, so a declaration has to resolve it rather than read it. The bridge
 * gives no tool a context (see `executeTool`), so it resolves with none — the
 * same value the SDK passes for a tool the caller supplied no context for.
 */
function describeTool(tool: Tool): string | undefined {
  return typeof tool.description === 'function'
    ? tool.description({ context: undefined })
    : tool.description;
}

/**
 * Run one tool call and render the result as text for the model.
 *
 * Never throws: a rejected tool becomes an error string the model can speak
 * ("I couldn't check that because…"), which is far better in a live call than a
 * silent session or a dropped turn. That includes the abort itself — a tool that
 * rejects because the call ended lands in the same catch, and the output is
 * dropped by the caller rather than spoken into a session that is gone.
 */
async function executeTool(
  tools: Record<string, Tool>,
  name: string,
  argumentsJson: string,
  abortSignal: AbortSignal,
): Promise<string> {
  const tool = tools[name];
  if (!tool || typeof tool.execute !== 'function') {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  let args: unknown;
  try {
    args = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
  } catch {
    return JSON.stringify({ error: `Invalid JSON arguments for ${name}` });
  }

  // A call can end between the model asking for a tool and this running — the
  // function-call event and the teardown race. Don't start the work at all.
  if (abortSignal.aborted) {
    logger.info(`[Meeting] Skipping tool ${name}: the call has ended`);
    return JSON.stringify({ error: 'The meeting ended before this could run' });
  }

  try {
    logger.info(`[Meeting] Executing tool ${name}`);
    // The AI SDK passes a call context (toolCallId, messages) that built-in tools
    // ignore; MCP tools and the delegating invoke both read `abortSignal`. It is
    // the meeting's, so leaving the call stops work started for it instead of
    // letting a shell command or an LLM turn run on against a closed session.
    // `context` carries per-tool state a caller can pass through `generateText`;
    // no tool here declares one, so it stays undefined.
    const result = await tool.execute(args, {
      toolCallId: `meeting-${Date.now()}`,
      messages: [],
      abortSignal,
      context: undefined,
    });
    return renderToolResult(result, {
      maxChars: MEETING_MAX_RESULT_CHARS,
      extraGuidance: VOICE_TRUNCATION_GUIDANCE,
      toolName: name,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[Meeting] Tool ${name} failed: ${message}`);
    return JSON.stringify({ error: message });
  }
}

