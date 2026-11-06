/**
 * Runs the suite's runtime as a child and starts it again when something kills
 * it with SIGKILL, as the process manager of a deployment does. The restart
 * scenario kills the runtime by the pid this writes to `RUNTIME_PID_FILE`.
 *
 * Any other exit ends the supervisor with the runtime's exit code, so a crash
 * still fails the suite. SIGTERM and SIGINT go to the runtime, and the
 * supervisor ends when the runtime does.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { RUNTIME_PID_FILE } from './runtime-pid';
import { PRISM_SERVER_BIN, assertRuntimeBuilt, webSuiteRuntimeEnv } from './runtime-command';

let runtime: ChildProcess;
let stopping = false;

function start(): void {
  runtime = spawn(PRISM_SERVER_BIN, [], {
    stdio: 'inherit',
    env: { ...process.env, ...webSuiteRuntimeEnv() },
  });
  writeFileSync(RUNTIME_PID_FILE, String(runtime.pid));
  runtime.on('exit', (code, signal) => {
    if (!stopping && signal === 'SIGKILL') {
      console.log('[runtime-supervisor] The runtime was killed; starting it again');
      start();
      return;
    }
    rmSync(RUNTIME_PID_FILE, { force: true });
    process.exit(code ?? 1);
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping = true;
    runtime.kill(signal);
  });
}

assertRuntimeBuilt();
start();
