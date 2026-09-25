/** Real processes and real signals: SIGSTOP is the whole point, and nothing fakes it. */

import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { agentProcesses } from './agent-processes';
import { createLocalEnvironment } from './execution-environments/local/local-environment';
import type { ExecProcess } from './execution-environments/execution-environment';

const execFileAsync = promisify(execFile);
const environment = createLocalEnvironment();

/** Whether a pid still names a live process; a zombie counts as gone. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return true;
}

function run(command: string): ExecProcess {
  return environment.runShell(command, { cwd: os.tmpdir(), env: process.env, stdin: 'ignore' });
}

/** A command that keeps talking, so silence means it is stopped. */
function chatty(): { proc: ExecProcess; ticks: () => number } {
  // Ticking rather than spinning: every iteration spawns `sleep`, so a faster loop
  // would load the machine the rest of the suite runs on.
  const proc = run('while true; do echo tick; sleep 0.05; done');
  let ticks = 0;
  proc.stdout?.on('data', (chunk: Buffer) => {
    ticks += chunk.toString().split('tick').length - 1;
  });
  return { proc, ticks: () => ticks };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const started: ExecProcess[] = [];

afterEach(async () => {
  agentProcesses.resume();
  for (const proc of started.splice(0)) {
    proc.kill('SIGKILL');
    await proc.ended;
  }
});

describe('the agent’s own processes', () => {
  // First, so the count it reads is its own process and nobody else's.
  it('forgets a process that has exited', async () => {
    const proc = run('exit 0');
    expect(agentProcesses.running).toBe(1);
    await proc.ended;
    await settle(0);
    expect(agentProcesses.running).toBe(0);
  });

  it('stops a running command and starts it again', async () => {
    const { proc, ticks } = chatty();
    started.push(proc);
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
    const { proc, ticks } = chatty();
    started.push(proc);
    await settle(200);
    expect(ticks()).toBe(0);

    agentProcesses.resume();
    await expect.poll(ticks, { timeout: 2_000 }).toBeGreaterThan(0);
  });

  it('starts one that lands in the last moment of the window', async () => {
    agentProcesses.suspend();
    const { proc, ticks } = chatty();
    started.push(proc);
    agentProcesses.resume();

    await expect.poll(ticks, { timeout: 2_000 }).toBeGreaterThan(0);
  });

  it('ends a held command that is killed before the window closes', async () => {
    agentProcesses.suspend();
    const proc = run('echo ran');
    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));

    expect(proc.kill('SIGTERM')).toBe(true);
    await expect(proc.closed).resolves.toMatchObject({ signal: 'SIGTERM' });
    agentProcesses.resume();
    await settle(100);
    // It never started, so nothing ran when the window closed.
    expect(output).toBe('');
  });

  it('kills what it started, stopped or not, when the runtime exits', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-processes-'));
    const script = path.join(dir, 'runtime.ts');
    const local = path.resolve(__dirname, 'execution-environments/local/local-environment.ts');
    await fs.writeFile(
      script,
      `import { agentProcesses } from ${JSON.stringify(path.resolve(__dirname, 'agent-processes.ts'))};\n` +
        `import { createLocalEnvironment } from ${JSON.stringify(local)};\n` +
        `const proc = createLocalEnvironment().runShell('echo $$; exec sleep 30', { cwd: '/', env: process.env, stdin: 'ignore' });\n` +
        `proc.stdout!.once('data', (chunk) => {\n` +
        `  console.log(chunk.toString().trim());\n` +
        `  agentProcesses.suspend();\n` +
        `  setTimeout(() => process.exit(0), 200);\n` +
        `});\n`,
    );
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', script]);
    const pid = Number(stdout.trim().split('\n').pop());
    await fs.rm(dir, { recursive: true, force: true });

    await expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false);
  });
});
