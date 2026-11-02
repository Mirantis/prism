/**
 * An XFCE desktop on the virtual display, so the screen the page shows is a desktop
 * with the agent's browser on it rather than a bare X root.
 *
 * The session bus is started here first, with `dbus-launch`, so its address is known
 * and can be handed to every program that should appear in the accessibility tree or
 * read it: the desktop, the browser, and the dump in `screen-elements.ts`. XFCE then
 * starts with accessibility switched on, and Plank is the dock along its bottom edge.
 * The desktop belongs to one voice chat and dies with it, bus included.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../logger';
import { getExecutionEnvironment } from '../../lib/execution-environments/get-execution-environment';

/**
 * The coding agents' homes, so `claude` or `codex` in the desktop's terminal
 * share the login a sign-in from Coding agents saved for tasks. Only when tasks
 * run in this container: a docker environment's homes are paths in another one.
 */
export function codingAgentHomesEnv(): Record<string, string> {
  try {
    const environment = getExecutionEnvironment();
    if (environment.id !== 'local') return {};
    const { claudeHome, codexHome } = environment.paths();
    return { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
  } catch (err) {
    logger.debug({ err }, "[VoiceChat] No coding agent homes for the desktop's terminal");
    return {};
  }
}

const run = promisify(execFile);

/** How long a program gets to exit on SIGTERM before SIGKILL. */
const EXIT_GRACE_MS = 3_000;
const COMMAND_TIMEOUT_MS = 10_000;
/** The dock's settings, which are per dock and so addressed by their path. */
const DOCK_SETTINGS = 'net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/';
/** The dock's half of the desktop's theme; the image installs it. */
const DOCK_THEME = 'Orchis';

export class DesktopSession {
  private proc: ChildProcess | null = null;
  private dock: ChildProcess | null = null;
  private busPid: number | null = null;
  /**
   * The session bus address and the accessibility switches. Every program that should
   * show up in the accessibility tree, or read it, starts with these in its environment.
   */
  busEnv: Record<string, string> = {};

  /** `env` is the virtual display's: DISPLAY, XDG_RUNTIME_DIR and the PulseAudio vars. */
  constructor(private readonly env: Record<string, string>) {}

  /** Start the bus and the desktop. Resolves once both are up; the panel appears a moment later. */
  async start(): Promise<void> {
    const { stdout } = await run('dbus-launch', ['--sh-syntax'], {
      env: { ...process.env, ...this.env },
      timeout: 10_000,
    });
    const address = stdout.match(/DBUS_SESSION_BUS_ADDRESS='([^']+)'/)?.[1];
    const pid = Number(stdout.match(/DBUS_SESSION_BUS_PID=(\d+)/)?.[1]);
    if (!address) throw new Error('dbus-launch printed no session bus address');
    this.busPid = Number.isFinite(pid) ? pid : null;
    this.busEnv = {
      DBUS_SESSION_BUS_ADDRESS: address,
      // GTK loads its accessibility bridge on these; Chromium and Qt read the other two.
      GTK_MODULES: 'gail:atk-bridge',
      ACCESSIBILITY_ENABLED: '1',
      QT_ACCESSIBILITY: '1',
    };

    const proc = spawn('startxfce4', [], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...codingAgentHomesEnv(), ...this.env, ...this.busEnv },
    });
    proc.on('error', (err) => logger.warn({ err }, '[VoiceChat] Desktop failed to start'));
    proc.on('exit', (code, signal) => {
      if (this.proc === proc) {
        logger.warn(`[VoiceChat] Desktop exited on its own (${signal ?? code})`);
        this.proc = null;
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logger.debug(`[VoiceChat:Desktop] ${line.split('\n').slice(-1)[0]}`);
    });
    this.proc = proc;
  }

  /**
   * Start the dock, replacing the one already running.
   *
   * Plank places itself against the screen once, when it starts, and stays where it put
   * itself when the screen changes size. The session therefore starts it after the screen
   * is the size it will be shown at, and again each time that size changes.
   */
  async startDock(): Promise<void> {
    // The dock starts the terminal too.
    const env = { ...process.env, ...codingAgentHomesEnv(), ...this.env, ...this.busEnv };
    const dock = this.dock;
    this.dock = null;
    await endProcess(dock);
    // Plank hides itself when a window comes near, which on a desktop nobody sits at
    // reads as a dock that is not there, and it takes its own look rather than the
    // desktop's, so both are said here.
    for (const [key, value] of [
      ['hide-mode', 'none'],
      ['theme', DOCK_THEME],
    ]) {
      await run('gsettings', ['set', DOCK_SETTINGS, key, value], {
        env,
        timeout: COMMAND_TIMEOUT_MS,
      }).catch((err: unknown) => logger.debug({ err }, `[VoiceChat] Could not set the dock's ${key}`));
    }

    const proc = spawn('plank', [], { stdio: ['ignore', 'ignore', 'pipe'], env });
    proc.on('error', (err) => logger.warn({ err }, '[VoiceChat] Dock failed to start'));
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logger.debug(`[VoiceChat:Dock] ${line.split('\n').slice(-1)[0]}`);
    });
    this.dock = proc;
  }

  /** Stop the dock and the desktop, then the bus. Idempotent, and never throws. */
  async stop(): Promise<void> {
    const dock = this.dock;
    const proc = this.proc;
    this.dock = null;
    this.proc = null;
    await endProcess(dock);
    await endProcess(proc);
    const busPid = this.busPid;
    this.busPid = null;
    if (busPid !== null) {
      try {
        process.kill(busPid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }
}

/**
 * SIGTERM, a moment to go, then SIGKILL.
 *
 * The wait is on the `exit` event, since a process that left on a signal reports it in
 * `signalCode` and leaves `exitCode` null.
 */
async function endProcess(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.removeAllListeners('exit');
  const gone = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  try {
    proc.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, EXIT_GRACE_MS);
  });
  await Promise.race([gone, grace]);
  clearTimeout(timer);
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}
