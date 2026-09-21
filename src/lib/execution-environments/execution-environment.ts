/**
 * The execution environment: where a command runs and what filesystem it sees.
 *
 * Every process the agent starts — `shell_exec`, `shell_spawn`, a coding
 * agent's CLI — and every file its tools read or write go through one of
 * these. `get-execution-environment.ts` picks the implementation.
 *
 * A read or write belongs here when the agent's own commands have to see the
 * same bytes. That covers the workspace, the attachment scratch dir, skills,
 * plugins and the saved copies of oversized tool results, since each of those
 * is a path the runtime hands the model and tells it to use the shell on. The
 * database and the runtime's own processes — the updater, the meeting and
 * computer stacks — stay outside.
 *
 * Errors are thrown, not returned: every caller already turns a failed file
 * operation into its own `{ error }` or an empty result.
 */

import type { Readable, Writable } from 'stream';

export type ExecutionEnvironmentName = 'local' | 'docker';

export interface ExecutionEnvironment {
  readonly id: ExecutionEnvironmentName;
  /** The name the startup log reports. */
  readonly displayName: string;

  /** Default cwd for a command, and the base a relative path resolves from. */
  workspaceRoot(): string;
  /**
   * Where the agent's own directories are, in this environment's namespace.
   *
   * The runtime keeps its data directory to itself — the database, the media
   * store, a plugin's scratch — while everything the agent works with is the
   * environment's to place, because an environment whose storage is not this
   * machine's filesystem has its own names for all of it.
   */
  paths(): AgentPaths;
  /**
   * Boot-time: make that root usable. `fellBackFrom` names the root that could
   * not be used, so the caller can warn; null when the intended one works.
   */
  prepareWorkspace(): { root: string; fellBackFrom: string | null };
  /**
   * Bring the environment up, once, at boot. Throws when it cannot serve
   * commands, which the selector turns into a fall back to `local`.
   */
  start(): Promise<void>;
  /** Tear it down at shutdown. Never throws: the process is leaving either way. */
  shutdown(): Promise<void>;
  /**
   * Whether a command with this cwd can run here. An environment that sees only
   * part of the host filesystem answers false for the rest, and the caller
   * falls back to `local` — see `getExecutionEnvironmentFor`.
   */
  servesPath(path: string): boolean;
  /** The environment a command inherits, with the runtime's own vars removed. */
  baseEnv(): NodeJS.ProcessEnv;

  /** Run `command` through a shell. */
  runShell(command: string, options: RunOptions): ExecProcess;
  /** Run a program with argv and no shell — a coding agent's CLI, `git`. */
  runProgram(command: string, args: readonly string[], options: RunOptions): ExecProcess;

  readonly files: ExecutionFiles;
}

/** The agent's directories. Every one of them is reached through `files`. */
export interface AgentPaths {
  skillsDir: string;
  pluginsDir: string;
  toolOutputDir: string;
  /** `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, which the coding agents are told. */
  claudeHome: string;
  codexHome: string;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** `pipe` when the caller writes to the process. */
  stdin: 'ignore' | 'pipe';
  /**
   * Signal the whole process group rather than the leader alone, so a shell
   * wrapper's forked children die with it.
   */
  processGroup?: boolean;
}

export interface ExecProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  /** Null while the process runs. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /**
   * Settles when the process ends, whether or not its pipes have drained. A
   * grandchild can inherit those pipes and hold them open long after the
   * process itself is gone, which is why running/exit accounting reads this
   * one and not `closed`.
   */
  readonly ended: Promise<ExecEnd>;
  /** Settles once the output streams have closed as well. */
  readonly closed: Promise<ExecEnd>;
  /**
   * Signal a running process, reporting whether the signal went out.
   *
   * A terminating signal has to reach something that settles `ended` and
   * `closed`, since every caller kills and then waits on the same process.
   */
  kill(signal: NodeJS.Signals): boolean;
}

export interface ExecEnd {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process never started. */
  error: Error | null;
}

export interface ExecutionFiles {
  /** `maxBytes` reads a prefix — a skill's frontmatter, not its whole body. */
  readText(path: string, options?: { maxBytes?: number }): Promise<string>;
  readBytes(path: string): Promise<Buffer>;
  writeText(path: string, content: string): Promise<void>;
  writeBytes(path: string, content: Buffer): Promise<void>;
  /** Creates parents too. */
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Follows symlinks. */
  stat(path: string): Promise<FileStat>;
  lstat(path: string): Promise<FileStat>;
  readDir(path: string): Promise<DirEntry[]>;
  /** Recursive, and succeeds on a path that is already gone. */
  remove(path: string): Promise<void>;
  /** Only when the directory is empty. */
  removeDir(path: string): Promise<void>;
  /** Point `linkPath` at `target`, replacing whatever link is there. */
  symlink(target: string, linkPath: string): Promise<void>;
  /** The path with every link resolved. Throws when it does not exist. */
  realpath(path: string): Promise<string>;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
