use diesel::prelude::*;
use serde_json::json;

use super::*;
use crate::db::models::NewAgentWorkspace;
use crate::support::http::testing::{TestResponse, call};

const AGENT_ID: &str = "test-agent-id";
const OWNER: &str = "test-owner-id";

fn insert_agent() {
    crate::db::run_sync(|conn| {
        let mut agent =
            NewAgentWorkspace::new(OWNER, "soul", "user", "memory", "heartbeat", "bootstrap");
        agent.id = AGENT_ID.to_string();
        diesel::insert_into(agent_workspaces::table)
            .values(&agent)
            .execute(conn)?;
        Ok(())
    })
    .expect("insert the agent");
}

async fn send(method: &str, uri: &str, body: Option<Value>) -> TestResponse {
    call(router(), method, uri, body).await
}

#[test]
fn builds_a_content_disposition_that_survives_non_latin1_filenames() {
    let disposition = content_disposition(ContentDispositionKind::Inline, "日本語 (1).pdf");
    assert!(disposition.starts_with("inline;"));
    assert!(disposition.contains("filename=\"___ (1).pdf\""));
    assert!(disposition.contains("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E%20%281%29.pdf"));
    assert_eq!(
        content_disposition(ContentDispositionKind::Attachment, "a\"b\\c\r\n.txt"),
        "attachment; filename=\"a_b_c__.txt\"; filename*=UTF-8''a_b_c__.txt"
    );
}

#[test]
fn names_a_blank_filename_file() {
    assert_eq!(sanitize_filename("  \u{1}  "), "file");
    assert_eq!(js_string(Some(&json!([1, null, "a"]))), "1,,a");
    assert_eq!(js_string(Some(&json!({ "a": 1 }))), "[object Object]");
    assert_eq!(js_string(None), "undefined");
}

#[test]
fn reads_a_part_filename_as_busboy_and_multer_do() {
    assert_eq!(busboy_basename("C:\\Users\\me\\report.pdf"), "report.pdf");
    assert_eq!(busboy_basename("dir/.."), "");
    assert_eq!(decode_form_data_name("a%22b%0Ac"), "a\"b\nc");
    assert_eq!(latin1("é"), "Ã©");
    assert_eq!(part_type(Some("Image/PNG; charset=x")), "image/png");
    assert_eq!(part_type(None), "text/plain");
}

fn body(value: Value) -> JsonBody {
    JsonBody(Some(value))
}

#[test]
fn refuses_an_unknown_auth_type_algorithm_or_encoding() {
    for (field, value) in [
        ("authType", json!({ "authType": "github" })),
        (
            "authAlgorithm",
            json!({ "authType": "hmac", "authHeader": "X-S", "secret": "s", "authAlgorithm": "md5" }),
        ),
        (
            "authEncoding",
            json!({ "authType": "hmac", "authHeader": "X-S", "secret": "s", "authEncoding": "rot13" }),
        ),
    ] {
        let refusal = read_webhook_auth_fields(&body(value), &webhook_auth_defaults()).unwrap_err();
        assert!(refusal.field_errors.contains_key(field), "{field}");
    }
}

#[test]
fn requires_a_secret_and_a_header_for_a_verifying_scheme() {
    let refusal = read_webhook_auth_fields(
        &body(json!({ "authType": "hmac", "authHeader": "X-Signature" })),
        &webhook_auth_defaults(),
    )
    .unwrap_err();
    assert_eq!(
        refusal.error,
        "A secret is required for 'hmac' authentication"
    );
    let refusal = read_webhook_auth_fields(
        &body(json!({ "authType": "token", "secret": "shhh" })),
        &webhook_auth_defaults(),
    )
    .unwrap_err();
    assert_eq!(
        refusal.error,
        "A header name is required for 'token' authentication (e.g. X-Hub-Signature-256)"
    );
    let refusal = read_webhook_auth_fields(
        &body(json!({ "authType": "token", "authHeader": "X-Token", "secret": 12345 })),
        &webhook_auth_defaults(),
    )
    .unwrap_err();
    assert_eq!(refusal.error, "secret must be a string");
}

#[test]
fn clears_the_credential_when_verification_is_turned_off() {
    let current = WebhookAuthFields {
        auth_type: WebhookAuthType::Hmac,
        auth_header: Some("X-Sig".into()),
        auth_prefix: Some("sha256=".into()),
        auth_algorithm: WebhookAuthAlgorithm::Sha256,
        auth_encoding: WebhookAuthEncoding::Hex,
        auth_signed_url: Some("https://example.com/hook".into()),
        secret: Some("s".into()),
    };
    let values = read_webhook_auth_fields(&body(json!({ "authType": "none" })), &current).unwrap();
    assert_eq!(values.auth_header, None);
    assert_eq!(values.auth_prefix, None);
    assert_eq!(values.secret, None);
    assert_eq!(values.auth_signed_url, None);
}

#[test]
fn keeps_the_prefix_spacing_and_trims_the_rest() {
    let values = read_webhook_auth_fields(
        &body(json!({
            "authType": "token", "authHeader": " Authorization ", "authPrefix": "Bearer ", "secret": " s "
        })),
        &webhook_auth_defaults(),
    )
    .unwrap();
    assert_eq!(values.auth_header.as_deref(), Some("Authorization"));
    assert_eq!(values.auth_prefix.as_deref(), Some("Bearer "));
    assert_eq!(values.secret.as_deref(), Some("s"));
}

#[test]
fn refuses_a_signed_url_that_is_not_absolute_http() {
    let refusal = read_webhook_auth_fields(
        &body(json!({
            "authType": "hmac", "authHeader": "X-S", "secret": "s", "authSignedUrl": "/relative"
        })),
        &webhook_auth_defaults(),
    )
    .unwrap_err();
    assert_eq!(
        refusal.error,
        "The signed URL must be an absolute http or https URL"
    );
}

#[tokio::test]
async fn refuses_a_model_write_without_the_model_key() {
    for uri in [
        "/agents/model",
        "/agents/heartbeat-model",
        "/agents/cron-model",
    ] {
        let res = send("PATCH", uri, Some(json!({}))).await;
        assert_eq!(res.status, 400, "{uri}");
        assert_eq!(
            res.json(),
            json!({ "error": "missing required field 'model' (use null to clear)" })
        );
    }
    let res = send("PATCH", "/agents/verbose", Some(json!({}))).await;
    assert_eq!(
        res.json(),
        json!({ "error": "missing required field 'verbose'" })
    );
}

#[tokio::test]
async fn refuses_an_interval_outside_one_minute_to_one_week() {
    let res = send(
        "PATCH",
        "/agents/heartbeat/interval",
        Some(json!({ "intervalMs": "x" })),
    )
    .await;
    assert_eq!(res.status, 400);
    assert_eq!(
        res.json(),
        json!({ "error": "intervalMs must be a finite number" })
    );
    for interval in [59_999, 604_800_001_i64] {
        let res = send(
            "PATCH",
            "/agents/heartbeat/interval",
            Some(json!({ "intervalMs": interval })),
        )
        .await;
        assert_eq!(res.status, 400);
        assert_eq!(
            res.json(),
            json!({ "error": "intervalMs must be between 60000 (1 minute) and 604800000 (1 week)" })
        );
    }
}

#[tokio::test]
async fn answers_500_for_a_start_without_a_body_and_400_without_an_agent() {
    let res = send("POST", "/agents/heartbeat/start", None).await;
    assert_eq!(res.status, 500);
    assert_eq!(
        res.json(),
        json!({ "error": "Cannot destructure property 'agent' of 'req.body' as it is undefined." })
    );
    let res = send("POST", "/agents/heartbeat/start", Some(json!({}))).await;
    assert_eq!(res.status, 400);
    assert_eq!(
        res.json(),
        json!({ "error": "Missing agent in request body" })
    );
}

#[tokio::test]
async fn refuses_a_receiver_toggle_that_is_not_a_boolean() {
    let res = send(
        "PATCH",
        "/agents/webhooks/receiver",
        Some(json!({ "enabled": "yes" })),
    )
    .await;
    assert_eq!(res.status, 400);
    assert_eq!(res.json(), json!({ "error": "enabled must be a boolean" }));
}

#[tokio::test]
async fn refuses_a_goal_without_a_thread_or_objective_or_with_a_bad_budget() {
    let res = send("POST", "/agents/goals", Some(json!({ "threadId": "t1" }))).await;
    assert_eq!(
        res.json(),
        json!({ "error": "Missing required fields: threadId, objective" })
    );
    let res = send(
        "POST",
        "/agents/goals",
        Some(json!({ "threadId": "t1", "objective": "x".repeat(GOAL_MAX_OBJECTIVE_CHARS + 1) })),
    )
    .await;
    assert_eq!(
        res.json(),
        json!({ "error": format!("Objective is too long (max {GOAL_MAX_OBJECTIVE_CHARS} characters)") })
    );
    for budget in [json!(0), json!(-5), json!(1.5), json!("100")] {
        let res = send(
            "POST",
            "/agents/goals",
            Some(json!({ "threadId": "t1", "objective": "Ship it", "tokenBudget": budget })),
        )
        .await;
        assert_eq!(
            res.json(),
            json!({ "error": "tokenBudget must be a positive integer" })
        );
    }
}

#[tokio::test]
async fn refuses_thread_reads_and_writes_that_miss_a_required_field() {
    let res = send("POST", "/agents/threads", Some(json!({ "agentId": "a" }))).await;
    assert_eq!(
        res.json(),
        json!({ "error": "Missing required fields: agentId, userId" })
    );
    let res = send("GET", "/agents/threads?userId=u", None).await;
    assert_eq!(
        res.json(),
        json!({ "error": "Missing required query params: userId, agentId" })
    );
    let res = send("GET", "/agents/threads?userId=u&agentId=a&limit=0", None).await;
    assert_eq!(
        res.json(),
        json!({ "error": "limit must be a positive integer" })
    );
    let res = send("GET", "/agents/threads/t1?agentId=a", None).await;
    assert_eq!(
        res.json(),
        json!({ "error": "Missing required query params: userId, agentId" })
    );
    let res = send(
        "POST",
        "/agents/threads/t1/set-external-id",
        Some(json!({})),
    )
    .await;
    assert_eq!(
        res.json(),
        json!({ "error": "Missing required field: externalThreadId" })
    );
}

#[tokio::test]
async fn refuses_a_message_without_its_fields_or_with_an_unknown_role_or_trigger() {
    let res = send(
        "POST",
        "/agents/threads/t1/messages",
        Some(json!({ "role": "USER" })),
    )
    .await;
    assert_eq!(
        res.json(),
        json!({ "error": "Missing required field(s): content, triggeredBy" })
    );
    let res = send(
        "POST",
        "/agents/threads/t1/messages",
        Some(json!({ "content": "hi", "role": "BOT", "triggeredBy": "USER_INPUT" })),
    )
    .await;
    assert_eq!(
        res.json(),
        json!({ "error": "Invalid role: BOT. Must be one of: USER, AGENT, SYSTEM" })
    );
    let res = send(
        "POST",
        "/agents/threads/t1/messages",
        Some(json!({ "content": "hi", "role": "USER", "triggeredBy": "AGENT_MESSAGE" })),
    )
    .await;
    assert_eq!(res.status, 400);
    assert!(
        res.json()["error"]
            .as_str()
            .unwrap()
            .starts_with("Invalid triggeredBy: AGENT_MESSAGE. Must be one of: USER_INPUT")
    );
}

#[tokio::test]
async fn refuses_a_chat_without_text_or_attachments_and_an_agent_without_its_fields() {
    let res = send(
        "POST",
        "/agents/chat",
        Some(json!({ "userId": "u", "agentId": "a", "message": "  " })),
    )
    .await;
    assert_eq!(
        res.json(),
        json!({ "error": "userId, agentId, and either message text or attachmentIds are required" })
    );
    let res = send("POST", "/agents", Some(json!({ "id": "x" }))).await;
    assert_eq!(
        res.json(),
        json!({ "error": "Missing required fields: id, userId, name, agentType, teamName" })
    );
    let res = send(
        "POST",
        "/agents",
        Some(
            json!({ "id": "x", "userId": "u", "name": "n", "agentType": "ROBOT", "teamName": "t" }),
        ),
    )
    .await;
    assert_eq!(
        res.json(),
        json!({ "error": "Invalid agentType. Must be one of: AGENT, SUBAGENT" })
    );
}

#[tokio::test]
async fn refuses_an_attachment_upload_without_a_file() {
    let res = send("POST", "/agents/attachments", None).await;
    assert_eq!(res.status, 400);
    assert_eq!(
        res.json(),
        json!({ "error": "Missing or empty `file` field in multipart body" })
    );
}

#[tokio::test]
#[serial_test::serial]
async fn answers_the_agent_identity() {
    let _db = crate::db::testing::test_db();
    insert_agent();
    let res = send("GET", "/agents/me", None).await;
    assert_eq!(res.status, 200);
    let body = res.json();
    assert_eq!(body["agentId"], AGENT_ID);
    assert_eq!(body["userId"], OWNER);
    assert_eq!(body["threadMode"], "multi");
    assert!(body["hasComputer"].is_boolean());
}

#[tokio::test]
#[serial_test::serial]
async fn creates_lists_and_deletes_a_webhook_subscription() {
    let _db = crate::db::testing::test_db();
    insert_agent();
    let res = send(
        "POST",
        "/agents/webhook-subscriptions",
        Some(json!({
            "name": "Alerts", "description": "  ops  ", "authType": "token",
            "authHeader": "X-Token", "secret": "s3cret"
        })),
    )
    .await;
    assert_eq!(res.status, 201, "{}", res.text());
    let created = res.json();
    assert_eq!(created["name"], "alerts");
    assert_eq!(created["description"], "ops");
    assert!(created.get("secret").is_none());

    let res = send(
        "POST",
        "/agents/webhook-subscriptions",
        Some(json!({ "name": "alerts", "authType": "none" })),
    )
    .await;
    assert_eq!(res.status, 409);
    assert_eq!(
        res.json()["error"],
        "A subscription named \"alerts\" already exists"
    );

    let res = send("GET", "/agents/webhook-subscriptions", None).await;
    assert_eq!(res.json().as_array().unwrap().len(), 1);

    let id = created["id"].as_str().unwrap().to_string();
    let res = send(
        "PATCH",
        &format!("/agents/webhook-subscriptions/{id}"),
        Some(json!({})),
    )
    .await;
    assert_eq!(res.status, 400);
    assert_eq!(
        res.json(),
        json!({ "error": "No updatable fields provided" })
    );

    let res = send(
        "PATCH",
        &format!("/agents/webhook-subscriptions/{id}"),
        Some(json!({ "isActive": false })),
    )
    .await;
    assert_eq!(res.status, 200);
    assert_eq!(res.json()["isActive"], false);

    let res = send(
        "DELETE",
        &format!("/agents/webhook-subscriptions/{id}"),
        None,
    )
    .await;
    assert_eq!(res.json(), json!({ "success": true }));
    let res = send(
        "DELETE",
        &format!("/agents/webhook-subscriptions/{id}"),
        None,
    )
    .await;
    assert_eq!(res.status, 404);
}
