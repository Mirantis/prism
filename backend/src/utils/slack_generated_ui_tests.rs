use serde_json::json;

use super::*;
use crate::services::generated_ui::generated_ui_schema::parse_spec;

const UI: &str = "6b0d6a4e-2f1c-4d8e-9c55-1e2f3a4b5c6d";
const IMAGE: &str = "0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

fn blocks_of(spec: Value, files: &HashMap<String, String>) -> Vec<Value> {
    let spec = parse_spec(&spec).unwrap();
    generated_ui_blocks(UI, &spec.root, &spec.elements, files)
}

fn blocks(spec: Value) -> Vec<Value> {
    blocks_of(spec, &HashMap::new())
}

fn issues(spec: Value) -> Vec<String> {
    let spec = parse_spec(&spec).unwrap();
    generated_ui_issues(&spec.root, &spec.elements)
}

#[test]
fn maps_a_card_to_its_title_then_its_children() {
    let blocks = blocks(json!({
        "root": "card",
        "elements": {
            "card": { "type": "Card", "props": { "title": "Deploys" }, "children": ["h", "text", "note", "line"] },
            "h": { "type": "Heading", "props": { "text": "This week" } },
            "text": { "type": "Text", "props": { "text": "**3** deploys" } },
            "note": { "type": "Note", "props": { "text": "Counts <prod> only" } },
            "line": { "type": "Divider" }
        }
    }));
    assert_eq!(
        blocks,
        vec![
            json!({ "type": "header", "text": { "type": "plain_text", "text": "Deploys" } }),
            json!({ "type": "header", "text": { "type": "plain_text", "text": "This week" } }),
            json!({ "type": "markdown", "text": "**3** deploys" }),
            json!({ "type": "context", "elements": [{ "type": "plain_text", "text": "Counts <prod> only" }] }),
            json!({ "type": "divider" }),
        ]
    );
}

#[test]
fn maps_a_card_without_a_title_to_its_children_alone() {
    let blocks = blocks(json!({
        "root": "card",
        "elements": {
            "card": { "type": "Card", "children": ["line"] },
            "line": { "type": "Divider" }
        }
    }));
    assert_eq!(blocks, vec![json!({ "type": "divider" })]);
}

#[test]
fn maps_fields_to_a_section_with_one_field_per_pair() {
    let blocks = blocks(json!({
        "root": "f",
        "elements": {
            "f": { "type": "Fields", "props": { "fields": [{ "label": "Failed", "value": "2 < 3" }, { "label": "Owner", "value": "ops & sre" }] } }
        }
    }));
    assert_eq!(
        blocks,
        vec![json!({ "type": "section", "fields": [
            { "type": "mrkdwn", "text": "*Failed*: 2 &lt; 3" },
            { "type": "mrkdwn", "text": "*Owner*: ops &amp; sre" },
        ] })]
    );
}

#[test]
fn maps_a_table_with_its_header_row_first() {
    let blocks = blocks(json!({
        "root": "t",
        "elements": {
            "t": { "type": "Table", "props": { "columns": ["Day", "Count"], "rows": [["Mon", "3"], ["Tue", ""]] } }
        }
    }));
    assert_eq!(
        blocks,
        vec![json!({
            "type": "table",
            "column_settings": [{ "is_wrapped": true }, { "is_wrapped": true }],
            "rows": [
                [{ "type": "raw_text", "text": "Day" }, { "type": "raw_text", "text": "Count" }],
                [{ "type": "raw_text", "text": "Mon" }, { "type": "raw_text", "text": "3" }],
                [{ "type": "raw_text", "text": "Tue" }, { "type": "raw_text", "text": " " }],
            ]
        })]
    );
}

#[test]
fn maps_a_comparison_to_a_table_with_a_column_per_option() {
    let blocks = blocks(json!({
        "root": "c",
        "elements": {
            "c": { "type": "Comparison", "props": { "rows": ["Price", "Seats"], "options": [{ "title": "Basic", "values": ["$5", "1"] }, { "title": "Team", "values": ["$20", "10"] }] } }
        }
    }));
    let rows: Vec<Vec<&str>> = blocks[0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            row.as_array()
                .unwrap()
                .iter()
                .map(|c| c["text"].as_str().unwrap())
                .collect()
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            vec![" ", "Basic", "Team"],
            vec!["Price", "$5", "$20"],
            vec!["Seats", "1", "10"]
        ]
    );
}

#[test]
fn maps_a_bar_chart_with_its_axis_and_a_pie_chart_with_segments() {
    let blocks = blocks(json!({
        "root": "card",
        "elements": {
            "card": { "type": "Card", "children": ["bar", "pie"] },
            "bar": { "type": "Chart", "props": { "kind": "bar", "title": "Per day", "xLabel": "Day", "categories": ["Mon", "Tue"], "series": [{ "name": "prod", "values": [3, -1.5] }, { "name": "dev", "values": [1, 2] }] } },
            "pie": { "type": "Chart", "props": { "kind": "pie", "title": "Share", "categories": ["a", "b"], "series": [{ "name": "s", "values": [1, 3] }] } }
        }
    }));
    assert_eq!(
        blocks[0],
        json!({
            "type": "data_visualization",
            "title": "Per day",
            "chart": {
                "type": "bar",
                "series": [
                    { "name": "prod", "data": [{ "label": "Mon", "value": 3.0 }, { "label": "Tue", "value": -1.5 }] },
                    { "name": "dev", "data": [{ "label": "Mon", "value": 1.0 }, { "label": "Tue", "value": 2.0 }] },
                ],
                "axis_config": { "categories": ["Mon", "Tue"], "x_label": "Day" }
            }
        })
    );
    assert_eq!(
        blocks[1],
        json!({
            "type": "data_visualization",
            "title": "Share",
            "chart": { "type": "pie", "segments": [{ "label": "a", "value": 1.0 }, { "label": "b", "value": 3.0 }] }
        })
    );
}

#[test]
fn maps_line_and_area_charts_to_their_own_kind() {
    for kind in ["line", "area"] {
        let blocks = blocks(json!({
            "root": "c",
            "elements": {
                "c": { "type": "Chart", "props": { "kind": kind, "title": "Calls", "yLabel": "n", "categories": ["Q1"], "series": [{ "name": "a", "values": [1] }] } }
            }
        }));
        assert_eq!(blocks[0]["chart"]["type"], kind);
        assert_eq!(
            blocks[0]["chart"]["axis_config"],
            json!({ "categories": ["Q1"], "y_label": "n" })
        );
    }
}

#[test]
fn maps_a_checklist_to_a_list_with_a_mark_on_each_item() {
    let blocks = blocks(json!({
        "root": "l",
        "elements": {
            "l": { "type": "Checklist", "props": { "items": [{ "text": "Tag", "done": true }, { "text": "Ship", "done": false }] } }
        }
    }));
    assert_eq!(
        blocks,
        vec![json!({
            "type": "rich_text",
            "elements": [{ "type": "rich_text_list", "style": "bullet", "elements": [
                { "type": "rich_text_section", "elements": [{ "type": "emoji", "name": "white_check_mark" }, { "type": "text", "text": " Tag" }] },
                { "type": "rich_text_section", "elements": [{ "type": "emoji", "name": "white_large_square" }, { "type": "text", "text": " Ship" }] },
            ] }]
        })]
    );
}

#[test]
fn maps_an_image_to_its_uploaded_file_or_to_its_description() {
    let spec = json!({
        "root": "img",
        "elements": { "img": { "type": "Image", "props": { "attachment": format!("attachment:{IMAGE}"), "alt": "The graph" } } }
    });
    let files = HashMap::from([(IMAGE.to_string(), "F0123".to_string())]);
    assert_eq!(
        blocks_of(spec.clone(), &files),
        vec![json!({ "type": "image", "slack_file": { "id": "F0123" }, "alt_text": "The graph" })]
    );
    assert_eq!(
        blocks(spec),
        vec![
            json!({ "type": "context", "elements": [{ "type": "plain_text", "text": "The graph" }] })
        ]
    );
}

#[test]
fn maps_actions_to_buttons_with_the_generated_ui_ids_and_link_buttons_with_a_url() {
    let blocks = blocks(json!({
        "root": "choose",
        "elements": {
            "choose": { "type": "Actions", "children": ["roll-back", "keep", "docs"] },
            "roll-back": { "type": "Button", "props": { "label": "Roll back", "style": "danger" } },
            "keep": { "type": "Button", "props": { "label": "Keep it", "style": "primary" } },
            "docs": { "type": "LinkButton", "props": { "label": "Docs", "url": "https://example.com/docs" } }
        }
    }));
    assert_eq!(
        blocks,
        vec![json!({
            "type": "actions",
            "block_id": format!("generated_ui:{UI}:choose"),
            "elements": [
                { "type": "button", "text": { "type": "plain_text", "text": "Roll back" }, "action_id": "generated_ui:roll-back", "style": "danger" },
                { "type": "button", "text": { "type": "plain_text", "text": "Keep it" }, "action_id": "generated_ui:keep", "style": "primary" },
                { "type": "button", "text": { "type": "plain_text", "text": "Docs" }, "url": "https://example.com/docs" },
            ]
        })]
    );
}

#[test]
fn a_ui_within_every_limit_has_no_issues() {
    assert!(issues(json!({
        "root": "card",
        "elements": {
            "card": { "type": "Card", "props": { "title": "T" }, "children": ["text", "a", "b"] },
            "text": { "type": "Text", "props": { "text": "x".repeat(12_000) } },
            "a": { "type": "Chart", "props": { "kind": "pie", "title": "A", "categories": ["a"], "series": [{ "name": "s", "values": [1] }] } },
            "b": { "type": "Chart", "props": { "kind": "pie", "title": "B", "categories": ["a"], "series": [{ "name": "s", "values": [1] }] } }
        }
    }))
    .is_empty());
}

#[test]
fn counts_the_blocks_a_ui_posts_as() {
    let mut elements = serde_json::Map::new();
    let children: Vec<String> = (0..63).map(|n| format!("d{n}")).collect();
    for child in &children {
        elements.insert(child.clone(), json!({ "type": "Divider" }));
    }
    elements.insert(
        "card".into(),
        json!({ "type": "Card", "children": children }),
    );
    assert_eq!(
        issues(json!({ "root": "card", "elements": elements })),
        vec!["the UI needs 63 Slack blocks; the most is 50. Use fewer elements.".to_string()]
    );
}

#[test]
fn counts_the_markdown_of_every_text_together() {
    let found = issues(json!({
        "root": "card",
        "elements": {
            "card": { "type": "Card", "children": ["a", "b"] },
            "a": { "type": "Text", "props": { "text": "x".repeat(7_000) } },
            "b": { "type": "Text", "props": { "text": "y".repeat(6_000) } }
        }
    }));
    assert_eq!(
        found,
        vec!["the Text elements hold 13000 characters together; Slack shows at most 12000 in one message. Shorten them.".to_string()]
    );
}

#[test]
fn counts_the_table_cells_as_slack_gets_them() {
    let rows: Vec<Value> = (0..50)
        .map(|_| json!([" ".repeat(0), "x".repeat(199)]))
        .collect();
    let found = issues(json!({
        "root": "t",
        "elements": { "t": { "type": "Table", "props": { "columns": ["a", "b"], "rows": rows } } }
    }));
    // Each empty cell goes to Slack as one space: 2 + 50 × 200.
    assert_eq!(
        found,
        vec!["the table cells hold 10002 characters in Slack; the most is 10000. Use fewer or shorter cells.".to_string()]
    );
}

#[test]
fn counts_a_field_with_its_markup_and_escapes() {
    let found = issues(json!({
        "root": "f",
        "elements": { "f": { "type": "Fields", "props": { "fields": [{ "label": "L", "value": "<".repeat(1_900) }] } } }
    }));
    assert_eq!(
        found,
        vec!["elements.f.props.fields[0]: the label and value take 7605 characters in Slack; the most is 2000. Shorten them.".to_string()]
    );
}

#[test]
fn splits_a_long_text_version_and_describes_its_images() {
    assert_eq!(
        text_messages(&format!("**T**\n\n![A graph](attachment:{IMAGE})")),
        vec!["**T**\n\nA graph".to_string()]
    );
    let long = format!("{}\n\n{}", "a".repeat(3_000), "b".repeat(3_000));
    assert_eq!(
        text_messages(&long),
        vec!["a".repeat(3_000), "b".repeat(3_000)]
    );
}

#[test]
fn reads_a_press_from_the_generated_ui_ids_only() {
    let action = json!({ "action_id": "generated_ui:keep", "block_id": format!("generated_ui:{UI}:choose") });
    assert_eq!(
        ui_press(&action),
        Some(UiPress {
            ui_id: UI.into(),
            element_id: "keep".into(),
            block_id: format!("generated_ui:{UI}:choose"),
        })
    );
    assert!(is_ui_action("generated_ui:keep"));
    assert!(!is_ui_action("feedback_thumbs_up"));
    assert_eq!(
        ui_press(&json!({ "action_id": "generated_ui:keep", "block_id": "x" })),
        None
    );
    assert_eq!(
        ui_press(&json!({ "action_id": "a1B2", "block_id": format!("generated_ui:{UI}:choose") })),
        None
    );
}

#[test]
fn a_press_leaves_the_link_buttons_and_names_the_label_and_the_person() {
    let spec = json!({
        "root": "card",
        "elements": {
            "card": { "type": "Card", "props": { "title": "Deploys" }, "children": ["first", "second"] },
            "first": { "type": "Actions", "children": ["keep", "docs"] },
            "second": { "type": "Actions", "children": ["roll-back"] },
            "keep": { "type": "Button", "props": { "label": "Keep <it>" } },
            "docs": { "type": "LinkButton", "props": { "label": "Docs", "url": "https://example.com/docs" } },
            "roll-back": { "type": "Button", "props": { "label": "Roll back" } }
        }
    });
    let posted = blocks(spec);
    let press = ui_press(&json!({ "action_id": "generated_ui:keep", "block_id": format!("generated_ui:{UI}:first") })).unwrap();
    let updated = pressed_message_blocks(&posted, &press, "Keep <it>", "U0ADA");
    assert_eq!(
        updated,
        vec![
            posted[0].clone(),
            json!({
                "type": "actions",
                "block_id": format!("generated_ui:{UI}:first"),
                "elements": [{ "type": "button", "text": { "type": "plain_text", "text": "Docs" }, "url": "https://example.com/docs" }]
            }),
            json!({ "type": "context", "elements": [{ "type": "mrkdwn", "text": "\u{2705} *Keep &lt;it&gt;*, pressed by <@U0ADA>" }] }),
        ]
    );
}
