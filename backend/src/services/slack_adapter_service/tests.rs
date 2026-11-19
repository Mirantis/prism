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
async fn the_thread_gate_ignores_threads_without_the_bot_and_classifies_tags_of_others() {
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
    assert_eq!(verdict, ThreadParticipation::Respond);

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
    // A DM's members are the bot and the person its mapping names.
    insert_agent("agent-1", "owner", "Agent");
    SLACK_MAPPING_SERVICE
        .upsert_user_mapping("T-post", "U11", "lens-1", "agent-1", Some("D1"))
        .await
        .unwrap();
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
    insert_agent(&CONFIG.agent_id().unwrap(), "owner", "Prism");
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
    assert_eq!(
        again.message,
        "That code is not valid. Generate a new code for Prism under Settings → Channels."
    );
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

// ---------------------------------------------------------------------------
// Routed mode
// ---------------------------------------------------------------------------

fn stored_messages(thread_id: &str) -> Vec<(MessageRole, String, Option<String>)> {
    let thread_id = thread_id.to_string();
    crate::db::run_sync(move |conn| {
        Ok(cm::conversation_messages
            .filter(cm::thread_id.eq(&thread_id))
            .order(cm::created_at.asc())
            .select((cm::role, cm::content, cm::external_message_id))
            .load(conn)?)
    })
    .unwrap()
}

#[test]
fn drops_the_address_of_a_routed_message_and_keeps_other_handles() {
    // A mention or a DM loses the app mention and the leading user group.
    assert_eq!(
        without_address(
            "<!subteam^S1|@prism> <@UBOT> deploy",
            "UBOT",
            SlackRoute::Mention
        ),
        "deploy"
    );
    assert_eq!(
        without_address("<!subteam^S1|@prism> hi", "UBOT", SlackRoute::Dm),
        "hi"
    );
    // A handle in the middle is its plain @handle.
    assert_eq!(
        without_address("ask <!subteam^S2|@ops> too", "UBOT", SlackRoute::Mention),
        "ask @ops too"
    );
    // A thread reply keeps the handle that starts it: it addresses another agent.
    assert_eq!(
        without_address(
            "<!subteam^S2|@ops> can you?",
            "UBOT",
            SlackRoute::ThreadReply
        ),
        "@ops can you?"
    );
}

#[tokio::test]
#[serial_test::serial]
async fn stores_the_messages_before_the_one_that_brought_the_agent_in_once() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    let api = fake_slack_api(Arc::new(|method, _| match method {
        "conversations.replies" => (
            200,
            json!({ "ok": true, "messages": [
                { "ts": "1.0", "user": "U1", "text": "the build broke" },
                { "ts": "2.0", "bot_id": "B9", "username": "ops-agent", "text": "looking" },
                { "ts": "3.0", "user": "U1", "text": "<@UBOT> can you help?" },
            ] }),
        ),
        "users.info" => (200, json!({ "ok": true, "user": { "real_name": "Ann" } })),
        _ => (200, json!({ "ok": false, "error": "unknown_method" })),
    }))
    .await;
    let _app = install_app("T-joined", &api.url);

    let thread = adapter()
        .stored_thread("owner", "agent-1", "C1", "1.0", "3.0", "T-joined")
        .await
        .unwrap();
    assert_eq!(
        stored_messages(&thread.id),
        vec![
            (
                MessageRole::User,
                "<@U1:Ann>: the build broke".to_string(),
                None
            ),
            (
                MessageRole::User,
                "<@B9:ops-agent>: looking".to_string(),
                None
            ),
        ]
    );
    // The next message of the thread reads nothing.
    adapter()
        .stored_thread("owner", "agent-1", "C1", "1.0", "4.0", "T-joined")
        .await
        .unwrap();
    assert_eq!(api.calls("conversations.replies").len(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn writes_the_agents_own_posts_again_in_their_place() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    let api = fake_slack_api(Arc::new(|method, _| match method {
        "conversations.replies" => (
            200,
            json!({ "ok": true, "messages": [
                { "ts": "1.0", "bot_id": "BME", "text": "formatted copy" },
                { "ts": "2.0", "user": "U1", "text": "thanks" },
            ] }),
        ),
        "users.info" => (200, json!({ "ok": true, "user": { "name": "ann" } })),
        _ => (200, json!({ "ok": false, "error": "unknown_method" })),
    }))
    .await;
    let _app = install_app("T-own", &api.url);
    // The agent's send_message post, stored when it was sent.
    let thread = CONVERSATION_SERVICE
        .get_or_create_thread_by_external_id(
            "owner",
            "agent-1",
            "1.0",
            Some(LiveThread {
                source: ThreadSource::Database,
                channel_id: "C1".into(),
            }),
        )
        .await
        .unwrap();
    let mut post = MessageInput::new(
        "Deploy finished",
        MessageRole::Agent,
        MessageTrigger::CronTask,
    );
    post.external_message_id = Some("1.0".into());
    CONVERSATION_SERVICE
        .add_message(&thread.id, post)
        .await
        .unwrap();

    adapter()
        .stored_thread("owner", "agent-1", "C1", "1.0", "3.0", "T-own")
        .await
        .unwrap();
    assert_eq!(
        stored_messages(&thread.id),
        vec![
            (
                MessageRole::Agent,
                "Deploy finished".to_string(),
                Some("1.0".to_string())
            ),
            (MessageRole::User, "<@U1:ann>: thanks".to_string(), None),
        ]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn starts_without_the_earlier_messages_when_slack_refuses_the_read() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    let api = fake_slack_api(Arc::new(|_, _| {
        (200, json!({ "ok": false, "error": "not_in_channel" }))
    }))
    .await;
    let _app = install_app("T-refused", &api.url);
    let thread = adapter()
        .stored_thread("owner", "agent-1", "C1", "1.0", "3.0", "T-refused")
        .await
        .unwrap();
    assert!(stored_messages(&thread.id).is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn judges_a_thread_reply_on_the_stored_thread() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    let thread = CONVERSATION_SERVICE
        .get_or_create_thread_by_external_id("owner", "agent-1", "1.0", None)
        .await
        .unwrap();
    let mut asked = MessageInput::new(
        "<@U1:Ann>: deploy it",
        MessageRole::User,
        MessageTrigger::UserInput,
    );
    asked.sender_external_id = Some("U1".into());
    CONVERSATION_SERVICE
        .add_message(&thread.id, asked)
        .await
        .unwrap();
    // The thread reads in createdAt order, so the reply gets a later millisecond.
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    CONVERSATION_SERVICE
        .add_message(
            &thread.id,
            MessageInput::new("Deployed", MessageRole::Agent, MessageTrigger::UserInput),
        )
        .await
        .unwrap();
    let arriving = |text: &str| GateMessage {
        user: Some("U1".into()),
        text: Some(text.into()),
        ts: Some("4.0".into()),
        ..GateMessage::default()
    };

    let (verdict, messages) = adapter()
        .stored_thread_gate(&thread.id, arriving("thanks, roll back too"), "UBOT")
        .await
        .unwrap();
    assert_eq!(verdict, ThreadParticipation::Respond);
    let lines: Vec<(Option<String>, Option<String>)> =
        messages.into_iter().map(|m| (m.user, m.text)).collect();
    assert_eq!(
        lines,
        vec![
            (Some("U1".into()), Some("deploy it".into())),
            (Some("UBOT".into()), Some("Deployed".into())),
            (Some("U1".into()), Some("thanks, roll back too".into())),
        ]
    );
    let (verdict, _) = adapter()
        .stored_thread_gate(&thread.id, arriving("<@U2> can you check?"), "UBOT")
        .await
        .unwrap();
    assert_eq!(verdict, ThreadParticipation::Respond);
}

#[tokio::test]
#[serial_test::serial]
async fn stores_a_routed_post_in_the_thread_its_channel_owner_reads() {
    let _db = test_db();
    insert_agent("agent-1", "owner", "Agent");
    SLACK_MAPPING_SERVICE
        .upsert_channel_mapping("T1", "C1", "agent-1", "general", "lens-1")
        .await
        .unwrap();
    let channel = LinkedTarget {
        key: "slack:C1".into(),
        platform: ChatPlatform::Slack,
        kind: LinkedTargetKind::Channel,
        conversation_id: "C1".into(),
        name: Some("#general".into()),
        is_main: false,
        dm_user_id: None,
    };
    assert_eq!(
        adapter().routed_post_history(&channel, "5.0", "5.0").await,
        Some(PostedHistory {
            user_id: "lens-1".into(),
            thread_key: "5.0".into(),
            channel_id: Some("C1".into()),
            external_message_id: Some("5.0".into()),
        })
    );
    let unlinked = LinkedTarget {
        conversation_id: "C2".into(),
        ..channel
    };
    assert_eq!(
        adapter().routed_post_history(&unlinked, "5.0", "5.0").await,
        None
    );
}

#[tokio::test]
#[serial_test::serial]
async fn links_and_unlinks_a_dm_and_a_channel_as_the_router_reports() {
    let _db = test_db();
    let agent_id = CONFIG.agent_id().unwrap();
    insert_agent(&agent_id, "owner", "Prism");
    let api = fake_slack_api(Arc::new(|method, _| match method {
        "conversations.info" => (200, json!({ "ok": true, "channel": { "name": "general" } })),
        _ => (200, json!({ "ok": false, "error": "unknown_method" })),
    }))
    .await;
    let _app = install_app("T-link", &api.url);
    let link: RoutedLink = serde_json::from_value(json!({
        "op": "add", "type": "dm", "slackUserId": "U1", "dmChannelId": "D1", "personId": "lens-1",
    }))
    .unwrap();
    adapter().apply_link("T-link", &link).await.unwrap();
    let mapping = SLACK_MAPPING_SERVICE
        .find_user_mapping("T-link", "U1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(mapping.mapping.lens_user_id.as_deref(), Some("lens-1"));
    assert_eq!(mapping.mapping.dm_channel_id.as_deref(), Some("D1"));
    let unlink: RoutedLink = serde_json::from_value(json!({
        "op": "remove", "type": "dm", "slackUserId": "U1", "dmChannelId": "D1", "personId": "lens-1",
    }))
    .unwrap();
    adapter().apply_link("T-link", &unlink).await.unwrap();
    assert!(
        SLACK_MAPPING_SERVICE
            .find_user_mapping("T-link", "U1")
            .await
            .unwrap()
            .is_none()
    );

    let channel: RoutedLink = serde_json::from_value(json!({
        "op": "add", "type": "channel", "channelId": "C1", "personId": "lens-1",
    }))
    .unwrap();
    adapter().apply_link("T-link", &channel).await.unwrap();
    let channel_row = || {
        crate::db::run_sync(|conn| {
            Ok(m::slack_mappings
                .filter(m::slack_channel_id.eq("C1"))
                .select(SlackMapping::as_select())
                .first(conn)
                .optional()?)
        })
        .unwrap()
    };
    let linked = channel_row().unwrap();
    assert_eq!(linked.slack_channel_name.as_deref(), Some("general"));
    assert_eq!(linked.lens_user_id.as_deref(), Some("lens-1"));
    let unlink_channel: RoutedLink = serde_json::from_value(json!({
        "op": "remove", "type": "channel", "channelId": "C1", "personId": "lens-1",
    }))
    .unwrap();
    adapter()
        .apply_link("T-link", &unlink_channel)
        .await
        .unwrap();
    assert!(channel_row().is_none());
}
