// The local environment runs a command as a child of this server process, so
// anything in the server's env leaks into every repo the agent clones. Two
// container-baked vars are actively harmful there and are stripped here:
//
//   - NODE_ENV=production → `npm install` applies --omit=dev, silently skipping
//     the dev toolchain (typescript/vitest/oxlint), so typecheck/lint/test
//     fail with `tsc: not found`. (This is also the root of the `prepare: husky`
//     exit-127 crash: husky isn't installed because it's a devDependency.)
//   - HUSKY=0 → disables the cloned repo's own git hooks. Suppressing a repo's
//     hooks is not this environment's call to make for someone else's code.
//
// We strip server-runtime-only vars rather than allowlisting because a command
// legitimately needs inherited PATH, HOME, AWS_*, GH_*, and token vars for
// gh/aws/kubectl and coding-agent auth.

const SERVER_ONLY_VARS = ['NODE_ENV', 'HUSKY', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS'] as const;

export function localBaseEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of SERVER_ONLY_VARS) {
    delete env[key];
  }
  return env;
}
