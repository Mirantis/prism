//! Read and write the `runtime_state` rows. What that table is for, and why it
//! is a table, is on the model in `prisma/sqlite/schema.prisma`.

use std::sync::LazyLock;

use diesel::prelude::*;
use serde_json::json;

use crate::db::models::NewRuntimeState;
use crate::lib::log_redaction::err_json;
use crate::log_warn;
use crate::db::schema::runtime_state::dsl as rs;
use crate::db::sql_types::DbDateTime;

/// The environment the previous run finished in: `local` or `docker`.
pub const LAST_EXECUTION_ENVIRONMENT: &str = "lastExecutionEnvironment";

/// The id of single-thread mode's one conversation.
pub const SINGLE_THREAD: &str = "singleThread";

/// This install's `deployment.id` on product telemetry.
pub const DEPLOYMENT_ID: &str = "deploymentId";

/// The end of the last closed hour that `llm usage aggregated` reported, as an ISO time.
pub const LLM_USAGE_REPORTED_THROUGH: &str = "llmUsageReportedThrough";

pub struct RuntimeStateService;

impl RuntimeStateService {
    pub fn new() -> Self {
        RuntimeStateService
    }

    /// The stored value, or `None` when nothing has written this key yet.
    pub async fn get(&self, key: &str) -> anyhow::Result<Option<String>> {
        let key = key.to_string();
        crate::db::read(move |conn| {
            Ok(rs::runtime_state
                .filter(rs::key.eq(&key))
                .select(rs::value)
                .first(conn)
                .optional()?)
        })
        .await
    }

    pub async fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        let row = NewRuntimeState::new(key, value);
        crate::db::run(move |conn| {
            diesel::insert_into(rs::runtime_state)
                .values(&row)
                .on_conflict(rs::key)
                .do_update()
                .set((
                    rs::value.eq(&row.value),
                    rs::updated_at.eq(DbDateTime::now()),
                ))
                .execute(conn)?;
            Ok(())
        })
        .await
    }

    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        let key = key.to_string();
        crate::db::run(move |conn| {
            diesel::delete(rs::runtime_state.filter(rs::key.eq(&key))).execute(conn)?;
            Ok(())
        })
        .await
    }

    /// This install's id: created on the first read and kept for as long as the
    /// database is. `None` when the database cannot be read, so telemetry goes out
    /// without the attribute.
    pub async fn deployment_id(&self) -> Option<String> {
        let row = NewRuntimeState::new(DEPLOYMENT_ID, &uuid::Uuid::new_v4().to_string());
        let stored = crate::db::run(move |conn| {
            conn.transaction(|conn| {
                diesel::insert_into(rs::runtime_state)
                    .values(&row)
                    .on_conflict(rs::key)
                    .do_nothing()
                    .execute(conn)?;
                Ok(rs::runtime_state
                    .filter(rs::key.eq(DEPLOYMENT_ID))
                    .select(rs::value)
                    .first::<String>(conn)?)
            })
        })
        .await;
        match stored {
            Ok(id) => Some(id),
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[RuntimeState] could not read or create the deployment id"
                );
                None
            }
        }
    }
}

impl Default for RuntimeStateService {
    fn default() -> Self {
        Self::new()
    }
}

pub static RUNTIME_STATE_SERVICE: LazyLock<RuntimeStateService> =
    LazyLock::new(RuntimeStateService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testing::test_db;

    #[tokio::test]
    #[serial_test::serial]
    async fn sets_overwrites_reads_and_deletes_a_key() {
        let _db = test_db();
        let svc = &*RUNTIME_STATE_SERVICE;
        assert_eq!(svc.get(SINGLE_THREAD).await.unwrap(), None);
        svc.set(SINGLE_THREAD, "thread-1").await.unwrap();
        svc.set(SINGLE_THREAD, "thread-2").await.unwrap();
        assert_eq!(
            svc.get(SINGLE_THREAD).await.unwrap().as_deref(),
            Some("thread-2")
        );
        svc.delete(SINGLE_THREAD).await.unwrap();
        svc.delete(SINGLE_THREAD).await.unwrap();
        assert_eq!(svc.get(SINGLE_THREAD).await.unwrap(), None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn creates_the_deployment_id_on_the_first_read_and_keeps_it() {
        let _db = test_db();
        let svc = &*RUNTIME_STATE_SERVICE;
        let first = svc.deployment_id().await.unwrap();
        assert!(uuid::Uuid::parse_str(&first).is_ok(), "{first}");
        assert_eq!(svc.deployment_id().await.as_deref(), Some(first.as_str()));
        assert_eq!(svc.get(DEPLOYMENT_ID).await.unwrap(), Some(first));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn gives_two_installs_two_deployment_ids() {
        let mine = {
            let _db = test_db();
            RUNTIME_STATE_SERVICE.deployment_id().await.unwrap()
        };
        let _db = test_db();
        let theirs = RUNTIME_STATE_SERVICE.deployment_id().await.unwrap();
        assert_ne!(mine, theirs);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn has_no_deployment_id_when_the_database_cannot_be_read() {
        let _db = test_db();
        crate::db::run(|conn| {
            diesel::sql_query("DROP TABLE runtime_state").execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(RUNTIME_STATE_SERVICE.deployment_id().await, None);
    }
}
