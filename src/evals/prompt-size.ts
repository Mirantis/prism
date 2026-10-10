/**
 * The size of the product text in a direct-message chat turn, in characters, as
 * the ticket's size criterion counts it: the system prompt the product writes, the
 * seeded templates a new agent starts with, and the built-in tool and parameter
 * descriptions. The tools are the chat set without the `computer_*` tools and with
 * the meeting tools, so the host's desktop and meeting toolchains leave the figure
 * alone. The `coding_agent` description names the coding agents the host has.
 */

import { asSchema, type Tool } from 'ai';
import { collectTools, filterToolsByMode } from '../lib/tool-collection';
import { buildSystemPromptParts } from '../prompts/context-builder';
import { getMeetingTools } from '../tools/meeting';
import { EVAL_AGENT_ID, EVAL_USER_ID, agentContext } from './harness';

export interface PromptSize {
  /** The system prompt with every workspace document empty. */
  productText: number;
  /** What the default soul, guide, user, memory and heartbeat documents add to it. */
  seededTemplates: number;
  /** Tool descriptions plus every parameter description in their schemas. */
  toolDescriptions: number;
}

export async function measurePromptSize(): Promise<PromptSize> {
  const context = await agentContext();
  const withoutDocuments = {
    ...context,
    soulMd: '',
    agentMd: '',
    userMd: '',
    memoryMd: '',
    heartbeatMd: '',
    visionMd: '',
  };
  const full = await systemPromptChars(context);
  const productText = await systemPromptChars(withoutDocuments);

  const { tools } = await collectTools({
    userId: EVAL_USER_ID,
    agentId: EVAL_AGENT_ID,
    mode: 'chat',
    taskInvoker: async () => {
      throw new Error('Not invoked.');
    },
    lockedIn: false,
  });
  const meetingTools = filterToolsByMode(
    getMeetingTools({ userId: EVAL_USER_ID, agentId: EVAL_AGENT_ID }),
    'chat',
  );
  const builtIns = { ...tools, ...meetingTools };

  let toolDescriptions = 0;
  for (const [name, tool] of Object.entries(builtIns)) {
    if (name.startsWith('computer_')) continue;
    toolDescriptions += await descriptionChars(tool);
  }

  return { productText, seededTemplates: full - productText, toolDescriptions };
}

async function systemPromptChars(context: Awaited<ReturnType<typeof agentContext>>): Promise<number> {
  const parts = await buildSystemPromptParts(context, 'chat');
  return parts.reduce((sum, part) => sum + part.text.length, 0);
}

async function descriptionChars(tool: Tool): Promise<number> {
  const schema = await asSchema(tool.inputSchema).jsonSchema;
  const description = typeof tool.description === 'string' ? tool.description.length : 0;
  return description + schemaDescriptionChars(schema);
}

function schemaDescriptionChars(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, item) => sum + schemaDescriptionChars(item), 0);
  if (typeof node !== 'object' || node === null) return 0;
  let sum = 0;
  for (const [key, value] of Object.entries(node)) {
    sum += key === 'description' && typeof value === 'string' ? value.length : schemaDescriptionChars(value);
  }
  return sum;
}
