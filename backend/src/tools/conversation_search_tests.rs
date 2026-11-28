use chrono::{DateTime, TimeZone, Utc};

use super::*;
use crate::services::conversation_search_service::SearchMatch;

fn at() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-10-01T09:00:00.000Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn message(
    role: MessageRole,
    content: &str,
    tool_calls: Option<Value>,
    position: i64,
) -> HistoryMessage {
    HistoryMessage {
        id: format!("m-{position}"),
        role,
        content: content.to_string(),
        tool_calls,
        internal_step: false,
        sender_name: None,
        created_at: at(),
        position,
    }
}

fn page(messages: Vec<HistoryMessage>, more: bool) -> HistoryPage {
    HistoryPage { messages, more }
}

#[test]
fn the_definition_matches_the_fixture() {
    let tools = get_conversation_search_tools(ConversationSearchToolsInput::default());
    crate::tools::schema_fixture::assert_matches_fixture("conversation-search", &tools);
}

#[test]
fn reads_one_page_with_its_tool_calls() {
    let listed = page(
        vec![
            message(MessageRole::User, "Deploy to staging.", None, 31),
            message(
                MessageRole::Agent,
                "It failed.",
                Some(json!([{
                    "tool": "shell_exec",
                    "input": { "command": "kubectl get pods" },
                    "output": "CrashLoopBackOff",
                    "rendered": true
                }])),
                32,
            ),
        ],
        true,
    );

    let result = page_result(&listed, 31, None);

    assert_eq!(
        result,
        json!({
            "messages": [
                { "position": 31, "from": "user", "at": "2026-10-01T09:00:00.000Z", "text": "Deploy to staging." },
                {
                    "position": 32,
                    "from": "you",
                    "at": "2026-10-01T09:00:00.000Z",
                    "text": "It failed.",
                    "toolCalls": [{ "tool": "shell_exec", "input": { "command": "kubectl get pods" }, "output": "CrashLoopBackOff" }]
                }
            ],
            "nextOffset": 33
        })
    );
}

#[test]
fn labels_recalled_context_and_names_a_person_in_a_channel() {
    let mut recalled = message(MessageRole::User, "<recalled-memories>", None, 0);
    recalled.internal_step = true;
    let mut person = message(MessageRole::User, "<@U1:Dana>: ship it", None, 1);
    person.sender_name = Some("Dana".into());

    let result = page_result(&page(vec![recalled, person], false), 0, None);

    assert_eq!(result["messages"][0]["from"], "context");
    assert!(result["messages"][0].get("name").is_none());
    assert_eq!(result["messages"][1]["from"], "user");
    assert_eq!(result["messages"][1]["name"], "Dana");
    assert!(result.get("nextOffset").is_none());
}

#[test]
fn stops_a_page_before_the_tool_budget_and_points_to_the_first_message_left_out() {
    let big = "x".repeat(1_800);
    let messages = (0..20)
        .map(|i| {
            message(
                MessageRole::Agent,
                "step",
                Some(json!([{ "tool": "shell_exec", "input": {}, "output": big }])),
                i,
            )
        })
        .collect();

    let result = page_result(&page(messages, false), 0, None);
    let shown = result["messages"].as_array().unwrap().len();

    assert!(shown < 20);
    assert!(len16(&stringify(&result["messages"])) <= 20_000);
    assert_eq!(result["nextOffset"], json!(shown));
}

#[test]
fn cuts_a_long_message_text_and_a_long_tool_input_too() {
    let long = message(
        MessageRole::Agent,
        &"z".repeat(40_000),
        Some(json!([{
            "tool": "shell_write",
            "input": { "path": "a", "content": "w".repeat(40_000) },
            "output": "ok"
        }])),
        0,
    );

    let result = page_result(&page(vec![long], false), 0, None);

    assert!(len16(&stringify(&result)) < 6_000);
}

#[test]
fn cuts_a_long_tool_result_inside_a_page() {
    let long = message(
        MessageRole::Agent,
        "",
        Some(json!([{ "tool": "t", "output": "y".repeat(5_000) }])),
        7,
    );

    let result = page_result(&page(vec![long], false), 0, None);

    assert_eq!(
        result["messages"][0]["toolCalls"][0]["output"],
        json!(format!(
            "{}\n[Cut: 2000 of 5000 characters shown. Call with position 7 to read this message in full.]",
            "y".repeat(2000)
        ))
    );
}

#[test]
fn reads_one_message_in_full_a_page_at_a_time() {
    let output = "z".repeat(30_000);
    let build = message(
        MessageRole::Agent,
        "Ran the build.",
        Some(
            json!([{ "tool": "shell_exec", "input": "{\"command\":\"make\"}", "output": output }]),
        ),
        12,
    );

    let first = message_part(Some(&build), 12, 0, None);
    assert_eq!(first["position"], 12);
    assert_eq!(first["from"], "you");
    assert_eq!(first["start"], 0);
    assert_eq!(first["nextStart"], 20_000);
    assert!(first["text"].as_str().unwrap().starts_with(
        "Ran the build.\n\n[Tool call: shell_exec]\n\n[Input]\n{\"command\":\"make\"}\n\n[Output]\n"
    ));

    let second = message_part(Some(&build), 12, 20_000, None);
    let total = first["characters"].as_u64().unwrap() as usize;
    assert_eq!(second["start"], 20_000);
    assert_eq!(second["characters"], json!(total));
    assert!(second.get("nextStart").is_none());
    assert_eq!(
        len16(first["text"].as_str().unwrap()) + len16(second["text"].as_str().unwrap()),
        total
    );
}

#[test]
fn says_when_no_message_has_the_position_or_the_page_is_empty() {
    assert_eq!(
        message_part(None, 99, 0, None),
        json!({ "note": "No message at position 99." })
    );
    assert_eq!(
        page_result(&page(vec![], false), 0, None),
        json!({ "messages": [], "note": "The conversation has no messages." })
    );
    assert_eq!(
        page_result(&page(vec![], false), 20, None),
        json!({ "messages": [], "note": "No more messages." })
    );
}

#[test]
fn writes_a_missing_tool_name_as_javascript_does() {
    let unnamed = message(MessageRole::Agent, "x", Some(json!([{ "output": 3 }])), 0);
    assert_eq!(
        full_text(&unnamed, None),
        "x\n\n[Tool call: undefined]\n\n[Input]\nnull\n\n[Output]\n3"
    );
}

#[test]
fn reads_a_date_a_time_and_a_span_back_from_now() {
    let now = Utc.with_ymd_and_hms(2026, 11, 27, 12, 0, 0).unwrap();
    assert_eq!(
        parse_time("2026-11-01", now),
        Some(
            Utc.with_ymd_and_hms(2026, 11, 1, 0, 0, 0)
                .unwrap()
                .timestamp_millis()
        )
    );
    assert_eq!(
        parse_time("2026-11-01T08:30:00+02:00", now),
        Some(
            Utc.with_ymd_and_hms(2026, 11, 1, 6, 30, 0)
                .unwrap()
                .timestamp_millis()
        )
    );
    assert_eq!(
        parse_time("7d", now),
        Some(
            Utc.with_ymd_and_hms(2026, 11, 20, 12, 0, 0)
                .unwrap()
                .timestamp_millis()
        )
    );
    assert_eq!(
        parse_time("24h", now),
        Some(
            Utc.with_ymd_and_hms(2026, 11, 26, 12, 0, 0)
                .unwrap()
                .timestamp_millis()
        )
    );
    assert_eq!(
        parse_time("2w", now),
        Some(
            Utc.with_ymd_and_hms(2026, 11, 13, 12, 0, 0)
                .unwrap()
                .timestamp_millis()
        )
    );
    assert_eq!(parse_time("last week", now), None);
    assert_eq!(parse_time("7y", now), None);
    assert_eq!(parse_time("", now), None);
}

fn found(thread: &str, title: Option<&str>, position: i64) -> SearchMatch {
    let mut message = message(
        MessageRole::User,
        "the codename is TANGERINE",
        None,
        position,
    );
    message.sender_name = Some("Dana".into());
    SearchMatch {
        thread_id: thread.into(),
        conversation_title: title.map(str::to_string),
        message,
        excerpt: "the codename is TANGERINE".into(),
    }
}

#[test]
fn lists_each_match_with_its_conversation_position_author_and_time() {
    let outcome = SearchOutcome {
        matches: vec![found("t1", Some("Staging plans"), 4), found("t2", None, 0)],
        any_word: false,
        no_words: false,
    };

    assert_eq!(
        search_result(&outcome, Some("t2")),
        json!({
            "matches": [
                {
                    "conversationId": "t1",
                    "conversation": "Staging plans",
                    "position": 4,
                    "from": "user",
                    "name": "Dana",
                    "at": "2026-10-01T09:00:00.000Z",
                    "text": "the codename is TANGERINE"
                },
                {
                    "conversationId": "t2",
                    "current": true,
                    "position": 0,
                    "from": "user",
                    "name": "Dana",
                    "at": "2026-10-01T09:00:00.000Z",
                    "text": "the codename is TANGERINE"
                }
            ]
        })
    );
}

#[test]
fn says_when_nothing_matches_or_only_some_words_do() {
    assert_eq!(
        search_result(&SearchOutcome::default(), None),
        json!({ "matches": [], "note": "No message matches." })
    );
    assert_eq!(
        search_result(
            &SearchOutcome {
                no_words: true,
                ..SearchOutcome::default()
            },
            None
        ),
        json!({ "matches": [], "note": "The query holds no word to search for." })
    );
    let partial = search_result(
        &SearchOutcome {
            matches: vec![found("t1", None, 0)],
            any_word: true,
            no_words: false,
        },
        None,
    );
    assert_eq!(
        partial["note"],
        "No message holds every word; these hold at least one."
    );
}

#[tokio::test]
async fn needs_a_conversation_for_current_and_a_query_or_a_conversation() {
    let bound = ConversationSearchToolsInput {
        agent_id: "agent-1".into(),
        ..ConversationSearchToolsInput::default()
    };
    let current = ConversationSearchInput {
        conversation_id: Some("current".into()),
        ..ConversationSearchInput::default()
    };
    assert_eq!(
        run_conversation_search(current, &bound, at())
            .await
            .unwrap(),
        json!({ "note": "This run has no conversation of its own." })
    );
    assert_eq!(
        run_conversation_search(ConversationSearchInput::default(), &bound, at())
            .await
            .unwrap(),
        json!({ "note": "Give a query to search, or a conversation_id to read." })
    );
}
