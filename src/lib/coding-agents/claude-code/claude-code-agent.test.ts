import { config } from '../../../config';
/**
 * The Claude Code adapter against a fake `claude`: the argv it builds for each
 * mode, the events it reads out of the stream-json output, and the home it
 * prepares at boot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FailedSpawnChild, FakeChild } from '../../../test-utils/fake-child';
import { logger } from '../../../logger';
import { fakeExecutionEnvironment } from '../../../test-utils/fake-execution-environment';
import { localFiles } from '../../execution-environments/local/local-files';
import type {
  ExecutionFiles,
  RunOptions,
} from '../../execution-environments/execution-environment';
import type {
  CodingAgentEvent,
  CodingAgentMcpServer,
  CodingAgentRun,
  CodingAgentTask,
} from '../coding-agent';
import { PLAN_ONLY_INSTRUCTION } from '../coding-agent';
import { createClaudeCodeAgent } from './claude-code-agent';
import { claudeMcpConfig } from './mcp-config';

const baseTask: CodingAgentTask = {
  taskId: 't1',
  prompt: 'do X',
  env: { PATH: '/bin' },
  mode: 'edit',
  maxTurns: 100,
  mcpServers: [],
};

/** Start a task in an environment that records the launch instead of running anything. */
function capture(task: Partial<CodingAgentTask>): {
  command: string;
  args: readonly string[];
  options: RunOptions;
} {
  let captured: { command: string; args: readonly string[]; options: RunOptions } | undefined;
  const environment = fakeExecutionEnvironment({
    runProgram: (command, args, options) => {
      captured = { command, args, options };
      return new FakeChild().asExecProcess();
    },
  });
  createClaudeCodeAgent(environment).run({ ...baseTask, ...task });
  if (!captured) throw new Error('the environment was not asked to run anything');
  return captured;
}

/** The value carried by a flag, or undefined when the flag is absent. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/** Feed stream-json lines to a fake `claude` and collect what the adapter reads. */
async function eventsFor(lines: object[], task: CodingAgentTask = baseTask): Promise<CodingAgentEvent[]> {
  const child = new FakeChild();
  const run = createClaudeCodeAgent(
    fakeExecutionEnvironment({ runProgram: () => child.asExecProcess() }),
  ).run(task);
  for (const line of lines) child.emitLine(JSON.stringify(line));
  child.finish(0);
  const events: CodingAgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

describe('createClaudeCodeAgent', () => {
  it('identifies itself', () => {
    const agent = createClaudeCodeAgent();
    expect(agent.id).toBe('claude-code');
    expect(agent.displayName).toBe('Claude Code');
  });
});

describe('run: the spawn', () => {
  it('runs the claude binary in print mode with stream-json output and the turn budget', () => {
    const { command, args } = capture({ maxTurns: 42 });
    expect(command).toBe('claude');
    expect(args.slice(0, 7)).toEqual([
      '-p',
      'do X',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '42',
    ]);
    expect(args).toEqual(expect.arrayContaining(['--disallowed-tools', 'AskUserQuestion']));
  });

  it("hands the task's cwd and env to the child", () => {
    const { options } = capture({ workdir: '/work' });
    expect(options.cwd).toBe('/work');
    // The home comes from the execution environment, since that is the
    // filesystem it is on — a path this process resolved could name nothing
    // there.
    expect(options.env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/workspace/.claude' });
  });

  it('takes the home from the environment, not from the task env', () => {
    const { options } = capture({ env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/theirs' } });
    expect(options.env.CLAUDE_CONFIG_DIR).toBe('/workspace/.claude');
  });

  it('resumes a session and turns on debug when asked', () => {
    const { args } = capture({ sessionId: 'sess-1', debug: true });
    expect(valueOf(args, '--resume')).toBe('sess-1');
    expect(args).toContain('--debug');
  });

  it('passes neither by default', () => {
    const { args } = capture({});
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--debug');
  });

  it.each([
    ['edit', 'auto'],
    ['plan', 'plan'],
  ] as const)('runs a %s task in the %s permission mode, never with the bypass', (mode, permissionMode) => {
    const { args } = capture({ mode });
    expect(valueOf(args, '--permission-mode')).toBe(permissionMode);
    expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
  });
});

/** The runtime's servers as a task gets them: the platform endpoint and two from a plugin. */
const SERVERS: CodingAgentMcpServer[] = [
  { kind: 'http', name: 'nexus', url: 'https://nexus.example.test/mcp', headers: {} },
  {
    kind: 'stdio',
    name: 'demo__probe',
    command: 'node',
    args: ['server.js'],
    env: { PROBE_TOKEN: 'stdio-secret-value' },
    cwd: '/plugins/demo',
  },
  {
    kind: 'http',
    name: 'demo__remote',
    url: 'https://remote.example.test/mcp',
    headers: { 'X-Api-Key': 'header-secret-value' },
  },
];

/**
 * An environment over the real filesystem that records each launch and each
 * temp dir, so a test can read the config file and see it go.
 */
function mcpHarness(
  options: { child?: () => FakeChild; files?: Partial<ExecutionFiles> } = {},
) {
  const launches: Array<{ args: readonly string[]; child: FakeChild }> = [];
  const dirs: string[] = [];
  const environment = fakeExecutionEnvironment({
    runProgram: (_command, args) => {
      const child = options.child?.() ?? new FakeChild();
      launches.push({ args, child });
      return child.asExecProcess();
    },
    files: {
      ...localFiles,
      makeTempDir: async (prefix) => {
        const dir = await localFiles.makeTempDir(prefix);
        dirs.push(dir);
        return dir;
      },
      ...options.files,
    },
  });
  const start = (): CodingAgentRun =>
    createClaudeCodeAgent(environment).run({ ...baseTask, mcpServers: SERVERS });
  /** The launch, once the config is written. */
  const launched = async () => {
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    return launches[0];
  };
  return { start, launched, launches, dirs };
}

describe('run: MCP servers', () => {
  it('gives the CLI no MCP server at all when the runtime connects none', () => {
    const { args } = capture({});
    expect(args).not.toContain('--mcp-config');
    // Strict with no config file: no server, an `.mcp.json` in the workdir included.
    expect(args).toContain('--strict-mcp-config');
  });

  it('points the CLI at a private config file, strictly', async () => {
    const { start, launched } = mcpHarness();
    const run = start();
    const { args, child } = await launched();

    const configPath = valueOf(args, '--mcp-config');
    if (!configPath) throw new Error('no --mcp-config');
    // Next to it, so the variadic `--mcp-config` takes the one path only.
    expect(args[args.indexOf('--mcp-config') + 2]).toBe('--strict-mcp-config');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(claudeMcpConfig(SERVERS, true).document);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);

    child.finish(0);
    await Array.fromAsync(run.events);
  });

  it('keeps every env value and header out of the process arguments', async () => {
    const { start, launched } = mcpHarness();
    const run = start();
    const { args, child } = await launched();

    const argv = args.join('\n');
    expect(argv).not.toContain('stdio-secret-value');
    expect(argv).not.toContain('header-secret-value');

    child.finish(0);
    await Array.fromAsync(run.events);
  });

  it.each([
    [
      'reports its result',
      (child: FakeChild) => {
        child.emitLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', num_turns: 1 }));
        child.finish(0);
      },
    ],
    ['exits without a result', (child: FakeChild) => child.finish(1)],
    ['is stopped', (_child: FakeChild, run: CodingAgentRun) => run.stop()],
  ])('removes the config when the CLI %s', async (_label, end) => {
    const { start, launched, dirs } = mcpHarness();
    const run = start();
    const { child } = await launched();

    end(child, run);
    const events = await Array.fromAsync(run.events);

    expect(events.at(-1)?.type).toBe('result');
    expect(dirs).toHaveLength(1);
    expect(fs.existsSync(dirs[0])).toBe(false);
    expect(run.exited).toBe(true);
  });

  it('removes the config when the CLI fails to launch', async () => {
    const { start, launched, dirs } = mcpHarness({ child: () => new FailedSpawnChild() });
    const run = start();
    const { child } = await launched();

    (child as FailedSpawnChild).fail('spawn claude ENOENT');
    const events = await Array.fromAsync(run.events);

    expect(events).toEqual([
      { type: 'result', stopReason: 'error', turns: 0, message: 'Claude Code failed to start: spawn claude ENOENT' },
    ]);
    expect(fs.existsSync(dirs[0])).toBe(false);
  });

  it('starts nothing and removes the config when stopped before the CLI starts', async () => {
    const { start, launches, dirs } = mcpHarness();
    const run = start();
    expect(run.exited).toBe(false);

    run.stop();
    const events = await Array.fromAsync(run.events);

    expect(events).toEqual([
      { type: 'result', stopReason: 'error', turns: 0, message: 'Claude Code was stopped before it started' },
    ]);
    expect(launches).toHaveLength(0);
    expect(fs.existsSync(dirs[0])).toBe(false);
    expect(run.exited).toBe(true);
  });

  it('reports a config that cannot be written as a failed start, and removes its directory', async () => {
    const { start, launches, dirs } = mcpHarness({
      files: { writeText: () => Promise.reject(new Error('No space left on device')) },
    });
    const events = await Array.fromAsync(start().events);

    expect(events).toEqual([
      { type: 'result', stopReason: 'error', turns: 0, message: 'Claude Code failed to start: No space left on device' },
    ]);
    expect(launches).toHaveLength(0);
    expect(fs.existsSync(dirs[0])).toBe(false);
  });
});

/**
 * `--system-prompt` *replaces* Claude Code's default prompt, stripping the sub-agent of
 * its tool-selection, todo and search conventions — so the invariant every case here
 * checks is that the flag is never emitted, whatever the mode. Plan mode's read-only
 * constraint and any caller framing are appended instead, on one flag.
 */
describe('run: system prompt args', () => {
  it('never replaces the default prompt, in any mode', () => {
    for (const mode of ['plan', 'edit'] as const) {
      for (const appendSystemPrompt of ['custom', undefined]) {
        const { args } = capture({ mode, appendSystemPrompt });
        expect(args).not.toContain('--system-prompt');
      }
    }
  });

  it('states plan mode to the model as well as to the CLI', () => {
    const { args } = capture({ mode: 'plan' });
    expect(valueOf(args, '--append-system-prompt')).toBe(PLAN_ONLY_INSTRUCTION);
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
  });

  it('carries the plan constraint and a caller prompt on one flag', () => {
    const { args } = capture({ mode: 'plan', appendSystemPrompt: 'custom' });
    // One occurrence, so neither part can silently drop the other.
    expect(args.filter((a) => a === '--append-system-prompt')).toHaveLength(1);
    const value = valueOf(args, '--append-system-prompt');
    expect(value).toContain(PLAN_ONLY_INSTRUCTION);
    expect(value).toContain('custom');
  });

  it('leaves edit mode with the caller prompt alone and no plan constraint', () => {
    const { args } = capture({ mode: 'edit', appendSystemPrompt: 'custom' });
    expect(valueOf(args, '--append-system-prompt')).toBe('custom');
  });

  it('passes no prompt flag at all for an edit task with no caller prompt', () => {
    const { args } = capture({});
    expect(args).not.toContain('--append-system-prompt');
  });

});

describe('run: reading the stream', () => {
  it('reports the session id, assistant text and the outcome as events', async () => {
    const events = await eventsFor([
      { type: 'system', subtype: 'init', session_id: 'sess-init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'world' }] },
      },
      { type: 'result', subtype: 'success', result: 'final', num_turns: 7, session_id: 'sess-42' },
    ]);

    expect(events).toEqual([
      { type: 'session', sessionId: 'sess-init' },
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
      { type: 'session', sessionId: 'sess-42' },
      { type: 'result', stopReason: 'end_turn', turns: 7, message: 'final' },
    ]);
  });

  it.each([
    ['success', 'end_turn'],
    ['error_max_turns', 'max_turns'],
    ['error', 'error'],
    ['error_during_execution', 'error'],
  ] as const)('maps the %s subtype to %s', async (subtype, stopReason) => {
    const events = await eventsFor([{ type: 'result', subtype, result: 'text', num_turns: 3 }]);
    expect(events).toEqual([{ type: 'result', stopReason, turns: 3, message: 'text' }]);
  });

  it('reports a failed model call as an error, though its subtype reads success', async () => {
    // A result line captured from Claude Code 2.1.296 when Bedrock answered 503.
    const events = await eventsFor([{
      type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error',
      num_turns: 1, permission_denials: [],
      result: 'API Error: 503 Bedrock is unable to process your request.',
    }]);
    expect(events).toEqual([{
      type: 'result', stopReason: 'error', turns: 1,
      message: 'API Error: 503 Bedrock is unable to process your request.',
    }]);
  });

  it('carries each refused action and its target on the result', async () => {
    // Shapes captured from Claude Code 2.1.296: the auto-mode classifier
    // refusing a force push, and a deny rule refusing a write.
    const events = await eventsFor([{
      type: 'result', subtype: 'success', is_error: false, num_turns: 5, result: 'Steps 1 and 2 are done.',
      permission_denials: [
        {
          tool_name: 'Bash', tool_use_id: 'toolu_1',
          tool_input: { command: 'git push --force origin main' },
        },
        {
          tool_name: 'Write', tool_use_id: 'toolu_2',
          tool_input: { file_path: '/work/forbidden.txt', content: 'nope\n' },
        },
      ],
    }]);
    expect(events).toEqual([{
      type: 'result', stopReason: 'end_turn', turns: 5, message: 'Steps 1 and 2 are done.',
      refusals: [
        { action: 'Bash', target: 'git push --force origin main' },
        { action: 'Write', target: '/work/forbidden.txt' },
      ],
    }]);
  });

  it('names a refused call without a known target field by its input, cut short', async () => {
    const events = await eventsFor([{
      type: 'result', subtype: 'success', num_turns: 1, result: 'ok',
      permission_denials: [
        { tool_name: 'mcp__deploy__run', tool_input: { service: 'api' } },
        { tool_name: 'Bash', tool_input: { command: 'x'.repeat(300) } },
      ],
    }]);
    expect(events).toEqual([expect.objectContaining({
      refusals: [
        { action: 'mcp__deploy__run', target: '{"service":"api"}' },
        { action: 'Bash', target: `${'x'.repeat(200)}…` },
      ],
    })]);
  });

  it('folds a multi-line refused command onto one line', async () => {
    const events = await eventsFor([{
      type: 'result', subtype: 'success', num_turns: 1, result: 'ok',
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: "python3 - <<'PY'\nprint(1)\nPY" } }],
    }]);
    expect(events).toEqual([expect.objectContaining({
      refusals: [{ action: 'Bash', target: "python3 - <<'PY' print(1) PY" }],
    })]);
  });

  it.each([
    ['edit', 'default', true],
    ['edit', 'auto', false],
    ['plan', 'plan', false],
  ] as const)('warns when a %s task starts in %s mode: %s', async (mode, permissionMode, warns) => {
    const warn = vi.spyOn(logger, 'warn');
    // The opening line of Claude Code 2.1.296 on Bedrock with `--model haiku`.
    await eventsFor([{
      type: 'system', subtype: 'init', session_id: 's1', permissionMode,
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    }], { ...baseTask, mode });
    expect(warn.mock.calls.length > 0).toBe(warns);
    if (warns) {
      expect(warn).toHaveBeenCalledWith(
        { taskId: 't1', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', permissionMode },
        expect.stringContaining('did not start in auto mode'),
      );
    }
  });

  it('falls back to the subtype as the message when the result line has no text', async () => {
    const events = await eventsFor([{ type: 'result', subtype: 'error_during_execution' }]);
    expect(events).toEqual([
      { type: 'result', stopReason: 'error', turns: 0, message: 'error_during_execution' },
    ]);
  });

  it('ignores lines of other types', async () => {
    const events = await eventsFor([
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
      { type: 'result', subtype: 'success', result: 'ok', num_turns: 1 },
    ]);
    expect(events).toEqual([{ type: 'result', stopReason: 'end_turn', turns: 1, message: 'ok' }]);
  });

  it('names Claude Code in the closing message when the binary is missing', async () => {
    const child = new FakeChild();
    child.stdout.end();
    child.stderr.end();
    const run = createClaudeCodeAgent(
    fakeExecutionEnvironment({ runProgram: () => child.asExecProcess() }),
  ).run(baseTask);
    process.nextTick(() => child.emit('error', new Error('spawn claude ENOENT')));
    const events: CodingAgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events).toEqual([
      {
        type: 'result',
        stopReason: 'error',
        turns: 0,
        message: 'Claude Code failed to start: spawn claude ENOENT',
      },
    ]);
  });
});

describe('prepareHome', () => {
  let savedConfigDir: string | undefined;
  let tmp: string;
  let skillsDir: string;
  let claudeHome: string;

  /** A fake environment over the real filesystem, so a link is a real link. */
  const environmentFor = () =>
    fakeExecutionEnvironment({ paths: { skillsDir, claudeHome }, files: localFiles });

  beforeEach(() => {
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-claude-home-'));
    skillsDir = path.join(tmp, 'skills');
    claudeHome = path.join(tmp, '.claude');
    fs.mkdirSync(skillsDir);
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the config dir and links the skills dir into it', async () => {
    const home = await createClaudeCodeAgent(environmentFor()).prepareHome();

    expect(home.configDir).toBe(claudeHome);
    expect(fs.statSync(home.configDir).isDirectory()).toBe(true);
    expect(home.skillsLinked).toBe(true);
    const link = path.join(home.configDir, 'skills');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(skillsDir));
    // Nothing is written to this process's env: the home comes from the
    // environment, so a run elsewhere is not left inheriting ours.
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    // Only skills are exposed — Claude Code's plugin layout differs from the
    // Agent Plugins one, so plugins are deliberately not linked across.
    expect(fs.existsSync(path.join(home.configDir, 'plugins'))).toBe(false);
  });

  it.each(['theirs', 'theirs '])('leaves the operator-set home %j alone', async (directory) => {
    const theirs = path.join(tmp, directory);
    fs.mkdirSync(theirs);
    process.env.CLAUDE_CONFIG_DIR = theirs;
    claudeHome = theirs;

    const home = await createClaudeCodeAgent(environmentFor()).prepareHome();

    expect(home).toEqual({ configDir: theirs, skillsLinked: false });
    // Their directory is usually their real ~/.claude, so nothing is put in it.
    expect(fs.readdirSync(theirs)).toEqual([]);
  });

  it('reports skills as linked when the operator-set home already points at them', async () => {
    const theirs = path.join(tmp, 'theirs');
    fs.mkdirSync(theirs);
    fs.symlinkSync(skillsDir, path.join(theirs, 'skills'));
    process.env.CLAUDE_CONFIG_DIR = theirs;
    claudeHome = theirs;

    const home = await createClaudeCodeAgent(environmentFor()).prepareHome();
    expect(home).toEqual({ configDir: theirs, skillsLinked: true });
  });

  it('reports the skills as unlinked when a populated dir sits at the link path', async () => {
    const claudeSkills = path.join(claudeHome, 'skills');
    fs.mkdirSync(claudeSkills, { recursive: true });
    fs.writeFileSync(path.join(claudeSkills, 'keep.txt'), 'x');

    const home = await createClaudeCodeAgent(environmentFor()).prepareHome();
    expect(home.skillsLinked).toBe(false);
    // Somebody's files, so the link is refused rather than written over them.
    expect(fs.existsSync(path.join(claudeSkills, 'keep.txt'))).toBe(true);
  });
});

describe('model tier and effort', () => {
  const tiers = ['small', 'medium', 'large'] as const;
  const models = ["haiku","sonnet","opus"];
  for (const sessionId of [undefined, 'session-1']) {
    it.each(tiers)('maps %s for session ' + sessionId, async (modelTier) => {
      const child = new FakeChild();
      let args: readonly string[] = [];
      const run = createClaudeCodeAgent(
        fakeExecutionEnvironment({
          runProgram: (_command, argv) => {
            args = argv;
            return child.asExecProcess();
          },
        }),
      ).run({ ...baseTask, modelTier, sessionId });
      expect(args[args.indexOf('--model') + 1]).toBe(models[tiers.indexOf(modelTier)]);
      child.finish(0);
      await Array.fromAsync(run.events);
    });

    it.each(['low', 'medium', 'high'] as const)('passes %s effort for session ' + sessionId, async (effort) => {
      const child = new FakeChild();
      let args: readonly string[] = [];
      const run = createClaudeCodeAgent(
        fakeExecutionEnvironment({
          runProgram: (_command, argv) => {
            args = argv;
            return child.asExecProcess();
          },
        }),
      ).run({ ...baseTask, effort, sessionId });
      expect(args[args.indexOf('--effort') + 1]).toBe(effort);
      expect(args).not.toContain('--model');
      child.finish(0);
      await Array.fromAsync(run.events);
    });
  }

  it.each([
    ['small', 'global.anthropic.claude-haiku-5-5'],
    ['medium', 'global.anthropic.claude-sonnet-5-5'],
    ['large', 'opus'],
  ] as const)('maps %s to the Bedrock model when Claude Code runs on Bedrock', async (modelTier, model) => {
    const child = new FakeChild();
    let args: readonly string[] = [];
    const run = createClaudeCodeAgent(
      fakeExecutionEnvironment({
        runProgram: (_command, argv) => {
          args = argv;
          return child.asExecProcess();
        },
      }),
    ).run({ ...baseTask, env: { AWS_BEARER_TOKEN_BEDROCK: 'test-token' }, modelTier });
    expect(args[args.indexOf('--model') + 1]).toBe(model);
    child.finish(0);
    await Array.fromAsync(run.events);
  });

  it.each(tiers)('uses the override for %s', async (modelTier) => {
    const overrides = config.codingAgentModels['claude-code'];
    const previous = overrides[modelTier];
    overrides[modelTier] = { default: 'custom-model', bedrock: 'custom-model' };
    try {
      const child = new FakeChild();
      let args: readonly string[] = [];
      const run = createClaudeCodeAgent(
        fakeExecutionEnvironment({
          runProgram: (_command, argv) => {
            args = argv;
            return child.asExecProcess();
          },
        }),
      ).run({ ...baseTask, modelTier, effort: 'high', sessionId: 'session-1' });
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
    const run = createClaudeCodeAgent(
      fakeExecutionEnvironment({
        runProgram: (_command, argv) => {
          args = argv;
          return child.asExecProcess();
        },
      }),
    ).run(baseTask);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(args.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false);
    child.finish(0);
    await Array.fromAsync(run.events);
  });
});
