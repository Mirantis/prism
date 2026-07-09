// The agent-runtime container doubles as the shell sandbox: shell tools
// (shell_exec, shell_spawn, claude_code) spawn /bin/bash as children of this
// server process. The server runs with NODE_ENV=production, which leaks into
// every repo the agent clones — causing `npm install` to apply --omit=dev
// (skips devDependencies, breaks `prepare: husky` with exit 127). We strip
// server-runtime-only vars rather than allowlisting because the sandbox
// legitimately needs inherited PATH, HOME, AWS_*, GH_*, and token vars for
// gh/aws/kubectl/claude auth.

const SERVER_ONLY_VARS = ['NODE_ENV'] as const;

export function sandboxEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of SERVER_ONLY_VARS) {
    delete env[key];
  }
  return env;
}
