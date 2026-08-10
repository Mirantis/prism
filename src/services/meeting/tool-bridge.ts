/**
 * Exposes the agent's real tools to the Realtime model, and runs them.
 *
 * This is what makes the voice in the meeting the agent rather than a narrator:
 * the same tools an ordinary chat turn gets — memory, cron, goals, shell, skills,
 * plus everything the Nexus MCP endpoint serves — are offered to the Realtime
 * session as function tools and executed in this process when called.
 *
 * Executing them here (rather than via OpenAI's remote-MCP feature) is not a
 * choice: the tools are in-process closures over service singletons and a
 * single-writer SQLite handle, and OpenAI's servers could not dial into the
 * container anyway.
 *
 * Because the bridge runs tools on behalf of whoever is talking, everything a
 * meeting participant says is untrusted input with tool authority behind it. Two
 * guards live here: the `meeting` tool mode drops what doesn't belong in a live
 * call, and every result is size-capped before it goes back to a model that has to
 * *say* it out loud.
 */

import { asSchema, type Tool } from 'ai';
import { logger } from '../../logger';
import { collectTools } from '../../lib/tool-collection';
import type { RealtimeFunctionTool } from './realtime-session';

/**
 * Cap on a tool result handed back to the Realtime model.
 *
 * Much smaller than the chat-path limits (`lib/tool-output-limiter.ts`) on
 * purpose: this model speaks its answer, and a 100 kB `kubectl get` dump costs
 * audio tokens and produces a monologue nobody wants. Truncation is announced in
 * the payload so the model says "there's more" instead of inventing an ending.
 */
const MAX_RESULT_CHARS = 4000;

export interface MeetingToolBridgeInput {
  userId: string;
  agentId: string;
  threadId?: string;
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
 * The Task tool is not offered even when subagents exist: it is collected by
 * `collectTools` and then dropped here, because a subagent invocation runs for
 * minutes while the meeting waits in silence. Long work belongs in a chat turn the
 * agent can follow up on.
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
    // Unreachable: the Task tool is dropped below, so nothing can invoke this.
    // Kept explicit rather than cast away so a future change fails loudly.
    taskInvoker: async () => {
      throw new Error('Subagent tasks are not available during a live meeting.');
    },
  });

  const usable: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (name === 'Task') continue;
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
    description: tool.description ?? name,
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
    const result = await tool.execute(args, {
      toolCallId: `meeting-${Date.now()}`,
      messages: [],
      abortSignal: new AbortController().signal,
    });
    return truncate(stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[Meeting] Tool ${name} failed: ${message}`);
    return JSON.stringify({ error: message });
  }
}

/** Render whatever a tool returned as a string the model can read. */
function stringify(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined || result === null) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n\n[truncated ${text.length - MAX_RESULT_CHARS} characters — summarize what's here and offer ` +
    `to follow up in chat with the full result]`
  );
}
