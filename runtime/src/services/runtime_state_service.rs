//! Read and write the `runtime_state` rows. What that table is for, and why it
//! is a table, is on the model in `prisma/sqlite/schema.prisma`.

use std::sync::LazyLock;

use diesel::prelude::*;

use crate::db::models::NewRuntimeState;
use crate::db::schema::runtime_state::dsl as rs;
use crate::db::sql_types::DbDateTime;

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
}
