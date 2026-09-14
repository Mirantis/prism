/**
 * Whether this host can give the agent a computer.
 *
 * A computer is a virtual display with a desktop on it, so it needs more than a voice
 * session does: the X server and audio stack a meeting already requires, plus the desktop
 * itself. The container image installs all of it; a host running the runtime directly
 * usually has none of it.
 *
 * The Web UI asks once at startup and leaves the Computer page out when the answer is no,
 * rather than offering a page whose call cannot start.
 */

import { missingBinary } from '../../lib/has-binary';
import { isMeetingSupported } from '../../tools/meeting';
import { logger } from '../../logger';

/**
 * The programs a computer needs beyond the browser and the audio stack, which
 * `isMeetingSupported` already checks.
 */
export const COMPUTER_BINARIES = [
  'dbus-launch',
  'startxfce4',
  'xdotool',
  'xrandr',
  'ffmpeg',
  'wmctrl',
  'tesseract',
] as const;

/** The apt packages that install them, for the message a host without them gets. */
const COMPUTER_PACKAGES =
  'xfce4, dbus-x11, ffmpeg, xdotool, wmctrl, x11-xserver-utils, tesseract-ocr, ' +
  'at-spi2-core, python3-pyatspi';

export function unsupportedReason(missing: string): string {
  return (
    `this image lacks the desktop packages (${missing} is not on PATH; the set is ` +
    `${COMPUTER_PACKAGES}); rebuild it with \`npm run docker:build\``
  );
}

export async function isComputerSupported(): Promise<boolean> {
  if (!(await isMeetingSupported())) return false;
  const missing = await missingBinary(...COMPUTER_BINARIES);
  if (missing) {
    logger.info(`[VoiceChat] No computer on this host: ${missing} is not on PATH`);
    return false;
  }
  return true;
}

/**
 * The startup answer, for the Web UI to read on every `/agents/me`.
 *
 * False until `initComputerAvailability` runs, so a runtime that never probes — a test,
 * an embedder — simply does not offer the page. A session asks `isComputerSupported`
 * again when it opens a computer, since an answer from startup is not a promise about now.
 */
let computerAvailable = false;

export function hasComputer(): boolean {
  return computerAvailable;
}

/** Probe once and remember the answer. Never throws: a failed probe means "no computer". */
export async function initComputerAvailability(): Promise<boolean> {
  try {
    computerAvailable = await isComputerSupported();
  } catch (err) {
    logger.warn(`[VoiceChat] Computer probe failed: ${String(err)}`);
    computerAvailable = false;
  }
  return computerAvailable;
}
