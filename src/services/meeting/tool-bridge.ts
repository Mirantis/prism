/**
 * Exposes the agent's real tools to the Realtime model, and runs them.
 *
 * This is what makes the voice in the meeting the agent rather than a narrator:
 * the tools an ordinary chat turn gets — memory, cron, goals, shell, skills, plus
 * everything the Lens Agents MCP endpoint serves — are offered to the Realtime session as
 * function tools and executed in this process when called. `filterToolsByMode` makes two
 * changes for `meeting`: it drops `share_file`, because a meeting runs neither the invoke
 * loop nor the conversation engine that deliver what it stores, and it adds
 * `send_meeting_chat`, which posts one short line into the call's own chat and which chat
 * mode does not get.
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

import { asSchema, type Tool } from 'ai';
import { logger } from '../../logger';
import { collectTools } from '../../lib/tool-collection';
import { MEETING_TOOL_NAMES } from '../../tools/meeting';
import { renderAndSpill } from '../../lib/tool-output-limiter';
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

export interface PreparedMeetingTools {
  /** Declarations for `session.update`. */
  declarations: RealtimeFunctionTool[];
  /** Executes a call by name; never throws — errors come back as text. */
  execute: (name: string, argumentsJson: string) => Promise<string>;
  /** Tool count, for logging and telemetry. */
  count: number;
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
): Promise<PreparedMeetingTools> {
  const { tools } = await collectTools({
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

  const prepared = prepareRealtimeTools(tools, 'Meeting');
  logger.info(`[Meeting] Offering ${prepared.count} tool(s) to the Realtime model`);
  return prepared;
}

/**
 * Adapt a set of AI SDK tools for the Realtime API.
 *
 * `label` names the owner in the log lines, since a session offers two sets: the agent's
 * own, and the tools of the computer it is working on.
 *
 * A tool with no local implementation is left out rather than declared: offering one
 * produces a call the bridge cannot answer.
 */
export function prepareRealtimeTools(
  tools: Record<string, Tool>,
  label: string,
): PreparedMeetingTools {
  const usable: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (typeof tool.execute !== 'function') {
      logger.debug(`[${label}] Skipping non-executable tool ${name}`);
      continue;
    }
    usable[name] = tool;
  }

  const declarations: RealtimeFunctionTool[] = Object.entries(usable).map(([name, tool]) => ({
    name,
    description: describeTool(tool) ?? name,
    // asSchema normalizes both shapes the codebase produces: zod schemas from the
    // built-in tools and pre-wrapped JSON Schema from MCP and the task tool.
    parameters: asSchema(tool.inputSchema).jsonSchema as Record<string, unknown>,
  }));

  return {
    declarations,
    count: declarations.length,
    execute: (name, argumentsJson) => executeTool(usable, name, argumentsJson, label),
  };
}

/**
 * The agent's set as a voice chat gets it: the meeting's own tools dropped, and the
 * computer's laid over the gap when the session has one.
 *
 * The meeting tools go whether or not there is a replacement, since each of them acts on
 * a call this session is not in. `browse` and `see_screen` come back pointed at the
 * computer, under the same names, so the prompt text written for a call still reads true.
 */
export function prepareVoiceChatTools(
  base: PreparedMeetingTools,
  computer: PreparedMeetingTools | null,
): PreparedMeetingTools {
  const extra = computer?.declarations ?? [];
  const dropped = new Set<string>([...MEETING_TOOL_NAMES, ...extra.map((d) => d.name)]);
  const declarations = [...base.declarations.filter((d) => !dropped.has(d.name)), ...extra];
  const extraNames = new Set(extra.map((d) => d.name));
  return {
    declarations,
    count: declarations.length,
    execute: (name, argumentsJson) =>
      computer && extraNames.has(name)
        ? computer.execute(name, argumentsJson)
        : base.execute(name, argumentsJson),
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
 * silent session or a dropped turn.
 */
async function executeTool(
  tools: Record<string, Tool>,
  name: string,
  argumentsJson: string,
  label: string,
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

  try {
    logger.info(`[${label}] Executing tool ${name}`);
    // The AI SDK passes a call context (toolCallId, messages) that built-in tools
    // ignore; MCP tools only read `abortSignal`. A fresh signal keeps the shape
    // valid without giving the bridge a cancellation story it doesn't have yet.
    // `context` carries per-tool state a caller can pass through `generateText`;
    // no tool here declares one, so it stays undefined.
    const result = await tool.execute(args, {
      toolCallId: `${label.toLowerCase()}-${Date.now()}`,
      messages: [],
      abortSignal: new AbortController().signal,
      context: undefined,
    });
    // The same store chat uses, so a call's saved outputs are read back the same
    // way and swept by the same janitor.
    const rendered = await renderAndSpill(result, {
      maxChars: MEETING_MAX_RESULT_CHARS,
      extraGuidance: VOICE_TRUNCATION_GUIDANCE,
      toolName: name,
    });
    return rendered.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[${label}] Tool ${name} failed: ${message}`);
    return JSON.stringify({ error: message });
  }
}

