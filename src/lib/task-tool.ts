import { jsonSchema, Tool } from 'ai';
import type { SubagentInfo } from '../services/agent-workspace.service';
import { logger } from '../logger';
import type { InvokeRequest, InvokeResponse } from '../types';

export type Subagent = {
  name: string;
  description: string;
}

export type Invoker = (request: InvokeRequest) => Promise<InvokeResponse>;

const taskToolSchema = jsonSchema({
  type: 'object',
  properties: {
    description: {
      description: 'A short (3-5 word) description of the task',
      type: 'string',
    },
    prompt: {
      description: 'The task for the agent to perform',
      type: 'string',
    },
    subagent_type: {
      description: 'The type of specialized agent to use for this task',
      type: 'string',
    },
  },
  required: ['description', 'prompt', 'subagent_type'],
  additionalProperties: false,
});

/**
 * Create a Task tool that delegates work to subagents.
 *
 * The factory captures the subagents list and an invoker function,
 * avoiding circular dependencies (task-tool doesn't import invoke).
 */
export function createTaskTool(
  subagents: SubagentInfo[],
  userId: string,
  invoker: Invoker,
): Tool {
  return {
    description:
      'Launch a new agent to handle complex, multi-step tasks autonomously. Use a subagent ' +
      "whenever the task matches its description. Each invocation begins with a clean slate: the " +
      'agent does not see this conversation, so give it clear and detailed instructions with all ' +
      'the context it needs, and say whether it should change anything or only research. Its ' +
      'output is not shown to the user, so tell the user the outcome.',
    inputSchema: taskToolSchema,
    execute: async (input) => {
      logger.info(`[TaskTool] Received task with input: ${JSON.stringify(input)}`);
      const { description, subagent_type, prompt } = input as {
        description: string;
        prompt: string;
        subagent_type: string;
      };

      const subagent = subagents.find((s) => s.name === subagent_type);

      if (!subagent) {
        return {
          error: `Unknown subagent type: "${subagent_type}". Available: ${subagents.map((s) => s.name).join(', ')}`,
        };
      }

      logger.info(`[TaskTool] Invoking subagent "${subagent.name}" (${subagent.id})`);

      const result = await invoker({
        userId,
        agentId: subagent.id,
        mode: 'subagent',
        prompt: `${description}\n${prompt}`,
      });

      logger.info(`[TaskTool] Subagent "${subagent.name}" responded with: ${JSON.stringify(result.response)} with ${result.toolCalls.length} tool calls`);

      return {
        response: result.response,
        // What the subagent did, as the parent model needs to see it. The stored
        // record also carries `rendered`/`truncated` — bookkeeping for replay and
        // for the UI, meaningless to a model and pure noise in its prompt.
        toolCalls: result.toolCalls.map(({ tool, input, output, success, timestamp }) => ({
          tool,
          input,
          output,
          success,
          timestamp,
        })),
      };
    },
  };
}
