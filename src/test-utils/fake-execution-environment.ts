/**
 * An execution environment for tests: every member throws unless the test
 * supplies it, so a test only states the part it exercises and an unexpected
 * call fails loudly rather than reaching the real host.
 */
import type {
  AgentPaths,
  ExecutionEnvironment,
  ExecutionFiles,
  RunOptions,
} from '../lib/execution-environments/execution-environment';

export type FakeRun = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => ReturnType<ExecutionEnvironment['runProgram']>;

export interface FakeEnvironmentParts {
  runProgram?: FakeRun;
  runShell?: (command: string, options: RunOptions) => ReturnType<ExecutionEnvironment['runShell']>;
  workspaceRoot?: string;
  baseEnv?: NodeJS.ProcessEnv;
  servesPath?: (path: string) => boolean;
  paths?: Partial<AgentPaths>;
  files?: Partial<ExecutionFiles>;
}

/** The agent's directories under a fake root, so a test can assert on them. */
function fakePaths(root: string, over: Partial<AgentPaths> = {}): AgentPaths {
  return {
    skillsDir: `${root}/skills`,
    pluginsDir: `${root}/plugins`,
    pluginDataDir: `${root}/plugin-data`,
    toolOutputDir: `${root}/tool-outputs`,
    claudeHome: `${root}/.claude`,
    codexHome: `${root}/.codex`,
    ...over,
  };
}

export function fakeExecutionEnvironment(parts: FakeEnvironmentParts = {}): ExecutionEnvironment {
  const unsupported = (member: string) => () => {
    throw new Error(`fake execution environment: ${member} was not supplied`);
  };

  return {
    id: 'local',
    displayName: 'fake',
    workspaceRoot: () => parts.workspaceRoot ?? '/workspace',
    paths: () => fakePaths(parts.workspaceRoot ?? '/workspace', parts.paths),
    prepareWorkspace: () => ({ root: parts.workspaceRoot ?? '/workspace', fellBackFrom: null }),
    start: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    servesPath: parts.servesPath ?? (() => true),
    baseEnv: () => parts.baseEnv ?? {},
    runShell: parts.runShell ?? (unsupported('runShell') as ExecutionEnvironment['runShell']),
    runProgram: parts.runProgram ?? (unsupported('runProgram') as ExecutionEnvironment['runProgram']),
    files: new Proxy({} as ExecutionFiles, {
      get(_target, prop: string | symbol) {
        // A matcher that inspects the object asks for symbols; they are no member.
        if (typeof prop === 'symbol') return undefined;
        const supplied = parts.files?.[prop as keyof ExecutionFiles];
        return supplied ?? unsupported(`files.${prop}`);
      },
    }),
  };
}
