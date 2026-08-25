/**
 * Download, verify and install one release into a standalone (SEA) install.
 *
 * The install root is the directory holding the running binary (~/.prism).
 * A release is staged under `<installRoot>/updates/<version>/` — the same
 * filesystem as the install, so activation is a handful of atomic renames:
 * current entry → `.update-trash/`, staged entry → current. The running
 * process keeps its open inodes, so the swap never touches it; the caller
 * exits afterwards and the service supervisor (launchd KeepAlive / systemd
 * Restart=always) respawns the new binary.
 *
 * Windows needs a second process for it. This runtime cannot stop its own
 * Scheduled Task, restart it, and still be around to report the outcome, and
 * the task restarts only on failure rather than on any exit — so there the
 * staged `install.ps1` is spawned detached: it stops the task and the server,
 * swaps the install by the same rename-aside-and-roll-back method used here,
 * re-registers the task and starts it again. `prism.exe` is deliberately left
 * running, since a self-update is usually driven by it.
 */

import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, renameSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { logger } from '../../logger';
import { UPDATE_GITHUB_REPO } from '../../constants';

const execFileAsync = promisify(execFile);

/** Whole-archive download budget; the archives are ~100-200 MB. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;

/**
 * What went wrong, kept narrow enough that a stored code points at one cause.
 * `verify_failed` means the bytes really were wrong; a missing checksum or a
 * failed extraction get their own codes, because reading either as "the bytes
 * were wrong" sends whoever is diagnosing it the wrong way.
 */
export type UpdateErrorCode =
  | 'download_failed'
  | 'asset_not_found'
  | 'checksum_unavailable'
  | 'extract_failed'
  | 'probe_failed'
  | 'verify_failed'
  | 'swap_failed'
  | 'spawn_failed';

export class UpdateError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UpdateError';
  }
}

/** The directory the running binary was installed into (~/.prism). */
export function installRoot(): string {
  return path.dirname(process.execPath);
}

function osArch(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Download and verify one release. Returns the staged dist directory
 * (`<installRoot>/updates/<version>/<platform>-<arch>`) ready to activate.
 */
export async function stageRelease(version: string, root: string = installRoot()): Promise<string> {
  const stagingRoot = path.join(root, 'updates', version);

  // A stage left by a deferred automatic apply (the agent was busy after the
  // download) is reused rather than re-downloaded — a few hundred MB every
  // tick while the agent stays busy would be waste.
  //
  // What that reuse re-checks is the layout and the binary's own reported
  // version, not the checksum: the archive it was verified from is deleted
  // straight after extraction. So this trusts that nothing rewrote the staged
  // files since. That is not a privilege boundary — the staging dir sits in
  // the install root, which is user-writable and already holds the running
  // binary — so anything able to tamper with it can edit the binary directly.
  const existing = await verifiedStagedDist(stagingRoot, version);
  if (existing) return existing;

  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  const asset = `prism-${version}-${osArch()}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const assetUrl = `https://github.com/${UPDATE_GITHUB_REPO}/releases/download/${version}/${asset}`;
  const archivePath = path.join(stagingRoot, asset);

  await downloadTo(assetUrl, archivePath);
  await verifyChecksum(assetUrl, archivePath);
  await extract(archivePath, stagingRoot);
  rmSync(archivePath, { force: true });

  const distDir = path.join(stagingRoot, osArch());
  const serverBinary = path.join(distDir, process.platform === 'win32' ? 'prism-server.exe' : 'prism-server');
  const expected = [
    path.join(distDir, process.platform === 'win32' ? 'prism.exe' : 'prism'),
    serverBinary,
    path.join(distDir, 'node_modules'),
    path.join(distDir, 'web'),
  ];
  for (const entry of expected) {
    if (!existsSync(entry)) {
      throw new UpdateError('verify_failed', `archive is missing ${path.basename(entry)}`);
    }
  }

  await probeStagedVersion(serverBinary, version);
  return distDir;
}

/** A previously staged dist for `version`, when its binary still verifies. */
async function verifiedStagedDist(stagingRoot: string, version: string): Promise<string | null> {
  const distDir = path.join(stagingRoot, osArch());
  const serverBinary = path.join(distDir, process.platform === 'win32' ? 'prism-server.exe' : 'prism-server');
  if (!existsSync(serverBinary)) return null;
  try {
    await probeStagedVersion(serverBinary, version);
    return distDir;
  } catch {
    return null;
  }
}

/**
 * The staged binary must identify as the target version — catches a wrong or
 * corrupt asset before anything is activated.
 */
async function probeStagedVersion(serverBinary: string, version: string): Promise<void> {
  let reported: string;
  try {
    const { stdout } = await execFileAsync(serverBinary, ['--version'], { timeout: PROBE_TIMEOUT_MS });
    reported = stdout.trim();
  } catch (error: unknown) {
    throw new UpdateError(
      'probe_failed',
      `staged prism-server --version failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (reported !== version) {
    throw new UpdateError('verify_failed', `staged prism-server reports ${reported}, expected ${version}`);
  }
}

/**
 * Activate a staged release on macOS/Linux: rename each current entry into
 * `.update-trash/<ts>/` and the staged entry into place. On a mid-swap
 * failure every completed rename is reversed, so the install is never left
 * half-swapped. The caller exits the process afterwards.
 *
 * Four renames, not one: a host crash inside that window can leave a mixed
 * install that needs a re-run of the installer. Named trade — a single-root
 * activation needs the whole install layout rebuilt around a versioned code
 * dir (install.sh, the launcher symlink, the service definitions), and the
 * window here is a few renames on one filesystem.
 */
export function swapInstall(distDir: string, root: string = installRoot()): void {
  const trashDir = path.join(root, '.update-trash', String(Date.now()));
  mkdirSync(trashDir, { recursive: true });

  const entries = ['node_modules', 'web', 'prism', 'prism-server'];
  const done: string[] = [];
  // The entry whose current copy is already in the trash while its staged
  // replacement has not landed yet — the one state the done-list can't see.
  let inFlight: string | null = null;
  try {
    for (const entry of entries) {
      const current = path.join(root, entry);
      if (existsSync(current)) {
        renameSync(current, path.join(trashDir, entry));
        inFlight = entry;
      }
      renameSync(path.join(distDir, entry), current);
      inFlight = null;
      done.push(entry);
    }
  } catch (error: unknown) {
    if (inFlight) {
      try {
        renameSync(path.join(trashDir, inFlight), path.join(root, inFlight));
      } catch (rollbackError: unknown) {
        logger.error({ err: rollbackError }, `[Update] rollback of ${inFlight} failed`);
      }
    }
    for (const entry of done.reverse()) {
      try {
        renameSync(path.join(root, entry), path.join(distDir, entry));
        const trashed = path.join(trashDir, entry);
        if (existsSync(trashed)) renameSync(trashed, path.join(root, entry));
      } catch (rollbackError: unknown) {
        logger.error({ err: rollbackError }, `[Update] rollback of ${entry} failed`);
      }
    }
    throw new UpdateError(
      'swap_failed',
      `swap failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Activate a staged release on Windows: run the staged install.ps1 detached.
 * It stops the PrismServer task and process, copies the staged files,
 * re-registers the task and starts it — this process is killed by it, so the
 * pending attempt row is resolved by the next boot.
 */
export async function spawnWindowsInstaller(distDir: string, version: string): Promise<void> {
  const script = path.join(distDir, 'install.ps1');
  if (!existsSync(script)) {
    throw new UpdateError('spawn_failed', 'staged archive has no install.ps1');
  }
  try {
    const logFd = openSync(path.join(installRoot(), 'updates', `update-${version}.log`), 'a');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        // PRISM_HOME explicitly: the scheduled server's environment does not
        // keep the installer-time value, and without it the staged installer
        // would default to %USERPROFILE%\.prism and update the wrong install.
        env: { ...process.env, PRISM_DIST: distDir, PRISM_HOME: installRoot() },
      },
    );
    // spawn() reports ENOENT and friends on the child's async 'error' event,
    // not by throwing — wait for 'spawn' so a start failure lands in the
    // caller's catch instead of leaving the attempt PENDING with no installer
    // owning the restart (and an unhandled 'error' crashing the process).
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } catch (error: unknown) {
    throw new UpdateError(
      'spawn_failed',
      `could not start install.ps1: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Remove one release's staged download. Best-effort, run on a failed apply. */
export function removeStagedRelease(version: string, root: string = installRoot()): void {
  try {
    rmSync(path.join(root, 'updates', version), { recursive: true, force: true });
  } catch (error: unknown) {
    logger.debug(
      `[Update] cleanup of staged ${version} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Remove staging and trash leftovers. Best-effort, run at every boot. */
export function sweepUpdateDirs(root: string = installRoot()): void {
  for (const dir of [path.join(root, 'updates'), path.join(root, '.update-trash')]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error: unknown) {
      logger.debug(`[Update] sweep of ${dir} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function downloadTo(url: string, dest: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error: unknown) {
    throw new UpdateError(
      'download_failed',
      `download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 404) {
    // The GHCR tag is pushed before the release assets are attached, so a
    // brand-new version can 404 here for a few minutes. Retryable.
    throw new UpdateError('asset_not_found', `release asset not published yet: ${url}`);
  }
  if (!res.ok || !res.body) {
    throw new UpdateError('download_failed', `download failed with ${res.status}: ${url}`);
  }
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  } catch (error: unknown) {
    throw new UpdateError(
      'download_failed',
      `download stream failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Verify the archive against its published `.sha256` asset. Fails closed:
 * every release the updater can install is newer than the release that
 * introduced the checksum step, so a missing, malformed or unfetchable
 * checksum means an unverifiable archive, not an old one. A transient
 * registry failure records `verify_failed` and the next tick retries.
 */
async function verifyChecksum(assetUrl: string, archivePath: string): Promise<void> {
  let expected: string | null = null;
  try {
    const res = await fetch(`${assetUrl}.sha256`, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (res.ok) {
      expected = (await res.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? null;
    }
  } catch (error: unknown) {
    throw new UpdateError(
      'checksum_unavailable',
      `checksum fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new UpdateError('checksum_unavailable', `no valid sha256 published at ${assetUrl}.sha256`);
  }

  const hash = createHash('sha256');
  await pipeline(createReadStream(archivePath), hash);
  const actual = hash.digest('hex');
  if (actual !== expected) {
    throw new UpdateError('verify_failed', `archive sha256 ${actual} does not match published ${expected}`);
  }
}

async function extract(archivePath: string, destDir: string): Promise<void> {
  // System tar handles .tar.gz everywhere; on Windows 10+ bsdtar also reads
  // .zip archives.
  const args = process.platform === 'win32' ? ['-xf', archivePath, '-C', destDir] : ['-xzf', archivePath, '-C', destDir];
  try {
    await execFileAsync('tar', args, { timeout: EXTRACT_TIMEOUT_MS });
  } catch (error: unknown) {
    throw new UpdateError(
      'extract_failed',
      `archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
