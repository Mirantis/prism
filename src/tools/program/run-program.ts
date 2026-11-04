/**
 * run_program: the model writes a JavaScript program that calls its other tools.
 *
 * One model step can then run many tool calls, in loops and in parallel, and only
 * what the program prints comes back into the context. Each call inside the program
 * goes through the same tool the model would call directly, risk gate included, so
 * the program reaches nothing the model could not reach one call at a time.
 */

import { asSchema, tool, type Tool } from 'ai';
import { z } from 'zod';
import type { PendingFileWrites } from '../../lib/pending-file-writes';
import { trackEvent } from '../../lib/telemetry';
import { logger } from '../../logger';
import { hasModelOnlyOutput } from './model-only';
import { MAX_PRINTED_CHARS, runInSandbox, type SandboxLimits, type SandboxResult } from './sandbox';

export const PROGRAM_TOOL_NAME = 'run_program';

export const PROGRAM_LIMITS: SandboxLimits = {
  timeoutMs: 10 * 60_000,
  maxToolCalls: 500,
  maxConcurrentCalls: 10,
  // The host's event loop waits while the interpreter computes, so a slice is short.
  sliceMs: 200,
  cpuBudgetMs: 30_000,
};

const DESCRIPTION = `Run a JavaScript program that calls your other tools. Use it when a task needs several tool calls, a loop over many items, or results filtered before you read them: one program replaces many separate tool calls.

The code is the body of an async function, so use \`await\` and \`return\` at the top level. Each tool is an async function on \`tools\`, named as in your tool list, that takes the same input object and resolves with the tool's result:

const files = await tools.shell_exec({ command: 'ls src' });
const results = await Promise.all(names.map((name) => tools.memory_search({ query: name })));

A call rejects with an Error when the tool fails or is refused, and the program can catch it. Run independent calls together with Promise.all. Only what the program prints with console.log and the value it returns come back to you, so print the facts you need, not whole results.

The program runs in an isolated interpreter: no require, filesystem, network or timers, and it reaches the outside only through \`tools\`. ${PROGRAM_LIMITS.maxToolCalls} tool calls and ${PROGRAM_LIMITS.timeoutMs / 60_000} minutes per run. Tools that return images, and run_program itself, are not on \`tools\`.`;

export const programInput = z.object({
  code: z.string().describe('The JavaScript program: the body of an async function.'),
});

export interface ProgramToolOptions {
  userId: string;
  agentId: string;
  invocationMode: string;
  /**
   * The step's file writes. A program can write any file through its shell calls,
   * so it holds every reader in its step until it ends, as `shell_exec` does.
   */
  pendingWrites?: PendingFileWrites;
  /** Told of each call the program made, once it has finished. */
  onCall?: (call: ProgramCall) => void;
}

/** One call a program made, for the run's tool-call record. */
export interface ProgramCall {
  /** The `run_program` call the program ran in. */
  parentCallId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** The tool's result, when the call succeeded. */
  output?: unknown;
  /** Why the call failed: what it threw, a refusal by the risk gate included, or an MCP error result. */
  error?: unknown;
}

/**
 * The program tool over `tools`. A tool marked with `withModelOnlyOutput` returns
 * content only a model reads, such as an image, so it stays outside the program. A
 * `toModelOutput` alone does not keep a tool out: the SDK gives one to every MCP tool.
 */
export function createProgramTool(tools: Record<string, Tool>, options: ProgramToolOptions): Tool {
  const callable = Object.entries(tools).filter(
    ([name, candidate]) => name !== PROGRAM_TOOL_NAME && candidate.execute && !hasModelOnlyOutput(candidate),
  );
  const byName = new Map(callable);
  const toolNames = callable.map(([name]) => name);

  return tool({
    description: DESCRIPTION,
    inputSchema: programInput,
    onInputAvailable: ({ toolCallId }) =>
      options.pendingWrites?.register(toolCallId, PROGRAM_TOOL_NAME, undefined, { outsideCallersOnly: true }),
    execute: async ({ code }, executionOptions) => {
      const parentCallId = executionOptions.toolCallId;
      const startedAt = Date.now();
      let callIndex = 0;
      let result: SandboxResult;
      try {
        result = await runInSandbox({
          code,
          toolNames,
          limits: PROGRAM_LIMITS,
          abortSignal: executionOptions.abortSignal,
          callTool: async (name, input, signal) => {
            const target = byName.get(name);
            if (!target?.execute) throw new Error(`No tool named ${name}.`);
            const parsed = await validate(target, input);
            callIndex++;
            const toolCallId = `${parentCallId}:${callIndex}`;
            const callOptions = { ...executionOptions, toolCallId, abortSignal: signal };
            const report = (outcome: { output: unknown } | { error: unknown }) =>
              options.onCall?.({ parentCallId, toolCallId, toolName: name, input: parsed, ...outcome });
            let output: unknown;
            try {
              // As the SDK does for a direct call: a write registers here, and a
              // reader announces itself, before the call executes.
              await target.onInputAvailable?.({ ...callOptions, input: parsed });
              output = await target.execute(parsed, callOptions);
            } catch (error) {
              report({ error });
              throw error;
            } finally {
              // A refused write never reaches its own settle.
              options.pendingWrites?.settle(toolCallId);
            }
            // An MCP error result is a failed call, reported once as its error.
            let value: unknown;
            try {
              value = programValue(output);
            } catch (error) {
              report({ error });
              throw error;
            }
            report({ output });
            return value;
          },
        });
      } catch (err) {
        logger.error({ err }, '[run_program] the sandbox failed');
        result = { status: 'error', printed: '', printedCut: false, error: 'The program could not run.', toolCalls: callIndex };
      } finally {
        options.pendingWrites?.settle(parentCallId);
      }

      trackEvent('program run finished', options.userId, {
        'agent.id': options.agentId,
        'invoke.mode': options.invocationMode,
        'program.status': result.status,
        'program.tool_calls': String(result.toolCalls),
        'program.elapsed_ms': String(Date.now() - startedAt),
      });

      return renderResult(result);
    },
  });
}

/**
 * What a program gets from a tool's result. An MCP tool returns an MCP result, whose
 * text the model reads: the program gets its structured content, or else its text,
 * and an MCP error rejects the call.
 */
export function programValue(output: unknown): unknown {
  if (!isMcpResult(output)) return output;
  const text = output.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  if (output.isError) throw new Error(text || 'The tool failed.');
  return output.structuredContent ?? text;
}

interface McpResult {
  content: { type: string; text?: unknown }[];
  structuredContent?: unknown;
  isError?: boolean;
}

function isMcpResult(output: unknown): output is McpResult {
  if (!output || typeof output !== 'object') return false;
  const content = (output as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.every((part) => Boolean(part) && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string')
  );
}

/** Checks a program's input against the tool's schema, as the SDK does for a direct call. */
async function validate(target: Tool, input: unknown): Promise<unknown> {
  const schema = asSchema(target.inputSchema);
  if (!schema.validate) return input;
  const outcome = await schema.validate(input);
  if (outcome.success) return outcome.value;
  throw new Error(`Invalid input: ${outcome.error.message}`);
}

function renderResult(result: SandboxResult): string {
  const parts: string[] = [];
  if (result.printed) parts.push(result.printed.trimEnd());
  if (result.printedCut) {
    parts.push(
      `(Output cut at ${MAX_PRINTED_CHARS.toLocaleString('en-US')} characters: whatever the program printed after that was not kept. Print less, or return the answer.)`,
    );
  }
  if (result.returned !== undefined) parts.push(`Returned: ${result.returned}`);
  if (result.error) parts.push(`Program stopped (${result.status}): ${result.error}`);
  parts.push(`(${result.toolCalls} tool call${result.toolCalls === 1 ? '' : 's'})`);
  return parts.join('\n\n');
}
