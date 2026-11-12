use super::testing::install_app;
use super::*;
use crate::db::models::NewSlackVerificationCode;
use crate::db::testing::test_db;
use crate::lib::slack_web_client::testing::fake_slack_api;
use crate::services::slack_mapping_service::testing::insert_agent;

fn adapter() -> &'static SlackAdapterService {
    &SLACK_ADAPTER_SERVICE
}

#[test]
fn reads_a_link_code_through_slack_formatting() {
    assert_eq!(
        adapter().parse_link_code(" *ab12cd* ").as_deref(),
        Some("AB12CD")
    );
    assert_eq!(
        adapter().parse_link_code("`AB12CD`").as_deref(),
        Some("AB12CD")
    );
    assert_eq!(adapter().parse_link_code("AB12CDE"), None);
    assert_eq!(adapter().parse_link_code("hello!"), None);
}

#[test]
fn tags_the_sender_and_strips_marker_characters_from_the_name() {
    assert_eq!(
        adapter().build_sender_tagged_content("U1", Some("Ann <Lee>: x"), "hi"),
        "<@U1:Ann Lee x>: hi"
    );
    assert_eq!(
        adapter().build_sender_tagged_content("U1", Some(":"), "hi"),
        "<@U1>: hi"
    );
    assert_eq!(
        adapter().build_sender_tagged_content("U1", None, "hi"),
        "hi"
    );
}

#[test]
fn describes_shared_files() {
    let file = |name: Option<&str>| SlackFileMeta {
        id: "F1".into(),
        name: name.map(str::to_string),
        ..SlackFileMeta::default()
    };
    assert_eq!(
        describe_shared_files(&[file(Some("a.png"))]),
        "(shared a file: a.png)"
    );
    assert_eq!(
        describe_shared_files(&[file(Some("a.png")), file(None)]),
        "(shared files: a.png, file)"
    );
}

#[test]
fn words_a_download_failure_for_one_file() {
    let note = adapter().build_attachment_failure_note(&[SlackFileFailure {
        filename: "a.png".into(),
        reason: "it downloaded as an empty file".into(),
    }]);
    assert!(note.starts_with("The user attached a file to this message that could not be downloaded from Slack, so you do NOT have its contents: \"a.png\": it downloaded as an empty file."));
    assert!(
        note.ends_with("— it was a chat attachment that failed to download, not a local file.")
    );
}

#[tokio::test]
#[serial_test::serial]
async fn resolves_inbound_mentions_and_rewrites_outbound_ones() {
    let api = fake_slack_api(Arc::new(|method, request| {
        match (method, request.field("user").as_deref()) {
            ("users.info", Some("U1")) => (
                200,
                json!({ "ok": true, "user": { "real_name": "Ann: Lee" } }),
            ),
            ("users.info", _) => (200, json!({ "ok": false, "error": "user_not_found" })),
            _ => (200, json!({ "ok": true })),
        }
    }))
    .await;
    let _app = install_app("T-mentions", &api.url);
    let inbound = adapter()
        .resolve_mentions("hi <@U1> and <@U1> <!here>", "T-mentions")
        .await;
    assert_eq!(inbound, "hi <@U1:Ann Lee> and <@U1:Ann Lee> @here");

    let outbound = adapter()
        .rewrite_outbound_mentions("<@U1:Ann Lee> <@U9:Ghost> <@U8> <@x:y>", "T-mentions")
        .await;
    assert_eq!(outbound, "<@U1> @Ghost  <@x:y>");
}

#[tokio::test]
#[serial_test::serial]
async fn the_thread_gate_ignores_threads_without_the_bot_and_reacts_to_tags_of_others() {
    let api = fake_slack_api(Arc::new(|method, request| match method {
        "conversations.replies" if request.field("ts").as_deref() == Some("1.0") => (
            200,
            json!({ "ok": true, "messages": [{ "ts": "1.0", "user": "U1", "text": "root" }] }),
        ),
        "conversations.replies" => (
            200,
            json!({ "ok": true, "messages": [
                { "ts": "2.0", "user": "U1", "text": "root" },
                { "ts": "2.1", "user": "UBOT", "text": "on it" },
            ] }),
        ),
        _ => (200, json!({ "ok": true })),
    }))
    .await;
    let _app = install_app("T-gate", &api.url);
    let arriving = |ts: &str, text: &str| GateMessage {
        user: Some("U2".into()),
        text: Some(text.into()),
        ts: Some(ts.into()),
        ..GateMessage::default()
    };
    let (verdict, messages) = adapter()
        .is_bot_in_thread("C1", "1.0", "T-gate", arriving("1.5", "hello"))
        .await;
    assert_eq!(verdict, ThreadParticipation::Ignore);
    assert_eq!(messages.len(), 2);

    let (verdict, _) = adapter()
        .is_bot_in_thread("C1", "2.0", "T-gate", arriving("2.2", "<@U3> can you?"))
        .await;
    assert_eq!(verdict, ThreadParticipation::React);

    let (verdict, messages) = adapter()
        .is_bot_in_thread("C1", "2.0", "T-gate", arriving("2.2", "thanks <@UBOT>"))
        .await;
    assert_eq!(verdict, ThreadParticipation::Respond);
    assert_eq!(messages.last().unwrap().ts.as_deref(), Some("2.2"));
}

#[tokio::test]
#[serial_test::serial]
async fn post_to_target_refuses_broadcasts_bad_threads_and_strangers() {
    let _db = test_db();
    crate::lib::slack_config::set_slack_config_for_tests(Some(
        crate::lib::slack_config::SlackConnectionRecord {
            id: "T-post".into(),
            team_id: "T-post".into(),
            team_name: "Team".into(),
            bot_token: "xoxb".into(),
            bot_id: "B1".into(),
            bot_user_id: "UBOT".into(),
            installed_at: crate::support::now_iso(),
            is_active: true,
        },
    ));
    let api = fake_slack_api(Arc::new(|method, _| match method {
        "conversations.members" => (200, json!({ "ok": true, "members": ["U11"] })),
        "chat.postMessage" => (200, json!({ "ok": true, "ts": "9.9" })),
        _ => (200, json!({ "ok": false, "error": "user_not_found" })),
    }))
    .await;
    let _app = install_app("T-post", &api.url);
    let target = LinkedTarget {
        key: "slack:D1".into(),
        platform: ChatPlatform::Slack,
        kind: LinkedTargetKind::Dm,
        conversation_id: "D1".into(),
        name: Some("<@U1>".into()),
        is_main: false,
        dm_user_id: Some("lens-1".into()),
    };
    let code = |result: anyhow::Result<PostedMessage>| {
        result
            .unwrap_err()
            .downcast::<SendRefusedError>()
            .unwrap()
            .code
    };
    assert_eq!(
        code(
            adapter()
                .post_to_target(&target, "hi <!channel>", None)
                .await
        ),
        "broadcast"
    );
    assert_eq!(
        code(adapter().post_to_target(&target, "hi", Some("abc")).await),
        "bad_thread"
    );
    assert_eq!(
        code(adapter().post_to_target(&target, "hi <@x1>", None).await),
        "bad_mention"
    );
    assert_eq!(
        code(
            adapter()
                .post_to_target(&target, "hi <@U22:Bob>", None)
                .await
        ),
        "not_member"
    );
    let posted = adapter()
        .post_to_target(&target, "hi <@U11:Ann>", None)
        .await
        .unwrap();
    crate::lib::slack_config::__reset_slack_config_for_tests();
    assert_eq!(posted.message_id, "9.9");
    assert_eq!(posted.history.unwrap().thread_key, "D1");
    assert_eq!(
        api.calls("chat.postMessage")[0].field("text").as_deref(),
        Some("hi <@U11>")
    );
}

#[tokio::test]
#[serial_test::serial]
async fn redeems_a_dm_code_once() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    let mut row = NewSlackVerificationCode::new(
        "AB12CD",
        SlackVerificationType::Dm,
        "lens-1",
        "T1",
        "agent-1",
        chrono::Utc::now() + chrono::Duration::minutes(5),
    );
    row.agent_name = Some("Prism".into());
    crate::db::run_sync(move |conn| {
        diesel::insert_into(vc::slack_verification_codes)
            .values(&row)
            .execute(conn)?;
        Ok(())
    })
    .unwrap();

    let linked = adapter()
        .verify_dm_link_code("ab12cd", "U1", "D1")
        .await
        .unwrap();
    assert_eq!(
        linked,
        LinkResult {
            success: true,
            message: "Your Slack account is now linked. You can chat with Prism here.".into(),
            agent_name: None,
        }
    );
    let again = adapter()
        .verify_dm_link_code("AB12CD", "U1", "D1")
        .await
        .unwrap();
    assert_eq!(again.message, CODE_NOT_VALID);
}

struct RecordingChat(Mutex<Vec<Value>>);

#[async_trait]
impl FeedbackChatClient for RecordingChat {
    async fn chat_update(&self, args: Value) -> anyhow::Result<Value> {
        self.0.lock().push(args);
        Ok(json!({ "ok": true }))
    }
}

#[tokio::test(start_paused = true)]
#[serial_test::serial]
async fn a_feedback_click_swaps_the_buttons_for_an_ack_then_clears_it() {
    let _db = test_db();
    let chat = Arc::new(RecordingChat(Mutex::new(Vec::new())));
    let body = json!({
        "user": { "id": "U1" },
        "channel": { "id": "C1" },
        "message": { "ts": "1.1", "blocks": [
            { "type": "markdown", "text": "hi", "block_id": "a" },
            { "type": "actions", "block_id": FEEDBACK_BLOCK_ID },
        ] },
        "actions": [{ "action_id": FEEDBACK_ACTION_UP, "value": "missing-message" }],
    });
    adapter()
        .handle_feedback_action(&body, chat.clone(), FeedbackRating::Up)
        .await
        .unwrap();
    let first = chat.0.lock()[0].clone();
    assert_eq!(first["blocks"].as_array().unwrap().len(), 2);
    assert_eq!(first["blocks"][1]["block_id"], FEEDBACK_ACK_BLOCK_ID);
    // Let the clearing task start its sleep before the clock moves.
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_millis(FEEDBACK_ACK_LINGER_MS + 1)).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    let second = chat.0.lock()[1].clone();
    assert_eq!(
        second["blocks"],
        json!([{ "type": "markdown", "text": "hi", "block_id": "a" }])
    );
}
