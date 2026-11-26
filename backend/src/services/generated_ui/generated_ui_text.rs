//! A generated UI as plain text: the message content that a channel without the
//! block shows, as `docs/websocket-protocol.md` describes it.

use indexmap::IndexMap;

use crate::protocol::chat_protocol::{GeneratedUiElement, UiChartKind};

/// A cell for a Markdown table: one line, with its pipes escaped.
fn cell(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('|', "\\|")
}

fn markdown_table(header: &[String], rows: &[Vec<String>]) -> String {
    let line = |cells: &[String]| {
        format!(
            "| {} |",
            cells
                .iter()
                .map(|c| cell(c))
                .collect::<Vec<_>>()
                .join(" | ")
        )
    };
    let mut lines = vec![line(header), format!("|{}", " --- |".repeat(header.len()))];
    lines.extend(rows.iter().map(|row| line(row)));
    lines.join("\n")
}

/// A number as a person writes it: no trailing `.0`.
pub fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

fn element_text(
    id: &str,
    elements: &IndexMap<String, GeneratedUiElement>,
    parts: &mut Vec<String>,
) {
    let Some(element) = elements.get(id) else {
        return;
    };
    match element {
        GeneratedUiElement::Card { props, children } => {
            if let Some(title) = &props.title {
                parts.push(format!("**{title}**"));
            }
            for child in children {
                element_text(child, elements, parts);
            }
        }
        GeneratedUiElement::Heading { props } => parts.push(format!("**{}**", props.text)),
        GeneratedUiElement::Text { props } | GeneratedUiElement::Note { props } => {
            parts.push(props.text.clone());
        }
        GeneratedUiElement::Fields { props } => parts.push(
            props
                .fields
                .iter()
                .map(|field| format!("{}: {}", field.label, field.value))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        GeneratedUiElement::Table { props } => {
            parts.push(markdown_table(&props.columns, &props.rows));
        }
        GeneratedUiElement::Comparison { props } => {
            let header: Vec<String> = std::iter::once(String::new())
                .chain(props.options.iter().map(|option| option.title.clone()))
                .collect();
            let rows: Vec<Vec<String>> =
                props
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
            parts.push(markdown_table(&header, &rows));
        }
        GeneratedUiElement::Chart { props } => {
            let mut lines = vec![format!("**{}**", props.title)];
            for (index, category) in props.categories.iter().enumerate() {
                let value_of = |values: &[f64]| values.get(index).copied().map(number);
                let values = if props.series.len() == 1 || props.kind == UiChartKind::Pie {
                    value_of(&props.series[0].values).unwrap_or_default()
                } else {
                    props
                        .series
                        .iter()
                        .map(|series| {
                            format!(
                                "{} {}",
                                series.name,
                                value_of(&series.values).unwrap_or_default()
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                lines.push(format!("{category}: {values}"));
            }
            parts.push(lines.join("\n"));
        }
        GeneratedUiElement::Checklist { props } => parts.push(
            props
                .items
                .iter()
                .map(|item| format!("- [{}] {}", if item.done { "x" } else { " " }, item.text))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        // An inline image reference, so the message's attachment is shown in place.
        GeneratedUiElement::Image { props } => parts.push(format!(
            "![{}]({})",
            props.alt.replace(['[', ']'], ""),
            props.attachment
        )),
        GeneratedUiElement::Divider {} => parts.push("---".to_string()),
        GeneratedUiElement::Actions { children } => {
            let labels: Vec<String> = children
                .iter()
                .filter_map(|child| match elements.get(child)? {
                    GeneratedUiElement::Button { props } => Some(props.label.clone()),
                    GeneratedUiElement::LinkButton { props } => {
                        Some(format!("{} ({})", props.label, props.url))
                    }
                    _ => None,
                })
                .collect();
            parts.push(labels.join(" / "));
        }
        GeneratedUiElement::LinkButton { props } => {
            parts.push(format!("{} ({})", props.label, props.url));
        }
        GeneratedUiElement::Button { props } => parts.push(props.label.clone()),
    }
}

/// The UI as plain text, drawn from the root in order.
pub fn generated_ui_text(root: &str, elements: &IndexMap<String, GeneratedUiElement>) -> String {
    let mut parts = Vec::new();
    element_text(root, elements, &mut parts);
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::generated_ui::generated_ui_schema::parse_spec;
    use serde_json::json;

    fn text_of(spec: serde_json::Value) -> String {
        let spec = parse_spec(&spec).unwrap();
        generated_ui_text(&spec.root, &spec.elements)
    }

    #[test]
    fn writes_each_element_in_order() {
        let text = text_of(json!({
            "root": "card",
            "elements": {
                "card": { "type": "Card", "props": { "title": "Deploys" }, "children": ["table", "chart", "list", "choose"] },
                "table": { "type": "Table", "props": { "columns": ["Day", "Count"], "rows": [["Mon", "3"], ["Tue | Wed", "5"]] } },
                "chart": { "type": "Chart", "props": { "kind": "bar", "title": "Per day", "categories": ["Mon", "Tue"], "series": [{ "name": "prod", "values": [3, 5.5] }] } },
                "list": { "type": "Checklist", "props": { "items": [{ "text": "Tag", "done": true }, { "text": "Ship", "done": false }] } },
                "choose": { "type": "Actions", "children": ["keep", "docs"] },
                "keep": { "type": "Button", "props": { "label": "Keep it" } },
                "docs": { "type": "LinkButton", "props": { "label": "Docs", "url": "https://example.com/docs" } }
            }
        }));
        assert_eq!(
            text,
            "**Deploys**\n\n| Day | Count |\n| --- | --- |\n| Mon | 3 |\n| Tue \\| Wed | 5 |\n\n**Per day**\nMon: 3\nTue: 5.5\n\n- [x] Tag\n- [ ] Ship\n\nKeep it / Docs (https://example.com/docs)"
        );
    }

    #[test]
    fn writes_an_image_as_an_inline_reference_to_its_attachment() {
        let text = text_of(json!({
            "root": "img",
            "elements": { "img": { "type": "Image", "props": { "attachment": "attachment:6b0d6a4e-2f1c-4d8e-9c55-1e2f3a4b5c6d", "alt": "The [weekly] graph" } } }
        }));
        assert_eq!(
            text,
            "![The weekly graph](attachment:6b0d6a4e-2f1c-4d8e-9c55-1e2f3a4b5c6d)"
        );
    }

    #[test]
    fn names_each_series_when_a_chart_has_several() {
        let text = text_of(json!({
            "root": "chart",
            "elements": {
                "chart": { "type": "Chart", "props": { "kind": "line", "title": "Calls", "categories": ["Q1"], "series": [{ "name": "a", "values": [1] }, { "name": "b", "values": [-2] }] } }
            }
        }));
        assert_eq!(text, "**Calls**\nQ1: a 1, b -2");
    }

    #[test]
    fn writes_a_comparison_as_a_table_with_a_column_per_option() {
        let text = text_of(json!({
            "root": "cmp",
            "elements": {
                "cmp": { "type": "Comparison", "props": { "rows": ["Price", "Seats"], "options": [{ "title": "Basic", "values": ["$5", "1"] }, { "title": "Team", "values": ["$20", "10"] }] } }
            }
        }));
        assert_eq!(
            text,
            "|  | Basic | Team |\n| --- | --- | --- |\n| Price | $5 | $20 |\n| Seats | 1 | 10 |"
        );
    }
}
