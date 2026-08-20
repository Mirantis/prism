/**
 * Exposes the agent's real tools to the Realtime model, and runs them.
 *
 * This is what makes the voice in the meeting the agent rather than a narrator:
 * the tools an ordinary chat turn gets — memory, cron, goals, shell, skills, plus
 * everything the Nexus MCP endpoint serves — are offered to the Realtime session as
 * function tools and executed in this process when called. `share_file` is the one
 * exception, dropped by `filterToolsByMode` because a meeting runs neither the
 * invoke loop nor the conversation engine that deliver what it stores.
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
import { renderToolResult } from '../../lib/tool-output-limiter';
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
 * pacing: `shell_spawn` and `claude_code` do hand back a handle immediately, but
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

  const declarations: RealtimeFunctionTool[] = Object.entries(usable).map(([name, tool]) => ({
    name,
    description: describeTool(tool) ?? name,
    // asSchema normalizes both shapes the codebase produces: zod schemas from the
    // built-in tools and pre-wrapped JSON Schema from MCP and the task tool.
    parameters: asSchema(tool.inputSchema).jsonSchema as Record<string, unknown>,
  }));

  logger.info(`[Meeting] Offering ${declarations.length} tool(s) to the Realtime model`);

  return {
    declarations,
    count: declarations.length,
    execute: (name, argumentsJson) => executeTool(usable, name, argumentsJson),
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
    logger.info(`[Meeting] Executing tool ${name}`);
    // The AI SDK passes a call context (toolCallId, messages) that built-in tools
    // ignore; MCP tools only read `abortSignal`. A fresh signal keeps the shape
    // valid without giving the bridge a cancellation story it doesn't have yet.
    // `context` carries per-tool state a caller can pass through `generateText`;
    // no tool here declares one, so it stays undefined.
    const result = await tool.execute(args, {
      toolCallId: `meeting-${Date.now()}`,
      messages: [],
      abortSignal: new AbortController().signal,
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

