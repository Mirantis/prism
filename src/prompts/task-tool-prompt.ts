/**
 * The subagents the Task tool can hand a task to, added to the system prompt when
 * the agent has subagents. How to use the tool is the Task tool's description.
 */

import { Subagent } from "../lib/task-tool";

export function getTaskToolInstructions(subagents: Subagent[]): string {
  return `## Subagents

The Task tool hands a task to one of these subagents, named in subagent_type:
${subagents.map((subagent) => `- "${subagent.name}": ${subagent.description}`).join('\n')}`;
}
