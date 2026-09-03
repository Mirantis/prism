/**
 * An XFCE desktop on the virtual display, so the screen the page shows is a desktop
 * with the agent's browser on it rather than a bare X root.
 *
 * The session bus is started here first, with `dbus-launch`, so its address is known
 * and can be handed to every program that should appear in the accessibility tree or
 * read it: the desktop, the browser, and the dump in `screen-elements.ts`. XFCE then
 * starts with accessibility switched on. The desktop belongs to one voice chat and dies
 * with it, bus included.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../logger';

const run = promisify(execFile);

/** How long the desktop gets to exit on SIGTERM before SIGKILL. */
const EXIT_GRACE_MS = 3_000;

export class DesktopSession {
  private proc: ChildProcess | null = null;
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
      env: {
        ...process.env,
        ...this.env,
        ...this.busEnv,
        // Debian puts games under /usr/games, which the runtime's PATH lacks; the menu
        // entries start them by bare name, so the desktop's PATH has to have it.
        PATH: `${process.env.PATH ?? ''}:/usr/games`,
      },
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

  /** Stop the desktop, then its bus. Idempotent, and never throws. */
  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      const deadline = Date.now() + EXIT_GRACE_MS;
      while (proc.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
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
