//! The remote computers the agent has: the `remote_computers` rows, kept in memory too,
//! since the tools and the prompt ask whether any exist on every turn.

use std::sync::{LazyLock, Once};

use chrono::Utc;
use diesel::prelude::*;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::link_protocol::RemotePlatform;
use crate::db::models::{
    NewRemoteComputer, RemoteComputer as RemoteComputerRow, RemoteComputerChangeset,
};
use crate::db::schema::remote_computers;
use crate::lib::telemetry::track_event;

/// Another computer of this agent already has the name.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ComputerNameTakenError {
    pub message: String,
}

impl ComputerNameTakenError {
    /// `A computer named "<name>" already exists.`
    pub fn new(name: &str) -> Self {
        Self::with_message(format!("A computer named \"{name}\" already exists."))
    }

    pub fn with_message(message: impl Into<String>) -> Self {
        REGISTER_LOG_FIELDS.call_once(|| {
            crate::lib::log_redaction::register_error_fields(log_fields);
        });
        ComputerNameTakenError {
            message: message.into(),
        }
    }
}

/// The error's `name`, as a log line and a tool error show it.
fn log_fields(err: &(dyn std::error::Error + 'static)) -> Option<Map<String, Value>> {
    err.downcast_ref::<ComputerNameTakenError>()?;
    let mut fields = Map::new();
    fields.insert("name".into(), json!("ComputerNameTakenError"));
    Some(fields)
}

static REGISTER_LOG_FIELDS: Once = Once::new();

/// The name, and id, the runtime's own computer goes by when a tool call names it.
const RESERVED_NAME: &str = "local";

/// Whether `error` is the database refusing a second row with the same unique key.
fn is_unique_violation(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<diesel::result::Error>(),
        Some(diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::UniqueViolation,
            _
        ))
    )
}

/// The error Prisma's `update` and `delete` give when no row has the id.
fn record_not_found(operation: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "An operation failed because it depends on one or more records that were required but not found. No record was found for {operation}."
    )
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

/// Update one row and read it back, as Prisma's `update` does.
async fn update_row(
    id: &str,
    changes: RemoteComputerChangeset,
) -> anyhow::Result<RemoteComputerRow> {
    let id = id.to_string();
    crate::db::run(move |conn| {
        diesel::update(remote_computers::table.find(&id))
            .set(&changes)
            .returning(RemoteComputerRow::as_returning())
            .get_result(conn)
            .optional()?
            .ok_or_else(|| record_not_found("an update"))
    })
    .await
}

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
        let agent = agent_id.to_string();
        let rows = crate::db::run(move |conn| {
            Ok(remote_computers::table
                .filter(remote_computers::agent_id.eq(&agent))
                .order(remote_computers::created_at.asc())
                .select(RemoteComputerRow::as_select())
                .load(conn)?)
        })
        .await?;
        let mut state = self.state.lock();
        state.agent_id = Some(agent_id.to_string());
        state.rows = rows.into_iter().map(|row| (row.id.clone(), row)).collect();
        Ok(())
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
        let _turn = self.writes.lock().await;
        self.add_now(input, user_id).await
    }

    /// Fails with `ComputerNameTakenError`.
    pub async fn rename(&self, id: &str, name: &str) -> anyhow::Result<RemoteComputerRow> {
        let _turn = self.writes.lock().await;
        self.rename_now(id, name).await
    }

    /// False when there was no such computer. Emits `computer removed`.
    pub async fn remove(&self, id: &str, user_id: &str) -> anyhow::Result<bool> {
        let _turn = self.writes.lock().await;
        self.remove_now(id, user_id).await
    }

    async fn add_now(
        &self,
        input: AddComputerInput,
        user_id: &str,
    ) -> anyhow::Result<(RemoteComputerRow, bool)> {
        let agent_id = self.require_agent()?;
        let existing = input.installation_id.as_ref().and_then(|installation| {
            self.list()
                .into_iter()
                .find(|row| row.installation_id.as_ref() == Some(installation))
        });
        if let Some(existing) = existing {
            let computer = if existing.name == input.name {
                existing
            } else {
                self.rename_now(&existing.id, &input.name).await?
            };
            return Ok((computer, false));
        }
        self.assert_name_free(&input.name, None)?;
        let mut row = NewRemoteComputer::new(agent_id.clone(), input.name.clone());
        row.platform = input.platform.map(|platform| platform.as_str().to_string());
        row.installation_id = input.installation_id.clone();
        let inserted = crate::db::run(move |conn| {
            Ok(diesel::insert_into(remote_computers::table)
                .values(&row)
                .returning(RemoteComputerRow::as_returning())
                .get_result(conn)?)
        })
        .await;
        let computer = match inserted {
            Ok(computer) => computer,
            Err(error) if is_unique_violation(&error) => {
                return Err(ComputerNameTakenError::new(&input.name).into());
            }
            Err(error) => return Err(error),
        };
        self.state
            .lock()
            .rows
            .insert(computer.id.clone(), computer.clone());
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), agent_id);
        props.insert("computer.id".to_string(), computer.id.clone());
        if let Some(platform) = &computer.platform {
            props.insert("platform".to_string(), platform.clone());
        }
        track_event("computer added", Some(user_id), Some(props));
        Ok((computer, true))
    }

    async fn rename_now(&self, id: &str, name: &str) -> anyhow::Result<RemoteComputerRow> {
        self.assert_name_free(name, Some(id))?;
        let changes = RemoteComputerChangeset {
            name: Some(name.to_string()),
            ..Default::default()
        };
        match update_row(id, changes).await {
            Ok(row) => Ok(self.cache(row)),
            Err(error) if is_unique_violation(&error) => {
                Err(ComputerNameTakenError::new(name).into())
            }
            Err(error) => Err(error),
        }
    }

    async fn remove_now(&self, id: &str, user_id: &str) -> anyhow::Result<bool> {
        if !self.state.lock().rows.contains_key(id) {
            return Ok(false);
        }
        let target = id.to_string();
        let deleted = crate::db::run(move |conn| {
            Ok(diesel::delete(remote_computers::table.find(&target)).execute(conn)?)
        })
        .await?;
        if deleted == 0 {
            return Err(record_not_found("a delete"));
        }
        self.state.lock().rows.shift_remove(id);
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), self.require_agent()?);
        props.insert("computer.id".to_string(), id.to_string());
        track_event("computer removed", Some(user_id), Some(props));
        Ok(true)
    }

    pub async fn record_connected(&self, id: &str, info: ConnectionInfo) -> anyhow::Result<()> {
        if !self.state.lock().rows.contains_key(id) {
            return Ok(());
        }
        let now = Utc::now();
        let changes = RemoteComputerChangeset {
            platform: Some(Some(info.platform.as_str().to_string())),
            client_version: Some(Some(info.client_version)),
            last_connected_at: Some(Some(now)),
            last_seen_at: Some(Some(now)),
            ..Default::default()
        };
        self.cache(update_row(id, changes).await?);
        Ok(())
    }

    pub async fn record_seen(&self, id: &str) -> anyhow::Result<()> {
        if !self.state.lock().rows.contains_key(id) {
            return Ok(());
        }
        let changes = RemoteComputerChangeset {
            last_seen_at: Some(Some(Utc::now())),
            ..Default::default()
        };
        self.cache(update_row(id, changes).await?);
        Ok(())
    }

    /// The agent picks a computer by name without case, so two names that differ only in
    /// case would leave one of them unreachable. The table's index compares with case.
    /// `local` is refused with `"<name>" is the name of the runtime's own computer.`
    fn assert_name_free(&self, name: &str, id: Option<&str>) -> Result<(), ComputerNameTakenError> {
        let wanted = name.to_lowercase();
        if wanted == RESERVED_NAME {
            return Err(ComputerNameTakenError::with_message(format!(
                "\"{name}\" is the name of the runtime's own computer."
            )));
        }
        let taken = self
            .state
            .lock()
            .rows
            .values()
            .any(|row| Some(row.id.as_str()) != id && row.name.to_lowercase() == wanted);
        if taken {
            return Err(ComputerNameTakenError::new(name));
        }
        Ok(())
    }

    fn cache(&self, row: RemoteComputerRow) -> RemoteComputerRow {
        self.state.lock().rows.insert(row.id.clone(), row.clone());
        row
    }

    /// Fails with `Remote computers are not loaded.` before `load`.
    fn require_agent(&self) -> anyhow::Result<String> {
        self.state
            .lock()
            .agent_id
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Remote computers are not loaded."))
    }
}

impl Default for RemoteComputerService {
    fn default() -> Self {
        RemoteComputerService::new()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db::models::NewAgentWorkspace;
    use crate::db::schema::agent_workspaces;

    /// An agent row for the computers to belong to; answers its id.
    pub(crate) async fn agent_row() -> String {
        crate::db::run(|conn| {
            let agent = NewAgentWorkspace::new("user-1", "", "", "", "", "");
            let id = agent.id.clone();
            diesel::insert_into(agent_workspaces::table)
                .values(&agent)
                .execute(conn)?;
            Ok(id)
        })
        .await
        .unwrap()
    }

    fn input(name: &str, installation_id: Option<&str>) -> AddComputerInput {
        AddComputerInput {
            name: name.to_string(),
            platform: Some(RemotePlatform::Macos),
            installation_id: installation_id.map(str::to_string),
        }
    }

    fn taken(error: anyhow::Error) -> String {
        error
            .downcast::<ComputerNameTakenError>()
            .expect("a name refusal")
            .message
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn adds_a_computer_and_lists_it_oldest_first() {
        let _db = crate::db::testing::test_db();
        let agent = agent_row().await;
        let service = RemoteComputerService::new();
        service.load(&agent).await.unwrap();
        let (first, created) = service
            .add(input("Work laptop", None), "user-1")
            .await
            .unwrap();
        assert!(created);
        assert_eq!(first.platform.as_deref(), Some("macos"));
        service
            .add(input("Office PC", None), "user-1")
            .await
            .unwrap();
        let names: Vec<String> = service.list().into_iter().map(|row| row.name).collect();
        assert_eq!(names, ["Work laptop", "Office PC"]);

        let again = RemoteComputerService::new();
        again.load(&agent).await.unwrap();
        assert_eq!(again.count(), 2);
        assert_eq!(again.list()[0].id, first.id);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn finds_the_computer_an_installation_added_before_renamed() {
        let _db = crate::db::testing::test_db();
        let service = RemoteComputerService::new();
        service.load(&agent_row().await).await.unwrap();
        let installation = "9b2f0c1e-0000-4000-8000-000000000001";
        let (first, _) = service
            .add(input("MacBook Pro", Some(installation)), "user-1")
            .await
            .unwrap();
        let (again, created) = service
            .add(input("Work laptop", Some(installation)), "user-1")
            .await
            .unwrap();
        assert!(!created);
        assert_eq!(again.id, first.id);
        assert_eq!(again.name, "Work laptop");
        assert_eq!(service.count(), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_a_name_taken_in_any_case_and_the_local_name() {
        let _db = crate::db::testing::test_db();
        let service = RemoteComputerService::new();
        service.load(&agent_row().await).await.unwrap();
        service.add(input("Laptop", None), "user-1").await.unwrap();
        assert_eq!(
            taken(
                service
                    .add(input("laptop", None), "user-1")
                    .await
                    .unwrap_err()
            ),
            "A computer named \"laptop\" already exists."
        );
        assert_eq!(
            taken(
                service
                    .add(input("Local", None), "user-1")
                    .await
                    .unwrap_err()
            ),
            "\"Local\" is the name of the runtime's own computer."
        );
        let (desktop, _) = service.add(input("Desktop", None), "user-1").await.unwrap();
        assert_eq!(
            taken(service.rename(&desktop.id, "LAPTOP").await.unwrap_err()),
            "A computer named \"LAPTOP\" already exists."
        );
        let renamed = service.rename(&desktop.id, "desktop").await.unwrap();
        assert_eq!(renamed.name, "desktop");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn adds_only_one_of_two_names_that_arrive_together() {
        let _db = crate::db::testing::test_db();
        let service = RemoteComputerService::new();
        service.load(&agent_row().await).await.unwrap();
        let (a, b) = tokio::join!(
            service.add(input("Laptop", None), "user-1"),
            service.add(input("laptop", None), "user-1"),
        );
        assert!(a.is_ok() != b.is_ok());
        assert_eq!(service.count(), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn removes_a_computer_once_and_records_its_connections() {
        let _db = crate::db::testing::test_db();
        let service = RemoteComputerService::new();
        service.load(&agent_row().await).await.unwrap();
        let (computer, _) = service.add(input("Laptop", None), "user-1").await.unwrap();
        service
            .record_connected(
                &computer.id,
                ConnectionInfo {
                    platform: RemotePlatform::Windows,
                    client_version: "1.2.3".into(),
                },
            )
            .await
            .unwrap();
        let row = service.get(&computer.id).unwrap();
        assert_eq!(row.platform.as_deref(), Some("windows"));
        assert_eq!(row.client_version.as_deref(), Some("1.2.3"));
        assert!(row.last_connected_at.is_some());
        assert_eq!(row.last_connected_at, row.last_seen_at);

        assert!(service.remove(&computer.id, "user-1").await.unwrap());
        assert!(!service.remove(&computer.id, "user-1").await.unwrap());
        assert_eq!(service.count(), 0);
        // A computer that is gone records nothing.
        service.record_seen(&computer.id).await.unwrap();
    }

    #[tokio::test]
    async fn refuses_to_add_before_it_is_loaded() {
        let service = RemoteComputerService::new();
        let error = service
            .add(input("Laptop", None), "user-1")
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Remote computers are not loaded.");
    }
}
