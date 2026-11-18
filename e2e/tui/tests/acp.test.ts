/**
 * `prism acp` against a real runtime, used the way an editor uses it: the test
 * starts the command, speaks the Agent Client Protocol on its stdio with the
 * protocol's own client library, and reads what the agent sends back.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import {
  client,
  methods,
  ndJsonStream,
  type ClientContext,
  type PromptResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { PRISM_CLI_DIR } from '../harness';
import { setupRuntime, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(readFileSync(join(import.meta.dirname, '../features/acp.feature'), 'utf8'));

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

interface AcpClient {
  agent: ClientContext;
  /** Every session update the agent sent, in order. */
  updates: SessionUpdate[];
  stop(): void;
}

/** Start `prism acp` as an editor does, and complete the handshake. */
async function startAcpClient(env: NodeJS.ProcessEnv): Promise<AcpClient> {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, join(PRISM_CLI_DIR, 'src/index.tsx'), 'acp'], {
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const updates: SessionUpdate[] = [];
  const connection = client({ name: 'e2e-editor' })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    })
    .connect(
      ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>),
    );
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1 });
  return { agent: connection.agent, updates, stop: () => child.kill() };
}

function textOf(updates: SessionUpdate[], kind: 'agent_message_chunk' | 'user_message_chunk'): string {
  return updates
    .flatMap((update) => (update.sessionUpdate === kind && update.content.type === 'text' ? [update.content.text] : []))
    .join('\n');
}

let env: RuntimeTestEnv;
let projectDir: string;
let first: AcpClient;
let second: AcpClient;
let sessionId: string;
let response: PromptResponse;
const PROMPT = 'You MUST call the shell_exec tool with command: pwd. After it returns, reply with its output only.';

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, Scenario }) => {
  BeforeAllScenarios(async () => {
    env = await setupRuntime();
    // The agent's shell reports the canonical path, which on macOS is not the one `tmpdir()` gives.
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'acp-e2e-project-')));
  });
  AfterAllScenarios(async () => {
    first?.stop();
    second?.stop();
    await env.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  });

  Scenario(
    'An ACP client prompts the agent in a project folder, and a later client loads the session',
    ({ Given, When, Then, And }) => {
      Given('an ACP client that started "prism acp"', async () => {
        first = await startAcpClient(env.prismEnv);
      });
      When('the client starts a session in a project folder', async () => {
        ({ sessionId } = await first.agent.request(methods.agent.session.new, { cwd: projectDir, mcpServers: [] }));
      });
      And('the client prompts the agent to run "pwd" in its shell', async () => {
        response = await first.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: PROMPT }],
        });
      });
      Then('the prompt ends with the stop reason "end_turn"', () => {
        expect(response.stopReason).toBe('end_turn');
      });
      And('the client was shown the shell_exec tool call and a reply that names the project folder', () => {
        // Read at the moment the prompt ended: the protocol sends a turn's updates before its response.
        const toolCalls = first.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' ? [update] : []));
        expect(toolCalls).toContainEqual(
          expect.objectContaining({
            title: 'shell_exec',
            status: 'completed',
            // The model can add the tool's optional arguments.
            rawInput: expect.objectContaining({ command: 'pwd' }),
          }),
        );
        expect(textOf(first.updates, 'agent_message_chunk')).toContain(projectDir);
        // The client drew its own prompt, so the agent does not send it back.
        expect(textOf(first.updates, 'user_message_chunk')).toBe('');
      });
      When('a second ACP client starts "prism acp"', async () => {
        second = await startAcpClient(env.prismEnv);
      });
      Then('it lists the session under the project folder', async () => {
        const { sessions } = await second.agent.request(methods.agent.session.list, { cwd: projectDir });
        expect(sessions).toEqual([expect.objectContaining({ sessionId, cwd: projectDir })]);
      });
      And('loading the session replays the prompt and the reply', async () => {
        await second.agent.request(methods.agent.session.load, { sessionId, cwd: projectDir, mcpServers: [] });
        expect(textOf(second.updates, 'user_message_chunk')).toBe(PROMPT);
        expect(textOf(second.updates, 'agent_message_chunk')).toContain(projectDir);
      });
    },
  );
});
