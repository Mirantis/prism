//! The local environment runs a command as a child of this server process, so
//! anything in the server's env leaks into every repo the agent clones. Two
//! container-baked vars are actively harmful there and are stripped here:
//!
//!   - `NODE_ENV=production` → `npm install` applies --omit=dev, silently skipping
//!     the dev toolchain (typescript/vitest/oxlint), so typecheck/lint/test
//!     fail with `tsc: not found`. (This is also the root of the `prepare: husky`
//!     exit-127 crash: husky isn't installed because it's a devDependency.)
//!   - `HUSKY=0` → disables the cloned repo's own git hooks. Suppressing a repo's
//!     hooks is not this environment's call to make for someone else's code.
//!
//! We strip server-runtime-only vars rather than allowlisting because a command
//! legitimately needs inherited PATH, HOME, AWS_*, GH_*, and token vars for
//! gh/aws/kubectl and coding-agent auth.

use crate::lib::execution_environments::execution_environment::ProcessEnv;

pub const SERVER_ONLY_VARS: [&str; 6] = [
    "NODE_ENV",
    "HUSKY",
    "DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "AT_SPI_BUS_ADDRESS",
];

/// This process's environment, in the order the OS gives it.
pub fn process_env() -> ProcessEnv {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// `base` (this process's environment when `None`) without the server-only vars.
pub fn local_base_env(base: Option<&ProcessEnv>) -> ProcessEnv {
    let mut env = match base {
        Some(base) => base.clone(),
        None => process_env(),
    };
    for key in SERVER_ONLY_VARS {
        env.shift_remove(key);
    }
    env
}
