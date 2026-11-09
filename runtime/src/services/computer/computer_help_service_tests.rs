use super::*;
use crate::db::models::{
    MessageRole, NewAgentWorkspace, NewConversationMessage, NewConversationThread,
};
use crate::services::computer::computer_access::{ComputerAccess, ComputerKind};

fn card(id: &str, status: HelpStatus) -> ComputerHelp {
    ComputerHelp {
        kind: ComputerHelpType::ComputerHelp,
        id: id.to_string(),
        reason: "Sign in to the dashboard".to_string(),
        tab: None,
        target_id: Some("target-1".to_string()),
        computer_id: Some(LOCAL_COMPUTER_ID.to_string()),
        credentials: None,
        credential_fields: None,
        site: None,
        status,
        thread_id: None,
        origin_channel: None,
        origin_channel_id: None,
        broadcast: None,
        requester_waits: None,
    }
}

/// An agent with one conversation holding `blocks`, one message each, oldest first.
async fn conversation(user_id: &str, blocks: Vec<Value>) -> (String, String) {
    let user = user_id.to_string();
    crate::db::run(move |conn| {
        use crate::db::schema::{agent_workspaces, conversation_messages, conversation_threads};
        let agent = NewAgentWorkspace::new(user.clone(), "", "", "", "", "");
        diesel::insert_into(agent_workspaces::table)
            .values(&agent)
            .execute(conn)?;
        let thread = NewConversationThread::new(agent.id.clone(), user.clone());
        diesel::insert_into(conversation_threads::table)
            .values(&thread)
            .execute(conn)?;
        for (i, block) in blocks.into_iter().enumerate() {
            let mut message = NewConversationMessage::new(
                thread.id.clone(),
                MessageRole::Agent,
                format!("message {i}"),
                MessageTrigger::UserInput,
            );
            message.blocks = Some(block);
            message.created_at = crate::db::sql_types::DbDateTime(
                chrono::Utc::now() + chrono::Duration::milliseconds(i as i64),
            );
            diesel::insert_into(conversation_messages::table)
                .values(&message)
                .execute(conn)?;
        }
        Ok((agent.id, thread.id))
    })
    .await
    .unwrap()
}

fn ids(help: &[ComputerHelp]) -> Vec<&str> {
    help.iter().map(|item| item.id.as_str()).collect()
}

#[test]
fn links_the_computer_page_with_the_request_and_a_remote_computer_selected() {
    assert!(
        computer_link(Some("help-1"), Some("box-2"))
            .ends_with("/computer?help=help-1&computer=box-2")
    );
    assert!(
        computer_link(Some("help-1"), Some(LOCAL_COMPUTER_ID)).ends_with("/computer?help=help-1")
    );
    assert!(computer_link(None, None).ends_with("/computer"));
}

#[test]
fn waits_for_the_answer_only_in_runs_that_store_no_steps() {
    for mode in ["heartbeat", "cron", "webhook"] {
        assert!(waits_for_answer(mode), "{mode}");
    }
    for mode in ["chat", "goal", "voice"] {
        assert!(!waits_for_answer(mode), "{mode}");
    }
}

#[test]
fn asks_every_channel_only_for_a_background_run_with_no_conversation() {
    assert!(asks_every_channel("heartbeat", None));
    assert!(asks_every_channel("goal", None));
    assert!(!asks_every_channel("heartbeat", Some("thread")));
    assert!(!asks_every_channel("chat", None));
}

#[test]
fn stores_a_card_with_its_fields_in_the_order_a_new_request_writes_them() {
    let mut help = card("help-1", HelpStatus::Waiting);
    help.credentials = Some(true);
    help.credential_fields = Some(CredentialFields::Password);
    help.site = Some("https://login.example.com".to_string());
    help.thread_id = Some("thread-1".to_string());
    help.requester_waits = Some(true);
    assert_eq!(
        serde_json::to_string(&help).unwrap(),
        r#"{"type":"computer_help","id":"help-1","reason":"Sign in to the dashboard","targetId":"target-1","computerId":"local","credentials":true,"credentialFields":"password","site":"https://login.example.com","status":"waiting","threadId":"thread-1","requesterWaits":true}"#
    );
}

#[tokio::test]
#[serial_test::serial]
async fn lists_the_help_cards_of_the_agents_conversations_oldest_first() {
    let _db = crate::db::testing::test_db();
    let (agent, thread) = conversation(
        "user-1",
        vec![
            json!([card("first", HelpStatus::Continued)]),
            json!([{ "type": "plan", "id": "not-help" }]),
            json!([card("second", HelpStatus::Waiting)]),
        ],
    )
    .await;
    let service = ComputerHelpService::new();

    let listed = service.list(&agent, "user-1", Some(&thread)).await.unwrap();
    assert_eq!(ids(&listed), vec!["first", "second"]);
    let waiting = service.waiting(&agent, "user-1").await.unwrap();
    assert_eq!(ids(&waiting), vec!["second"]);
    assert!(
        service
            .list(&agent, "someone-else", None)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
#[serial_test::serial]
async fn answers_a_waiting_request_once() {
    let _db = crate::db::testing::test_db();
    let (agent, thread) =
        conversation("user-1", vec![json!([card("help-1", HelpStatus::Waiting)])]).await;
    let service = ComputerHelpService::new();

    let resolved = service
        .resolve(&agent, "user-1", "help-1", HelpStatus::Continued)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resolved.help.status, HelpStatus::Continued);
    assert_eq!(resolved.answered_runs, 0);
    let stored = service.list(&agent, "user-1", Some(&thread)).await.unwrap();
    assert_eq!(stored[0].status, HelpStatus::Continued);

    // Already answered, by this or by another client.
    assert!(
        service
            .resolve(&agent, "user-1", "help-1", HelpStatus::Dismissed)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_help_id_that_does_not_exist() {
    let _db = crate::db::testing::test_db();
    let (agent, _) = conversation("user-1", vec![]).await;
    let err = ComputerHelpService::new()
        .resolve(&agent, "user-1", "missing", HelpStatus::Continued)
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "Help request not found.");
}

fn background_use(mode: &str) -> Arc<ComputerUse> {
    ComputerAccess::new(None, ComputerKind::Local).create(
        ComputerCaller {
            user_id: "user-1".to_string(),
            agent_id: "agent-1".to_string(),
            thread_id: None,
            mode: mode.to_string(),
            origin_channel: None,
            origin_channel_id: None,
        },
        None,
    )
}

#[tokio::test]
async fn tells_a_waiting_run_the_users_answer() {
    let service = ComputerHelpService::new();
    let use_ = background_use("heartbeat");
    let answer = service
        .expect_answer(&use_, &card("help-1", HelpStatus::Waiting))
        .unwrap();
    assert_eq!(service.awaiting().len(), 1);
    assert_eq!(service.awaiting()[0].help_id, "help-1");

    assert_eq!(service.answer("help-1", HelpStatus::Dismissed), 1);
    assert_eq!(answer.await.unwrap().unwrap(), HelpAnswer::Dismissed);
    assert!(service.awaiting().is_empty());
}

#[tokio::test]
async fn stops_waiting_when_its_invocation_is_canceled() {
    let service = ComputerHelpService::new();
    let use_ = background_use("webhook");
    let answer = service
        .expect_answer(&use_, &card("help-1", HelpStatus::Waiting))
        .unwrap();
    use_.controller.cancel();
    let err = answer.await.unwrap().unwrap_err();
    assert_eq!(err.to_string(), "This operation was aborted");
    assert!(service.awaiting().is_empty());
}

#[tokio::test(start_paused = true)]
async fn goes_on_without_an_answer_after_thirty_minutes() {
    let service = ComputerHelpService::new();
    let use_ = background_use("cron");
    let answer = service
        .expect_answer(&use_, &card("help-1", HelpStatus::Waiting))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(HELP_ANSWER_WAIT_MS + 1)).await;
    assert_eq!(answer.await.unwrap().unwrap(), HelpAnswer::Unanswered);
    assert!(service.awaiting().is_empty());
}

#[test]
fn takes_no_answer_for_a_run_that_does_not_wait() {
    let service = ComputerHelpService::new();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let use_ = background_use("chat");
        assert!(
            service
                .expect_answer(&use_, &card("help-1", HelpStatus::Waiting))
                .is_none()
        );
    });
}
