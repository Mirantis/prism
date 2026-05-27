/**
 * `claude_code` + `claude_code_status` tools — in-process port of
 * the upstream Nexus handlers.
 *
 * The agent dispatches a task with `claude_code({ prompt, ... })`,
 * gets back a `taskId`, then polls `claude_code_status({ taskId })`
 * for drain-on-read output + completion.
 *
 * Auth inherits from the agent-runtime's env: the spawned `claude`
 * CLI picks up `AWS_BEARER_TOKEN_BEDROCK` / `CLAUDE_CODE_USE_BEDROCK=1`
 * (injected by the Nexus policy) and authenticates through the same
 * Bearer-Bedrock path the agent itself uses.
 */
import { z } from 'zod';
import { resolvePath } from './workspace';
import { resolveWorkspaceRoot } from './config';
import {
  AgentTaskParams,
  getAgentTaskManager,
} from './agent-task-manager';

export const claudeCodeInput = z.object({
  prompt: z.string().describe('The task for the sub-agent to perform'),
  workdir: z
    .string()
    .optional()
    .describe(
      'Working directory. Relative paths resolve from the workspace root; absolute paths pass through.',
    ),
  systemPrompt: z.string().optional().describe('Custom system prompt for the sub-agent'),
  mode: z
    .enum(['edit', 'plan'])
    .optional()
    .describe(
      '"edit" (default) allows code changes, "plan" only analyzes. Pass sessionId from plan to edit to preserve context.',
    ),
  maxTurns: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum agent turns before stopping (default: 100, max: 200)'),
  sessionId: z
    .string()
    .optional()
    .describe(
      'Session ID from a previous claude_code call to resume context. Pass this when transitioning plan → edit.',
    ),
  debug: z.boolean().optional().describe('Enable debug logging'),
});

export const claudeCodeStatusInput = z.object({
  taskId: z.string().describe('Task ID returned by claude_code'),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(30_000)
    .optional()
    .describe('Max ms to wait for new output if none is buffered (default: 5000)'),
});

export async function runClaudeCode(input: z.infer<typeof claudeCodeInput>) {
  const workspace = resolveWorkspaceRoot();
  const workdir = input.workdir ? resolvePath(workspace, input.workdir) : workspace;
  const params: AgentTaskParams = {
    prompt: input.prompt,
    workdir,
    systemPrompt: input.systemPrompt,
    mode: input.mode,
    maxTurns: input.maxTurns,
    sessionId: input.sessionId,
    debug: input.debug,
  };
  const taskId = getAgentTaskManager().startTask(params);
  return { taskId };
}

export async function runClaudeCodeStatus(input: z.infer<typeof claudeCodeStatusInput>) {
  return getAgentTaskManager().readStatus(input.taskId, input.waitMs);
}
