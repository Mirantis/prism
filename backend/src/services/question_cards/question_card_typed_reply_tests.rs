//! A typed reply and the card it closes, and a turn that ends on a card, on a
//! database built from the committed migrations, through the engine's real paths.

use std::sync::Arc;

use futures::StreamExt;
use serde_json::{Value, json};

use super::question_card_service::tests::{
    THREAD, USER, agent, agent_id, card, chat_work, rows, seed, settle, stored,
};
use crate::config::CodingAgentName;
use crate::db::models::{MessageRole, MessageTrigger};
use crate::protocol::chat_protocol::AgentMessageKind;
use crate::services::coding_agent_sign_in::coding_agent_sign_in_request_service::CODING_AGENT_SIGN_IN_REQUEST_SERVICE;
use crate::services::conversation_engine_service::{
    CONVERSATION_ENGINE_SERVICE, ChatInput, UserMessageInput,
};
use crate::services::conversation_service::{CONVERSATION_SERVICE, MessageInput};
use crate::services::inbound_message_service::{INBOUND_MESSAGE_SERVICE, InboundMessage};
use crate::services::question_cards::question_card_schema::ASK_QUESTIONS_TOOL_NAME;
use crate::types::{
    AgentMessageOrigin, InvokeRequest, InvokeStep, PromptSource, TaskNotificationOrigin,
    ToolCallRecord,
};

fn person(message: &str) -> UserMessageInput {
    UserMessageInput {
        agent_id: agent_id(),
        user_id: USER.into(),
        message: message.into(),
        ..UserMessageInput::default()
    }
}

/// The model answers each turn with these steps.
fn model(steps: Vec<InvokeStep>) {
    *crate::services::conversation_engine_service::testing::INVOKE.write() =
        Some(Arc::new(move |_: InvokeRequest| {
            futures::stream::iter(steps.clone().into_iter().map(Ok)).boxed()
        }));
}

fn asked(success: bool) -> ToolCallRecord {
    serde_json::from_value(json!({
        "tool": ASK_QUESTIONS_TOOL_NAME,
        "input": "{}",
        "output": "",
        "success": success,
        "timestamp": "2025-01-01"
    }))
    .unwrap()
}

fn step(text: &str, tool_calls: Vec<ToolCallRecord>) -> InvokeStep {
    InvokeStep {
        text: text.into(),
        tool_calls,
        ..InvokeStep::default()
    }
}

async fn chat() -> anyhow::Result<()> {
    Box::pin(CONVERSATION_ENGINE_SERVICE.chat(ChatInput {
        agent_id: agent_id(),
        user_id: USER.into(),
        message: "Budget first.".into(),
        thread_id: Some(THREAD.into()),
        ..ChatInput::default()
    }))
    .await
    .map(|_| ())
}

#[tokio::test]
#[serial_test::serial]
async fn a_typed_reply_is_stored_and_closes_the_waiting_card() {
    let _db = agent().await;
    let card_row = seed(card(json!({})), THREAD).await;

    Box::pin(CONVERSATION_ENGINE_SERVICE.accept_user_message(
        &person("Budget first."),
        THREAD,
        Some("typed-1"),
    ))
    .await
    .unwrap();

    assert_eq!(stored(&card_row).await["status"], json!("answered_in_chat"));
    assert!(rows(THREAD).await.iter().any(|row| row.id == "typed-1"));
}

#[tokio::test]
#[serial_test::serial]
async fn leaves_the_card_waiting_and_keeps_the_row_when_the_insert_fails() {
    let _db = agent().await;
    let card_row = seed(card(json!({})), THREAD).await;
    let mut taken = MessageInput::new("earlier", MessageRole::User, MessageTrigger::UserInput);
    taken.id = Some("taken".into());
    CONVERSATION_SERVICE
        .add_message(THREAD, taken)
        .await
        .unwrap();

    let failed = Box::pin(CONVERSATION_ENGINE_SERVICE.accept_user_message(
        &person("Budget first."),
        THREAD,
        Some("taken"),
    ))
    .await;

    assert!(failed.is_err());
    assert_eq!(stored(&card_row).await["status"], json!("waiting"));
    assert!(chat_work().await.iter().any(|(key, _)| key == "taken"));
}

#[tokio::test]
#[serial_test::serial]
async fn removes_the_reply_when_the_write_that_goes_with_it_fails() {
    let _db = agent().await;
    let mut row = MessageInput::new("x", MessageRole::User, MessageTrigger::UserInput);
    row.id = Some("typed-2".into());

    let failed = CONVERSATION_SERVICE
        .add_message_with(THREAD, row, |_| -> anyhow::Result<()> {
            anyhow::bail!("card write failed")
        })
        .await;

    assert_eq!(failed.unwrap_err().to_string(), "card write failed");
    assert!(!rows(THREAD).await.iter().any(|row| row.id == "typed-2"));
}

#[tokio::test]
#[serial_test::serial]
async fn leaves_a_card_waiting_on_a_message_the_runtime_wrote() {
    let _db = agent().await;
    let card_row = seed(card(json!({})), THREAD).await;

    Box::pin(CONVERSATION_ENGINE_SERVICE.accept_user_message(
        &UserMessageInput {
            runtime_written: true,
            ..person("I signed in to the example plan.")
        },
        THREAD,
        Some("continuation-1"),
    ))
    .await
    .unwrap();

    assert_eq!(stored(&card_row).await["status"], json!("waiting"));
    let work = chat_work().await;
    let (_, payload) = work
        .iter()
        .find(|(key, _)| key == "continuation-1")
        .unwrap();
    assert_eq!(payload["message"]["runtimeWritten"], json!(true));
}

#[tokio::test]
#[serial_test::serial]
async fn stores_a_task_notification_hidden_under_the_task_id_and_leaves_a_card_open() {
    let _db = agent().await;
    let card_row = seed(card(json!({})), THREAD).await;

    Box::pin(CONVERSATION_ENGINE_SERVICE.accept_user_message(
        &UserMessageInput {
            task_notification: Some(TaskNotificationOrigin {
                task_id: "task-1".into(),
            }),
            ..person("<task-notification task-id=\"task-1\">Done.</task-notification>")
        },
        THREAD,
        Some("task-1"),
    ))
    .await
    .unwrap();

    assert_eq!(stored(&card_row).await["status"], json!("waiting"));
    let row = rows(THREAD)
        .await
        .into_iter()
        .find(|row| row.id == "task-1")
        .expect("the notification is stored under the task id");
    assert_eq!(row.triggered_by, MessageTrigger::TaskNotification);
    assert!(row.internal_step);
    // A restart before the insert stores it again as a notification, not as the person's words.
    let work = chat_work().await;
    let (_, payload) = work.iter().find(|(key, _)| key == "task-1").unwrap();
    assert_eq!(
        payload["message"]["taskNotification"],
        json!({ "taskId": "task-1" })
    );
}

#[tokio::test]
#[serial_test::serial]
async fn answers_a_task_notification_in_a_turn_the_risk_gate_reads_as_the_tasks() {
    let _db = agent().await;
    let seen: Arc<parking_lot::Mutex<Vec<InvokeRequest>>> = Arc::default();
    let record = seen.clone();
    *crate::services::conversation_engine_service::testing::INVOKE.write() =
        Some(Arc::new(move |request: InvokeRequest| {
            record.lock().push(request);
            futures::stream::iter(vec![Ok(step("The task finished.", Vec::new()))]).boxed()
        }));

    Box::pin(CONVERSATION_ENGINE_SERVICE.chat(ChatInput {
        agent_id: agent_id(),
        user_id: USER.into(),
        message: "<task-notification task-id=\"task-1\">Done.</task-notification>".into(),
        thread_id: Some(THREAD.into()),
        task_notification: Some(TaskNotificationOrigin {
            task_id: "task-1".into(),
        }),
        ..ChatInput::default()
    }))
    .await
    .unwrap();

    let seen = seen.lock();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].prompt_source, Some(PromptSource::Task));
}

#[tokio::test]
#[serial_test::serial]
async fn leaves_a_card_waiting_on_another_agents_message() {
    let _db = agent().await;
    let card_row = seed(card(json!({})), THREAD).await;

    Box::pin(CONVERSATION_ENGINE_SERVICE.accept_user_message(
        &UserMessageInput {
            agent_message: Some(AgentMessageOrigin {
                kind: AgentMessageKind::Notice,
                sender_id: "a".into(),
                sender_name: "A".into(),
                message_id: "m".into(),
            }),
            ..person("A notice.")
        },
        THREAD,
        Some("delivery-9"),
    ))
    .await
    .unwrap();

    assert_eq!(stored(&card_row).await["status"], json!("waiting"));
}

#[tokio::test]
#[serial_test::serial]
async fn an_answer_message_that_the_next_boot_stores_leaves_a_newer_waiting_card_open() {
    let _db = agent().await;
    let card_row = seed(card(json!({})), THREAD).await;
    let work = INBOUND_MESSAGE_SERVICE.pending_work_for(&InboundMessage {
        id: "answer-1".into(),
        thread_id: THREAD.into(),
        content: "1. Pick? A".into(),
        attachment_ids: Vec::new(),
        sender: None,
        agent_message: None,
        runtime_written: true,
        task_notification: None,
    });
    let message = work.message.clone().unwrap();

    // As resume_replies stores a message from its row.
    Box::pin(CONVERSATION_ENGINE_SERVICE.accept_user_message(
        &UserMessageInput {
            agent_id: work.agent_id.clone(),
            user_id: work.user_id.clone(),
            metadata: work.metadata.clone(),
            message: message.message,
            attachment_ids: message.attachment_ids,
            agent_message: message.agent_message,
            runtime_written: message.runtime_written,
            task_notification: None,
            generated_ui_press: message.generated_ui_press,
        },
        &work.thread_id,
        Some("answer-1"),
    ))
    .await
    .unwrap();

    assert_eq!(stored(&card_row).await["status"], json!("waiting"));
    assert!(rows(THREAD).await.iter().any(|row| row.id == "answer-1"));
}

/// The AGENT rows of the conversation: (content, internal, tool calls).
async fn agent_rows() -> Vec<(String, bool, Option<Value>)> {
    rows(THREAD)
        .await
        .into_iter()
        .filter(|row| row.role == MessageRole::Agent)
        .map(|row| (row.content, row.internal_step, row.tool_calls))
        .collect()
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_the_tool_call_of_a_turn_that_ended_on_the_card_in_a_row_no_client_shows() {
    let _db = agent().await;
    model(vec![step("", vec![asked(true)])]);

    chat().await.unwrap();
    settle().await;

    assert_eq!(
        agent_rows().await,
        vec![(
            String::new(),
            true,
            Some(serde_json::to_value(vec![asked(true)]).unwrap())
        )]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn publishes_the_tool_only_turn_when_the_call_failed() {
    let _db = agent().await;
    model(vec![step("", vec![asked(false)])]);

    chat().await.unwrap();
    settle().await;

    let rows = agent_rows().await;
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].1);
}

#[tokio::test]
#[serial_test::serial]
async fn publishes_a_reply_the_agent_wrote_after_the_card() {
    let _db = agent().await;
    model(vec![
        step("", vec![asked(true)]),
        step("Over to you.", Vec::new()),
    ]);

    chat().await.unwrap();
    settle().await;

    let visible: Vec<String> = agent_rows()
        .await
        .into_iter()
        .filter(|(_, internal, _)| !internal)
        .map(|(content, _, _)| content)
        .collect();
    assert_eq!(visible, vec!["Over to you.".to_string()]);
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_the_row_of_a_message_that_could_not_be_stored_for_the_next_boot() {
    let _db = agent().await;

    // A conversation that does not exist refuses the insert.
    let failed = Box::pin(CONVERSATION_ENGINE_SERVICE.chat(ChatInput {
        agent_id: agent_id(),
        user_id: USER.into(),
        message: "Budget first.".into(),
        thread_id: Some("missing-thread".into()),
        ..ChatInput::default()
    }))
    .await;

    assert!(failed.is_err());
    let work = chat_work().await;
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].1["threadId"], json!("missing-thread"));
}

#[tokio::test]
#[serial_test::serial]
async fn a_sign_in_continuation_leaves_a_question_card_waiting() {
    let _db = agent().await;
    seed(
        json!({ "type": "coding_agent_sign_in", "id": "sign-in-1", "agent": "claude-code", "status": "waiting" }),
        THREAD,
    )
    .await;
    let card_row = seed(card(json!({})), THREAD).await;

    Box::pin(CODING_AGENT_SIGN_IN_REQUEST_SERVICE.signed_in(
        &agent_id(),
        USER,
        CodingAgentName::ClaudeCode,
    ))
    .await
    .unwrap();
    settle().await;

    assert_eq!(stored(&card_row).await["status"], json!("waiting"));
    let continuation = rows(THREAD)
        .await
        .into_iter()
        .find(|row| row.id == "sign-in-1")
        .unwrap();
    assert_eq!(continuation.content, "I signed in to Claude.");
}
