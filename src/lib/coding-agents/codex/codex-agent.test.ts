import { config } from '../../../config';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeChild } from '../../../test-utils/fake-child';
import type { CodingAgentEvent, CodingAgentTask } from '../coding-agent';
import { createCodexAgent } from './codex-agent';
import { fakeExecutionEnvironment, type FakeRun } from '../../../test-utils/fake-execution-environment';
import { resolveCodexHome } from './credentials';
import { trackEvent } from '../../telemetry';

vi.mock('../../telemetry', () => ({ trackEvent: vi.fn() }));

const task: CodingAgentTask = {
  taskId: 'task-1', prompt: 'Inspect the project', workdir: '/work',
  env: { OPENAI_API_KEY: 'test-key' }, mode: 'edit', maxTurns: 100, gateMode: 'off',
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
  it.each([
    ['plan', 'off', 'read-only'], ['plan', 'enforce', 'read-only'],
    ['edit', 'off', 'danger-full-access'], ['edit', 'observe', 'danger-full-access'],
    ['edit', 'enforce', 'workspace-write'],
  ] as const)('uses %s mode with the %s gate', async (mode, gateMode, sandbox) => {
    const child = new FakeChild();
    const spawner = vi.fn<FakeRun>(() => child.asExecProcess());
    const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: spawner })).run({ ...task, mode, gateMode });
    expect(spawner).toHaveBeenCalledWith('codex', expect.arrayContaining([
      'exec', '--json', 'approval_policy="never"', `sandbox_mode="${sandbox}"`,
    ]), { cwd: '/work', env: { OPENAI_API_KEY: 'test-key', CODEX_API_KEY: 'test-key', CODEX_HOME: resolveCodexHome(task.env) }, stdin: 'pipe' });
    child.finish(1);
    await Array.fromAsync(run.events);
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
    const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: spawner })).run({ ...task, env: {
      CODEX_HOME: authHome, OPENAI_API_KEY: apiKey, AWS_PROFILE: 'test-profile',
    } });
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
    const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: () => child.asExecProcess() })).run({ ...task,
      env: { CODEX_HOME: authHome } });
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
    const run = createCodexAgent(fakeExecutionEnvironment({ runProgram: () => child.asExecProcess() })).run({ ...task,
      env: { CODEX_HOME: authHome } });
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

  it('prepares an isolated home with shared skills', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-codex-test-'));
    try {
      vi.stubEnv('CODEX_HOME', '');
      const skillsDir = path.join(root, 'skills');
      fs.mkdirSync(skillsDir);
      const home = createCodexAgent().prepareHome({ dataDir: root, skillsDir });
      expect(home).toEqual({ configDir: path.join(root, '.codex'), skillsLinked: true });
      expect(fs.realpathSync(path.join(home.configDir, 'skills'))).toBe(fs.realpathSync(skillsDir));
      // Nothing is written to this process's env: a task states the home on
      // its own env, so a run in another environment does not inherit ours.
      expect(process.env.CODEX_HOME).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
