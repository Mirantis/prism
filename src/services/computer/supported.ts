/** Desktop availability is independent of voice credentials. */

import { missingBinary } from '../../lib/has-binary';
import { AUDIO_STACK_BINARIES } from '../meeting/audio-stack';
import { isBrowserAvailable } from '../meeting/browser-stack';
import { logger } from '../../logger';

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
  if (!(await isBrowserAvailable())) return false;
  if (await missingBinary(...AUDIO_STACK_BINARIES)) return false;
  const missing = await missingBinary(...COMPUTER_BINARIES);
  if (missing) {
    logger.info(`[Computer] No computer on this host: ${missing} is not on PATH`);
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

/** Meetings use their own browser; subagents return work to the desktop's owning invocation. */
export function hasComputerForMode(mode: string): boolean {
  return hasComputer() && mode !== 'meeting' && mode !== 'subagent';
}

/** Probe once and remember the answer. Never throws: a failed probe means "no computer". */
export async function initComputerAvailability(): Promise<boolean> {
  try {
    computerAvailable = await isComputerSupported();
  } catch (err) {
    logger.warn(`[Computer] Computer probe failed: ${String(err)}`);
    computerAvailable = false;
  }
  return computerAvailable;
}
