/**
 * Moving the agent's files when the deployment changes where commands run.
 *
 * The two environments keep the agent's storage in different places: one uses
 * directories on this machine, the other named volumes the engine owns.
 * Installing a container engine, or setting `EXECUTION_ENVIRONMENT`, therefore
 * moves the agent to storage that starts out empty — its skills, its plugins,
 * its workspace and both coding-agent logins would appear to be gone, with the
 * originals sitting untouched on the side it came from.
 *
 * So a boot that finds the environment changed copies the agent's files across
 * first. The database is not involved: it is the runtime's own and stays on
 * this machine under either environment, which is why memory, threads and the
 * identity documents survive the switch on their own.
 *
 * **Nothing is overwritten.** Only an entry the destination does not already
 * have is copied, so switching back and forth merges rather than clobbers: work
 * done on one side arrives on the other, and work already there is left alone.
 * The cost is that an entry edited on both sides keeps the destination's copy,
 * which is the safe way round — the other one is still where it was.
 */
import { logger } from '../../logger';
import { trackEvent } from '../telemetry';
import { config } from '../../config';
import {
  LAST_EXECUTION_ENVIRONMENT,
  runtimeStateService,
} from '../../services/runtime-state.service';
import type {
  ExecutionEnvironment,
  ExecutionEnvironmentName,
  ExecutionFiles,
} from './execution-environment';
import { createLocalEnvironment } from './local/local-environment';
import {
  createDockerEnvironment,
  deploymentId,
  execContainerName,
} from './docker/docker-environment';
import { createDockerFiles } from './docker/docker-files';
import { copyFromContainer, copyIntoContainer, openVolumes } from './docker/docker-copy';
import { getExecutionEnvironment } from './get-execution-environment';
import { resolveClaudeConfigDir } from '../coding-agents/claude-code/home';
import { resolveCodexHome } from '../coding-agents/codex/credentials';

/**
 * What moves. The saved tool outputs and the container's `$HOME` are left out:
 * both are caches with their own expiry, and copying them would move stale
 * bytes the agent never asked for.
 */
const MIGRATED = [
  'workspace',
  'skills',
  'plugins',
  'plugin data',
  'claude home',
  'codex home',
] as const;

type Migrated = (typeof MIGRATED)[number];

export interface MigrationReport {
  from: ExecutionEnvironmentName;
  to: ExecutionEnvironmentName;
  copied: number;
  skipped: number;
  failures: number;
}

/**
 * Record the environment this run uses, and move the agent's files first when
 * the last run used the other one.
 *
 * Never throws: a failed entry is removed from the target, so both sides are as
 * they were for it, and an agent that boots without its skills is better than
 * one that does not boot. The stored environment advances only once every entry
 * has landed, so the next boot tries the rest again.
 */
export async function migrateStorageIfEnvironmentChanged(): Promise<MigrationReport | null> {
  const current = getExecutionEnvironment().id;
  const stored = (await runtimeStateService
    .get(LAST_EXECUTION_ENVIRONMENT)
    .catch(() => null)) as ExecutionEnvironmentName | null;
  // No record is an install from before the record existed, and every such
  // install ran locally. A fresh install reads the same way and moves nothing,
  // because its host directories are empty.
  const previous = stored ?? 'local';

  if (previous === current) {
    if (stored === null) await remember(current);
    return null;
  }

  logger.info(
    { from: previous, to: current },
    "[Startup] the execution environment changed; moving the agent's files",
  );

  let report: MigrationReport;
  try {
    report = await migrate(previous, current);
  } catch (err) {
    logger.error({ err, from: previous, to: current }, '[Startup] could not move the files');
    trackEvent('exec storage migrated', config.ownerUserId, {
      'migration.from': previous,
      'migration.to': current,
      status: 'failed',
    });
    return null;
  }

  // An entry that failed was removed from the target, so the next boot finds
  // it missing there and copies it again. Recording the new environment now
  // would stop that retry for good.
  if (report.failures === 0) await remember(current);
  logger.info(report, "[Startup] moved the agent's files");
  trackEvent('exec storage migrated', config.ownerUserId, {
    'migration.from': report.from,
    'migration.to': report.to,
    status: report.failures > 0 ? 'partial' : 'ok',
    copied: String(report.copied),
    skipped: String(report.skipped),
  });
  return report;
}

async function remember(current: ExecutionEnvironmentName): Promise<void> {
  await runtimeStateService.set(LAST_EXECUTION_ENVIRONMENT, current).catch((err: unknown) => {
    // The next boot would then try the same migration again, which is safe —
    // nothing is overwritten — so this is reported and not fatal.
    logger.warn({ err }, '[Startup] could not record the execution environment');
  });
}

async function migrate(
  previous: ExecutionEnvironmentName,
  current: ExecutionEnvironmentName,
): Promise<MigrationReport> {
  const deployment = deploymentId();
  const local = createLocalEnvironment();
  const docker = createDockerEnvironment();
  const access = await openVolumes(deployment, execContainerName(deployment));
  const containerFiles = createDockerFiles(access.container);

  const report: MigrationReport = { from: previous, to: current, copied: 0, skipped: 0, failures: 0 };

  try {
    for (const what of MIGRATED) {
      const hostPath = directoryOf(local, what);
      const containerPath = directoryOf(docker, what);
      const intoContainer = current === 'docker';

      await move({
        what,
        intoContainer,
        container: access.container,
        source: intoContainer ? sideOf(local, hostPath) : sideOf(containerFiles, containerPath),
        target: intoContainer ? sideOf(containerFiles, containerPath) : sideOf(local, hostPath),
        report,
      });
    }
  } finally {
    await access.release().catch((err: unknown) => {
      logger.warn({ err }, '[Docker] could not remove the copy container');
    });
  }

  return report;
}

interface Side {
  path: string;
  list: () => Promise<Array<{ name: string }>>;
  /** The destination may not exist yet: `docker cp` will not create a parent. */
  ensure: () => Promise<void>;
  remove: (entryPath: string) => Promise<void>;
}

async function move(opts: {
  what: Migrated;
  intoContainer: boolean;
  container: string;
  source: Side;
  target: Side;
  report: MigrationReport;
}): Promise<void> {
  const { what, intoContainer, container, source, target, report } = opts;

  const entries = await source.list().catch(() => null);
  if (entries === null || entries.length === 0) return; // nothing there to move

  const held = new Set((await target.list().catch(() => [])).map((entry) => entry.name));
  await target.ensure();

  for (const entry of entries) {
    if (held.has(entry.name)) {
      report.skipped++;
      continue;
    }
    const from = `${source.path}/${entry.name}`;
    const to = `${target.path}/${entry.name}`;
    // Logged before the copy: a large workspace entry can hold up boot for as
    // long as the copy timeout, and this line names what it is waiting on.
    logger.info({ what, entry: entry.name }, '[Startup] moving');
    try {
      if (intoContainer) await copyIntoContainer(container, from, to);
      else await copyFromContainer(container, from, to);
      report.copied++;
    } catch (err) {
      report.failures++;
      logger.warn({ err, what, entry: entry.name }, '[Startup] could not move this one');
      // The target lacked this entry before the copy started, so whatever is
      // there now is the partial copy and nothing else.
      await target.remove(to).catch((removeErr: unknown) => {
        logger.warn({ err: removeErr, what, entry: entry.name }, '[Startup] could not remove a partial copy');
      });
    }
  }
}

/** One side of a copy, over whichever filesystem holds it. */
function sideOf(
  owner: ExecutionEnvironment | ExecutionFiles,
  path: string,
): Side {
  const files = 'files' in owner ? owner.files : owner;
  return {
    path,
    list: () => files.readDir(path),
    ensure: () => files.mkdir(path),
    remove: (entryPath) => files.remove(entryPath),
  };
}

/**
 * The directory each kind lives in, for one environment.
 *
 * On this machine a coding agent's home is always the runtime's own one under
 * the data dir. An operator's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` usually names
 * their real `~/.claude` or `~/.codex`, and copying that into the agent's volume
 * would hand the agent's shell the operator's sessions and credentials.
 */
function directoryOf(environment: ExecutionEnvironment, what: Migrated): string {
  const paths = environment.paths();
  const onHost = environment.id === 'local';
  switch (what) {
    case 'workspace':
      return environment.workspaceRoot();
    case 'skills':
      return paths.skillsDir;
    case 'plugins':
      return paths.pluginsDir;
    case 'plugin data':
      return paths.pluginDataDir;
    case 'claude home':
      return onHost ? resolveClaudeConfigDir({}) : paths.claudeHome;
    case 'codex home':
      return onHost ? resolveCodexHome({}) : paths.codexHome;
  }
}
