/**
 * `prism acp` against a real runtime, used the way an editor uses it: the test
 * starts the command, speaks the Agent Client Protocol on its stdio with the
 * protocol's own client library, and reads what the agent sends back.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
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
import { PRISM_CLI_BIN } from '../../support/runtime-command';
import { runtimeRequest, setupRuntime, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(readFileSync(join(import.meta.dirname, '../features/acp.feature'), 'utf8'));

interface AcpClient {
  agent: ClientContext;
  /** Every session update the agent sent, in order. */
  updates: SessionUpdate[];
  /** Close the agent's stdin, as an editor that quits does. */
  closeInput(): void;
  /** Resolves when the process exits. */
  exited: Promise<void>;
  stop(): void;
}

/** Start `prism acp` as an editor does, and complete the handshake. */
async function startAcpClient(env: NodeJS.ProcessEnv): Promise<AcpClient> {
  const child: ChildProcess = spawn(PRISM_CLI_BIN, ['acp'], {
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
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { agent: connection.agent, updates, closeInput: () => child.stdin!.end(), exited, stop: () => child.kill() };
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
let quitting: AcpClient;
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
    quitting?.stop();
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

  Scenario('The ACP client quits while a prompt is still running', ({ Given, When, Then, And }) => {
    let quitSession: string;
    Given('an ACP client that started "prism acp"', async () => {
      quitting = await startAcpClient(env.prismEnv);
    });
    When('the client starts a session in a project folder', async () => {
      ({ sessionId: quitSession } = await quitting.agent.request(methods.agent.session.new, {
        cwd: projectDir,
        mcpServers: [],
      }));
    });
    And('the client prompts the agent to run "sleep 30" in its shell', () => {
      // The answer comes only when the turn ends, after the client has gone.
      void quitting.agent
        .request(methods.agent.session.prompt, {
          sessionId: quitSession,
          prompt: [{ type: 'text', text: 'You MUST call the shell_exec tool with command: sleep 30. Then reply "done".' }],
        })
        .catch(() => {});
    });
    And('the agent is working on the prompt', async () => {
      await expect
        .poll(async () => (await runtimeRequest<{ state: string }>(env.port, 'GET', '/agents/state')).state, {
          timeout: 60_000,
        })
        .toBe('working');
    });
    When('the client closes its end of the connection', () => {
      quitting.closeInput();
    });
    Then('"prism acp" exits within 5 seconds', async () => {
      const timedOut = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000));
      expect(await Promise.race([quitting.exited.then(() => 'exited' as const), timedOut])).toBe('exited');
    });
  });
});
