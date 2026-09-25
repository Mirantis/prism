/**
 * Offer a set of the agent's tools to a voice session's backend, and run them when it calls.
 *
 * Every voice session needs this, and one session can own more than one set: the agent's
 * own tools, and the tools of the computer it is working on. So this file holds the
 * adapter and nothing about whose tools it adapts. The caller names itself with `label`,
 * which is what the log lines and the tool-call ids say, and supplies the sentence a
 * truncated result carries, since what the model can do with the part it cannot see
 * depends on the call it is in.
 *
 * Running the tools in this process is not a choice: they are in-process closures over
 * service singletons and a single-writer SQLite handle, and a remote executor could not
 * dial into the container anyway.
 */

import { asSchema, type Tool } from 'ai';
import { logger } from '../../logger';
import { renderAndSpill } from '../../lib/tool-output-limiter';
import type { LiveFunctionTool } from './live-session';

/**
 * Cap on a tool result handed back to the voice session's backend.
 *
 * Smaller than the chat-path budget (`lib/tool-output-limiter.ts`) on purpose: a tool
 * result stays in the backend's context for the rest of the call and is billed on every
 * later response, and what the backend writes is spoken, so a 100 kB `kubectl get` dump
 * only produces a monologue nobody wants.
 *
 * 12,000 (~3k tokens) holds a long issue or a few dozen listed items while staying a
 * modest share of the session. The *shape* of the cut is chat's, not this file's: shared
 * head+tail, and a notice that says outright the result is incomplete.
 */
export const MAX_TOOL_RESULT_CHARS = 12_000;

/** A tool set a voice session can be given, and the way to run what it calls. */
export interface PreparedTools {
  declarations: LiveFunctionTool[];
  count: number;
  execute: (name: string, argumentsJson: string) => Promise<string>;
}

export interface RealtimeToolsOptions {
  /** Names the owner in the log lines and in the tool-call ids. */
  label: string;
  /** What a truncated result tells the model to do with the part it cannot see. */
  truncationGuidance: string;
}

/**
 * Adapt a set of the agent's tools for a voice session's backend.
 *
 * A tool with no local implementation is left out rather than declared: offering one
 * produces a call this file cannot answer.
 */
export function prepareRealtimeTools(
  tools: Record<string, Tool>,
  options: RealtimeToolsOptions,
): PreparedTools {
  const usable: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (typeof tool.execute !== 'function') {
      logger.debug(`[${options.label}] Skipping non-executable tool ${name}`);
      continue;
    }
    usable[name] = tool;
  }

  const declarations: LiveFunctionTool[] = Object.entries(usable).map(([name, tool]) => ({
    name,
    description: describeTool(tool) ?? name,
    // asSchema normalizes both shapes the codebase produces: zod schemas from the
    // built-in tools and pre-wrapped JSON Schema from MCP and the task tool.
    parameters: asSchema(tool.inputSchema).jsonSchema as Record<string, unknown>,
  }));

  return {
    declarations,
    count: declarations.length,
    execute: (name, argumentsJson) => executeTool(usable, name, argumentsJson, options),
  };
}

/**
 * A tool's description as plain text, or undefined when it declares none.
 *
 * A description may be a function of the tool's execution context, so a declaration has
 * to resolve it rather than read it. Nothing here gives a tool a context (see
 * `executeTool`), so it resolves with none.
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
  options: RealtimeToolsOptions,
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
    logger.info(`[${options.label}] Executing tool ${name}`);
    // The call context a chat turn would pass: built-in tools ignore it and MCP tools
    // read only `abortSignal`. A fresh signal keeps the shape valid without promising a
    // cancellation this path does not have. `context` carries per-tool state a caller can
    // pass through `generateText`; no tool here declares one, so it stays undefined.
    const result = await tool.execute(args, {
      toolCallId: `${options.label.toLowerCase()}-${Date.now()}`,
      messages: [],
      abortSignal: new AbortController().signal,
      context: undefined,
    });
    // The same store chat uses, so a call's saved outputs are read back the same
    // way and swept by the same janitor.
    const rendered = await renderAndSpill(result, {
      maxChars: MAX_TOOL_RESULT_CHARS,
      extraGuidance: options.truncationGuidance,
      toolName: name,
    });
    return rendered.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[${options.label}] Tool ${name} failed: ${message}`);
    return JSON.stringify({ error: message });
  }
}
