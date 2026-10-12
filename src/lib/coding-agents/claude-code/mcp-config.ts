/**
 * The MCP servers of a Claude Code task, given to the CLI as a `--mcp-config`
 * file.
 *
 * A server's env values and headers can be credentials, so they travel in a
 * file rather than on the command line: written 0600 into a directory of the
 * task's own that only this user can open, and removed with that directory
 * before the run's stream ends.
 */
import path from 'path';
import { logger } from '../../../logger';
import { AsyncChannel } from '../../../utils/async-channel';
import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import type {
  CodingAgentEvent,
  CodingAgentMcpServer,
  CodingAgentRun,
  CodingAgentTask,
} from '../coding-agent';

const DIR_PREFIX = 'prism-claude-code-';
const FILE_NAME = 'mcp.json';

/**
 * Changes to the server's own directory, then runs it. The CLI starts a stdio
 * server in the task's working directory and has no field for another one.
 */
const IN_SERVER_DIR = 'cd "$0" && exec "$@"';

/**
 * Text the CLI replaces with a variable from its own environment, in any value
 * of a server, while the runtime passes it to the server unchanged. No escape
 * holds for every value: Claude Code 2.1.296 replaces a header value more than
 * once.
 */
const CLI_EXPANDED = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;

/**
 * The CLI's `mcpServers` document for these servers. With `viaSh` a stdio
 * server starts in its own directory; without it, in the task's. A server whose
 * values hold text the CLI would replace is left out and named in `leftOut`, so
 * it never receives the CLI's environment.
 */
export function claudeMcpConfig(
  servers: readonly CodingAgentMcpServer[],
  viaSh: boolean,
): { document: string; leftOut: string[] } {
  const mcpServers: Record<string, unknown> = {};
  const leftOut: string[] = [];
  for (const server of servers) {
    const entry = entryFor(server, viaSh);
    if (CLI_EXPANDED.test(JSON.stringify(entry))) leftOut.push(server.name);
    else mcpServers[server.name] = entry;
  }
  return { document: JSON.stringify({ mcpServers }), leftOut };
}

function entryFor(server: CodingAgentMcpServer, viaSh: boolean): Record<string, unknown> {
  if (server.kind !== 'stdio') {
    return { type: server.kind, url: server.url, headers: server.headers };
  }
  if (!viaSh) {
    return { type: 'stdio', command: server.command, args: server.args, env: server.env };
  }
  return {
    type: 'stdio',
    command: 'sh',
    args: ['-c', IN_SERVER_DIR, server.cwd, server.command, ...server.args],
    env: server.env,
  };
}

/**
 * Write the task's config, start the CLI on it through `launch`, and remove the
 * config once that run's stream has ended. A failure to write it is the run's
 * closing `result`, as a launch failure is.
 */
export function runWithMcpConfig(
  task: CodingAgentTask,
  environment: ExecutionEnvironment,
  displayName: string,
  launch: (configPath: string) => CodingAgentRun,
): CodingAgentRun {
  const { files } = environment;
  // Native Windows puts no `sh` on the path; the container and macOS and Linux
  // hosts do.
  const viaSh = environment.id !== 'local' || process.platform !== 'win32';
  const events = new AsyncChannel<CodingAgentEvent>();
  let run: CodingAgentRun | null = null;
  let stopped = false;
  let ended = false;

  const closeWith = (message: string): void => {
    events.push({ type: 'result', stopReason: 'error', turns: 0, message });
  };

  const pump = async (): Promise<void> => {
    const dir = await files.makeTempDir(DIR_PREFIX);
    try {
      const configPath = path.posix.join(dir, FILE_NAME);
      const { document, leftOut } = claudeMcpConfig(task.mcpServers, viaSh);
      if (leftOut.length > 0) {
        logger.warn(
          { taskId: task.taskId, servers: leftOut },
          '[AgentTask] MCP servers left out: a value holds ${…} text that Claude Code would replace',
        );
      }
      await files.writeText(configPath, document, { mode: 0o600 });
      if (stopped) {
        closeWith(`${displayName} was stopped before it started`);
        return;
      }
      run = launch(configPath);
      for await (const event of run.events) events.push(event);
    } finally {
      await files.remove(dir).catch((err: unknown) => {
        logger.warn({ err, taskId: task.taskId, dir }, '[AgentTask] could not remove the MCP config');
      });
    }
  };

  pump()
    .catch((err: unknown) => {
      logger.error({ err, taskId: task.taskId }, '[AgentTask] coding task failed to start');
      closeWith(`${displayName} failed to start: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      ended = true;
      events.close();
    });

  return {
    events,
    get exited(): boolean {
      return run ? run.exited : ended;
    },
    get mark() {
      return run?.mark;
    },
    stop: () => {
      stopped = true;
      run?.stop();
    },
  };
}
