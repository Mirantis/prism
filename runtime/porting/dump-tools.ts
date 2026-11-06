/**
 * Dumps every built-in tool the TypeScript runtime defines, as the AI SDK sends it to a
 * provider: `{ type, name, inputSchema, description?, providerOptions? }`. The Rust tool
 * definitions are checked against this output byte for byte.
 *
 * Run from the repo root with Node 24:
 *   DATABASE_URL=file:/tmp/x.db PRISM_DATA_DIR=<tmp> npx tsx runtime/porting/dump-tools.ts <out.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { asSchema } from '@ai-sdk/provider-utils';
import type { Tool } from 'ai';

async function main() {
  const out = process.argv[2];
  const { ensureCodingAgentsDetected } = await import('../../src/lib/coding-agents/availability');
  await ensureCodingAgentsDetected();
  const { getMemoryTools } = await import('../../src/tools/memory');
  const { getComputerTools } = await import('../../src/tools/computer');
  const { getCronTools } = await import('../../src/tools/cron');
  const { getGoalTools } = await import('../../src/tools/goals');
  const { getCodingAgentSignInTools } = await import('../../src/tools/coding-agent-sign-in');
  const { getAgentConfigTools } = await import('../../src/tools/agent-config');
  const { getShellTools } = await import('../../src/tools/shell/index');
  const { getShareFileTools } = await import('../../src/tools/share-file');
  const { getSendMessageTools } = await import('../../src/tools/send-message');
  const { getAttachmentTools } = await import('../../src/tools/attachments');
  const { getWebFetchTools } = await import('../../src/tools/web/web-fetch');
  const { getConversationHistoryTools } = await import('../../src/tools/conversation-history');
  const { getSkillTools } = await import('../../src/tools/skills/index');
  const { getMeetingTools } = await import('../../src/tools/meeting');
  const { createTaskTool } = await import('../../src/lib/task-tool');

  const groups: Record<string, () => Promise<Record<string, Tool>> | Record<string, Tool>> = {
    memory: () => getMemoryTools('user-1', 'agent-1'),
    'computer:chat': () => getComputerTools(undefined, undefined, 'chat'),
    'cron:chat': () => getCronTools('user-1', 'agent-1', 'chat', 'thread-1', 'websocket', undefined),
    'cron:heartbeat': () => getCronTools('user-1', 'agent-1', 'heartbeat', undefined, 'websocket', undefined),
    goals: () => getGoalTools('user-1', 'agent-1', 'thread-1', 'websocket', undefined),
    'coding-agent-sign-in': () =>
      getCodingAgentSignInTools('user-1', 'agent-1', 'thread-1', 'websocket', undefined, ['claude-code', 'codex']),
    'agent-config': () => getAgentConfigTools(),
    shell: () => getShellTools(undefined, undefined),
    'share-file': () => getShareFileTools(undefined, undefined),
    'send-message:chat': () =>
      getSendMessageTools('user-1', 'agent-1', 'chat', 'thread-1', 'websocket', undefined, undefined),
    'send-message:heartbeat': () =>
      getSendMessageTools('user-1', 'agent-1', 'heartbeat', undefined, 'websocket', undefined, {
        webChat: true,
        targets: [],
      } as never),
    attachments: () => getAttachmentTools('user-1', 'agent-1', 'thread-1', undefined, undefined),
    'web-fetch': () => getWebFetchTools('user-1', 'agent-1'),
    'conversation-history': () => getConversationHistoryTools('thread-1', undefined),
    skills: () => getSkillTools(undefined),
    'meeting:chat': () => getMeetingTools({ userId: 'user-1', agentId: 'agent-1', threadId: 'thread-1', inMeetingSession: false }),
    'meeting:meeting': () => getMeetingTools({ userId: 'user-1', agentId: 'agent-1', threadId: 'thread-1', inMeetingSession: true }),
    task: () => ({
      Task: createTaskTool(
        [{ id: 'sub-1', name: 'Researcher', description: 'Finds things out.' }] as never,
        'user-1',
        async () => ({}) as never,
      ),
    }),
  };

  const result: Record<string, unknown> = {};
  for (const [group, build] of Object.entries(groups)) {
    try {
      const tools = await build();
      const entries: unknown[] = [];
      for (const [name, tool] of Object.entries(tools)) {
        const description =
          tool.description === undefined || typeof tool.description === 'string'
            ? tool.description
            : '<function>';
        entries.push({
          type: 'function',
          name,
          inputSchema: await asSchema(tool.inputSchema).jsonSchema,
          ...(description != null ? { description } : {}),
          ...(tool.providerOptions != null ? { providerOptions: tool.providerOptions } : {}),
        });
      }
      result[group] = entries;
    } catch (err) {
      result[group] = { error: err instanceof Error ? err.stack ?? err.message : String(err) };
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${out}`);
  process.exit(0);
}

void main();
