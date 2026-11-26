//! Generated UI in Slack on a database built from the committed migrations: the
//! post, the text version when Slack refuses the blocks, and the first press.

use std::sync::atomic::{AtomicUsize, Ordering};

use futures::StreamExt;

use super::*;
use crate::lib::slack_config::{
    __reset_slack_config_for_tests, SlackConnectionRecord, set_slack_config_for_tests,
};
use crate::lib::slack_web_client::WebClientOptions;
use crate::lib::slack_web_client::testing::{FakeSlackApi, fake_slack_api};
use crate::services::generated_ui::generated_ui_schema::parse_spec;
use crate::services::generated_ui::generated_ui_service::PRESS_TRIGGER_NAME;
use crate::services::question_cards::question_card_service::tests::{
    THREAD, USER, agent, agent_id, chat_work, rows, stored,
};
use crate::services::slack_adapter_service::testing::install_app;
use crate::services::slack_router_envelope::{RouterEnvelope, parse_router_envelope};

const TEAM: &str = "T-ui";
const TS: &str = "1767225600.000200";

fn adapter() -> &'static SlackAdapterService {
    &SLACK_ADAPTER_SERVICE
}

fn connection() -> SlackConnectionRecord {
    SlackConnectionRecord {
        id: TEAM.into(),
        team_id: TEAM.into(),
        team_name: "Team".into(),
        bot_token: "xoxb".into(),
        bot_id: "B1".into(),
        bot_user_id: "UBOT".into(),
        installed_at: crate::support::now_iso(),
        is_active: true,
    }
}

/// A UI with two buttons and a link button, as `publish` stores it.
fn ui() -> GeneratedUiBlock {
    parse_spec(&json!({
        "root": "card",
        "elements": {
            "card": { "type": "Card", "props": { "title": "Deploys" }, "children": ["choose"] },
            "choose": { "type": "Actions", "children": ["roll-back", "keep", "docs"] },
            "roll-back": { "type": "Button", "props": { "label": "Roll back", "style": "danger" } },
            "keep": { "type": "Button", "props": { "label": "Keep it" } },
            "docs": { "type": "LinkButton", "props": { "label": "Docs", "url": "https://example.com/docs" } }
        }
    }))
    .unwrap()
    .into_block(uuid::Uuid::new_v4().to_string())
}

/// Stores the UI as the agent's message posted at `TS`, and answers the row id.
async fn seed_ui(ui: &GeneratedUiBlock) -> String {
    let mut row = crate::db::models::NewConversationMessage::new(
        THREAD,
        MessageRole::Agent,
        "**Deploys**\n\nRoll back / Keep it / Docs (https://example.com/docs)",
        MessageTrigger::UserInput,
    );
    row.blocks = Some(json!([ui]));
    row.external_message_id = Some(TS.into());
    crate::db::run(move |conn| {
        diesel::insert_into(cm::conversation_messages)
            .values(&row)
            .execute(conn)?;
        Ok(row.id)
    })
    .await
    .unwrap()
}

/// A Slack API that names U0ADA and U0GRACE and takes every other call.
async fn people_api() -> FakeSlackApi {
    fake_slack_api(Arc::new(|method, request| {
        match (method, request.field("user").as_deref()) {
            ("users.info", Some("U0ADA")) => (
                200,
                json!({ "ok": true, "user": { "real_name": "Ada Example" } }),
            ),
            ("users.info", Some("U0GRACE")) => (
                200,
                json!({ "ok": true, "user": { "real_name": "Grace Example" } }),
            ),
            _ => (200, json!({ "ok": true })),
        }
    }))
    .await
}

struct RecordingChat(Mutex<Vec<Value>>);

#[async_trait]
impl FeedbackChatClient for RecordingChat {
    async fn chat_update(&self, args: Value) -> anyhow::Result<Value> {
        self.0.lock().push(args);
        Ok(json!({ "ok": true }))
    }
}

/// The `block_actions` payload of a press, with the blocks the UI posted as.
fn press_body(ui: &GeneratedUiBlock, element_id: &str, slack_user_id: &str) -> Value {
    let blocks = generated_ui_blocks(&ui.id, &ui.root, &ui.elements, &HashMap::new());
    json!({
        "type": "block_actions",
        "user": { "id": slack_user_id },
        "channel": { "id": "D0ADA" },
        "message": { "ts": TS, "thread_ts": "1767225600.000100", "text": "Deploys", "blocks": blocks },
        "actions": [{
            "action_id": format!("generated_ui:{element_id}"),
            "block_id": format!("generated_ui:{}:choose", ui.id),
        }],
    })
}

async fn press(body: &Value, chat: &Arc<RecordingChat>) {
    adapter()
        .handle_generated_ui_press(body, TEAM, chat.clone(), None)
        .await
        .unwrap();
}

fn context(api: &FakeSlackApi) -> Arc<ConnectionContext> {
    Arc::new(ConnectionContext {
        connection_id: TEAM.into(),
        team_id: TEAM.into(),
        team_name: "Team".into(),
        bot_id: "B1".into(),
        bot_user_id: "UBOT".into(),
        client: Arc::new(SlackWebClient::new(
            Some("xoxb-test"),
            Some(WebClientOptions {
                timeout_ms: Some(5_000),
                retry_config: None,
                slack_api_url: Some(api.url.clone()),
            }),
        )),
    })
}

#[tokio::test]
#[serial_test::serial]
async fn posts_a_ui_as_its_blocks_and_links_the_stored_message() {
    let _db = agent().await;
    set_slack_config_for_tests(Some(connection()));
    let api = fake_slack_api(Arc::new(|method, _| match method {
        "chat.postMessage" => (200, json!({ "ok": true, "ts": TS })),
        _ => (200, json!({ "ok": true })),
    }))
    .await;
    let _app = install_app(TEAM, &api.url);
    let ui = ui();
    let row_id = seed_ui(&ui).await;
    let content = "**Deploys**\n\nRoll back / Keep it / Docs (https://example.com/docs)";
    adapter()
        .deliver_to_channel(
            "C1",
            content,
            THREAD,
            None,
            None,
            Some(&json!([ui])),
            Some(&row_id),
            false,
            &[],
            None,
        )
        .await
        .unwrap();
    __reset_slack_config_for_tests();

    let posts = api.calls("chat.postMessage");
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].field("text").as_deref(), Some(content));
    assert_eq!(
        posts[0].json_field("blocks").unwrap(),
        json!(generated_ui_blocks(
            &ui.id,
            &ui.root,
            &ui.elements,
            &HashMap::new()
        ))
    );
    let stored = rows(THREAD).await;
    assert_eq!(stored[0].external_message_id.as_deref(), Some(TS));
}

#[tokio::test]
#[serial_test::serial]
async fn autonomous_delivery_posts_a_ui_only_to_the_main_channel_not_also_to_the_dm() {
    let _db = agent().await;
    set_slack_config_for_tests(Some(connection()));
    let api = fake_slack_api(Arc::new(|method, _| match method {
        "chat.postMessage" => (200, json!({ "ok": true, "ts": TS })),
        _ => (200, json!({ "ok": true })),
    }))
    .await;
    let _app = install_app(TEAM, &api.url);
    let mut mapping = crate::db::models::NewSlackMapping::new(TEAM, agent_id());
    mapping.lens_user_id = Some(USER.into());
    mapping.dm_channel_id = Some("D0ADA".into());
    mapping.slack_channel_id = Some("C1".into());
    mapping.is_main_channel = true;
    crate::db::run(move |conn| {
        diesel::insert_into(crate::db::schema::slack_mappings::table)
            .values(&mapping)
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
    let ui = ui();
    seed_ui(&ui).await;
    let row = rows(THREAD).await.remove(0);
    adapter()
        .deliver(USER, &DeliverableMessage::bare(row), None)
        .await
        .unwrap();
    __reset_slack_config_for_tests();

    let posts = api.calls("chat.postMessage");
    let channels: Vec<Option<String>> = posts.iter().map(|post| post.field("channel")).collect();
    assert_eq!(channels, [Some("C1".to_string())]);
}

#[tokio::test]
#[serial_test::serial]
async fn a_ui_in_reply_to_a_dm_posts_only_to_that_dm_thread() {
    let _db = agent().await;
    set_slack_config_for_tests(Some(connection()));
    let api = fake_slack_api(Arc::new(|method, _| match method {
        "chat.postMessage" => (200, json!({ "ok": true, "ts": TS })),
        _ => (200, json!({ "ok": true })),
    }))
    .await;
    let _app = install_app(TEAM, &api.url);
    let mut mapping = crate::db::models::NewSlackMapping::new(TEAM, agent_id());
    mapping.lens_user_id = Some(USER.into());
    mapping.dm_channel_id = Some("D0ADA".into());
    mapping.slack_channel_id = Some("C1".into());
    mapping.is_main_channel = true;
    crate::db::run(move |conn| {
        diesel::insert_into(crate::db::schema::slack_mappings::table)
            .values(&mapping)
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
    let ui = ui();
    seed_ui(&ui).await;
    let row = rows(THREAD).await.remove(0);
    let dm_turn = ChannelContext {
        channel: ChannelName::Slack,
        channel_id: None,
        channel_thread_id: Some("1767225500.000100".into()),
        thread_id: THREAD.into(),
        include_feedback: None,
    };
    adapter()
        .deliver(USER, &DeliverableMessage::bare(row), Some(&dm_turn))
        .await
        .unwrap();
    __reset_slack_config_for_tests();

    let posts = api.calls("chat.postMessage");
    let targets: Vec<(Option<String>, Option<String>)> = posts
        .iter()
        .map(|post| (post.field("channel"), post.field("thread_ts")))
        .collect();
    assert_eq!(
        targets,
        [(
            Some("D0ADA".to_string()),
            Some("1767225500.000100".to_string())
        )]
    );
    assert_eq!(
        rows(THREAD).await[0].external_message_id.as_deref(),
        Some(TS)
    );
}

#[tokio::test]
#[serial_test::serial]
async fn posts_the_text_version_when_slack_refuses_the_blocks_with_each_refusal_code() {
    for code in REFUSED_BLOCKS {
        let _db = agent().await;
        set_slack_config_for_tests(Some(connection()));
        let api = fake_slack_api(Arc::new(move |method, request| match method {
            "chat.postMessage" if request.field("blocks").is_some() => {
                (200, json!({ "ok": false, "error": code }))
            }
            "chat.postMessage" => (200, json!({ "ok": true, "ts": TS })),
            _ => (200, json!({ "ok": true })),
        }))
        .await;
        let _app = install_app(TEAM, &api.url);
        let ui = ui();
        let row_id = seed_ui(&ui).await;
        let content = format!(
            "**Deploys**\n\n{}\n\n{}",
            "a".repeat(3_000),
            "b".repeat(3_000)
        );
        adapter()
            .deliver_to_channel(
                "C1",
                &content,
                THREAD,
                None,
                None,
                Some(&json!([ui])),
                Some(&row_id),
                false,
                &[],
                None,
            )
            .await
            .unwrap();
        __reset_slack_config_for_tests();

        let posts = api.calls("chat.postMessage");
        assert_eq!(posts.len(), 3, "{code}");
        assert!(posts[1].field("blocks").is_none(), "{code}");
        assert!(posts[2].field("blocks").is_none(), "{code}");
        assert_eq!(
            posts[1].field("text").unwrap(),
            format!("**Deploys**\n\n{}", "a".repeat(3_000))
        );
        assert_eq!(posts[2].field("text").unwrap(), "b".repeat(3_000));
        assert_eq!(
            rows(THREAD).await[0].external_message_id.as_deref(),
            Some(TS)
        );
    }
}

#[tokio::test]
#[serial_test::serial]
async fn posts_no_text_version_for_any_other_error() {
    let _db = agent().await;
    set_slack_config_for_tests(Some(connection()));
    let api = fake_slack_api(Arc::new(|method, _| match method {
        "chat.postMessage" => (200, json!({ "ok": false, "error": "channel_not_found" })),
        _ => (200, json!({ "ok": true })),
    }))
    .await;
    let _app = install_app(TEAM, &api.url);
    let ui = ui();
    let row_id = seed_ui(&ui).await;
    adapter()
        .deliver_to_channel(
            "C1",
            "Deploys",
            THREAD,
            None,
            None,
            Some(&json!([ui])),
            Some(&row_id),
            false,
            &[],
            None,
        )
        .await
        .unwrap();
    __reset_slack_config_for_tests();
    assert_eq!(api.calls("chat.postMessage").len(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn the_first_press_wins_updates_the_message_and_becomes_the_persons_message() {
    let _db = agent().await;
    let api = people_api().await;
    let _app = install_app(TEAM, &api.url);
    let ui = ui();
    let row_id = seed_ui(&ui).await;
    let chat = Arc::new(RecordingChat(Mutex::new(Vec::new())));

    press(&press_body(&ui, "keep", "U0ADA"), &chat).await;
    assert_eq!(
        stored(&row_id).await["pressed"],
        json!({ "elementId": "keep", "label": "Keep it", "by": { "id": "U0ADA", "name": "Ada Example" } })
    );
    let updates = chat.0.lock().clone();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0]["channel"], "D0ADA");
    assert_eq!(updates[0]["ts"], TS);
    let blocks = updates[0]["blocks"].as_array().unwrap();
    assert_eq!(blocks[1]["elements"].as_array().unwrap().len(), 1);
    assert_eq!(blocks[1]["elements"][0]["url"], "https://example.com/docs");
    assert_eq!(
        blocks[2]["elements"][0]["text"],
        "\u{2705} *Keep it*, pressed by <@U0ADA>"
    );
    let users: Vec<ConversationMessage> = rows(THREAD)
        .await
        .into_iter()
        .filter(|row| row.role == MessageRole::User)
        .collect();
    assert_eq!(users.len(), 1);
    assert_eq!(users[0].content, "<@U0ADA:Ada Example>: Keep it");
    assert_eq!(users[0].trigger_name.as_deref(), Some(PRESS_TRIGGER_NAME));
    assert_eq!(users[0].sender_external_id.as_deref(), Some("U0ADA"));
    assert!(chat_work().await.is_empty());

    // Anyone may press, but only the first press is taken.
    press(&press_body(&ui, "roll-back", "U0GRACE"), &chat).await;
    assert_eq!(stored(&row_id).await["pressed"]["elementId"], "keep");
    assert_eq!(chat.0.lock().len(), 1);
    let users = rows(THREAD)
        .await
        .into_iter()
        .filter(|row| row.role == MessageRole::User)
        .count();
    assert_eq!(users, 1);
}

#[tokio::test]
#[serial_test::serial]
async fn a_restart_after_the_press_keeps_the_message_owed_an_answer() {
    let _db = agent().await;
    let api = people_api().await;
    let _app = install_app(TEAM, &api.url);
    let ui = ui();
    seed_ui(&ui).await;
    // The turn fails, as a process stopping mid-turn leaves it: the row stays.
    *crate::services::conversation_engine_service::testing::INVOKE.write() =
        Some(Arc::new(|_: crate::types::InvokeRequest| {
            futures::stream::pending().boxed()
        }));
    let chat = Arc::new(RecordingChat(Mutex::new(Vec::new())));
    let body = press_body(&ui, "keep", "U0ADA");
    let handle = tokio::spawn(async move {
        adapter()
            .handle_generated_ui_press(&body, TEAM, chat, None)
            .await
    });
    let mut work = Vec::new();
    for _ in 0..200 {
        work = chat_work().await;
        if work
            .iter()
            .any(|(_, payload)| payload.get("message").is_some())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    handle.abort();
    let (_, payload) = work.first().expect("the press is owed an answer");
    assert_eq!(
        payload["message"]["message"],
        "<@U0ADA:Ada Example>: Keep it"
    );
    assert_eq!(payload["message"]["generatedUiPress"], true);
    assert_eq!(payload["message"]["runtimeWritten"], true);
    assert_eq!(payload["metadata"]["channel"], "slack");
    assert_eq!(payload["metadata"]["channelThreadId"], "1767225600.000100");
}

#[tokio::test]
#[serial_test::serial]
async fn acknowledges_every_action_and_ignores_link_buttons_and_unknown_ones() {
    let _db = agent().await;
    let api = people_api().await;
    let _app = install_app(TEAM, &api.url);
    let ui = ui();
    let row_id = seed_ui(&ui).await;
    let acks = Arc::new(AtomicUsize::new(0));
    let counted = acks.clone();
    let ack = move || {
        counted.fetch_add(1, Ordering::SeqCst);
        Ok(())
    };
    let link = json!({
        "type": "block_actions",
        "user": { "id": "U0ADA" },
        "channel": { "id": "D0ADA" },
        "message": { "ts": TS },
        // Slack names a link button's action itself.
        "actions": [{ "action_id": "Xq7=", "block_id": format!("generated_ui:{}:choose", ui.id) }],
    });
    let unknown_ui = json!({
        "type": "block_actions",
        "user": { "id": "U0ADA" },
        "channel": { "id": "D0ADA" },
        "message": { "ts": TS },
        "actions": [{ "action_id": "generated_ui:keep", "block_id": "generated_ui:missing:choose" }],
    });
    for body in [link, unknown_ui] {
        adapter()
            .process_body(context(&api), &body, &ack, None)
            .await;
    }
    assert_eq!(acks.load(Ordering::SeqCst), 2);
    assert!(stored(&row_id).await.get("pressed").is_none());
    assert!(api.calls("chat.update").is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn takes_a_routed_press_through_the_same_handler() {
    let _db = agent().await;
    let api = people_api().await;
    let _app = install_app(TEAM, &api.url);
    let ui = ui();
    let row_id = seed_ui(&ui).await;
    let envelope = json!({
        "version": 1, "kind": "slack", "eventId": "Ev0PRESS", "sentAt": chrono::Utc::now().to_rfc3339(),
        "teamId": TEAM, "route": "action", "person": { "id": "ada" }, "payloadType": "block_actions",
        "payload": press_body(&ui, "keep", "U0ADA"),
    });
    let Ok(RouterEnvelope::Slack(envelope)) = parse_router_envelope(&envelope) else {
        panic!("the action envelope did not parse");
    };
    let body = envelope.to_listener_body();
    assert_eq!(body["message"]["thread_ts"], "1767225600.000100");
    adapter()
        .process_body(context(&api), &body, &|| Ok(()), None)
        .await;
    assert_eq!(stored(&row_id).await["pressed"]["label"], "Keep it");
    let updates = api.calls("chat.update");
    assert_eq!(updates.len(), 1);
    assert_eq!(
        updates[0].json_field("blocks").unwrap()[2]["elements"][0]["text"],
        "\u{2705} *Keep it*, pressed by <@U0ADA>"
    );
}
