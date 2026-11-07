//! Slack Connection Source
//!
//! Thin passthrough over `slack_config` (env-sourced Slack connection).
//! Call sites (`slack_adapter_service`, `slack_mapping_service`,
//! `slack_thread_provider`) import from here to keep the indirection
//! available if we ever need a non-env source again.

use crate::lib::slack_config::get_slack_config;

pub use crate::lib::slack_config::SlackConnectionRecord;

pub async fn get_active_slack_connections() -> anyhow::Result<Vec<SlackConnectionRecord>> {
    let cfg = get_slack_config().await?;
    Ok(cfg.into_iter().collect())
}

pub async fn get_slack_connection() -> anyhow::Result<Option<SlackConnectionRecord>> {
    // Exactly one connection in this runtime. Legacy mappings persisted a
    // SlackMapping.connectionId that may or may not match the current
    // token's teamId — return the singleton either way since there's
    // nowhere else the token could have come from.
    get_slack_config().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::slack_config::{__reset_slack_config_for_tests, set_slack_config_for_tests};

    fn singleton_record() -> SlackConnectionRecord {
        SlackConnectionRecord {
            id: "T123".into(),
            team_id: "T123".into(),
            team_name: "Test".into(),
            bot_token: "xoxb-TEST".into(),
            bot_id: "BBOT".into(),
            bot_user_id: "UBOT".into(),
            installed_at: crate::support::now_iso(),
            is_active: true,
        }
    }

    #[tokio::test]
    #[serial_test::serial(slack_config)]
    async fn lists_the_singleton_when_configured() {
        set_slack_config_for_tests(Some(singleton_record()));
        let result = get_active_slack_connections().await.unwrap();
        __reset_slack_config_for_tests();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].team_id, "T123");
    }

    #[tokio::test]
    #[serial_test::serial(slack_config)]
    async fn lists_nothing_when_slack_is_disabled() {
        set_slack_config_for_tests(None);
        let result = get_active_slack_connections().await.unwrap();
        __reset_slack_config_for_tests();
        assert!(result.is_empty());
    }

    #[tokio::test]
    #[serial_test::serial(slack_config)]
    async fn the_connection_is_the_singleton() {
        set_slack_config_for_tests(Some(singleton_record()));
        let result = get_slack_connection().await.unwrap();
        __reset_slack_config_for_tests();
        assert_eq!(result.unwrap().bot_user_id, "UBOT");
    }

    #[tokio::test]
    #[serial_test::serial(slack_config)]
    async fn no_connection_when_slack_is_disabled() {
        set_slack_config_for_tests(None);
        let result = get_slack_connection().await.unwrap();
        __reset_slack_config_for_tests();
        assert!(result.is_none());
    }
}
