//! A turn that calls `show_ui`, through the engine's real paths: the UI is a
//! message of its own, after the text of the step that called it.

use std::sync::Arc;

use diesel::prelude::*;
use futures::StreamExt;
use serde_json::{Value, json};

use crate::db::models::NewMessageAttachment;
use crate::db::models::{ConversationMessage, MessageRole};
use crate::db::schema::{agent_workspaces, message_attachments};
use crate::services::conversation_engine_service::{CONVERSATION_ENGINE_SERVICE, ChatInput};
use crate::services::question_cards::question_card_service::tests::{
    THREAD, USER, agent, agent_id, rows,
};
use crate::types::{InvokeRequest, InvokeStep, ToolCallRecord};

use super::generated_ui_schema::is_generated_ui;

fn model(steps: Vec<InvokeStep>) {
    *crate::services::conversation_engine_service::testing::INVOKE.write() =
        Some(Arc::new(move |_: InvokeRequest| {
            futures::stream::iter(steps.clone().into_iter().map(Ok)).boxed()
        }));
}

fn spec() -> Value {
    json!({
        "root": "card",
        "elements": {
            "card": { "type": "Card", "props": { "title": "Deploys" }, "children": ["table"] },
            "table": { "type": "Table", "props": { "columns": ["Day", "Count"], "rows": [["Mon", "3"]] } }
        }
    })
}

fn shown(success: bool) -> ToolCallRecord {
    serde_json::from_value(json!({
        "tool": "show_ui",
        "input": spec().to_string(),
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

async fn chat() {
    Box::pin(CONVERSATION_ENGINE_SERVICE.chat(ChatInput {
        agent_id: agent_id(),
        user_id: USER.into(),
        message: "How did deploys go?".into(),
        thread_id: Some(THREAD.into()),
        ..ChatInput::default()
    }))
    .await
    .unwrap();
}

async fn set_verbose(verbose: bool) {
    crate::db::run(move |conn| {
        diesel::update(agent_workspaces::table)
            .set(agent_workspaces::verbose.eq(verbose))
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
}

/// The agent's rows, as (shown to clients, is the UI, content).
fn agent_rows(all: Vec<ConversationMessage>) -> Vec<(bool, bool, String)> {
    all.into_iter()
        .filter(|row| row.role == MessageRole::Agent)
        .map(|row| {
            (
                !row.internal_step,
                is_generated_ui(row.blocks.as_ref()),
                row.content,
            )
        })
        .collect()
}

#[tokio::test]
#[serial_test::serial]
async fn in_verbose_mode_the_ui_shows_after_the_text_of_its_step_and_before_later_text() {
    let _db = agent().await;
    set_verbose(true).await;
    model(vec![
        step("Here is the week.", vec![shown(true)]),
        step("Monday was the busiest.", vec![]),
    ]);
    chat().await;
    let rows = agent_rows(rows(THREAD).await);
    assert_eq!(
        rows,
        vec![
            (true, false, "Here is the week.".to_string()),
            (
                true,
                true,
                "**Deploys**\n\n| Day | Count |\n| --- | --- |\n| Mon | 3 |".to_string()
            ),
            (true, false, "Monday was the busiest.".to_string()),
        ]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn in_concise_mode_the_person_sees_the_text_before_the_ui_the_ui_and_the_final_reply() {
    let _db = agent().await;
    model(vec![
        step("Let me draw it.", vec![shown(true)]),
        step("Monday was the busiest.", vec![]),
    ]);
    chat().await;
    let shown_rows: Vec<(bool, bool, String)> = agent_rows(rows(THREAD).await)
        .into_iter()
        .filter(|(visible, _, _)| *visible)
        .collect();
    assert_eq!(shown_rows.len(), 3);
    assert_eq!(shown_rows[0].2, "Let me draw it.");
    assert!(shown_rows[1].1, "the UI comes after its text");
    assert_eq!(shown_rows[2].2, "Monday was the busiest.");
}

#[tokio::test]
#[serial_test::serial]
async fn in_concise_mode_the_text_before_the_ui_shows_when_the_last_step_is_empty() {
    let _db = agent().await;
    model(vec![
        step(
            "Wednesday frees the most time. Here are the three slots.",
            vec![shown(true)],
        ),
        step("", vec![]),
    ]);
    chat().await;
    let shown_rows: Vec<(bool, bool, String)> = agent_rows(rows(THREAD).await)
        .into_iter()
        .filter(|(visible, _, _)| *visible)
        .collect();
    assert_eq!(shown_rows.len(), 2);
    assert_eq!(
        shown_rows[0].2,
        "Wednesday frees the most time. Here are the three slots."
    );
    assert!(shown_rows[1].1, "the UI comes after its text");
}

#[tokio::test]
#[serial_test::serial]
async fn a_file_shared_earlier_goes_out_when_the_turn_ends_on_the_ui() {
    let _db = agent().await;
    let mut file = NewMessageAttachment::new("report.csv", "text/csv", 3, "text", "agent");
    file.id = "att-report".into();
    file.thread_id = Some(THREAD.into());
    file.data = Some(b"a,b".to_vec());
    crate::db::run(move |conn| {
        diesel::insert_into(message_attachments::table)
            .values(&file)
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
    let shared: ToolCallRecord = serde_json::from_value(json!({
        "tool": "share_file",
        "input": "{\"path\":\"report.csv\"}",
        "output": "",
        "success": true,
        "timestamp": "2025-01-01"
    }))
    .unwrap();
    model(vec![
        InvokeStep {
            attachment_ids: Some(vec!["att-report".into()]),
            ..step("", vec![shared])
        },
        step("Here is the report.", vec![shown(true)]),
        step("", vec![]),
    ]);
    chat().await;
    let all = rows(THREAD).await;
    let linked: Option<String> = crate::db::run(|conn| {
        Ok(message_attachments::table
            .find("att-report")
            .select(message_attachments::message_id)
            .first::<Option<String>>(conn)?)
    })
    .await
    .unwrap();
    let holder = all
        .iter()
        .find(|row| Some(&row.id) == linked.as_ref())
        .expect("the file is linked to a message");
    assert_eq!(holder.role, MessageRole::Agent);
    assert!(!holder.internal_step, "the person sees the file");
}

#[tokio::test]
#[serial_test::serial]
async fn a_turn_that_ends_on_the_ui_keeps_its_call_and_shows_nothing_empty() {
    let _db = agent().await;
    set_verbose(true).await;
    model(vec![step("", vec![shown(true)])]);
    chat().await;
    let all = rows(THREAD).await;
    let agent: Vec<&ConversationMessage> = all
        .iter()
        .filter(|row| row.role == MessageRole::Agent)
        .collect();
    assert_eq!(agent.len(), 2);
    assert!(is_generated_ui(agent[0].blocks.as_ref()));
    assert!(agent[1].internal_step, "the call's row is hidden");
    assert!(
        agent[1]
            .tool_calls
            .as_ref()
            .unwrap()
            .to_string()
            .contains("show_ui")
    );
}

#[tokio::test]
#[serial_test::serial]
async fn a_failed_call_shows_no_ui() {
    let _db = agent().await;
    model(vec![
        step("", vec![shown(false)]),
        step("Here it is in words.", vec![]),
    ]);
    chat().await;
    assert!(
        !rows(THREAD)
            .await
            .iter()
            .any(|row| is_generated_ui(row.blocks.as_ref()))
    );
}
