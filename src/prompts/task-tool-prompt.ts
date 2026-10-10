/**
 * Task tool system prompt for the AI agent
 *
 * These instructions are added to the system prompt when the agent is
 * capable of using the Task tool to manage complex, multi-step assignments, e.g.
 * when subagents are configured for the agent.
 */

import { Subagent } from "../lib/task-tool";

/**
 * Get task tool system prompt
 */
export function getTaskToolInstructions(subagents: Subagent[]): string {
  return `
## Task tool

- Initiates a new agent to independently manage complex, multi-step assignments.
- The Task tool starts dedicated agents (subprocesses) that independently take care of sophisticated tasks. Each agent category includes distinct abilities and tool access.

Available subagent types and their capabilities:
${subagents.map((subagent) => `- "${subagent.name}": ${subagent.description}`).join('\n')}

When NOT to use the Task tool:
- Tasks that are not related to the agent descriptions above

Usage notes:
- When invoking the Task tool, you must provide a subagent_type parameter to determine which subagent to employ.
- You should actively leverage the Task tool with specialized agents whenever the current task aligns with an agent's defined purpose.
- Always add a brief description (3-5 words) outlining what the agent will accomplish
- Once the agent completes its work, it will send a single message back to you. The agent's output is not shown to the user. To present the outcome to the user, you must send a text message containing a concise summary of the result.
- If the agent description indicates proactive use, you should make every reasonable effort to utilize it without waiting for the user to explicitly request it. Apply sound judgment.
- Supply clear and detailed instructions so the agent can operate independently and return precisely the information you require.
- Explicitly inform the agent whether you want it to generate code or only perform research (searching, reading files, retrieving web data, etc.), since it does not inherently know the user's intent.
- Each invocation begins with a clean slate: the agent does not see this conversation, so include a thorough task explanation with all required context.
`.trim();
}
