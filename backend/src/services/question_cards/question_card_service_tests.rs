//! Question cards on a database built from the committed migrations: one waiting
//! card per conversation, the first answer wins, and a person's words close it.

use std::sync::Arc;
use std::time::Duration;

use diesel::prelude::*;
use futures::StreamExt;
use serde_json::{Value, json};

use super::*;
use crate::config::CONFIG;
use crate::db::models::{
    MessageRole, NewAgentWorkspace, NewConversationMessage, NewConversationThread,
};
use crate::db::schema::agent_workspaces;
use crate::support::http::testing::{request, send};
use crate::tools::ask_questions::get_ask_questions_tools;
use crate::types::{InvokeRequest, InvokeStep};

pub(crate) const USER: &str = "user-1";
pub(crate) const THREAD: &str = "6f1d3c2a-9b8e-4c7d-a6f5-0e1d2c3b4a59";

fn ada() -> QuestionCardPerson {
    QuestionCardPerson {
        id: "ada-id".into(),
        name: "Ada Example".into(),
    }
}

fn grace() -> QuestionCardPerson {
    QuestionCardPerson {
        id: "grace-id".into(),
        name: "Grace Example".into(),
    }
}

fn questions() -> Value {
    json!([
        { "text": "Budget?", "options": [{ "label": "Low" }, { "label": "High" }], "allowOther": true, "multiSelect": false },
        { "text": "Channels?", "options": [{ "label": "Mail" }, { "label": "Web" }], "allowOther": false, "multiSelect": true }
    ])
}

/// A waiting card with a fresh id, with `over` merged in.
pub(crate) fn card(over: Value) -> Value {
    let mut card = json!({
        "type": "question_card",
        "id": uuid::Uuid::new_v4().to_string(),
        "status": "waiting",
        "questions": questions(),
        "otherMaxLength": 500
    });
    for (key, value) in over.as_object().unwrap() {
        card[key] = value.clone();
    }
    card
}

/// A fresh database with the agent and its conversation, and no model behind a turn.
pub(crate) async fn agent() -> crate::db::testing::TestDb {
    let db = crate::db::testing::test_db();
    INBOUND_MESSAGE_SERVICE.reset_for_tests();
    *crate::services::conversation_engine_service::testing::INVOKE.write() =
        Some(Arc::new(|_: InvokeRequest| {
            futures::stream::empty().boxed()
        }));
    *crate::services::thread_title_service::testing::GENERATE.write() =
        Some(Arc::new(|_: &str| None));
    let agent_id = crate::db::run(|conn| {
        let agent = NewAgentWorkspace::new(USER, "", "", "", "", "");
        diesel::insert_into(agent_workspaces::table)
            .values(&agent)
            .execute(conn)?;
        let mut thread = NewConversationThread::new(agent.id.clone(), USER);
        thread.id = THREAD.into();
        diesel::insert_into(conversation_threads::table)
            .values(&thread)
            .execute(conn)?;
        Ok(agent.id)
    })
    .await
    .unwrap();
    CONFIG.set_agent_id(Some(agent_id));
    CONFIG.set_owner_user_id(USER.to_string());
    db
}

pub(crate) fn agent_id() -> String {
    CONFIG.agent_id().unwrap()
}

pub(crate) async fn seed(block: Value, thread_id: &str) -> String {
    let mut row = NewConversationMessage::new(
        thread_id,
        MessageRole::Agent,
        "text",
        MessageTrigger::UserInput,
    );
    row.blocks = Some(json!([block]));
    crate::db::run(move |conn| {
        diesel::insert_into(conversation_messages::table)
            .values(&row)
            .execute(conn)?;
        Ok(row.id)
    })
    .await
    .unwrap()
}

pub(crate) async fn rows(thread_id: &str) -> Vec<ConversationMessage> {
    let thread_id = thread_id.to_string();
    crate::db::run(move |conn| {
        Ok(conversation_messages::table
            .filter(conversation_messages::thread_id.eq(thread_id))
            .order(conversation_messages::created_at.asc())
            .select(ConversationMessage::as_select())
            .load(conn)?)
    })
    .await
    .unwrap()
}

pub(crate) async fn stored(message_id: &str) -> Value {
    let id = message_id.to_string();
    let blocks: Option<Value> = crate::db::run(move |conn| {
        Ok(conversation_messages::table
            .find(id)
            .select(conversation_messages::blocks)
            .first(conn)?)
    })
    .await
    .unwrap();
    blocks.unwrap()[0].clone()
}

pub(crate) async fn chat_work() -> Vec<(String, Value)> {
    PENDING_WORK_SERVICE.flush().await;
    PENDING_WORK_SERVICE
        .rows(PendingWorkKind::Chat)
        .await
        .unwrap()
        .into_iter()
        .map(|row| (row.key, row.payload))
        .collect()
}

/// Waits for the turns the answers started to end.
pub(crate) async fn settle() {
    for _ in 0..200 {
        if chat_work().await.is_empty() && INBOUND_MESSAGE_SERVICE.turns().is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the turn did not end");
}

fn caller() -> QuestionCardCaller {
    QuestionCardCaller {
        agent_id: agent_id(),
        user_id: USER.into(),
        thread_id: THREAD.into(),
        origin_channel: Some(ChannelName::Websocket),
        origin_channel_id: None,
    }
}

fn input(intro: Option<&str>) -> AskQuestionsInput {
    serde_json::from_value(json!({ "intro": intro, "questions": questions() })).unwrap()
}

fn answers(value: Value) -> Vec<QuestionCardAnswer> {
    serde_json::from_value(value).unwrap()
}

fn valid() -> Vec<QuestionCardAnswer> {
    answers(json!([{ "options": [1] }, { "options": [] }]))
}

async fn answer(
    id: &str,
    given: Vec<QuestionCardAnswer>,
    sender: Option<QuestionCardPerson>,
) -> AnswerOutcome {
    QUESTION_CARD_SERVICE
        .answer(&agent_id(), USER, id, &given, sender)
        .await
        .unwrap()
}

fn card_id(card: &Value) -> String {
    card["id"].as_str().unwrap().to_string()
}

#[tokio::test]
#[serial_test::serial]
async fn publishes_one_card_as_the_only_block_with_the_plain_text_as_the_message() {
    let _db = agent().await;
    let posted = QUESTION_CARD_SERVICE
        .post(&caller(), input(Some("Two decisions.")))
        .await
        .unwrap();
    let rows = rows(THREAD).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].triggered_by, MessageTrigger::UserInput);
    assert!(rows[0].content.starts_with("Two decisions.\n\n1. Budget?"));
    assert_eq!(rows[0].blocks, Some(json!([posted])));
    assert_eq!(posted.status, QuestionCardStatus::Waiting);
    assert_eq!(posted.other_max_length, 500);
    assert_eq!(posted.intro.as_deref(), Some("Two decisions."));
}

#[tokio::test]
#[serial_test::serial]
async fn stores_no_intro_field_without_one() {
    let _db = agent().await;
    let blank = QUESTION_CARD_SERVICE
        .post(&caller(), input(Some("")))
        .await
        .unwrap();
    assert!(serde_json::to_value(&blank).unwrap().get("intro").is_none());
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_new_card_while_one_waits_in_the_conversation() {
    let _db = agent().await;
    QUESTION_CARD_SERVICE
        .post(&caller(), input(None))
        .await
        .unwrap();
    let refused = QUESTION_CARD_SERVICE.post(&caller(), input(None)).await;
    assert!(
        refused
            .unwrap_err()
            .downcast_ref::<QuestionCardWaitingError>()
            .is_some()
    );
    assert_eq!(rows(THREAD).await.len(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn fails_the_tool_call_with_the_reason_while_a_card_waits() {
    let _db = agent().await;
    let tools = get_ask_questions_tools(
        USER,
        &agent_id(),
        Some(THREAD),
        ChannelName::Websocket,
        None,
    );
    let tool = &tools["ask_questions"];
    let run = || {
        let parsed = tool
            .input_schema
            .validate(&json!({ "questions": questions() }))
            .unwrap();
        (tool.execute.as_ref().unwrap())(parsed, Default::default())
    };
    run().await.unwrap();
    let error = run().await.unwrap_err();
    assert!(error.to_string().contains("already waits"));
    assert_eq!(rows(THREAD).await.len(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_the_second_of_two_calls_in_one_step() {
    let _db = agent().await;
    let caller = caller();
    let (first, second) = tokio::join!(
        QUESTION_CARD_SERVICE.post(&caller, input(None)),
        QUESTION_CARD_SERVICE.post(&caller, input(None)),
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert_eq!(rows(THREAD).await.len(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn posts_again_once_the_earlier_card_has_closed() {
    let _db = agent().await;
    seed(card(json!({ "status": "answered_in_chat" })), THREAD).await;
    QUESTION_CARD_SERVICE
        .post(&caller(), input(None))
        .await
        .unwrap();
    assert_eq!(rows(THREAD).await.len(), 2);
}

#[tokio::test]
#[serial_test::serial]
async fn stores_the_answers_and_who_sent_them_and_accepts_one_message_from_that_person() {
    let _db = agent().await;
    let block = card(json!({}));
    let message_id = seed(block.clone(), THREAD).await;

    let outcome = answer(
        &card_id(&block),
        answers(json!([{ "options": [0] }, { "options": [1, 0] }])),
        Some(ada()),
    )
    .await;
    settle().await;

    let AnswerOutcome::Answered(answered) = outcome else {
        panic!("not answered: {outcome:?}");
    };
    assert_eq!(answered.status, QuestionCardStatus::Answered);
    assert_eq!(answered.answered_by, Some(Some(ada())));
    let card = stored(&message_id).await;
    assert_eq!(card["status"], json!("answered"));
    assert_eq!(
        card["answers"],
        json!([{ "options": [0] }, { "options": [0, 1] }])
    );
    assert_eq!(
        card["answeredBy"],
        json!({ "id": "ada-id", "name": "Ada Example" })
    );
    let users: Vec<ConversationMessage> = rows(THREAD)
        .await
        .into_iter()
        .filter(|row| row.role == MessageRole::User)
        .collect();
    assert_eq!(users.len(), 1);
    assert_eq!(users[0].content, "1. Budget? Low\n2. Channels? Mail, Web");
    assert_eq!(users[0].sender_external_id.as_deref(), Some("ada-id"));
    assert_eq!(users[0].sender_name.as_deref(), Some("Ada Example"));
}

#[tokio::test]
#[serial_test::serial]
async fn writes_the_pending_work_row_of_the_answer_message_with_the_card_marked_as_written_by_the_runtime()
 {
    let _db = agent().await;
    let release = Arc::new(tokio::sync::Notify::new());
    let held = Arc::clone(&release);
    *crate::services::conversation_engine_service::testing::INVOKE.write() =
        Some(Arc::new(move |_: InvokeRequest| {
            let held = Arc::clone(&held);
            futures::stream::once(async move {
                held.notified().await;
                Ok(InvokeStep::default())
            })
            .filter(|_| async { false })
            .boxed()
        }));
    let block = card(json!({}));
    seed(block.clone(), THREAD).await;

    answer(&card_id(&block), valid(), Some(ada())).await;

    let work = chat_work().await;
    assert_eq!(work.len(), 1);
    let user = rows(THREAD)
        .await
        .into_iter()
        .find(|row| row.role == MessageRole::User)
        .unwrap();
    assert_eq!(work[0].0, user.id);
    assert_eq!(work[0].1["threadId"], json!(THREAD));
    assert_eq!(
        work[0].1["message"],
        json!({ "message": "1. Budget? High\n2. Channels? no answer", "attachmentIds": [], "runtimeWritten": true })
    );
    release.notify_one();
    settle().await;
}

#[tokio::test]
#[serial_test::serial]
async fn answers_reply_pending_and_keeps_the_row_for_the_next_boot_when_the_message_cannot_be_accepted()
 {
    let _db = agent().await;
    let block = card(json!({}));
    let message_id = seed(block.clone(), THREAD).await;
    let agent = agent_id();
    // The message service takes nothing while the agent is starting.
    CONFIG.set_agent_id(None);

    let outcome = QUESTION_CARD_SERVICE
        .answer(&agent, USER, &card_id(&block), &valid(), Some(ada()))
        .await
        .unwrap();

    assert!(
        matches!(outcome, AnswerOutcome::ReplyPending(ref card) if card.status == QuestionCardStatus::Answered)
    );
    assert_eq!(stored(&message_id).await["status"], json!("answered"));
    assert_eq!(chat_work().await.len(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn lets_the_first_answer_win_when_two_arrive_together() {
    let _db = agent().await;
    let block = card(json!({}));
    let message_id = seed(block.clone(), THREAD).await;
    let id = card_id(&block);

    let (first, second) = tokio::join!(
        answer(
            &id,
            answers(json!([{ "options": [0] }, { "options": [] }])),
            Some(grace())
        ),
        answer(&id, valid(), Some(ada())),
    );
    settle().await;

    let final_card = parse_question_card(&stored(&message_id).await).unwrap();
    let outcomes = [first, second];
    let answered: Vec<_> = outcomes
        .iter()
        .filter(|outcome| matches!(outcome, AnswerOutcome::Answered(_)))
        .collect();
    assert_eq!(answered.len(), 1);
    assert!(outcomes.contains(&AnswerOutcome::Closed(final_card.clone())));
    assert_eq!(*answered[0], AnswerOutcome::Answered(final_card));
    let users = rows(THREAD)
        .await
        .into_iter()
        .filter(|row| row.role == MessageRole::User)
        .count();
    assert_eq!(users, 1);
}

#[tokio::test]
#[serial_test::serial]
async fn changes_nothing_on_a_closed_card() {
    let _db = agent().await;
    for status in ["answered", "answered_in_chat"] {
        let block = card(json!({
            "status": status,
            "answers": [{ "options": [0] }, { "options": [] }],
            "answeredBy": { "id": "ada-id", "name": "Ada Example" }
        }));
        let message_id = seed(block.clone(), THREAD).await;
        let outcome = answer(&card_id(&block), valid(), Some(grace())).await;
        assert_eq!(
            outcome,
            AnswerOutcome::Closed(parse_question_card(&block).unwrap())
        );
        assert_eq!(stored(&message_id).await, block);
    }
    assert!(
        !rows(THREAD)
            .await
            .iter()
            .any(|row| row.role == MessageRole::User)
    );
}

#[tokio::test]
#[serial_test::serial]
async fn collapses_line_breaks_in_other_so_that_a_question_stays_one_line() {
    let _db = agent().await;
    let block = card(json!({}));
    let message_id = seed(block.clone(), THREAD).await;
    answer(
        &card_id(&block),
        answers(json!([{ "options": [], "other": "first\r\n  second" }, { "options": [] }])),
        Some(ada()),
    )
    .await;
    settle().await;
    assert_eq!(
        stored(&message_id).await["answers"][0]["other"],
        json!("first second")
    );
    let user = rows(THREAD)
        .await
        .into_iter()
        .find(|row| row.role == MessageRole::User)
        .unwrap();
    assert!(user.content.contains("Budget? first second"));
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_answers_that_do_not_fit_and_leaves_the_card_waiting() {
    let _db = agent().await;
    let cases = [
        ("too few answers", json!([{ "options": [0] }])),
        (
            "an option that does not exist",
            json!([{ "options": [2] }, { "options": [] }]),
        ),
        (
            "two choices on a single-select question",
            json!([{ "options": [0, 1] }, { "options": [] }]),
        ),
        (
            "an option and Other on a single-select question",
            json!([{ "options": [0], "other": "mine" }, { "options": [] }]),
        ),
        (
            "Other where the question takes none",
            json!([{ "options": [0] }, { "options": [], "other": "mine" }]),
        ),
        (
            "nothing answered",
            json!([{ "options": [] }, { "options": [] }]),
        ),
        (
            "only an empty Other",
            json!([{ "options": [], "other": "" }, { "options": [] }]),
        ),
    ];
    for (name, given) in cases {
        let block = card(json!({}));
        let message_id = seed(block.clone(), THREAD).await;
        let outcome = answer(&card_id(&block), answers(given), Some(ada())).await;
        assert!(
            matches!(outcome, AnswerOutcome::Invalid(_)),
            "accepts {name}"
        );
        assert_eq!(stored(&message_id).await["status"], json!("waiting"));
    }
    assert!(
        !rows(THREAD)
            .await
            .iter()
            .any(|row| row.role == MessageRole::User)
    );
}

#[tokio::test]
#[serial_test::serial]
async fn records_a_null_answered_by_when_the_request_names_nobody() {
    let _db = agent().await;
    let block = card(json!({}));
    let message_id = seed(block.clone(), THREAD).await;
    answer(&card_id(&block), valid(), None).await;
    settle().await;
    let card = stored(&message_id).await;
    assert_eq!(card.get("answeredBy"), Some(&Value::Null));
}

#[tokio::test]
#[serial_test::serial]
async fn finds_no_card_with_an_unknown_id_a_malformed_block_or_a_conversation_clients_cannot_see() {
    let _db = agent().await;
    assert_eq!(answer("nope", valid(), None).await, AnswerOutcome::NotFound);

    seed(
        json!({ "type": "question_card", "id": "forged", "status": "waiting", "questions": "none" }),
        THREAD,
    )
    .await;
    assert_eq!(
        answer("forged", valid(), None).await,
        AnswerOutcome::NotFound
    );

    // A channel's thread, which no web client can see.
    let hidden_thread = crate::db::run(|conn| {
        let mut thread = NewConversationThread::new(agent_id(), USER);
        thread.external_thread_id = Some("C1:1700000000.000100".into());
        thread.thread_source = crate::db::models::ThreadSource::Slack;
        diesel::insert_into(conversation_threads::table)
            .values(&thread)
            .execute(conn)?;
        Ok(thread.id)
    })
    .await
    .unwrap();
    let hidden = card(json!({}));
    seed(hidden.clone(), &hidden_thread).await;
    assert_eq!(
        answer(&card_id(&hidden), valid(), None).await,
        AnswerOutcome::NotFound
    );
}

#[tokio::test]
#[serial_test::serial]
async fn closes_the_waiting_card_in_chat_and_leaves_a_closed_one_and_another_conversation_alone() {
    let _db = agent().await;
    let other_thread = crate::db::run(|conn| {
        let thread = NewConversationThread::new(agent_id(), USER);
        diesel::insert_into(conversation_threads::table)
            .values(&thread)
            .execute(conn)?;
        Ok(thread.id)
    })
    .await
    .unwrap();
    let waiting = seed(card(json!({})), THREAD).await;
    let closed = card(json!({
        "status": "answered",
        "answers": [{ "options": [1] }, { "options": [] }],
        "answeredBy": { "id": "ada-id", "name": "Ada Example" }
    }));
    let closed_id = seed(closed.clone(), THREAD).await;
    let elsewhere = seed(card(json!({})), &other_thread).await;

    let closed_cards = crate::db::run(|conn| {
        conn.transaction(|conn| QUESTION_CARD_SERVICE.close_waiting_in_chat(conn, THREAD))
    })
    .await
    .unwrap();
    assert_eq!(closed_cards.len(), 1);
    QUESTION_CARD_SERVICE
        .show_closed_in_chat(&agent_id(), USER, closed_cards)
        .await;

    assert_eq!(stored(&waiting).await["status"], json!("answered_in_chat"));
    assert!(stored(&waiting).await.get("answers").is_none());
    assert_eq!(stored(&closed_id).await, closed);
    assert_eq!(stored(&elsewhere).await["status"], json!("waiting"));
}

#[tokio::test]
#[serial_test::serial]
async fn the_route_takes_the_answers_and_names_the_sender_from_the_ingress_headers() {
    let _db = agent().await;
    let block = card(json!({}));
    seed(block.clone(), THREAD).await;
    let url = format!("/agents/question-cards/{}/answer", card_id(&block));
    let mut req = request(
        "POST",
        &url,
        Some(json!({ "answers": [{ "options": [0] }, { "options": [] }] })),
    );
    req.headers_mut().insert(
        "x-forwarded-user-id",
        http::HeaderValue::from_static("ada-id"),
    );
    req.headers_mut().insert(
        "x-forwarded-user-display-name",
        http::HeaderValue::from_static("%C3%85da%20Example"),
    );

    let res = send(
        crate::support::http::testing::app(crate::routes::question_cards::router()),
        req,
    )
    .await;
    settle().await;

    assert_eq!(res.status, 200);
    assert_eq!(res.json()["card"]["status"], json!("answered"));
    assert_eq!(
        res.json()["card"]["answeredBy"],
        json!({ "id": "ada-id", "name": "Åda Example" })
    );
    assert_eq!(res.json().as_object().unwrap().len(), 1);

    // A second answer gets the stored card.
    let again = crate::support::http::testing::call(
        crate::routes::question_cards::router(),
        "POST",
        &url,
        Some(json!({ "answers": [{ "options": [1] }, { "options": [] }] })),
    )
    .await;
    assert_eq!(again.status, 409);
    assert_eq!(again.json()["card"], res.json()["card"]);
    assert!(again.json()["error"].is_string());
}

#[tokio::test]
#[serial_test::serial]
async fn the_route_answers_each_refusal_with_its_status() {
    let _db = agent().await;
    async fn call(url: String, body: Value) -> crate::support::http::testing::TestResponse {
        crate::support::http::testing::call(
            crate::routes::question_cards::router(),
            "POST",
            &url,
            Some(body),
        )
        .await
    }
    let body = json!({ "answers": [{ "options": [0] }, { "options": [] }] });

    let missing = call("/agents/question-cards/nope/answer".into(), body.clone()).await;
    assert_eq!(missing.status, 404);

    let block = card(json!({}));
    seed(block.clone(), THREAD).await;
    let url = format!("/agents/question-cards/{}/answer", card_id(&block));
    let invalid = call(
        url.clone(),
        json!({ "answers": [{ "options": [5] }, { "options": [] }] }),
    )
    .await;
    assert_eq!(invalid.status, 400);
    assert_eq!(
        invalid.json()["error"],
        json!("That option does not exist.")
    );

    let malformed = call(url.clone(), json!({ "answers": [] })).await;
    assert_eq!(malformed.status, 400);
    assert_eq!(
        malformed.json()["error"],
        json!("Those answers do not fit the card.")
    );

    CONFIG.set_agent_id(None);
    assert_eq!(call(url, body).await.status, 503);
    assert_eq!(
        stored(&rows(THREAD).await[0].id).await["status"],
        json!("waiting")
    );
}

#[test]
fn counts_answers_in_telemetry_and_never_names_their_text() {
    let answers =
        answers(json!([{ "options": [], "other": "my private answer text" }, { "options": [] }]));
    let props = answer_counts(&answers);
    assert_eq!(
        serde_json::to_value(&props).unwrap(),
        json!({ "answered": "1", "blank": "1", "other": "1" })
    );
}
