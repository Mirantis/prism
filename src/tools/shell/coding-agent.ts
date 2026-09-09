/**
 * `coding_agent` + `coding_agent_status` + `coding_agent_stop` tools —
 * in-process port of the upstream Lens Agents handlers.
 *
 * The agent dispatches a task with `coding_agent({ prompt, ... })`, gets back
 * a `taskId`, then polls `coding_agent_status({ taskId })` for drain-on-read
 * output + completion. `coding_agent_stop({ taskId })` abandons a task that is
 * no longer worth waiting out.
 *
 * The available credentials select the coding agent
 * (`lib/coding-agents/`); the sub-agent inherits the runtime's environment, so
 * it authenticates the same way the agent itself does.
 */
import { z } from 'zod';
import { config, CODING_AGENTS } from '../../config';
import { resolvePath } from './workspace';
import { AgentTaskParams, getAgentTaskManager } from './agent-task-manager';

export const codingAgentInput = z.object({
  agent: z.enum(CODING_AGENTS).optional().describe(
    `Coding agent to use. Available values: ${config.availableCodingAgents.join(', ') || 'none detected'}. Default: ${config.codingAgent}. Use the same agent when resuming a session.`,
  ),
  prompt: z.string().describe('The task for the sub-agent to perform'),
  model: z.enum(['small', 'medium', 'large']).optional().describe(
    'Model tier for this task. Small is for mechanical edits and focused reads. Medium is for routine implementation and debugging. Large is for cross-file analysis and design changes. Omit to keep the deployment model.',
  ),
  effort: z.enum(['low', 'medium', 'high']).optional().describe(
    'Reasoning effort for this task. Low is for straightforward tasks with clear steps. Medium is for tasks that need some investigation. High is for difficult reasoning and complex tradeoffs. Omit to keep the deployment effort.',
  ),
  workdir: z
    .string()
    .optional()
    .describe(
      'Working directory. Relative paths resolve from the workspace root; absolute paths pass through.',
    ),
  appendSystemPrompt: z
    .string()
    .optional()
    .describe(
      "Extra instructions appended to the sub-agent's default system prompt. Its built-in tool, todo and search conventions are always kept.",
    ),
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
    .describe('Claude Code turn limit (default: 100, max: 200). Codex runs one task to completion; use coding_agent_stop to cancel.'),
  sessionId: z
    .string()
    .optional()
    .describe(
      'Session ID from a previous coding_agent call to resume context. Pass this when transitioning plan → edit.',
    ),
  debug: z.boolean().optional().describe('Enable debug logging'),
});

export const codingAgentStatusInput = z.object({
  taskId: z.string().describe('Task ID returned by coding_agent'),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(30_000)
    .optional()
    .describe('Max ms to wait for new output if none is buffered (default: 5000)'),
});

export const codingAgentStopInput = z.object({
  taskId: z.string().describe('Task ID returned by coding_agent'),
});

export async function runCodingAgent(
  input: z.infer<typeof codingAgentInput>,
  workspace: string,
) {
  const workdir = input.workdir ? resolvePath(workspace, input.workdir) : workspace;
  const params: AgentTaskParams = {
    agent: input.agent,
    prompt: input.prompt,
    workdir,
    appendSystemPrompt: input.appendSystemPrompt,
    mode: input.mode,
    modelTier: input.model,
    effort: input.effort,
    maxTurns: input.maxTurns,
    sessionId: input.sessionId,
    debug: input.debug,
  };
  return getAgentTaskManager().startTask(params);
}

export async function runCodingAgentStatus(input: z.infer<typeof codingAgentStatusInput>) {
  return getAgentTaskManager().readStatus(input.taskId, input.waitMs);
}

export async function runCodingAgentStop(input: z.infer<typeof codingAgentStopInput>) {
  return getAgentTaskManager().stopTask(input.taskId);
}
