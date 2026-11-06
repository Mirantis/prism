//! The remote computers the agent has: the `remote_computers` rows, kept in memory too,
//! since the tools and the prompt ask whether any exist on every turn.

use std::sync::LazyLock;

use indexmap::IndexMap;
use parking_lot::Mutex;

use super::link_protocol::RemotePlatform;
use crate::db::models::RemoteComputer as RemoteComputerRow;

/// Another computer of this agent already has the name.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ComputerNameTakenError {
    pub message: String,
}

impl ComputerNameTakenError {
    /// `A computer named "<name>" already exists.`
    pub fn new(name: &str) -> Self {
        ComputerNameTakenError {
            message: format!("A computer named \"{name}\" already exists."),
        }
    }

    pub fn with_message(message: impl Into<String>) -> Self {
        ComputerNameTakenError {
            message: message.into(),
        }
    }
}

/// The name, and id, the runtime's own computer goes by when a tool call names it.
const RESERVED_NAME: &str = "local";

/// Whether `error` is the database refusing a second row with the same unique key.
fn is_unique_violation(error: &anyhow::Error) -> bool {
    todo!()
}

/// What adding a computer takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddComputerInput {
    pub name: String,
    pub platform: Option<RemotePlatform>,
    pub installation_id: Option<String>,
}

/// What `record_connected` writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionInfo {
    pub platform: RemotePlatform,
    pub client_version: String,
}

struct Rows {
    /// Oldest first.
    rows: IndexMap<String, RemoteComputerRow>,
    agent_id: Option<String>,
}

pub struct RemoteComputerService {
    state: Mutex<Rows>,
    /// One write at a time, in arrival order. The name check reads the cache, so a check
    /// sees every write before it only when the write before it has finished.
    writes: tokio::sync::Mutex<()>,
}

pub static REMOTE_COMPUTER_SERVICE: LazyLock<RemoteComputerService> =
    LazyLock::new(RemoteComputerService::new);

impl RemoteComputerService {
    pub fn new() -> Self {
        RemoteComputerService {
            state: Mutex::new(Rows {
                rows: IndexMap::new(),
                agent_id: None,
            }),
            writes: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn load(&self, agent_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Oldest first, the order the list and the prompt show them in.
    pub fn list(&self) -> Vec<RemoteComputerRow> {
        self.state.lock().rows.values().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<RemoteComputerRow> {
        self.state.lock().rows.get(id).cloned()
    }

    pub fn count(&self) -> usize {
        self.state.lock().rows.len()
    }

    /// Add a computer, or find the one an installation added before. `created` is false for
    /// the second case, where a changed name renames it. Fails with
    /// `ComputerNameTakenError`. Emits `computer added` for a new one.
    pub async fn add(
        &self,
        input: AddComputerInput,
        user_id: &str,
    ) -> anyhow::Result<(RemoteComputerRow, bool)> {
        todo!()
    }

    /// Fails with `ComputerNameTakenError`.
    pub async fn rename(&self, id: &str, name: &str) -> anyhow::Result<RemoteComputerRow> {
        todo!()
    }

    /// False when there was no such computer. Emits `computer removed`.
    pub async fn remove(&self, id: &str, user_id: &str) -> anyhow::Result<bool> {
        todo!()
    }

    async fn add_now(
        &self,
        input: AddComputerInput,
        user_id: &str,
    ) -> anyhow::Result<(RemoteComputerRow, bool)> {
        todo!()
    }

    async fn rename_now(&self, id: &str, name: &str) -> anyhow::Result<RemoteComputerRow> {
        todo!()
    }

    async fn remove_now(&self, id: &str, user_id: &str) -> anyhow::Result<bool> {
        todo!()
    }

    pub async fn record_connected(&self, id: &str, info: ConnectionInfo) -> anyhow::Result<()> {
        todo!()
    }

    pub async fn record_seen(&self, id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// The agent picks a computer by name without case, so two names that differ only in
    /// case would leave one of them unreachable. The table's index compares with case.
    /// `local` is refused with `"<name>" is the name of the runtime's own computer.`
    fn assert_name_free(&self, name: &str, id: Option<&str>) -> Result<(), ComputerNameTakenError> {
        todo!()
    }

    fn cache(&self, row: RemoteComputerRow) -> RemoteComputerRow {
        self.state.lock().rows.insert(row.id.clone(), row.clone());
        row
    }

    /// Fails with `Remote computers are not loaded.` before `load`.
    fn require_agent(&self) -> anyhow::Result<String> {
        todo!()
    }
}

impl Default for RemoteComputerService {
    fn default() -> Self {
        RemoteComputerService::new()
    }
}
