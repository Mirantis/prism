import { config } from '../../../config';
/**
 * The Claude Code adapter against a fake `claude`: the argv it builds for each
 * mode and gate setting, the events it reads out of the stream-json output, and
 * the home it prepares at boot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FakeChild } from '../../../test-utils/fake-child';
import type { Spawner } from '../cli-run';
import type { CodingAgentEvent, CodingAgentTask } from '../coding-agent';
import { createClaudeCodeAgent, PLAN_ONLY_INSTRUCTION } from './claude-code-agent';

const baseTask: CodingAgentTask = {
  taskId: 't1',
  prompt: 'do X',
  env: { PATH: '/bin' },
  mode: 'edit',
  maxTurns: 100,
  gateMode: 'off',
};

/** Start a task with a spawner that records the spawn instead of running anything. */
function capture(task: Partial<CodingAgentTask>): {
  command: string;
  args: readonly string[];
  options: { cwd?: string; env: NodeJS.ProcessEnv };
} {
  let captured: Parameters<Spawner> | undefined;
  const spawner: Spawner = (...spawnArgs) => {
    captured = spawnArgs;
    return new FakeChild().asChildProcess();
  };
  createClaudeCodeAgent(spawner).run({ ...baseTask, ...task });
  if (!captured) throw new Error('spawner was not called');
  return { command: captured[0], args: captured[1], options: captured[2] };
}

/** The value carried by a flag, or undefined when the flag is absent. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/** Feed stream-json lines to a fake `claude` and collect what the adapter reads. */
async function eventsFor(lines: object[]): Promise<CodingAgentEvent[]> {
  const child = new FakeChild();
  const run = createClaudeCodeAgent(() => child.asChildProcess()).run(baseTask);
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
    expect(options.env).toEqual({ PATH: '/bin' });
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

  it.each(['off', 'observe'] as const)('preserves bypass permissions in %s gate mode', (gateMode) => {
    const { args } = capture({ gateMode });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('auto');
  });

  it('uses auto permission mode without bypass when the gate enforces', () => {
    const { args } = capture({ gateMode: 'enforce' });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
  });

  it('keeps plan mode without bypass when the gate enforces', () => {
    const { args } = capture({ gateMode: 'enforce', mode: 'plan' });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
    expect(args).not.toContain('auto');
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

  it('constrains plan mode by instruction, since the permission mode does not', () => {
    // The off/observe branch passes bypass permissions, under which Claude Code
    // auto-approves writes even in plan mode — so the instruction is the real guard.
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

  it('keeps the plan constraint under the enforcing tool-risk gate too', () => {
    // Enforce mode withholds bypass, so plan really is read-only there; the
    // instruction still rides along, since `claude` on PATH is not version-pinned.
    const { args } = capture({ gateMode: 'enforce', mode: 'plan', appendSystemPrompt: 'custom' });
    expect(args).not.toContain('--dangerously-skip-permissions');
    const value = valueOf(args, '--append-system-prompt');
    expect(value).toContain(PLAN_ONLY_INSTRUCTION);
    expect(value).toContain('custom');
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
    const run = createClaudeCodeAgent(() => child.asChildProcess()).run(baseTask);
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
  const agent = createClaudeCodeAgent();
  let savedConfigDir: string | undefined;
  let tmp: string;

  beforeEach(() => {
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-claude-home-'));
    fs.mkdirSync(path.join(tmp, 'skills'));
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the config dir, links the skills dir into it and sets CLAUDE_CONFIG_DIR', () => {
    const skillsDir = path.join(tmp, 'skills');
    const home = agent.prepareHome({ dataDir: tmp, skillsDir });

    expect(home.configDir).toBe(path.join(tmp, '.claude'));
    expect(fs.statSync(home.configDir).isDirectory()).toBe(true);
    expect(home.skillsLinked).toBe(true);
    const link = path.join(home.configDir, 'skills');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(skillsDir));
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(home.configDir);
    // Only skills are exposed — Claude Code's plugin layout differs from the
    // Agent Plugins one, so plugins are deliberately not linked across.
    expect(fs.existsSync(path.join(home.configDir, 'plugins'))).toBe(false);
  });

  it.each(['theirs', 'theirs '])('reports the operator-set home %j', (directory) => {
    const theirs = path.join(tmp, directory);
    fs.mkdirSync(theirs);
    process.env.CLAUDE_CONFIG_DIR = theirs;

    const home = agent.prepareHome({ dataDir: tmp, skillsDir: path.join(tmp, 'skills') });

    expect(process.env.CLAUDE_CONFIG_DIR).toBe(theirs);
    expect(home).toEqual({ configDir: theirs, skillsLinked: false });
    expect(fs.readdirSync(theirs)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, '.claude'))).toBe(false);
  });

  it('reports skills as linked when the operator-set home already points at them', () => {
    const theirs = path.join(tmp, 'theirs');
    fs.mkdirSync(theirs);
    fs.symlinkSync(path.join(tmp, 'skills'), path.join(theirs, 'skills'));
    process.env.CLAUDE_CONFIG_DIR = theirs;

    const home = agent.prepareHome({ dataDir: tmp, skillsDir: path.join(tmp, 'skills') });
    expect(home).toEqual({ configDir: theirs, skillsLinked: true });
  });

  it('reports the skills as unlinked when a populated dir sits at the link path', () => {
    const claudeSkills = path.join(tmp, '.claude', 'skills');
    fs.mkdirSync(claudeSkills, { recursive: true });
    fs.writeFileSync(path.join(claudeSkills, 'keep.txt'), 'x');

    const home = agent.prepareHome({ dataDir: tmp, skillsDir: path.join(tmp, 'skills') });
    expect(home.skillsLinked).toBe(false);
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
      const run = createClaudeCodeAgent((_command, argv) => {
        args = argv;
        return child.asChildProcess();
      }).run({ ...baseTask, modelTier, sessionId });
      expect(args[args.indexOf('--model') + 1]).toBe(models[tiers.indexOf(modelTier)]);
      child.finish(0);
      await Array.fromAsync(run.events);
    });

    it.each(['low', 'medium', 'high'] as const)('passes %s effort for session ' + sessionId, async (effort) => {
      const child = new FakeChild();
      let args: readonly string[] = [];
      const run = createClaudeCodeAgent((_command, argv) => {
        args = argv;
        return child.asChildProcess();
      }).run({ ...baseTask, effort, sessionId });
      expect(args[args.indexOf('--effort') + 1]).toBe(effort);
      expect(args).not.toContain('--model');
      child.finish(0);
      await Array.fromAsync(run.events);
    });
  }

  it.each(tiers)('uses the override for %s', async (modelTier) => {
    const overrides = config.codingAgentModelOverrides['claude-code'];
    const previous = overrides[modelTier];
    overrides[modelTier] = 'custom-model';
    try {
      const child = new FakeChild();
      let args: readonly string[] = [];
      const run = createClaudeCodeAgent((_command, argv) => {
        args = argv;
        return child.asChildProcess();
      }).run({ ...baseTask, modelTier, effort: 'high', sessionId: 'session-1' });
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
    const run = createClaudeCodeAgent((_command, argv) => {
      args = argv;
      return child.asChildProcess();
    }).run(baseTask);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(args.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false);
    child.finish(0);
    await Array.fromAsync(run.events);
  });
});
