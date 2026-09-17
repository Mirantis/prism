/** Real children and real signals: SIGSTOP is the whole point, and nothing fakes it. */

import { describe, it, expect, afterEach } from 'vitest';
import { execFile, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { agentProcesses } from './agent-processes';

const execFileAsync = promisify(execFile);

/** Whether a pid still names a live process; a zombie counts as gone. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return true;
}

/** A child that keeps talking, so silence means it is stopped. */
function chatty(): { child: ChildProcess; ticks: () => number } {
  const child = agentProcesses.spawn(
    '/bin/bash',
    // Ticking rather than spinning: every iteration spawns `sleep`, so a faster loop
    // would load the machine the rest of the suite runs on.
    ['-c', 'while true; do echo tick; sleep 0.05; done'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let ticks = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    ticks += chunk.toString().split('tick').length - 1;
  });
  return { child, ticks: () => ticks };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const started: ChildProcess[] = [];

afterEach(() => {
  agentProcesses.resume();
  for (const child of started.splice(0)) {
    try {
      process.kill(-(child.pid as number), 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
});

describe('the agent’s own processes', () => {
  // First, so the count it reads is its own child and nobody else's.
  it('forgets a child that has exited', async () => {
    const child = agentProcesses.spawn('/bin/bash', ['-c', 'exit 0'], { stdio: 'ignore' });
    expect(agentProcesses.running).toBe(1);
    await new Promise((resolve) => child.once('exit', resolve));
    expect(agentProcesses.running).toBe(0);
  });

  it('stops a running command and starts it again', async () => {
    const { child, ticks } = chatty();
    started.push(child);
    await expect.poll(ticks, { timeout: 2_000 }).toBeGreaterThan(0);

    agentProcesses.suspend();
    await settle(100);
    const whileStopped = ticks();
    await settle(200);
    expect(ticks()).toBe(whileStopped);

    agentProcesses.resume();
    await expect.poll(ticks, { timeout: 2_000 }).toBeGreaterThan(whileStopped);
  });

  it('holds a command that lands inside the window until it closes', async () => {
    agentProcesses.suspend();
    const { child, ticks } = chatty();
    started.push(child);
    await settle(200);
    expect(ticks()).toBe(0);

    agentProcesses.resume();
    await expect.poll(ticks, { timeout: 2_000 }).toBeGreaterThan(0);
  });

  it('kills what it started, stopped or not, when the runtime exits', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-processes-'));
    const script = path.join(dir, 'runtime.ts');
    await fs.writeFile(
      script,
      `import { agentProcesses } from ${JSON.stringify(path.resolve(__dirname, 'agent-processes.ts'))};\n` +
        `const child = agentProcesses.spawn('/bin/sleep', ['30'], { stdio: 'ignore' });\n` +
        `console.log(child.pid);\n` +
        `agentProcesses.suspend();\n` +
        `setTimeout(() => process.exit(0), 200);\n`,
    );
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', script]);
    const pid = Number(stdout.trim().split('\n').pop());
    await fs.rm(dir, { recursive: true, force: true });

    await expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false);
  });

  it('starts one that lands in the last moment of the window', async () => {
    // The window closes before the child has reached the gate.
    agentProcesses.suspend();
    const { child, ticks } = chatty();
    started.push(child);
    agentProcesses.resume();

    await expect.poll(ticks, { timeout: 2_000 }).toBeGreaterThan(0);
  });

});
