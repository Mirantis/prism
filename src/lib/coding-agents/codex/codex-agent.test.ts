import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeChild } from '../../../test-utils/fake-child';
import type { CodingAgentEvent, CodingAgentTask } from '../coding-agent';
import { createCodexAgent } from './codex-agent';

const task: CodingAgentTask = {
  taskId: 'task-1', prompt: 'Inspect the project', workdir: '/work',
  env: { OPENAI_API_KEY: 'test-key' }, mode: 'edit', maxTurns: 100, gateMode: 'off',
};

afterEach(() => vi.unstubAllEnvs());

async function collect(lines: object[]) {
  const child = new FakeChild();
  const run = createCodexAgent(() => child.asChildProcess()).run(task);
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
    const spawner = vi.fn(() => child.asChildProcess());
    const run = createCodexAgent(spawner).run({ ...task, mode, gateMode });
    expect(spawner).toHaveBeenCalledWith('codex', expect.arrayContaining([
      'exec', '--json', 'approval_policy="never"', `sandbox_mode="${sandbox}"`,
    ]), { cwd: '/work', env: { OPENAI_API_KEY: 'test-key', CODEX_API_KEY: 'test-key' } });
    child.finish(1);
    await Array.fromAsync(run.events);
  });

  it('resumes with the requested permissions and preserves prompt text', async () => {
    const child = new FakeChild();
    const spawner = vi.fn(() => child.asChildProcess());
    const run = createCodexAgent(spawner).run({ ...task, sessionId: 'session-1',
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
    const agent = createCodexAgent(() => children[index++].asChildProcess());
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
      expect(process.env.CODEX_HOME).toBe(home.configDir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
