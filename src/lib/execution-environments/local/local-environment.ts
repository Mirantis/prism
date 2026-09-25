/**
 * The local execution environment: commands run as children of this process,
 * on the filesystem this process sees.
 */
import type { ExecutionEnvironment } from '../execution-environment';
import { agentProcesses } from '../../agent-processes';
import { localBaseEnv } from './local-env';
import { localFiles } from './local-files';
import { localAgentPaths } from './local-paths';
import { runLocalProgram, runLocalShell } from './local-process';
import { prepareLocalWorkspace, resolveLocalWorkspaceRoot } from './local-workspace';

export function createLocalEnvironment(): ExecutionEnvironment {
  return {
    id: 'local',
    displayName: 'local',
    workspaceRoot: resolveLocalWorkspaceRoot,
    paths: localAgentPaths,
    prepareWorkspace: prepareLocalWorkspace,
    // Nothing to bring up or tear down: a command here is a child of this
    // process, and the filesystem is the one this process already has.
    start: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    // Every path this process can reach, which is what makes local the
    // fallback for a path no other environment serves.
    servesPath: () => true,
    baseEnv: () => localBaseEnv(),
    runShell: (command, options) =>
      agentProcesses.track(() => runLocalShell(command, options, true), options.stdin === 'pipe'),
    runProgram: (command, args, options) =>
      agentProcesses.track(
        () => runLocalProgram(command, args, options, true),
        options.stdin === 'pipe',
      ),
    files: localFiles,
  };
}
