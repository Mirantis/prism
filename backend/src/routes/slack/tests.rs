use super::*;
use crate::db::models::{NewSlackHeartbeatTrigger, NewSlackMapping};
use crate::db::testing::test_db;
use crate::services::slack_mapping_service::testing::{
    channel_mapping, insert_agent, insert_mapping,
};
use crate::support::http::testing::call;

fn insert_code(code: &str, kind: SlackVerificationType, expires_in_minutes: i64) {
    let mut row = NewSlackVerificationCode::new(
        code,
        kind,
        "lens-1",
        "T1",
        "agent-1",
        Utc::now() + chrono::Duration::minutes(expires_in_minutes),
    );
    row.agent_name = Some("Prism".into());
    crate::db::run_sync(move |conn| {
        diesel::insert_into(vc::slack_verification_codes)
            .values(&row)
            .execute(conn)?;
        Ok(())
    })
    .unwrap();
}

fn code_count() -> i64 {
    crate::db::read_sync(|conn| Ok(vc::slack_verification_codes.count().get_result(conn)?)).unwrap()
}

fn mappings() -> Vec<SlackMapping> {
    crate::db::read_sync(|conn| {
        Ok(m::slack_mappings
            .select(SlackMapping::as_select())
            .load(conn)?)
    })
    .unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_requests_missing_required_fields() {
    let _db = test_db();
    let cases = [
        (
            "GET",
            "/agents/slack-heartbeat-trigger",
            None,
            "Missing userId query parameter",
        ),
        (
            "POST",
            "/agents/slack-heartbeat-trigger",
            Some(json!({ "connectionId": "T1" })),
            "Missing required fields: connectionId, channelId, userId",
        ),
        (
            "PATCH",
            "/agents/slack-heartbeat-trigger",
            Some(json!({ "triggerId": "t", "userId": "u" })),
            "Missing required fields: triggerId, userId, throttleSeconds",
        ),
        (
            "DELETE",
            "/agents/slack-heartbeat-trigger/t1",
            None,
            "Missing userId query parameter",
        ),
        (
            "POST",
            "/agents/slack/verify-channel-link-code",
            Some(json!({ "code": "ABC123" })),
            "Missing required fields: code, channelId",
        ),
        (
            "POST",
            "/agents/slack/verify-link-code",
            Some(json!({ "code": "ABC123", "slackUserId": "U1" })),
            "Missing required fields: code, slackUserId, dmChannelId",
        ),
        (
            "POST",
            "/agents/threads/get-or-create-by-external-id",
            Some(json!({ "userId": "u" })),
            "Missing required fields: userId, agentId, externalThreadId",
        ),
        (
            "POST",
            "/agents/slack/create-verification-code",
            Some(json!({ "type": "DM" })),
            "Missing required fields: type, lensUserId, connectionId, agentId, expiresAt",
        ),
        (
            "GET",
            "/agents/slack/channel-name?channelId=C1",
            None,
            "Missing required query params: channelId, teamId",
        ),
    ];
    for (method, uri, body, error) in cases {
        let response = call(router(), method, uri, body).await;
        assert_eq!(response.status, 400, "{method} {uri}");
        assert_eq!(response.json(), json!({ "error": error }), "{method} {uri}");
    }
}

#[tokio::test]
#[serial_test::serial]
async fn verifies_a_dm_code_once_in_upper_case() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    insert_code("ABC123", SlackVerificationType::Dm, 5);
    let body = json!({ "code": "abc123", "slackUserId": "U1", "dmChannelId": "D1" });
    let linked = call(
        router(),
        "POST",
        "/agents/slack/verify-link-code",
        Some(body.clone()),
    )
    .await;
    assert_eq!(
        linked.json(),
        json!({ "success": true, "message": "Your Slack account is now linked. You can chat with Prism here." })
    );
    assert_eq!(code_count(), 0);
    let mapping = &mappings()[0];
    assert_eq!(mapping.dm_channel_id.as_deref(), Some("D1"));
    assert_eq!(mapping.lens_user_id.as_deref(), Some("lens-1"));

    let again = call(
        router(),
        "POST",
        "/agents/slack/verify-link-code",
        Some(body),
    )
    .await;
    assert_eq!(again.json()["message"], CODE_NOT_VALID);
}

#[tokio::test]
#[serial_test::serial]
async fn deletes_an_expired_dm_code() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    insert_code("ABC123", SlackVerificationType::Dm, -5);
    let response = call(
        router(),
        "POST",
        "/agents/slack/verify-link-code",
        Some(json!({ "code": "ABC123", "slackUserId": "U1", "dmChannelId": "D1" })),
    )
    .await;
    assert_eq!(
        response.json(),
        json!({ "success": false, "message": CODE_EXPIRED })
    );
    assert_eq!(code_count(), 0);
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_slack_user_already_linked() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    insert_code("ABC123", SlackVerificationType::Dm, 5);
    let mut existing = NewSlackMapping::new("T1", "agent-1");
    existing.slack_user_id = Some("U1".into());
    existing.lens_user_id = Some("someone-else".into());
    insert_mapping(existing);
    let response = call(
        router(),
        "POST",
        "/agents/slack/verify-link-code",
        Some(json!({ "code": "ABC123", "slackUserId": "U1", "dmChannelId": "D1" })),
    )
    .await;
    assert_eq!(
        response.json()["message"],
        "This Slack account is already linked to another Prism Agent user."
    );
    assert_eq!(code_count(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn verifies_a_channel_code_and_refuses_a_linked_channel() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    insert_code("ABC123", SlackVerificationType::Channel, 5);
    let linked = call(
        router(),
        "POST",
        "/agents/slack/verify-channel-link-code",
        Some(json!({ "code": "abc123", "channelId": "C1" })),
    )
    .await;
    assert_eq!(
        linked.json(),
        json!({
            "success": true,
            "message": "Your Slack channel is now linked. Mention me anytime you need help!",
            "agentName": "Prism",
        })
    );
    // No channelName given: the name stays null.
    assert_eq!(mappings()[0].slack_channel_name, None);

    insert_code("DEF456", SlackVerificationType::Channel, 5);
    let taken = call(
        router(),
        "POST",
        "/agents/slack/verify-channel-link-code",
        Some(json!({ "code": "DEF456", "channelId": "C1" })),
    )
    .await;
    assert_eq!(
        taken.json()["message"],
        "This channel is already linked to an agent."
    );
}

#[tokio::test]
#[serial_test::serial]
async fn lists_channel_mappings_with_the_main_channel_and_link_status() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    let mut old = channel_mapping("agent-1", "C-old", 5_000);
    old.connection_id = "legacy-uuid".into();
    insert_mapping(old);
    insert_mapping(channel_mapping("agent-1", "C-new", 1_000));
    let listed = call(router(), "GET", "/agents/slack-channel-mappings", None).await;
    let channels = listed.json()["channels"].clone();
    assert_eq!(channels[0]["channelId"], "C-old");
    assert_eq!(channels[0]["isMain"], true);
    assert_eq!(channels[0]["agentName"], "Agent");
    assert_eq!(channels[1]["isMain"], false);

    let status = call(router(), "GET", "/agents/slack-link-status", None).await;
    assert_eq!(
        status.json(),
        json!({ "hasDmMapping": false, "hasChannelMapping": true, "slackUserId": null })
    );

    let main = call(
        router(),
        "PUT",
        "/agents/slack/channel-mapping/C-new/main",
        None,
    )
    .await;
    assert_eq!(main.json(), json!({ "ok": true }));
    let listed = call(router(), "GET", "/agents/slack-channel-mappings", None).await;
    assert_eq!(listed.json()["channels"][1]["isMain"], true);

    let missing = call(
        router(),
        "PUT",
        "/agents/slack/channel-mapping/C-x/main",
        None,
    )
    .await;
    assert_eq!(missing.status, 404);

    let found = call(router(), "GET", "/agents/slack/channel-mapping/C-old", None).await;
    assert_eq!(found.json()["mapping"]["agentId"], "agent-1");

    let deleted = call(
        router(),
        "DELETE",
        "/agents/slack/channel-mapping/C-old",
        None,
    )
    .await;
    assert_eq!(deleted.json(), json!({ "deleted": 1 }));
    let again = call(
        router(),
        "DELETE",
        "/agents/slack/channel-mapping/C-old",
        None,
    )
    .await;
    assert_eq!(again.status, 404);
}

#[tokio::test]
#[serial_test::serial]
async fn deletes_dm_mappings_and_finds_the_connection_id() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    let none = call(router(), "GET", "/agents/slack-connection-id", None).await;
    assert_eq!(none.status, 404);
    let mut dm = NewSlackMapping::new("legacy-uuid", "agent-1");
    dm.slack_user_id = Some("U1".into());
    dm.dm_channel_id = Some("D1".into());
    insert_mapping(dm);
    let found = call(router(), "GET", "/agents/slack-connection-id", None).await;
    assert_eq!(found.json(), json!({ "connectionId": "legacy-uuid" }));
    let deleted = call(router(), "DELETE", "/agents/slack/dm-mapping", None).await;
    assert_eq!(deleted.json(), json!({ "deleted": 1 }));
}

#[tokio::test]
#[serial_test::serial]
async fn creates_a_six_character_verification_code() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    let response = call(
        router(),
        "POST",
        "/agents/slack/create-verification-code",
        Some(json!({
            "type": "DM",
            "lensUserId": "lens-1",
            "connectionId": "T1",
            "agentId": "agent-1",
            "expiresAt": (Utc::now() + chrono::Duration::minutes(10)).to_rfc3339(),
        })),
    )
    .await;
    let code = response.json()["code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 6);
    assert!(
        code.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase())
    );
    assert_eq!(code_count(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn manages_a_trigger_and_answers_a_second_with_conflict() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    let mut existing = NewSlackHeartbeatTrigger::new("T1", "C9", "agent-1", "owner");
    existing.throttle_seconds = 30;
    let id = existing.id.clone();
    crate::db::run_sync(move |conn| {
        diesel::insert_into(crate::db::schema::slack_heartbeat_triggers::table)
            .values(&existing)
            .execute(conn)?;
        Ok(())
    })
    .unwrap();

    let check = call(
        router(),
        "GET",
        "/agents/slack-heartbeat-trigger/channel/C9",
        None,
    )
    .await;
    assert_eq!(
        check.json(),
        json!({ "isTrigger": true, "userId": "owner", "agentId": "agent-1" })
    );
    let listed = call(
        router(),
        "GET",
        "/agents/slack-heartbeat-trigger?userId=owner",
        None,
    )
    .await;
    assert_eq!(
        listed.json()[0]["agentWorkspace"],
        json!({ "name": "Agent" })
    );

    let updated = call(
        router(),
        "PATCH",
        "/agents/slack-heartbeat-trigger",
        Some(json!({ "triggerId": id, "userId": "owner", "throttleSeconds": 5 })),
    )
    .await;
    assert_eq!(updated.json()["throttleSeconds"], 5);
    let missing = call(
        router(),
        "PATCH",
        "/agents/slack-heartbeat-trigger",
        Some(json!({ "triggerId": "nope", "userId": "owner", "throttleSeconds": 5 })),
    )
    .await;
    assert_eq!(missing.status, 404);

    let claim = call(
        router(),
        "POST",
        "/agents/slack-heartbeat-trigger/claim",
        None,
    )
    .await;
    assert_eq!(claim.json(), json!({ "claimed": true }));

    let deleted = call(
        router(),
        "DELETE",
        &format!("/agents/slack-heartbeat-trigger/{id}?userId=owner"),
        None,
    )
    .await;
    assert_eq!(deleted.json(), json!({ "success": true }));
}

#[tokio::test]
#[serial_test::serial]
async fn an_absent_body_fails_as_destructuring_undefined_does() {
    let _db = test_db();
    let response = call(router(), "POST", "/agents/slack/link-user", None).await;
    assert_eq!(response.status, 500);
    assert_eq!(
        response.json(),
        json!({ "error": "Cannot destructure property 'connectionId' of 'req.body' as it is undefined." })
    );
}
