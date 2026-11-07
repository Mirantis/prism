//! Teams Config
//!
//! Microsoft Teams configuration comes from env (`TEAMS_APP_ID`,
//! `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID`). At first access we build and
//! cache a [`TeamsConnectionRecord`] singleton that downstream services
//! (`services/teams/teams_adapter_service`, the management routes) consume.
//!
//! Unlike `slack_config.rs` there is no network validation here: the adapter
//! first uses the credentials when it sends or reads, and a failure there is
//! logged for that request rather than failing boot.

use crate::config::CONFIG;
use crate::log_info;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsConnectionRecord {
    /// Synthetic id — the tenant id, stable and unique per tenant.
    pub id: String,
    pub tenant_id: String,
    pub client_id: String,
    pub name: String,
}

/// `None` until the first load; then the loaded value, `Some(None)` when Teams is
/// disabled.
static CACHED: LazyLock<parking_lot::Mutex<Option<Option<TeamsConnectionRecord>>>> =
    LazyLock::new(|| parking_lot::Mutex::new(None));

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
}

fn load_from_env() -> Option<TeamsConnectionRecord> {
    load(
        &CONFIG.teams_app_id,
        &CONFIG.teams_app_password,
        &CONFIG.teams_app_tenant_id,
    )
}

/// The connection the three Teams settings describe, or `None` unless all are set.
fn load(
    teams_app_id: &Option<String>,
    teams_app_password: &Option<String>,
    teams_app_tenant_id: &Option<String>,
) -> Option<TeamsConnectionRecord> {
    let (Some(teams_app_id), Some(_), Some(teams_app_tenant_id)) = (
        non_empty(teams_app_id),
        non_empty(teams_app_password),
        non_empty(teams_app_tenant_id),
    ) else {
        log_info!(
            "[TeamsConfig] TEAMS_APP_ID / TEAMS_APP_PASSWORD / TEAMS_APP_TENANT_ID not all set — Teams disabled"
        );
        return None;
    };

    log_info!(
        json!({ "clientId": teams_app_id, "tenantId": teams_app_tenant_id }),
        "[TeamsConfig] Teams connection configured from env"
    );

    Some(TeamsConnectionRecord {
        id: teams_app_tenant_id.to_string(),
        tenant_id: teams_app_tenant_id.to_string(),
        client_id: teams_app_id.to_string(),
        name: "Microsoft Teams".to_string(),
    })
}

/// Get the env-sourced Teams connection, cached after first load.
/// Returns `None` when the Teams env vars are not all set (Teams disabled).
pub async fn get_teams_config() -> Option<TeamsConnectionRecord> {
    let mut cached = CACHED.lock();
    if let Some(record) = cached.as_ref() {
        return record.clone();
    }
    let record = load_from_env();
    *cached = Some(record.clone());
    record
}

/// Test-only: reset the cached singleton. Not for production use.
#[doc(hidden)]
pub fn __reset_teams_config_for_tests() {
    *CACHED.lock() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some(value: &str) -> Option<String> {
        Some(value.to_string())
    }

    #[test]
    fn has_no_connection_when_no_teams_env_is_set() {
        assert_eq!(load(&None, &None, &None), None);
    }

    #[test]
    fn has_no_connection_on_a_partial_config() {
        assert_eq!(load(&some("app-1"), &None, &None), None);
        assert_eq!(load(&None, &some("secret"), &None), None);
        assert_eq!(load(&None, &None, &some("tenant-1")), None);
        assert_eq!(load(&some("app-1"), &some("secret"), &None), None);
        assert_eq!(load(&some("app-1"), &some(""), &some("tenant-1")), None);
    }

    #[test]
    fn builds_a_connection_record_when_all_three_vars_are_set() {
        assert_eq!(
            load(&some("app-1"), &some("secret"), &some("tenant-1")),
            Some(TeamsConnectionRecord {
                id: "tenant-1".to_string(),
                tenant_id: "tenant-1".to_string(),
                client_id: "app-1".to_string(),
                name: "Microsoft Teams".to_string(),
            })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn caches_the_result_including_none_until_reset() {
        __reset_teams_config_for_tests();
        // The test configuration sets no Teams env.
        assert_eq!(get_teams_config().await, None);

        *CACHED.lock() = Some(load(&some("app-1"), &some("secret"), &some("tenant-1")));
        assert_eq!(
            get_teams_config().await.map(|c| c.tenant_id),
            Some("tenant-1".to_string())
        );

        __reset_teams_config_for_tests();
        assert_eq!(get_teams_config().await, None);
    }
}
