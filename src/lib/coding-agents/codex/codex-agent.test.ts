import { config } from '../../../config';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeChild } from '../../../test-utils/fake-child';
import { PLAN_ONLY_INSTRUCTION, type CodingAgentEvent, type CodingAgentTask } from '../coding-agent';
import { createCodexAgent } from './codex-agent';
import { fakeExecutionEnvironment, type FakeRun } from '../../../test-utils/fake-execution-environment';
import { localFiles } from '../../execution-environments/local/local-files';
import type { ExecutionEnvironment, RunOptions } from '../../execution-environments/execution-environment';
import { __setExecutionEnvironmentForTests } from '../../execution-environments/get-execution-environment';
import { trackEvent } from '../../telemetry';

vi.mock('../../telemetry', () => ({ trackEvent: vi.fn() }));

/** The environment a task's workdir resolves to, when a test stands one in. */
const forPath = vi.hoisted(() => ({ environment: null as ExecutionEnvironment | null }));
vi.mock('../../execution-environments/get-execution-environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../execution-environments/get-execution-environment')>();
  return {
    ...actual,
    getExecutionEnvironmentFor: (cwd?: string) => forPath.environment ?? actual.getExecutionEnvironmentFor(cwd),
  };
});

const task: CodingAgentTask = {
  taskId: 'task-1', prompt: 'Inspect the project', workdir: '/work',
  env: { OPENAI_API_KEY: 'test-key' }, mode: 'edit', maxTurns: 100,
  mcpServers: [],
};

let authHome: string;
beforeEach(() => {
  authHome = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-codex-auth-'));
  vi.stubEnv('CODEX_HOME', authHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(authHome, { recursive: true, force: true });
});

async function collect(lines: object[]) {
  const child = new FakeChild();
  const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: () => child.asExecProcess() })).run(task);
  for (const line of lines) child.emitLine(JSON.stringify(line));
  child.finish(0);
  return Array.fromAsync(run.events);
}

describe('Codex adapter', () => {
  it('names its process to the next boot', async () => {
    const child = new FakeChild();
    child.mark = { pid: 4242, startedAt: 1_000 };
    const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: () => child.asExecProcess() })).run(task);

    expect(run.mark).toEqual({ pid: 4242, startedAt: 1_000 });
    child.finish(0);
    await Array.fromAsync(run.events);
  });

  describe.each(['off', 'observe', 'enforce'] as const)('with the %s gate', (gateMode) => {
    const original = config.toolRiskGateMode;
    beforeEach(() => { config.toolRiskGateMode = gateMode; });
    afterEach(() => { config.toolRiskGateMode = original; });

    it.each([
      ['edit', 'Implement the requested changes and verify the result.'],
      ['plan', PLAN_ONLY_INSTRUCTION],
    ] as const)('runs a %s task without the sandbox and with its instruction', async (mode, instruction) => {
      const child = new FakeChild();
      const spawner = vi.fn<FakeRun>(() => child.asExecProcess());
      const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: spawner, paths: { codexHome: authHome }, files: localFiles })).run({ ...task, mode });
      expect(spawner).toHaveBeenCalledWith('codex', expect.arrayContaining([
        'exec', '--json', 'approval_policy="never"', 'sandbox_mode="danger-full-access"',
      ]), { cwd: '/work', env: { OPENAI_API_KEY: 'test-key', CODEX_API_KEY: 'test-key', CODEX_HOME: authHome }, stdin: 'pipe' });
      const args = spawner.mock.calls[0][1] as string[];
      expect(args.filter(arg => /^(approval_policy|sandbox_mode)=/.test(arg)))
        .toEqual(['approval_policy="never"', 'sandbox_mode="danger-full-access"']);
      expect(args.at(-1)).toBe(`${instruction}\n\n${task.prompt}`);
      child.finish(1);
      await Array.fromAsync(run.events);
    });
  });

  it.each([
    { AWS_BEARER_TOKEN_BEDROCK: 'test-key', AWS_REGION: 'us-west-2' },
    { AWS_ACCESS_KEY_ID: 'test-id', AWS_SECRET_ACCESS_KEY: 'test-secret', AWS_REGION: 'us-west-2' },
    { AWS_PROFILE: 'test-profile', AWS_DEFAULT_REGION: 'us-west-2' },
  ])('configures Bedrock authentication: %j', async (env) => {
    const child = new FakeChild();
    const spawner = vi.fn<FakeRun>(() => child.asExecProcess());
    const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: spawner })).run({ ...task, env });
    expect(spawner).toHaveBeenCalledWith('codex', expect.arrayContaining([
      'model_provider="amazon-bedrock"', 'model="openai.gpt-5.6-terra"',
      'model_providers.amazon-bedrock.aws.region="us-west-2"',
    ]), expect.objectContaining({ env: expect.objectContaining(env) }));
    child.finish(0);
    await Array.fromAsync(run.events);
  });

  it('passes the default region with IAM credentials', async () => {
    const child = new FakeChild();
    const spawner = vi.fn<FakeRun>(() => child.asExecProcess());
    const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: spawner })).run({ ...task, env: { AWS_PROFILE: 'test-profile' } });
    expect(spawner).toHaveBeenCalledWith('codex', expect.arrayContaining([
      'model_providers.amazon-bedrock.aws.region="us-east-1"',
    ]), expect.anything());
    child.finish(0);
    await Array.fromAsync(run.events);
  });

  it('prefers a direct OpenAI key when AWS credentials are also present', async () => {
    const child = new FakeChild();
    const spawner = vi.fn<FakeRun>(() => child.asExecProcess());
    const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: spawner })).run({ ...task,
      env: { ...task.env, AWS_BEARER_TOKEN_BEDROCK: 'test-bedrock-key' } });
    expect(spawner).toHaveBeenCalledWith('codex', expect.arrayContaining([
      'model_provider="openai"', 'forced_login_method="api"',
    ]), expect.anything());
    child.finish(0);
    await Array.fromAsync(run.events);
  });

  it.each([undefined, 'test-openai-key'])('uses saved login unless an API key is set: %s', async (apiKey) => {
    fs.writeFileSync(path.join(authHome, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt', tokens: { access_token: 'test-access', refresh_token: 'test-refresh' },
    }));
    const child = new FakeChild();
    const spawner = vi.fn<FakeRun>(() => child.asExecProcess());
    const agent = createCodexAgent(
      fakeExecutionEnvironment({ runProgram: spawner, paths: { codexHome: authHome }, files: localFiles }),
    );
    // The saved login is read when availability is probed, which is what a
    // task's argv then reflects.
    await agent.isAvailable({ AWS_PROFILE: 'test-profile' });
    const run = agent.run({ ...task, env: { OPENAI_API_KEY: apiKey, AWS_PROFILE: 'test-profile' } });
    const args = spawner.mock.calls[0][1] as string[];
    expect(args).toContain('model_provider="openai"');
    expect(args.includes('forced_login_method="api"')).toBe(Boolean(apiKey));
    expect(args.includes('cli_auth_credentials_store="file"')).toBe(!apiKey);
    expect(spawner.mock.calls[0][2]).toMatchObject({ env: { CODEX_HOME: authHome } });
    child.emitLine(JSON.stringify({ type: 'turn.completed' }));
    child.finish(0);
    await Array.fromAsync(run.events);
    expect(trackEvent).toHaveBeenCalledWith('codex task started', 'test-owner-id', {
      'task.id': task.taskId, 'auth.method': apiKey ? 'api' : 'saved',
    });
    expect(trackEvent).toHaveBeenCalledWith('codex task finished', 'test-owner-id', {
      'task.id': task.taskId, 'auth.method': apiKey ? 'api' : 'saved',
      status: 'end_turn', elapsed_ms: expect.any(String),
    });
    expect(trackEvent).toHaveBeenCalledTimes(2);
  });

  it('preserves an explicit Codex API key', async () => {
    const child = new FakeChild();
    const spawner = vi.fn<FakeRun>(() => child.asExecProcess());
    const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: spawner })).run({ ...task,
      env: { ...task.env, CODEX_API_KEY: 'test-codex-key' } });
    expect(spawner).toHaveBeenCalledWith('codex', expect.arrayContaining([
      'forced_login_method="api"',
    ]), expect.objectContaining({ env: expect.objectContaining({ CODEX_API_KEY: 'test-codex-key' }) }));
    child.finish(1);
    await Array.fromAsync(run.events);
    expect(trackEvent).toHaveBeenCalledWith('codex task finished', 'test-owner-id', {
      'task.id': task.taskId, 'auth.method': 'api', status: 'error', elapsed_ms: expect.any(String),
    });
    expect(trackEvent).toHaveBeenCalledTimes(2);
  });

  it('reports a saved-login failure once', async () => {
    fs.writeFileSync(path.join(authHome, 'auth.json'), '{}');
    const child = new FakeChild();
    const agent = createCodexAgent(
      fakeExecutionEnvironment({ runProgram: () => child.asExecProcess(), paths: { codexHome: authHome }, files: localFiles }),
    );
    await agent.isAvailable({});
    const run = agent.run({ ...task, env: {} });
    child.emitLine(JSON.stringify({ type: 'turn.failed', error: { message: 'Login required' } }));
    child.finish(1);
    expect((await Array.fromAsync(run.events)).at(-1)).toMatchObject({ stopReason: 'error' });
    expect(trackEvent).toHaveBeenCalledWith('codex task finished', 'test-owner-id', {
      'task.id': task.taskId, 'auth.method': 'saved', status: 'error', elapsed_ms: expect.any(String),
    });
    expect(trackEvent).toHaveBeenCalledTimes(2);
    expect(run.exited).toBe(true);
  });

  it('reports cancellation separately from a failed saved login', async () => {
    fs.writeFileSync(path.join(authHome, 'auth.json'), '{}');
    const child = new FakeChild();
    const agent = createCodexAgent(
      fakeExecutionEnvironment({ runProgram: () => child.asExecProcess(), paths: { codexHome: authHome }, files: localFiles }),
    );
    await agent.isAvailable({});
    const run = agent.run({ ...task, env: {} });
    expect(run.exited).toBe(false);
    run.stop();
    child.finish(1);
    await Array.fromAsync(run.events);
    expect(trackEvent).toHaveBeenCalledWith('codex task finished', 'test-owner-id', {
      'task.id': task.taskId, 'auth.method': 'saved', status: 'stopped', elapsed_ms: expect.any(String),
    });
    expect(trackEvent).toHaveBeenCalledTimes(2);
  });

  it('resumes with the requested permissions and preserves prompt text', async () => {
    const child = new FakeChild();
    const spawner = vi.fn<FakeRun>(() => child.asExecProcess());
    const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: spawner })).run({ ...task, sessionId: 'session-1',
      prompt: '--inspect', appendSystemPrompt: 'Use "examples".\nKeep it short.' });
    expect(spawner).toHaveBeenCalledWith('codex', expect.arrayContaining([
      'developer_instructions="Use \\"examples\\".\\nKeep it short."',
      'resume', 'session-1', '--', 'Implement the requested changes and verify the result.\n\n--inspect',
    ]), expect.anything());
    child.finish(1);
    await Array.fromAsync(run.events);
  });

  it('reads the documented JSON event stream', async () => {
    expect(await collect([
      { type: 'thread.started', thread_id: 'session-1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { type: 'command_execution', command: 'ls' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Project inspected.' } },
      { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } },
    ])).toEqual([
      { type: 'session', sessionId: 'session-1' },
      { type: 'text', text: 'Project inspected.' },
      { type: 'result', stopReason: 'end_turn', turns: 1, message: 'Project inspected.' },
    ] satisfies CodingAgentEvent[]);
  });

  it('reports terminal failures', async () => {
    expect(await collect([{ type: 'turn.failed', error: { message: 'Quota exceeded' } }]))
      .toEqual([{ type: 'result', stopReason: 'error', turns: 1, message: 'Quota exceeded' }]);
  });

  it('allows a successful retry after an error event', async () => {
    const events = await collect([
      { type: 'error', message: 'Reconnecting' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Done' } },
      { type: 'turn.completed' },
    ]);
    expect(events.filter(e => e.type === 'result')).toEqual([
      { type: 'result', stopReason: 'end_turn', turns: 1, message: 'Done' },
    ]);
  });

  it('keeps concurrent task results separate', async () => {
    const children = [new FakeChild(), new FakeChild()];
    let index = 0;
    const agent = createCodexAgent(fakeExecutionEnvironment({ runProgram: () => children[index++].asExecProcess() }));
    const runs = [agent.run(task), agent.run(task)];
    children[0].emitLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'First' } }));
    children[1].emitLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Second' } }));
    for (const child of children) {
      child.emitLine(JSON.stringify({ type: 'turn.completed' }));
      child.finish(0);
    }
    const events = await Promise.all(runs.map(run => Array.fromAsync(run.events)));
    expect(events[0].at(-1)).toMatchObject({ message: 'First' });
    expect(events[1].at(-1)).toMatchObject({ message: 'Second' });
  });

  it('prepares an isolated home with shared skills', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-codex-test-'));
    try {
      vi.stubEnv('CODEX_HOME', '');
      const skillsDir = path.join(root, 'skills');
      const codexHome = path.join(root, '.codex');
      fs.mkdirSync(skillsDir);
      // The real local filesystem behind a fake environment, so the link is a
      // link rather than a recorded call.
      const home = await createCodexAgent(
        fakeExecutionEnvironment({ paths: { skillsDir, codexHome }, files: localFiles }),
      ).prepareHome();

      expect(home).toEqual({ configDir: codexHome, skillsLinked: true });
      expect(fs.realpathSync(path.join(home.configDir, 'skills'))).toBe(fs.realpathSync(skillsDir));
      // Nothing is written to this process's env: the home comes from the
      // environment, so a run elsewhere does not inherit ours.
      expect(process.env.CODEX_HOME).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/** `codex login status` for a ChatGPT login, as Codex 0.163 prints it on stderr. */
const CHATGPT = 'Logged in using ChatGPT';

/**
 * An environment whose `codex login status` prints `status`, recording every
 * other launch. Without `status` the status call never ends.
 */
function subscriptionHarness(status?: string) {
  const launches: Array<{ args: readonly string[]; options: RunOptions; child: FakeChild }> = [];
  let asked = 0;
  const environment = fakeExecutionEnvironment({
    paths: { codexHome: '/home/.codex' },
    runProgram: (_command, args, options) => {
      const child = new FakeChild();
      if (args[0] !== 'login') {
        launches.push({ args, options, child });
        return child.asExecProcess();
      }
      asked += 1;
      if (status !== undefined) {
        child.stderr.write(`${status}\n`);
        process.nextTick(() => child.finish(0));
      }
      return child.asExecProcess();
    },
  });
  return { agent: createCodexAgent(environment), launches, asked: () => asked };
}

describe('the ChatGPT subscription', () => {
  const env = {
    PATH: '/bin',
    OPENAI_API_KEY: 'test-key',
    CODEX_API_KEY: 'test-codex-key',
    CODEX_ACCESS_TOKEN: 'test-token',
    AWS_BEARER_TOKEN_BEDROCK: 'test-bedrock-key',
  };
  const NO_LOGIN =
    'Codex failed to start: Codex is set to use your ChatGPT subscription, and nobody is signed in to it: sign in again from Coding agents';

  it('asks nothing and keeps the API key while CODEX_SUBSCRIPTION is off', async () => {
    const { agent, launches, asked } = subscriptionHarness(CHATGPT);
    const run = agent.run({ ...task, env });
    expect(asked()).toBe(0);
    expect(launches[0].options.env).toMatchObject({ OPENAI_API_KEY: 'test-key', CODEX_API_KEY: 'test-codex-key' });
    expect(launches[0].args).toContain('forced_login_method="api"');
    launches[0].child.finish(0);
    await Array.fromAsync(run.events);
  });

  describe('with CODEX_SUBSCRIPTION on', () => {
    beforeEach(() => {
      config.codexSubscription = true;
    });
    afterEach(() => {
      config.codexSubscription = false;
    });

    it('runs a task on the ChatGPT login, with no API key and no Bedrock', async () => {
      const { agent, launches } = subscriptionHarness(CHATGPT);
      const run = agent.run({ ...task, env, modelTier: 'medium' });
      await vi.waitFor(() => expect(launches).toHaveLength(1));
      const { args, options, child } = launches[0];
      expect(options.env).toEqual({
        PATH: '/bin',
        AWS_BEARER_TOKEN_BEDROCK: 'test-bedrock-key',
        CODEX_HOME: '/home/.codex',
      });
      expect(args).toEqual(expect.arrayContaining([
        'model_provider="openai"', 'openai_base_url=""', 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
        'forced_login_method="chatgpt"', 'cli_auth_credentials_store="file"',
      ]));
      expect(args).not.toContain('model_provider="amazon-bedrock"');
      expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
      child.emitLine(JSON.stringify({ type: 'turn.completed' }));
      child.finish(0);
      await Array.fromAsync(run.events);
      expect(trackEvent).toHaveBeenCalledWith('codex task finished', 'test-owner-id', {
        'task.id': task.taskId, 'auth.method': 'subscription', status: 'end_turn', elapsed_ms: expect.any(String),
      });
    });

    it.each([
      ['no login', 'Not logged in', NO_LOGIN],
      ['an API-key login', 'Logged in using an API key - sk-test-***-real', NO_LOGIN],
      ['no answer', '', 'Codex failed to start: codex login status exited with 0 and no status'],
    ])('fails the task, and starts nothing, with %s in the home', async (_label, status, message) => {
      const { agent, launches } = subscriptionHarness(status);
      expect(await Array.fromAsync(agent.run({ ...task, env }).events)).toEqual([
        { type: 'result', stopReason: 'error', turns: 0, message },
      ]);
      expect(launches).toHaveLength(0);
      expect(trackEvent).toHaveBeenCalledWith('codex task finished', 'test-owner-id', {
        'task.id': task.taskId, 'auth.method': 'subscription', status: 'error', elapsed_ms: expect.any(String),
      });
    });

    it("reads the login and runs a task on the host from the host's home, while other commands run in a container", async () => {
      const homes: Array<string | undefined> = [];
      forPath.environment = fakeExecutionEnvironment({
        paths: { codexHome: '/host/.codex' },
        runProgram: (_command, args, options) => {
          homes.push(options.env.CODEX_HOME);
          const child = new FakeChild();
          if (args[0] === 'login') child.stderr.write(`${CHATGPT}\n`);
          else child.emitLine(JSON.stringify({ type: 'turn.completed' }));
          process.nextTick(() => child.finish(0));
          return child.asExecProcess();
        },
      });
      __setExecutionEnvironmentForTests(fakeExecutionEnvironment({ paths: { codexHome: '/prism/codex' } }));
      try {
        const events = await Array.fromAsync(createCodexAgent().run({ ...task, workdir: '/repo', env }).events);
        expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });
        expect(homes).toEqual(['/host/.codex', '/host/.codex']);
      } finally {
        forPath.environment = null;
        __setExecutionEnvironmentForTests(null);
      }
    });

    it("names the command that signs in the host's home when a task on the host finds nobody signed in", async () => {
      forPath.environment = fakeExecutionEnvironment({
        paths: { codexHome: '/host/.codex' },
        runProgram: () => {
          const child = new FakeChild();
          child.stderr.write('Not logged in\n');
          process.nextTick(() => child.finish(0));
          return child.asExecProcess();
        },
      });
      __setExecutionEnvironmentForTests(fakeExecutionEnvironment({ servesPath: () => false }));
      try {
        const events = await Array.fromAsync(createCodexAgent().run({ ...task, workdir: '/repo', env }).events);
        expect(events.at(-1)).toMatchObject({
          stopReason: 'error',
          message: expect.stringContaining(
            "on this computer, where this conversation's folder is. Coding agents signs in elsewhere: sign in by running " +
              "`CODEX_HOME='/host/.codex' codex login -c 'cli_auth_credentials_store=\"file\"'`",
          ),
        });
      } finally {
        forPath.environment = null;
        __setExecutionEnvironmentForTests(null);
      }
    });

    it('asks again for every task, so a sign-in applies to the next one', async () => {
      let status = 'Not logged in';
      const launches: string[][] = [];
      const agent = createCodexAgent(fakeExecutionEnvironment({
        paths: { codexHome: '/home/.codex' },
        runProgram: (_command, args) => {
          const child = new FakeChild();
          if (args[0] === 'login') child.stderr.write(`${status}\n`);
          else launches.push([...args]);
          process.nextTick(() => child.finish(0));
          return child.asExecProcess();
        },
      }));

      const first = await Array.fromAsync(agent.run({ ...task, env }).events);
      status = CHATGPT;
      await Array.fromAsync(agent.run({ ...task, env }).events);

      expect(first).toEqual([{ type: 'result', stopReason: 'error', turns: 0, message: NO_LOGIN }]);
      expect(launches).toHaveLength(1);
    });

    it.each([
      ['before the CLI answers', ''],
      ['after the CLI reports a ChatGPT login', CHATGPT],
    ])('starts nothing when the task is stopped %s', async (_label, printed) => {
      const launches: string[][] = [];
      let asked = 0;
      const agent = createCodexAgent(fakeExecutionEnvironment({
        paths: { codexHome: '/home/.codex' },
        runProgram: (_command, args) => {
          const child = new FakeChild();
          if (args[0] === 'login') {
            asked += 1;
            if (printed) child.stderr.write(`${printed}\n`);
          } else {
            launches.push([...args]);
          }
          return child.asExecProcess();
        },
      }));
      const run = agent.run({ ...task, env });
      await vi.waitFor(() => expect(asked).toBe(1));

      run.stop();

      expect(await Array.fromAsync(run.events)).toEqual([
        { type: 'result', stopReason: 'error', turns: 0, message: 'Codex was stopped before it started' },
      ]);
      expect(launches).toHaveLength(0);
      expect(trackEvent).toHaveBeenCalledWith('codex task finished', 'test-owner-id', {
        'task.id': task.taskId, 'auth.method': 'subscription', status: 'stopped', elapsed_ms: expect.any(String),
      });
    });
  });
});

describe('model tier and effort', () => {
  const tiers = ['small', 'medium', 'large'] as const;
  const models = ["gpt-5.6-luna","gpt-5.6-terra","gpt-5.6-sol"];
  for (const sessionId of [undefined, 'session-1']) {
    it.each(tiers)('maps %s for session ' + sessionId, async (modelTier) => {
      const child = new FakeChild();
      let args: readonly string[] = [];
      const run = createCodexAgent(
        fakeExecutionEnvironment({
          runProgram: (_command, argv) => {
            args = argv;
            return child.asExecProcess();
          },
        }),
      ).run({ ...task, modelTier, sessionId });
      expect(args[args.indexOf('--model') + 1]).toBe(models[tiers.indexOf(modelTier)]);
      child.finish(0);
      await Array.fromAsync(run.events);
    });

    it.each(['low', 'medium', 'high'] as const)('passes %s effort for session ' + sessionId, async (effort) => {
      const child = new FakeChild();
      let args: readonly string[] = [];
      const run = createCodexAgent(
        fakeExecutionEnvironment({
          runProgram: (_command, argv) => {
            args = argv;
            return child.asExecProcess();
          },
        }),
      ).run({ ...task, effort, sessionId });
      expect(args).toContain('model_reasoning_effort="' + effort + '"');
      expect(args).not.toContain('--model');
      child.finish(0);
      await Array.fromAsync(run.events);
    });
  }

  it.each(tiers)('uses the override for %s', async (modelTier) => {
    const overrides = config.codingAgentModels['codex'];
    const previous = overrides[modelTier];
    overrides[modelTier] = { openai: 'custom-model', bedrock: 'custom-model' };
    try {
      const child = new FakeChild();
      let args: readonly string[] = [];
      const run = createCodexAgent(
        fakeExecutionEnvironment({
          runProgram: (_command, argv) => {
            args = argv;
            return child.asExecProcess();
          },
        }),
      ).run({ ...task, modelTier, effort: 'high', sessionId: 'session-1' });
      expect(args[args.indexOf('--model') + 1]).toBe('custom-model');
      child.finish(0);
      await Array.fromAsync(run.events);
    } finally {
      overrides[modelTier] = previous;
    }
  });

  it('preserves deployment defaults when both parameters are omitted', async () => {
    const child = new FakeChild();
    let args: readonly string[] = [];
    const run = createCodexAgent(
      fakeExecutionEnvironment({
        runProgram: (_command, argv) => {
          args = argv;
          return child.asExecProcess();
        },
      }),
    ).run(task);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(args.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false);
    child.finish(0);
    await Array.fromAsync(run.events);
  });
});

it.each([
  ['small', 'openai.gpt-5.6-luna'],
  ['medium', 'openai.gpt-5.6-terra'],
  ['large', 'openai.gpt-5.6-sol'],
] as const)('uses the Bedrock model for %s', async (modelTier, model) => {
  const child = new FakeChild();
  let args: readonly string[] = [];
  const run = createCodexAgent(
    fakeExecutionEnvironment({
      runProgram: (_command, argv) => {
        args = argv;
        return child.asExecProcess();
      },
    }),
  ).run({ ...task, env: { AWS_PROFILE: 'test-profile' }, modelTier, effort: 'low', sessionId: 'session-1' });
  expect(args[args.indexOf('--model') + 1]).toBe(model);
  expect(args.some(arg => arg.startsWith('model='))).toBe(false);
  expect(args).toContain('model_reasoning_effort="low"');
  child.finish(0);
  await Array.fromAsync(run.events);
});
