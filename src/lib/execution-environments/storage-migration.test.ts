/**
 * Moving the agent's files when the deployment changes where commands run.
 *
 * The engine is never run: the copies are recorded, so these cases say the
 * same thing on a machine with a container engine and one without.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry } from './execution-environment';

const state = new Map<string, string>();
const copies: Array<{ direction: 'in' | 'out'; from: string; to: string }> = [];
const created: string[] = [];
let released = 0;

/** What each side holds, keyed by directory. */
const hostDirs = new Map<string, string[]>();
const containerDirs = new Map<string, string[]>();
let copyFails: string | null = null;
const removed: string[] = [];

vi.mock('../telemetry', () => ({ trackEvent: vi.fn() }));

vi.mock('../../services/runtime-state.service', () => ({
  LAST_EXECUTION_ENVIRONMENT: 'lastExecutionEnvironment',
  runtimeStateService: {
    get: (key: string) => Promise.resolve(state.get(key) ?? null),
    set: (key: string, value: string) => {
      state.set(key, value);
      return Promise.resolve();
    },
  },
}));

vi.mock('./docker/docker-copy', () => ({
  openVolumes: (_deployment: string, container: string) => {
    created.push(container);
    return Promise.resolve({
      container,
      release: () => {
        released++;
        return Promise.resolve();
      },
    });
  },
  copyIntoContainer: (_c: string, from: string, to: string) => {
    if (copyFails && from.includes(copyFails)) return Promise.reject(new Error('copy failed'));
    copies.push({ direction: 'in', from, to });
    return Promise.resolve();
  },
  copyFromContainer: (_c: string, from: string, to: string) => {
    if (copyFails && from.includes(copyFails)) return Promise.reject(new Error('copy failed'));
    copies.push({ direction: 'out', from, to });
    return Promise.resolve();
  },
}));

vi.mock('./docker/docker-files', () => ({
  createDockerFiles: () => filesOver(containerDirs),
}));

vi.mock('./local/local-environment', () => ({
  createLocalEnvironment: () => ({
    id: 'local',
    workspaceRoot: () => '/host/workspace',
    paths: () => ({
      skillsDir: '/host/skills',
      pluginsDir: '/host/plugins',
      pluginDataDir: '/host/plugin-data',
      toolOutputDir: '/host/tool-outputs',
      // What an operator's CLAUDE_CONFIG_DIR / CODEX_HOME names: their own.
      claudeHome: '/host/operator/.claude',
      codexHome: '/host/operator/.codex',
    }),
    files: filesOver(hostDirs),
  }),
}));

// The runtime's own homes under the data dir.
vi.mock('../coding-agents/claude-code/home', () => ({
  resolveClaudeConfigDir: () => '/host/data/.claude',
}));
vi.mock('../coding-agents/codex/credentials', () => ({
  resolveCodexHome: () => '/host/data/.codex',
}));

let currentEnvironment = 'local';
vi.mock('./get-execution-environment', () => ({
  getExecutionEnvironment: () => ({ id: currentEnvironment }),
}));

/** A filesystem over a map of directory to entry names. */
function filesOver(dirs: Map<string, string[]>) {
  return {
    readDir: (path: string): Promise<DirEntry[]> => {
      const names = dirs.get(path);
      if (!names) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(
        names.map((name) => ({ name, isFile: true, isDirectory: false, isSymbolicLink: false })),
      );
    },
    mkdir: (path: string) => {
      if (!dirs.has(path)) dirs.set(path, []);
      return Promise.resolve();
    },
    remove: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
  };
}

const { migrateStorageIfEnvironmentChanged } = await import('./storage-migration');

beforeEach(() => {
  state.clear();
  copies.length = 0;
  created.length = 0;
  released = 0;
  hostDirs.clear();
  containerDirs.clear();
  copyFails = null;
  removed.length = 0;
  currentEnvironment = 'local';
});

describe('when nothing has changed', () => {
  it('records where a first local boot ran, and moves nothing', async () => {
    hostDirs.set('/host/skills', ['a-skill']);

    expect(await migrateStorageIfEnvironmentChanged()).toBeNull();
    expect(copies).toEqual([]);
    expect(state.get('lastExecutionEnvironment')).toBe('local');
  });

  it('does nothing when the environment is the same as last time', async () => {
    state.set('lastExecutionEnvironment', 'local');
    hostDirs.set('/host/skills', ['a-skill']);

    expect(await migrateStorageIfEnvironmentChanged()).toBeNull();
    expect(copies).toEqual([]);
    expect(created).toEqual([]);
  });
});

describe('an install from before the record existed', () => {
  it('moves its host files into the container on its first Docker boot', async () => {
    // No record at all: every install ran locally before this one was written.
    currentEnvironment = 'docker';
    hostDirs.set('/host/skills', ['old-skill']);
    hostDirs.set('/host/workspace', ['old-work.md']);

    const report = await migrateStorageIfEnvironmentChanged();

    expect(report).toMatchObject({ from: 'local', to: 'docker', copied: 2, failures: 0 });
    expect(copies.map((c) => c.to)).toEqual([
      '/prism/workspace/old-work.md',
      '/prism/skills/old-skill',
    ]);
    expect(state.get('lastExecutionEnvironment')).toBe('docker');
  });
});

describe('from this machine into a container', () => {
  beforeEach(() => {
    state.set('lastExecutionEnvironment', 'local');
    currentEnvironment = 'docker';
  });

  it('copies what the container does not have', async () => {
    hostDirs.set('/host/skills', ['kept-skill']);
    hostDirs.set('/host/workspace', ['report.md']);
    containerDirs.set('/prism/skills', []);
    containerDirs.set('/prism/workspace', []);

    const report = await migrateStorageIfEnvironmentChanged();

    expect(report).toMatchObject({ from: 'local', to: 'docker', copied: 2, failures: 0 });
    expect(copies).toEqual([
      { direction: 'in', from: '/host/workspace/report.md', to: '/prism/workspace/report.md' },
      { direction: 'in', from: '/host/skills/kept-skill', to: '/prism/skills/kept-skill' },
    ]);
    expect(state.get('lastExecutionEnvironment')).toBe('docker');
  });

  it('never overwrites: an entry the container already has is left alone', async () => {
    hostDirs.set('/host/skills', ['shared', 'only-here']);
    containerDirs.set('/prism/skills', ['shared']);

    const report = await migrateStorageIfEnvironmentChanged();

    expect(report).toMatchObject({ copied: 1, skipped: 1 });
    expect(copies.map((c) => c.from)).toEqual(['/host/skills/only-here']);
  });

  it("moves a plugin's data with it, since its server now runs in there", async () => {
    hostDirs.set('/host/plugin-data', ['weather']);

    await migrateStorageIfEnvironmentChanged();
    expect(copies.map((c) => c.to)).toEqual(['/prism/plugin-data/weather']);
  });

  it("moves the runtime's own coding-agent homes, never the operator's", async () => {
    // The operator's real ~/.claude holds their sessions and credentials.
    hostDirs.set('/host/operator/.claude', ['sessions', '.credentials.json']);
    hostDirs.set('/host/data/.claude', ['runtime-session']);

    await migrateStorageIfEnvironmentChanged();
    expect(copies.map((c) => c.from)).toEqual(['/host/data/.claude/runtime-session']);
  });

  it('leaves the saved tool outputs behind, since they expire on their own', async () => {
    hostDirs.set('/host/tool-outputs', ['spilled']);
    containerDirs.set('/prism/tool-outputs', []);

    await migrateStorageIfEnvironmentChanged();
    expect(copies).toEqual([]);
  });

  it('skips a directory that is not there rather than failing', async () => {
    // A deployment that never installed a plugin has no plugins dir at all.
    hostDirs.set('/host/skills', ['a-skill']);
    const report = await migrateStorageIfEnvironmentChanged();
    expect(report).toMatchObject({ copied: 1, failures: 0 });
  });
});

describe('from a container back to this machine', () => {
  beforeEach(() => {
    state.set('lastExecutionEnvironment', 'docker');
    currentEnvironment = 'local';
  });

  it('copies out, and opens the volumes to do it', async () => {
    containerDirs.set('/prism/skills', ['made-in-there']);
    hostDirs.set('/host/skills', []);

    const report = await migrateStorageIfEnvironmentChanged();

    expect(report).toMatchObject({ from: 'docker', to: 'local', copied: 1 });
    expect(copies).toEqual([
      { direction: 'out', from: '/prism/skills/made-in-there', to: '/host/skills/made-in-there' },
    ]);
    // No container is running in local mode, so one is opened and released.
    expect(created).toHaveLength(1);
    expect(released).toBe(1);
  });

  it('merges a round trip rather than clobbering either side', async () => {
    // The host still holds what it had before the deployment moved; the
    // container holds what the agent did while it was over there.
    hostDirs.set('/host/skills', ['from-before']);
    containerDirs.set('/prism/skills', ['from-before', 'from-the-container']);

    const report = await migrateStorageIfEnvironmentChanged();

    expect(report).toMatchObject({ copied: 1, skipped: 1 });
    expect(copies.map((c) => c.to)).toEqual(['/host/skills/from-the-container']);
  });
});

describe('when a copy fails', () => {
  beforeEach(() => {
    state.set('lastExecutionEnvironment', 'local');
    currentEnvironment = 'docker';
  });

  it('carries on with the rest and counts the failure', async () => {
    hostDirs.set('/host/skills', ['good', 'bad']);
    copyFails = 'bad';

    const report = await migrateStorageIfEnvironmentChanged();

    expect(report).toMatchObject({ copied: 1, failures: 1 });
    expect(copies.map((c) => c.from)).toEqual(['/host/skills/good']);
  });

  it('removes the partial copy, so it cannot hide the intact source', async () => {
    hostDirs.set('/host/skills', ['bad']);
    copyFails = 'bad';

    await migrateStorageIfEnvironmentChanged();
    // A copy that stopped part-way would otherwise sit at the target, and the
    // next attempt skips a name the target already has.
    expect(removed).toEqual(['/prism/skills/bad']);
  });

  it('keeps the old environment recorded, so the next boot tries again', async () => {
    hostDirs.set('/host/skills', ['bad']);
    copyFails = 'bad';

    await migrateStorageIfEnvironmentChanged();
    expect(state.get('lastExecutionEnvironment')).toBe('local');
  });

  it('releases the container even when the whole copy throws', async () => {
    hostDirs.set('/host/skills', ['a-skill']);
    // A listing that rejects for a reason other than a missing directory.
    containerDirs.set('/prism/skills', []);
    await migrateStorageIfEnvironmentChanged();
    expect(released).toBe(1);
  });
});
