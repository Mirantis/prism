//! A generated UI as Slack Block Kit: the blocks of each element, the limits of
//! one Slack message, the text version Slack takes when it refuses the blocks,
//! and the press of one of the UI's buttons. `docs/slack-router-protocol.md`
//! lists the same blocks for a router.

use std::collections::HashMap;

use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::protocol::chat_protocol::{
    GeneratedUiElement, UiButtonStyle, UiChartKind, UiChartProps, UiChecklistItem,
};
use crate::services::generated_ui::generated_ui_schema::IMAGE_SCHEME;
use crate::support::js::len16;
use crate::utils::slack_formatter::describe_images;
use crate::utils::text_chunker::split_content;

/// A button's `action_id` is this prefix and the element id.
pub const ACTION_PREFIX: &str = "generated_ui:";
/// An actions block's `block_id` is this prefix, the UI id, `:` and the element id.
pub const BLOCK_PREFIX: &str = "generated_ui:";

pub const MAX_BLOCKS: usize = 50;
pub const MAX_MARKDOWN_CHARS: usize = 12_000;
pub const MAX_TABLE_CHARS: usize = 10_000;
pub const MAX_CHARTS: usize = 2;
const MAX_FIELD_CHARS: usize = 2_000;

/// The text length Slack advises for one message. A longer text version posts as several messages.
pub const TEXT_LIMIT: usize = 4_000;

/// The errors with which Slack refuses a message's blocks. The UI then posts as its text version.
pub const REFUSED_BLOCKS: [&str; 3] =
    ["invalid_blocks", "msg_blocks_too_long", "invalid_arguments"];

/// The id `generated_ui_issues` maps a spec under, the length of a real one.
const CHECK_ID: &str = "00000000-0000-0000-0000-000000000000";

/// The text Slack's `mrkdwn` shows as written.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn plain(text: &str) -> Value {
    json!({ "type": "plain_text", "text": text })
}

fn header(text: &str) -> Value {
    json!({ "type": "header", "text": plain(text) })
}

fn field_text(label: &str, value: &str) -> String {
    format!("*{}*: {}", escape(label), escape(value))
}

/// A table cell. Slack gets a space for an empty cell, as a comparison's corner is.
fn cell(text: &str) -> Value {
    let text = if text.is_empty() { " " } else { text };
    json!({ "type": "raw_text", "text": text })
}

fn table(header: Vec<String>, rows: Vec<Vec<String>>) -> Value {
    let wrapped: Vec<Value> = header
        .iter()
        .map(|_| json!({ "is_wrapped": true }))
        .collect();
    let rows: Vec<Value> = std::iter::once(header)
        .chain(rows)
        .map(|row| Value::Array(row.iter().map(|text| cell(text)).collect()))
        .collect();
    json!({ "type": "table", "column_settings": wrapped, "rows": rows })
}

fn chart(props: &UiChartProps) -> Value {
    let chart = if props.kind == UiChartKind::Pie {
        let segments: Vec<Value> = props
            .categories
            .iter()
            .zip(&props.series[0].values)
            .map(|(label, value)| json!({ "label": label, "value": value }))
            .collect();
        json!({ "type": "pie", "segments": segments })
    } else {
        let series: Vec<Value> = props
            .series
            .iter()
            .map(|series| {
                let data: Vec<Value> = props
                    .categories
                    .iter()
                    .zip(&series.values)
                    .map(|(label, value)| json!({ "label": label, "value": value }))
                    .collect();
                json!({ "name": series.name, "data": data })
            })
            .collect();
        let mut axis = json!({ "categories": props.categories });
        if let Some(label) = &props.x_label {
            axis["x_label"] = json!(label);
        }
        if let Some(label) = &props.y_label {
            axis["y_label"] = json!(label);
        }
        json!({ "type": props.kind.as_str(), "series": series, "axis_config": axis })
    };
    json!({ "type": "data_visualization", "title": props.title, "chart": chart })
}

fn checklist(items: &[UiChecklistItem]) -> Value {
    let lines: Vec<Value> = items
        .iter()
        .map(|item| {
            let mark = if item.done {
                "white_check_mark"
            } else {
                "white_large_square"
            };
            json!({
                "type": "rich_text_section",
                "elements": [
                    { "type": "emoji", "name": mark },
                    { "type": "text", "text": format!(" {}", item.text) }
                ]
            })
        })
        .collect();
    json!({
        "type": "rich_text",
        "elements": [{ "type": "rich_text_list", "style": "bullet", "elements": lines }]
    })
}

/// A button of an Actions. A link button has no `action_id`, so Slack gives it one
/// the press handler does not read.
fn button(id: &str, element: &GeneratedUiElement) -> Option<Value> {
    match element {
        GeneratedUiElement::Button { props } => {
            let mut button = json!({
                "type": "button",
                "text": plain(&props.label),
                "action_id": format!("{ACTION_PREFIX}{id}"),
            });
            if let Some(style) = props.style {
                button["style"] = json!(match style {
                    UiButtonStyle::Primary => "primary",
                    UiButtonStyle::Danger => "danger",
                });
            }
            Some(button)
        }
        GeneratedUiElement::LinkButton { props } => {
            Some(json!({ "type": "button", "text": plain(&props.label), "url": props.url }))
        }
        _ => None,
    }
}

struct Mapping<'a> {
    ui_id: &'a str,
    elements: &'a IndexMap<String, GeneratedUiElement>,
    /// Attachment id → Slack file id of each image uploaded for the message.
    files: &'a HashMap<String, String>,
    blocks: Vec<Value>,
}

impl Mapping<'_> {
    fn element(&mut self, id: &str) {
        let Some(element) = self.elements.get(id) else {
            return;
        };
        let block = match element {
            GeneratedUiElement::Card { props, children } => {
                if let Some(title) = &props.title {
                    self.blocks.push(header(title));
                }
                for child in children {
                    self.element(child);
                }
                return;
            }
            GeneratedUiElement::Heading { props } => header(&props.text),
            GeneratedUiElement::Text { props } => json!({ "type": "markdown", "text": props.text }),
            GeneratedUiElement::Fields { props } => {
                let fields: Vec<Value> = props
                    .fields
                    .iter()
                    .map(|field| json!({ "type": "mrkdwn", "text": field_text(&field.label, &field.value) }))
                    .collect();
                json!({ "type": "section", "fields": fields })
            }
            GeneratedUiElement::Table { props } => table(props.columns.clone(), props.rows.clone()),
            GeneratedUiElement::Comparison { props } => {
                let header = std::iter::once(String::new())
                    .chain(props.options.iter().map(|option| option.title.clone()))
                    .collect();
                let rows = props
                    .rows
                    .iter()
                    .enumerate()
                    .map(|(index, label)| {
                        std::iter::once(label.clone())
                            .chain(props.options.iter().map(|option| {
                                option.values.get(index).cloned().unwrap_or_default()
                            }))
                            .collect()
                    })
                    .collect();
                table(header, rows)
            }
            GeneratedUiElement::Chart { props } => chart(props),
            GeneratedUiElement::Checklist { props } => checklist(&props.items),
            // An image whose upload failed shows its description.
            GeneratedUiElement::Image { props } => {
                let id = props
                    .attachment
                    .strip_prefix(IMAGE_SCHEME)
                    .unwrap_or_default();
                match self.files.get(id) {
                    Some(file) => json!({
                        "type": "image",
                        "slack_file": { "id": file },
                        "alt_text": props.alt,
                    }),
                    None => json!({ "type": "context", "elements": [plain(&props.alt)] }),
                }
            }
            GeneratedUiElement::Note { props } => {
                json!({ "type": "context", "elements": [plain(&props.text)] })
            }
            GeneratedUiElement::Divider {} => json!({ "type": "divider" }),
            GeneratedUiElement::Actions { children } => {
                let buttons: Vec<Value> = children
                    .iter()
                    .filter_map(|child| button(child, self.elements.get(child)?))
                    .collect();
                json!({
                    "type": "actions",
                    "block_id": format!("{BLOCK_PREFIX}{}:{id}", self.ui_id),
                    "elements": buttons,
                })
            }
            // A button sits inside an Actions.
            GeneratedUiElement::Button { .. } | GeneratedUiElement::LinkButton { .. } => return,
        };
        self.blocks.push(block);
    }
}

/// The blocks of a UI, drawn from its root in order.
pub fn generated_ui_blocks(
    ui_id: &str,
    root: &str,
    elements: &IndexMap<String, GeneratedUiElement>,
    files: &HashMap<String, String>,
) -> Vec<Value> {
    let mut mapping = Mapping {
        ui_id,
        elements,
        files,
        blocks: Vec::new(),
    };
    mapping.element(root);
    mapping.blocks
}

fn text_of(value: &Value) -> usize {
    value.get("text").and_then(Value::as_str).map_or(0, len16)
}

/// What keeps a UI from fitting one Slack message, measured on the blocks it posts as.
pub fn generated_ui_issues(
    root: &str,
    elements: &IndexMap<String, GeneratedUiElement>,
) -> Vec<String> {
    let blocks = generated_ui_blocks(CHECK_ID, root, elements, &HashMap::new());
    let of_type = |kind: &'static str| {
        blocks
            .iter()
            .filter(move |block| block.get("type").and_then(Value::as_str) == Some(kind))
    };
    let markdown: usize = of_type("markdown").map(text_of).sum();
    let table: usize = of_type("table")
        .flat_map(|block| block["rows"].as_array().cloned().unwrap_or_default())
        .flat_map(|row| row.as_array().cloned().unwrap_or_default())
        .map(|cell| text_of(&cell))
        .sum();
    let charts = of_type("data_visualization").count();

    let mut issues = Vec::new();
    if blocks.len() > MAX_BLOCKS {
        issues.push(format!(
            "the UI needs {} Slack blocks; the most is {MAX_BLOCKS}. Use fewer elements.",
            blocks.len()
        ));
    }
    if markdown > MAX_MARKDOWN_CHARS {
        issues.push(format!(
            "the Text elements hold {markdown} characters together; Slack shows at most {MAX_MARKDOWN_CHARS} in one message. Shorten them."
        ));
    }
    if table > MAX_TABLE_CHARS {
        issues.push(format!(
            "the table cells hold {table} characters in Slack; the most is {MAX_TABLE_CHARS}. Use fewer or shorter cells."
        ));
    }
    if charts > MAX_CHARTS {
        issues.push(format!(
            "the UI has {charts} charts; Slack shows at most {MAX_CHARTS} in one message. Use fewer charts."
        ));
    }
    for (id, element) in elements {
        let GeneratedUiElement::Fields { props } = element else {
            continue;
        };
        for (index, field) in props.fields.iter().enumerate() {
            let length = len16(&field_text(&field.label, &field.value));
            if length > MAX_FIELD_CHARS {
                issues.push(format!(
                    "elements.{id}.props.fields[{index}]: the label and value take {length} characters in Slack; the most is {MAX_FIELD_CHARS}. Shorten them."
                ));
            }
        }
    }
    issues
}

/// The text version as the messages Slack posts in place of refused blocks, each
/// image as its description.
pub fn text_messages(content: &str) -> Vec<String> {
    let text = describe_images(content);
    let messages = split_content(&text, TEXT_LIMIT);
    if messages.is_empty() {
        vec![text]
    } else {
        messages
    }
}

/// The press of a generated UI button, from a `block_actions` action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiPress {
    pub ui_id: String,
    pub element_id: String,
    /// The actions block that holds the button.
    pub block_id: String,
}

/// Whether an `action_id` is a generated UI button's.
pub fn is_ui_action(action_id: &str) -> bool {
    action_id.starts_with(ACTION_PREFIX)
}

/// The press an action is, or `None` when its ids do not have the generated UI forms.
pub fn ui_press(action: &Value) -> Option<UiPress> {
    let element_id = action
        .get("action_id")
        .and_then(Value::as_str)?
        .strip_prefix(ACTION_PREFIX)?;
    let block_id = action.get("block_id").and_then(Value::as_str)?;
    let (ui_id, _) = block_id.strip_prefix(BLOCK_PREFIX)?.split_once(':')?;
    Some(UiPress {
        ui_id: ui_id.to_string(),
        element_id: element_id.to_string(),
        block_id: block_id.to_string(),
    })
}

/// The line that names the pressed button and the person who pressed it.
pub fn pressed_line(label: &str, slack_user_id: &str) -> Value {
    json!({
        "type": "context",
        "elements": [{
            "type": "mrkdwn",
            "text": format!("\u{2705} *{}*, pressed by <@{slack_user_id}>", escape(label)),
        }],
    })
}

/// The message's blocks after a press: every actions block of the UI keeps only
/// its link buttons, and the pressed line follows the block that was pressed.
pub fn pressed_message_blocks(
    blocks: &[Value],
    press: &UiPress,
    label: &str,
    slack_user_id: &str,
) -> Vec<Value> {
    let ours = format!("{BLOCK_PREFIX}{}:", press.ui_id);
    let mut updated = Vec::new();
    for block in blocks {
        let block_id = block.get("block_id").and_then(Value::as_str).unwrap_or("");
        if !block_id.starts_with(&ours) {
            updated.push(block.clone());
            continue;
        }
        let links: Vec<Value> = block
            .get("elements")
            .and_then(Value::as_array)
            .map(|elements| {
                elements
                    .iter()
                    .filter(|element| element.get("url").is_some())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if !links.is_empty() {
            let mut kept = block.clone();
            kept["elements"] = Value::Array(links);
            updated.push(kept);
        }
        if block_id == press.block_id {
            updated.push(pressed_line(label, slack_user_id));
        }
    }
    updated
}

#[cfg(test)]
#[path = "slack_generated_ui_tests.rs"]
mod tests;
