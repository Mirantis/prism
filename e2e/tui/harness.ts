/**
 * Process harness for the TUI e2e suite.
 *
 * Two processes per session:
 *  - `agent-runtime` as a plain background server (no PTY — it's just
 *    an HTTP+WS endpoint).
 *  - `prism-cli` under a real PTY pointed at the runtime over WebSocket.
 *    Ink requires raw-mode stdin, which only a TTY (or PTY) provides.
 */

import http from 'node:http';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as pty from 'node-pty';
import stripAnsi from 'strip-ansi';

const AGENT_RUNTIME_DIR = path.resolve(import.meta.dirname, '../..');
export const PRISM_CLI_DIR = path.resolve(import.meta.dirname, '../../cli');
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '../..');
// Spawn `node <tsx-cli.mjs> <entry>` instead of the .bin/tsx shim.
// macOS's posix_spawnp doesn't follow `#!/usr/bin/env node` reliably from
// node-pty when the env's PATH has been substituted, so we point at
// the node binary that's already running this process.
const TSX_CLI = path.join(WORKSPACE_ROOT, 'node_modules/tsx/dist/cli.mjs');

/**
 * Budget for a CLI's *first* frame — the `waitForFrame(/Prism/, …)` every spec
 * opens with. Deliberately generous: this suite's dominant flake is the boot
 * frame never arriving under CI load (it has blown a 90s budget in
 * share-file.test.ts), and a stalled boot fails the scenario with a timeout
 * that says nothing about the feature under test. It costs nothing on a
 * healthy run, because `waitForFrame` returns the moment the frame matches.
 *
 * This is a boot budget, not a round-trip one — chat replies, share-file's
 * 300s and compaction's 180s are sized against a model call and stay local to
 * their specs.
 */
export const BOOT_FRAME_TIMEOUT_MS = 120_000;

function sanitizeEnv(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailString(buf: string, max = 8_000): string {
  if (!buf) return '<no output>';
  return buf.length > max ? '… ' + buf.slice(-max) : buf;
}

// ----------------------------------------------------------------------------
// agent-runtime
// ----------------------------------------------------------------------------

export interface StartRuntimeOptions {
  /** Env block including PORT, DATABASE_URL, etc. */
  env: NodeJS.ProcessEnv;
  /**
   * Tee runtime stdout/stderr to the test process's stderr (with a `[runtime]`
   * prefix) in addition to the in-memory buffer. Default: on under CI, off
   * locally. Useful for debugging hangs where the in-buffer log tail never
   * makes it to the reporter (e.g. vitest's stacktrace symbolication crashes).
   */
  verbose?: boolean;
}

export interface RuntimeHandle {
  /** The TCP port the runtime is listening on (read from env.PORT). */
  port: number;
  /** Resolve when `/health` returns 200, or throw on timeout. */
  waitForReady(timeoutMs?: number): Promise<void>;
  /** SIGTERM → 5s grace → SIGKILL. */
  kill(): Promise<void>;
  /** Last N chars of the runtime's combined stdout + stderr. */
  logTail(max?: number): string;
}

export function startRuntime(opts: StartRuntimeOptions): RuntimeHandle {
  const port = Number.parseInt(opts.env.PORT ?? '', 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('startRuntime requires opts.env.PORT to be a valid port number');
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, 'src/index.ts'],
    {
      cwd: AGENT_RUNTIME_DIR,
      env: sanitizeEnv(opts.env) as NodeJS.ProcessEnv,
      // Pipe so we can capture pino output for error messages without
      // polluting vitest's reporter.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const verbose = opts.verbose ?? Boolean(process.env.CI);
  let buffer = '';
  const sink = (chunk: Buffer) => {
    const s = chunk.toString();
    buffer += s;
    if (verbose) process.stderr.write(s.replace(/^/gm, '[runtime] '));
  };
  child.stdout?.on('data', sink);
  child.stderr?.on('data', sink);

  let exited = false;
  let exitCode: number | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      resolve(code ?? -1);
    });
  });

  const logTail = (max = 8_000) => tailString(buffer, max);

  return {
    port,
    logTail,
    async waitForReady(timeoutMs = 30_000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (exited) {
          throw new Error(
            `agent-runtime exited (code ${exitCode}) before /health came up.\n` +
              `--- runtime log ---\n${logTail()}`,
          );
        }
        const ok = await probeHealth(port);
        if (ok) return;
        await sleep(100);
      }
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for agent-runtime /health on :${port}.\n` +
          `--- runtime log ---\n${logTail()}`,
      );
    },
    async kill() {
      if (exited) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      const code = await Promise.race([exitPromise, sleep(5_000).then(() => -1)]);
      if (code === -1) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        await exitPromise;
      }
    },
  };
}

function probeHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: 1_000 },
      (res) => {
        // Drain the body so the socket can close cleanly.
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ----------------------------------------------------------------------------
// prism-cli
// ----------------------------------------------------------------------------

export interface StartPrismOptions {
  /** Env block; must include PRISM_HTTP_URL pointing at the runtime. */
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  /** Optional: agent-runtime handle whose log tail is included in error messages. */
  runtime?: RuntimeHandle;
  /** Extra CLI argv appended after the entry (e.g. ['--resume']). */
  args?: string[];
  /**
   * Directory to launch the CLI from. The CLI sends this as the thread's
   * workspaceRoot, so a repo seeded with `.claude/skills/` is picked up as
   * workspace skills. Defaults to the prism-cli package dir.
   */
  cwd?: string;
}

export interface TuiSession {
  /** Snapshot of stdout so far, with ANSI escape sequences stripped. */
  output(): string;
  /** Raw stdout with ANSI escapes intact (debug only). */
  rawOutput(): string;
  /** Write raw bytes to the child's stdin. */
  send(input: string): void;
  /** Wait until the stripped output matches the given string or regex. */
  waitForFrame(matcher: string | RegExp, timeoutMs?: number): Promise<void>;
  /** Wait until the child process has exited. */
  waitForExit(timeoutMs?: number): Promise<number>;
  /** Send SIGTERM, then SIGKILL after a grace period. */
  stop(): Promise<number>;
}

/** Spawn `tsx src/index.tsx` from prism-cli under a PTY. */
export function startPrism(opts: StartPrismOptions): TuiSession {
  const child = pty.spawn(
    process.execPath,
    // Absolute entry path so `cwd` can be an arbitrary repo dir (the CLI sends
    // its cwd as the thread's workspaceRoot) without breaking entry resolution.
    [TSX_CLI, path.join(PRISM_CLI_DIR, 'src/index.tsx'), ...(opts.args ?? [])],
    {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 32,
      cwd: opts.cwd ?? PRISM_CLI_DIR,
      env: sanitizeEnv(opts.env),
    },
  );

  const runtimeLogTail = () =>
    opts.runtime ? opts.runtime.logTail() : '<no runtime handle>';

  let buffer = '';
  let exitCode: number | null = null;
  let exitSignal: number | null = null;

  child.onData((data) => {
    buffer += data;
  });

  const exitPromise = new Promise<number>((resolve) => {
    child.onExit(({ exitCode: code, signal }) => {
      exitCode = code;
      exitSignal = signal ?? null;
      resolve(code);
    });
  });

  const session: TuiSession = {
    output: () => stripAnsi(buffer),
    rawOutput: () => buffer,
    send: (input) => child.write(input),

    async waitForFrame(matcher, timeoutMs = 30_000) {
      const matches = (s: string) =>
        typeof matcher === 'string' ? s.includes(matcher) : matcher.test(s);
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (matches(stripAnsi(buffer))) return;
        if (exitCode !== null) {
          const msg =
            `prism-cli exited (code ${exitCode}, signal ${exitSignal}) before frame matched ${matcher}.\n` +
            `--- pty output ---\n${stripAnsi(buffer)}\n` +
            `--- runtime log ---\n${runtimeLogTail()}`;
          // Print directly: vitest's stacktrace symbolication occasionally
          // crashes on inline source-maps and swallows the thrown error.
          if (process.env.CI) process.stderr.write(`\n[harness] ${msg}\n`);
          throw new Error(msg);
        }
        await sleep(50);
      }
      const msg =
        `Timed out after ${timeoutMs}ms waiting for ${matcher}.\n` +
        `--- pty output ---\n${stripAnsi(buffer)}\n` +
        `--- runtime log ---\n${runtimeLogTail()}`;
      if (process.env.CI) process.stderr.write(`\n[harness] ${msg}\n`);
      throw new Error(msg);
    },

    async waitForExit(timeoutMs = 20_000) {
      if (exitCode !== null) return exitCode;
      const result = await Promise.race([
        exitPromise,
        sleep(timeoutMs).then(() => -1),
      ]);
      if (result === -1) {
        throw new Error(`prism-cli did not exit within ${timeoutMs}ms`);
      }
      return result;
    },

    async stop() {
      if (exitCode !== null) return exitCode;
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      const code = await Promise.race([
        exitPromise,
        sleep(5_000).then(() => -1),
      ]);
      if (code === -1) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        return exitPromise;
      }
      return code;
    },
  };

  return session;
}

/**
 * Keystroke constants for sending to the PTY.
 * Arrow keys use the standard CSI sequences xterm produces.
 */
export const KEYS = {
  ENTER: '\r',
  TAB: '\t',
  BACKSPACE: '\x08',
  ESC: '\x1b',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
  CTRL_C: '\x03',
  CTRL_O: '\x0f',
} as const;
