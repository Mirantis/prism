/**
 * What the desktop terminal's `claude` and `codex` run: the wrappers that
 * `desktop-session.ts` puts first on the desktop's PATH exec
 * `node coding-agent-exec.js <claude|codex> [args…]`.
 *
 * It reads the subscription switch from the runtime's database, read-only,
 * builds the environment the way a task does, and runs the real binary from
 * the rest of the PATH. With the switch on and nobody signed in it refuses,
 * as a task does, rather than run on the deployment's models. When the
 * database can't be read it says so and runs as with the switch off.
 */

import { spawn, spawnSync, type StdioOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { notSignedInMessage } from '../lib/coding-agents/subscription';
import {
  isTerminalCommand,
  loginStatusArgs,
  signedInToSubscription,
  terminalLaunch,
  terminalUsesSubscription,
  TERMINAL_COMMANDS,
  WRAPPERS_ENV,
} from '../lib/coding-agents/terminal';

const LOGIN_CHECK_TIMEOUT_MS = 30_000;

interface Io {
  stdio: StdioOptions;
  stderr: (line: string) => void;
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io = { stdio: 'inherit', stderr: (line) => process.stderr.write(`${line}\n`) },
): Promise<number> {
  const [command, ...args] = argv;
  if (!isTerminalCommand(command)) {
    io.stderr('usage: coding-agent-exec <claude|codex> [args…]');
    return 2;
  }
  const agent = TERMINAL_COMMANDS[command];
  const wrappers = env[WRAPPERS_ENV];
  const { [WRAPPERS_ENV]: _wrappers, ...rest } = env;
  const childEnv: NodeJS.ProcessEnv = {
    ...rest,
    PATH: (env.PATH ?? '').split(path.delimiter).filter((dir) => dir && dir !== wrappers).join(path.delimiter),
  };

  let subscription = false;
  try {
    subscription = terminalUsesSubscription(env, agent);
  } catch (err) {
    io.stderr(`${command}: could not read the Coding agents setting (${(err as Error).message}); using the deployment's models`);
  }
  const launch = terminalLaunch(command, args, childEnv, subscription);

  if (launch.checkLogin) {
    const status = spawnSync(command, loginStatusArgs(command), {
      env: launch.env,
      encoding: 'utf8',
      timeout: LOGIN_CHECK_TIMEOUT_MS,
    });
    if (status.error && (status.error as NodeJS.ErrnoException).code === 'ENOENT') {
      io.stderr(`${command}: command not found`);
      return 127;
    }
    if (!signedInToSubscription(command, { stdout: status.stdout ?? '', stderr: status.stderr ?? '', exitCode: status.status })) {
      io.stderr(notSignedInMessage(agent));
      return 1;
    }
  }

  return new Promise((resolve) => {
    const child = spawn(command, launch.args, { stdio: io.stdio, env: launch.env });
    // The terminal sends Ctrl-C and Ctrl-\ to the whole foreground group, the
    // CLI included; passing them on would deliver them twice.
    const ignore = () => {};
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const handlers: [NodeJS.Signals, () => void][] = [
      ['SIGINT', ignore],
      ['SIGQUIT', ignore],
      ['SIGTERM', forward('SIGTERM')],
      ['SIGHUP', forward('SIGHUP')],
    ];
    for (const [signal, handler] of handlers) process.on(signal, handler);
    let finished = false;
    const done = (code: number) => {
      if (finished) return;
      finished = true;
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(code);
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      io.stderr(err.code === 'ENOENT' ? `${command}: command not found` : `${command}: ${err.message}`);
      done(err.code === 'ENOENT' ? 127 : 126);
    });
    child.on('exit', (code, signal) => done(code ?? 128 + (signal ? os.constants.signals[signal] : 0)));
  });
}

if (typeof module !== 'undefined' && require.main === module) {
  void main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
