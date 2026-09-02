/**
 * An XFCE desktop on the virtual display, so the screen the page shows is a desktop
 * with the agent's browser on it rather than a bare X root.
 *
 * `startxfce4` under `dbus-launch`, which gives the session the bus XFCE expects
 * without a display manager or an init system. The desktop belongs to one voice chat
 * and dies with it.
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../../logger';

/** How long the desktop gets to exit on SIGTERM before SIGKILL. */
const EXIT_GRACE_MS = 3_000;

export class DesktopSession {
  private proc: ChildProcess | null = null;

  /** `env` is the virtual display's: DISPLAY, XDG_RUNTIME_DIR and the PulseAudio vars. */
  constructor(private readonly env: Record<string, string>) {}

  /** Start the desktop. Resolves once the process is up; the panel appears a moment later. */
  start(): void {
    const proc = spawn('dbus-launch', ['--exit-with-session', 'startxfce4'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...this.env },
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

  /** Stop the desktop. Idempotent, and never throws. */
  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.kill('SIGTERM');
    } catch {
      return;
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
}
