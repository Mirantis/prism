/**
 * `prism update` — non-interactive update flow, no TUI render.
 *
 * The update itself runs server-side (the runtime owns the install and the
 * restart); this command triggers it over the management API and then waits
 * for the restarted runtime to report the new version. Exit 0 on success or
 * a benign no-op (up to date, updater off), 1 when the server is unreachable
 * or the update fails.
 */

import { ApiError, apiClient } from './api-client.js';
import { loadConfig } from './config.js';
import { updateUnavailableText } from './commands/update.js';

// Above the server's own worst-case budget (10 min download + 30 s checksum
// + 5 min extract + 1 min probe), so a slow but succeeding update is never
// reported as a timeout.
const UPDATE_TIMEOUT_MS = 20 * 60_000;
const POLL_MS = 1_000;

export async function runUpdateCommand(): Promise<never> {
  // No local DISABLE_UPDATER check: the server reads it from ~/.prism/.env,
  // this process reads its own shell, and the two disagree often enough to
  // matter — exporting it in a shell would otherwise report a server as
  // disabled while its updater is on. `updateStatus()` answers the same
  // question authoritatively, as `disabled_by_env`.
  const httpUrl = loadConfig().httpUrl;
  let status;
  try {
    status = await apiClient.updateStatus();
  } catch {
    console.error(`prism-server is not reachable at ${httpUrl} — start it and retry.`);
    process.exit(1);
  }

  if (!status.enabled) {
    console.log(updateUnavailableText(status.reason));
    process.exit(0);
  }
  if (status.applying) {
    console.log('An update is already in progress.');
    process.exit(0);
  }

  console.log(`Checking for updates (current ${status.currentVersion})…`);
  // Baseline for failure detection: a FAILURE row for the target version that
  // predates this run must not be read as this run's outcome.
  const priorAttemptStartedAt = status.lastAttempt?.startedAt ?? null;
  let version: string;
  try {
    const result = await apiClient.applyUpdate();
    version = result.version;
  } catch (err) {
    if (err instanceof ApiError) {
      // 409 "already up to date" is a benign no-op, everything else failed.
      console.log(err.message);
      process.exit(err.status === 409 ? 0 : 1);
    }
    console.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`Updating to ${version} — downloading, then the backend restarts…`);
  const deadline = Date.now() + UPDATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      const fresh = await apiClient.updateStatus();
      if (fresh.currentVersion === version) {
        console.log(`Updated to ${version}.`);
        process.exit(0);
      }
      const attempt = fresh.lastAttempt;
      if (
        attempt &&
        attempt.versionTo === version &&
        attempt.outcome === 'FAILURE' &&
        attempt.startedAt !== priorAttemptStartedAt
      ) {
        console.error(`Update to ${version} failed (${attempt.errorCode ?? 'unknown error'}).`);
        process.exit(1);
      }
      // Still downloading, or the old process answering before its exit —
      // keep polling.
    } catch {
      // Down while restarting — keep polling.
    }
  }

  console.error(
    `The backend did not come back on ${version} within ${UPDATE_TIMEOUT_MS / 60_000} minutes — ` +
      'check the service (launchctl/systemctl/Task Scheduler) and its server.log.',
  );
  process.exit(1);
}
