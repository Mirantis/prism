/**
 * The local execution environment: commands run as children of this process,
 * on the filesystem this process sees.
 */
import type { ExecutionEnvironment } from '../execution-environment';
import { localBaseEnv } from './local-env';
import { localFiles } from './local-files';
import { runLocalProgram, runLocalShell } from './local-process';
import { prepareLocalWorkspace, resolveLocalWorkspaceRoot } from './local-workspace';

export function createLocalEnvironment(): ExecutionEnvironment {
  return {
    id: 'local',
    displayName: 'local',
    workspaceRoot: resolveLocalWorkspaceRoot,
    prepareWorkspace: prepareLocalWorkspace,
    baseEnv: () => localBaseEnv(),
    runShell: runLocalShell,
    runProgram: runLocalProgram,
    files: localFiles,
  };
}
