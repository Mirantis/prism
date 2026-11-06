//! Read and write the `runtime_state` rows. What that table is for, and why it
//! is a table, is on the model in `prisma/sqlite/schema.prisma`.

use std::sync::LazyLock;

/// The environment the previous run finished in: `local` or `docker`.
pub const LAST_EXECUTION_ENVIRONMENT: &str = "lastExecutionEnvironment";

/// The id of single-thread mode's one conversation.
pub const SINGLE_THREAD: &str = "singleThread";

pub struct RuntimeStateService;

impl RuntimeStateService {
    pub fn new() -> Self {
        RuntimeStateService
    }

    /// The stored value, or `None` when nothing has written this key yet.
    pub async fn get(&self, key: &str) -> anyhow::Result<Option<String>> {
        todo!()
    }

    pub async fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        todo!()
    }

    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        todo!()
    }
}

impl Default for RuntimeStateService {
    fn default() -> Self {
        Self::new()
    }
}

pub static RUNTIME_STATE_SERVICE: LazyLock<RuntimeStateService> =
    LazyLock::new(RuntimeStateService::new);
