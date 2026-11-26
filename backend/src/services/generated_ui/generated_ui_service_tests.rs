//! Generated UI on a database built from the committed migrations: a message of its
//! own, the first press wins, and a press becomes the person's message.

use serde_json::{Value, json};

use super::*;
use crate::db::models::MessageRole;
use crate::services::question_cards::question_card_service::tests::{
    THREAD, USER, agent, agent_id, rows, seed, settle, stored,
};
use crate::support::http::testing::{app, request, send};

fn ada() -> QuestionCardPerson {
    QuestionCardPerson {
        id: "ada-id".into(),
        name: "Ada Example".into(),
    }
}

fn spec() -> Value {
    json!({
        "root": "card",
        "elements": {
            "card": { "type": "Card", "props": { "title": "Deploys" }, "children": ["fields", "choose"] },
            "fields": { "type": "Fields", "props": { "fields": [{ "label": "Failed", "value": "2" }] } },
            "choose": { "type": "Actions", "children": ["roll-back", "keep"] },
            "roll-back": { "type": "Button", "props": { "label": "Roll back", "style": "danger" } },
            "keep": { "type": "Button", "props": { "label": "Keep it" } }
        }
    })
}

/// A stored UI block with a fresh id.
fn block() -> Value {
    let parsed = parse_spec(&spec()).unwrap();
    serde_json::to_value(parsed.into_block(uuid::Uuid::new_v4().to_string())).unwrap()
}

fn caller() -> GeneratedUiCaller {
    GeneratedUiCaller {
        agent_id: agent_id(),
        user_id: USER.into(),
        thread_id: THREAD.into(),
        origin_channel: ChannelName::Websocket,
    }
}

async fn press(id: &str, element_id: &str, sender: Option<QuestionCardPerson>) -> PressOutcome {
    GENERATED_UI_SERVICE
        .press(&agent_id(), USER, id, element_id, sender)
        .await
        .unwrap()
}

fn user_rows(all: Vec<ConversationMessage>) -> Vec<ConversationMessage> {
    all.into_iter()
        .filter(|row| row.role == MessageRole::User)
        .collect()
}

#[tokio::test]
#[serial_test::serial]
async fn posts_the_ui_as_the_only_block_with_the_plain_text_as_the_message() {
    let _db = agent().await;
    let spec = GENERATED_UI_SERVICE
        .check(&caller(), &spec())
        .await
        .unwrap();
    GENERATED_UI_SERVICE
        .publish(&agent_id(), USER, THREAD, None, spec)
        .await
        .unwrap();
    let rows = rows(THREAD).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].content,
        "**Deploys**\n\nFailed: 2\n\nRoll back / Keep it"
    );
    let block = rows[0].blocks.as_ref().unwrap()[0].clone();
    assert_eq!(block["type"], "generated_ui");
    assert_eq!(block["version"], 1);
    assert!(block.get("pressed").is_none());
    assert!(uuid::Uuid::parse_str(block["id"].as_str().unwrap()).is_ok());
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_spec_with_issues_and_an_image_that_was_not_shared() {
    let _db = agent().await;
    let invalid = GENERATED_UI_SERVICE
        .check(&caller(), &json!({ "root": "x", "elements": {} }))
        .await
        .unwrap_err();
    assert!(invalid.to_string().starts_with("The UI was not shown."));
    let image = json!({
        "root": "img",
        "elements": { "img": { "type": "Image", "props": { "attachment": "attachment:6b0d6a4e-2f1c-4d8e-9c55-1e2f3a4b5c6d", "alt": "A graph" } } }
    });
    let invalid = GENERATED_UI_SERVICE
        .check(&caller(), &image)
        .await
        .unwrap_err();
    assert_eq!(invalid.issues.len(), 1);
    assert!(invalid.issues[0].contains("that you shared with share_file in this turn"));
}

#[tokio::test]
#[serial_test::serial]
async fn the_first_press_wins_and_becomes_one_message_from_that_person() {
    let _db = agent().await;
    let block = block();
    let id = block["id"].as_str().unwrap().to_string();
    let message_id = seed(block, THREAD).await;

    let outcome = press(&id, "keep", Some(ada())).await;
    settle().await;
    let PressOutcome::Pressed(pressed) = outcome else {
        panic!("not pressed: {outcome:?}");
    };
    assert_eq!(
        pressed.pressed,
        Some(GeneratedUiPress {
            element_id: "keep".into(),
            label: "Keep it".into(),
            by: Some(ada()),
        })
    );
    assert_eq!(
        stored(&message_id).await["pressed"],
        json!({ "elementId": "keep", "label": "Keep it", "by": { "id": "ada-id", "name": "Ada Example" } })
    );

    let second = press(&id, "roll-back", None).await;
    settle().await;
    let PressOutcome::Closed(closed) = second else {
        panic!("a second press was taken: {second:?}");
    };
    assert_eq!(closed.pressed.unwrap().element_id, "keep");
    let users = user_rows(rows(THREAD).await);
    assert_eq!(users.len(), 1);
    assert_eq!(users[0].content, "Keep it");
    assert_eq!(users[0].sender_external_id.as_deref(), Some("ada-id"));
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_press_on_what_is_not_a_button_and_on_an_unknown_ui() {
    let _db = agent().await;
    let block = block();
    let id = block["id"].as_str().unwrap().to_string();
    seed(block, THREAD).await;
    assert!(matches!(
        press(&id, "fields", None).await,
        PressOutcome::Invalid(_)
    ));
    assert!(matches!(
        press(&id, "nope", None).await,
        PressOutcome::Invalid(_)
    ));
    assert_eq!(press("missing", "keep", None).await, PressOutcome::NotFound);
    assert!(user_rows(rows(THREAD).await).is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn the_route_answers_each_outcome() {
    let _db = agent().await;
    let block = block();
    let id = block["id"].as_str().unwrap().to_string();
    seed(block, THREAD).await;
    let url = format!("/agents/generated-ui/{id}/press");
    let post = |body: Value| {
        let url = url.clone();
        async move {
            send(
                app(crate::routes::generated_ui::router()),
                request("POST", &url, Some(body)),
            )
            .await
        }
    };

    assert_eq!(post(json!({})).await.status, 400);
    assert_eq!(post(json!({ "elementId": "fields" })).await.status, 400);
    let taken = post(json!({ "elementId": "roll-back" })).await;
    settle().await;
    assert_eq!(taken.status, 200);
    assert_eq!(taken.json()["ui"]["pressed"]["label"], "Roll back");
    assert_eq!(taken.json()["ui"]["pressed"]["by"], Value::Null);
    let again = post(json!({ "elementId": "keep" })).await;
    assert_eq!(again.status, 409);
    assert_eq!(again.json()["ui"]["pressed"]["elementId"], "roll-back");
    let missing = send(
        app(crate::routes::generated_ui::router()),
        request(
            "POST",
            "/agents/generated-ui/missing/press",
            Some(json!({ "elementId": "keep" })),
        ),
    )
    .await;
    assert_eq!(missing.status, 404);
}
