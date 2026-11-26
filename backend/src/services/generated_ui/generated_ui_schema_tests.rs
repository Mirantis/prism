use serde_json::{Value, json};

use super::*;

/// A spec whose root card holds `children`, with `extra` elements beside it.
fn card_with(children: &[&str], extra: Value) -> Value {
    let mut elements = json!({
        "card": { "type": "Card", "props": { "title": "Status" }, "children": children }
    });
    for (id, element) in extra.as_object().unwrap() {
        elements[id] = element.clone();
    }
    json!({ "root": "card", "elements": elements })
}

fn issues(spec: Value) -> Vec<String> {
    parse_spec(&spec).expect_err("the spec has issues")
}

fn has_issue(spec: Value, part: &str) -> bool {
    let found = issues(spec);
    assert!(
        found.iter().any(|issue| issue.contains(part)),
        "no issue contains {part:?}: {found:#?}"
    );
    true
}

fn every_type() -> Value {
    card_with(
        &[
            "heading",
            "text",
            "fields",
            "table",
            "chart",
            "pie",
            "checklist",
            "image",
            "note",
            "divider",
            "actions",
        ],
        json!({
            "heading": { "type": "Heading", "props": { "text": "This week" } },
            "text": { "type": "Text", "props": { "text": "Two deploys **failed**." } },
            "fields": { "type": "Fields", "props": { "fields": [{ "label": "Owner", "value": "Platform" }] } },
            "table": { "type": "Table", "props": { "columns": ["Day", "Deploys"], "rows": [["Mon", "3"]] } },
            "chart": { "type": "Chart", "props": { "kind": "bar", "title": "Per day", "xLabel": "Day", "categories": ["Mon", "Tue"], "series": [{ "name": "prod", "values": [3, -1] }, { "name": "stage", "values": [2, 4] }] } },
            "pie": { "type": "Chart", "props": { "kind": "pie", "title": "Share", "categories": ["a", "b"], "series": [{ "name": "share", "values": [1, 2] }] } },
            "checklist": { "type": "Checklist", "props": { "items": [{ "text": "Tag", "done": true }] } },
            "image": { "type": "Image", "props": { "attachment": "attachment:6b0d6a4e-2f1c-4d8e-9c55-1e2f3a4b5c6d", "alt": "The graph" } },
            "note": { "type": "Note", "props": { "text": "Source: CI" } },
            "divider": { "type": "Divider" },
            "actions": { "type": "Actions", "children": ["go", "docs"] },
            "go": { "type": "Button", "props": { "label": "Roll back", "style": "danger" } },
            "docs": { "type": "LinkButton", "props": { "label": "Docs", "url": "https://example.com" } }
        }),
    )
}

#[test]
fn accepts_every_component_type() {
    let spec = parse_spec(&every_type()).unwrap();
    assert_eq!(spec.root, "card");
    assert_eq!(spec.elements.len(), 14);
    assert_eq!(
        image_attachment_ids(&spec.elements),
        ["6b0d6a4e-2f1c-4d8e-9c55-1e2f3a4b5c6d"]
    );
}

#[test]
fn accepts_a_comparison() {
    let spec = card_with(
        &["cmp"],
        json!({ "cmp": { "type": "Comparison", "props": { "rows": ["Price"], "options": [{ "title": "A", "values": ["$1"] }, { "title": "B", "values": ["$2"] }] } } }),
    );
    assert!(parse_spec(&spec).is_ok());
}

#[test]
fn refuses_data_bindings_conditions_and_unknown_fields() {
    assert!(has_issue(
        card_with(
            &["t"],
            json!({ "t": { "type": "Text", "props": { "text": { "$state": "/summary" } } } })
        ),
        "`$state` is a data binding"
    ));
    assert!(has_issue(
        card_with(
            &["t"],
            json!({ "t": { "type": "Text", "props": { "text": "Hi" }, "visible": { "$state": "/x" } } })
        ),
        "data binding"
    ));
    assert!(has_issue(
        card_with(
            &["t"],
            json!({ "t": { "type": "Text", "props": { "text": "Hi" }, "repeat": "/items" } })
        ),
        "unknown field `repeat`"
    ));
    assert!(has_issue(
        card_with(
            &["d"],
            json!({ "d": { "type": "Divider", "children": [] } })
        ),
        "unknown field `children`"
    ));
}

#[test]
fn refuses_a_tree_that_is_not_one() {
    assert!(has_issue(
        card_with(&["missing"], json!({})),
        "\"missing\" is not an element id"
    ));
    assert!(has_issue(
        card_with(
            &["t"],
            json!({ "t": { "type": "Text", "props": { "text": "a" } }, "lost": { "type": "Divider" } })
        ),
        "elements.lost: is not a child of any element"
    ));
    assert!(has_issue(
        card_with(
            &["a", "b"],
            json!({
                "a": { "type": "Actions", "children": ["go"] },
                "b": { "type": "Actions", "children": ["go"] },
                "go": { "type": "Button", "props": { "label": "Go" } }
            })
        ),
        "already a child of \"a\""
    ));
    assert!(has_issue(
        json!({ "root": "nope", "elements": { "t": { "type": "Text", "props": { "text": "a" } } } }),
        "root: \"nope\" is not an element id"
    ));
    assert!(has_issue(
        card_with(&["card"], json!({})),
        "the root cannot be a child"
    ));
}

#[test]
fn keeps_buttons_inside_actions_and_cards_apart() {
    assert!(has_issue(
        card_with(
            &["go"],
            json!({ "go": { "type": "Button", "props": { "label": "Go" } } })
        ),
        "sits inside an Actions"
    ));
    assert!(has_issue(
        card_with(
            &["a"],
            json!({ "a": { "type": "Actions", "children": ["t"] }, "t": { "type": "Text", "props": { "text": "x" } } })
        ),
        "holds only Button and LinkButton"
    ));
    assert!(has_issue(
        card_with(
            &["inner"],
            json!({ "inner": { "type": "Card", "children": ["t"] }, "t": { "type": "Text", "props": { "text": "x" } } })
        ),
        "cannot hold another Card"
    ));
    let six: Vec<String> = (0..6).map(|i| format!("b{i}")).collect();
    let mut extra = json!({ "a": { "type": "Actions", "children": six } });
    for id in &six {
        extra[id] = json!({ "type": "Button", "props": { "label": id } });
    }
    assert!(has_issue(
        card_with(&["a"], extra),
        "must have 1 to 5 entries, not 6"
    ));
}

#[test]
fn checks_the_chart_rules() {
    let chart =
        |props: Value| card_with(&["c"], json!({ "c": { "type": "Chart", "props": props } }));
    assert!(has_issue(
        chart(
            json!({ "kind": "pie", "title": "Share", "categories": ["a"], "series": [{ "name": "s", "values": [0] }] })
        ),
        "greater than 0"
    ));
    assert!(has_issue(
        chart(
            json!({ "kind": "pie", "title": "Share", "categories": ["a"], "series": [{ "name": "s", "values": [1] }, { "name": "t", "values": [1] }] })
        ),
        "must have 1 to 1 entries"
    ));
    assert!(has_issue(
        chart(
            json!({ "kind": "bar", "title": "T", "categories": ["a", "b"], "series": [{ "name": "s", "values": [1] }] })
        ),
        "one value per category (2), not 1"
    ));
    assert!(has_issue(
        chart(
            json!({ "kind": "bar", "title": "T", "categories": ["a", "a"], "series": [{ "name": "s", "values": [1, 2] }] })
        ),
        "\"a\" appears twice"
    ));
    assert!(has_issue(
        chart(
            json!({ "kind": "bar", "title": "", "categories": ["a"], "series": [{ "name": "s", "values": [1] }] })
        ),
        "props.title: must be 1 to 50 characters, not 0"
    ));
}

#[test]
fn counts_tables_charts_and_table_characters_per_ui() {
    let table =
        |rows: Value| json!({ "type": "Table", "props": { "columns": ["c"], "rows": rows } });
    assert!(has_issue(
        card_with(
            &["t1", "t2"],
            json!({ "t1": table(json!([["a"]])), "t2": table(json!([["b"]])) })
        ),
        "at most one Table or Comparison"
    ));
    let chart = json!({ "type": "Chart", "props": { "kind": "line", "title": "T", "categories": ["a"], "series": [{ "name": "s", "values": [1] }] } });
    assert!(has_issue(
        card_with(
            &["c1", "c2", "c3"],
            json!({ "c1": chart, "c2": chart, "c3": chart })
        ),
        "at most 2 charts, not 3"
    ));
    let long = "x".repeat(200);
    let rows: Vec<Value> = (0..60).map(|_| json!([long])).collect();
    assert!(has_issue(
        card_with(&["t"], json!({ "t": table(json!(rows)) })),
        "the most is 10000"
    ));
    assert!(has_issue(
        card_with(
            &["t"],
            json!({ "t": { "type": "Table", "props": { "columns": ["a", "b"], "rows": [["1"]] } } })
        ),
        "one cell per column (2), not 1"
    ));
}

#[test]
fn checks_ids_urls_and_images() {
    assert!(has_issue(
        card_with(&["bad id"], json!({ "bad id": { "type": "Divider" } })),
        "an element id is 1 to 64 characters"
    ));
    assert!(has_issue(
        card_with(
            &["a"],
            json!({ "a": { "type": "Actions", "children": ["l"] }, "l": { "type": "LinkButton", "props": { "label": "Docs", "url": "http://example.com" } } })
        ),
        "must be an https URL"
    ));
    assert!(has_issue(
        card_with(
            &["i"],
            json!({ "i": { "type": "Image", "props": { "attachment": "https://example.com/a.png", "alt": "A" } } })
        ),
        "must be attachment:<id>"
    ));
}

#[test]
fn reports_every_issue_at_once() {
    let found = issues(card_with(
        &["h", "n"],
        json!({
            "h": { "type": "Heading", "props": { "text": "" } },
            "n": { "type": "Note", "props": { "text": "x".repeat(301) } }
        }),
    ));
    assert_eq!(found.len(), 2, "{found:#?}");
}

#[test]
fn reads_only_a_stored_block_of_this_version() {
    let block = parse_spec(&every_type())
        .unwrap()
        .into_block("ui-1".to_string());
    let value = serde_json::to_value(&block).unwrap();
    assert_eq!(value["type"], "generated_ui");
    assert_eq!(parse_block(&value), Some(block));
    let mut later = value.clone();
    later["version"] = json!(2);
    assert_eq!(parse_block(&later), None);
    assert!(is_generated_ui(Some(&json!([later]))));
    assert!(!is_generated_ui(Some(
        &json!([{ "type": "question_card" }])
    )));
}

/// The JSON Schema that client authors read, beside the protocol fixtures.
fn block_schema() -> jsonschema::Validator {
    let schema: Value = serde_json::from_str(include_str!(
        "../../protocol/fixtures/generated-ui.schema.json"
    ))
    .unwrap();
    jsonschema::validator_for(&schema).unwrap()
}

#[test]
fn the_blocks_the_runtime_stores_match_the_published_schema() {
    let schema = block_schema();
    let block = parse_spec(&every_type())
        .unwrap()
        .into_block("ui-1".to_string());
    let open = serde_json::to_value(&block).unwrap();
    let errors: Vec<String> = schema.iter_errors(&open).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "{errors:#?}");

    let pressed = crate::services::generated_ui::generated_ui_service::pressed_block(
        &block,
        "go",
        Some(crate::protocol::chat_protocol::QuestionCardPerson {
            id: "ada-id".into(),
            name: "Ada Example".into(),
        }),
    )
    .unwrap();
    let pressed = serde_json::to_value(&pressed).unwrap();
    assert!(schema.is_valid(&pressed));
    let mut anonymous = pressed.clone();
    anonymous["pressed"]["by"] = Value::Null;
    assert!(schema.is_valid(&anonymous));
}

#[test]
fn the_published_schema_refuses_what_the_catalog_refuses() {
    let schema = block_schema();
    let mut block = serde_json::to_value(
        parse_spec(&every_type())
            .unwrap()
            .into_block("ui-1".to_string()),
    )
    .unwrap();
    assert!(schema.is_valid(&block));
    block["elements"]["heading"]["props"]["text"] = json!({ "$state": "/title" });
    assert!(!schema.is_valid(&block));
}

/// A message a real runtime stored after a press, which client tests decode too.
#[test]
fn a_recorded_message_matches_the_schema_and_its_text_version() {
    let recorded: Value = serde_json::from_str(include_str!(
        "../../protocol/fixtures/generated-ui-message.json"
    ))
    .unwrap();
    let block = &recorded["blocks"][0];
    assert!(block_schema().is_valid(block));
    let parsed = parse_block(block).expect("the recorded block reads");
    assert_eq!(parsed.pressed.as_ref().unwrap().label, "Keep Wednesday");
    assert_eq!(
        crate::services::generated_ui::generated_ui_text::generated_ui_text(
            &parsed.root,
            &parsed.elements
        ),
        recorded["content"].as_str().unwrap()
    );
}
