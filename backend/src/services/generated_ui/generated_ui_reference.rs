//! The component reference `ui_reference` returns. It states the same catalog as
//! `generated_ui_schema.rs` and `docs/websocket-protocol.md`; a change to one is a
//! change to all three.

pub const UI_REFERENCE: &str = r#"# show_ui components

A UI is a flat map of elements by id, and the id of the root element:
{ "root": "<id>", "elements": { "<id>": { "type": "<Type>", "props": { ... }, "children": ["<id>", ...] } } }
Element ids are 1 to 64 characters of A-Z, a-z, 0-9, _ and -. Every element but the root is a child of exactly one element. Only Card and Actions have children. Leave out props on Divider and Actions, and children on every other type. Lengths count characters.

## Types

- Card: groups other elements. props: title (optional, 1 to 150). children: any type except Card, Button and LinkButton.
- Heading: a short title. props: text (1 to 150).
- Text: a paragraph of Markdown. props: text (1 to 12000).
- Fields: label and value pairs. props: fields, 1 to 10 of { label (1 to 100), value (1 to 1900) }.
- Table: props: columns, 1 to 20 strings; rows, 1 to 99 rows, each a list of one string per column.
- Chart: props: kind (bar, line, area or pie); title (1 to 50); xLabel and yLabel (optional, 1 to 50); categories, 1 to 20 unique strings of 1 to 20; series, 1 to 12 of { name (1 to 20, unique), values (one number per category) }. A pie chart has one series, at most 12 categories and values greater than 0. Bars are grouped, and bar, line and area values may be negative.
- Comparison: options side by side. props: rows, 1 to 99 row labels; options, 2 to 4 of { title (1 to 100), values (one string per row) }.
- Checklist: props: items, 1 to 50 of { text (1 to 300), done (true or false) }. It shows a state; the user cannot tick it.
- Image: props: attachment, "attachment:<id>" with the id share_file gave for a PNG, JPEG or GIF you shared in this turn; alt (1 to 2000). No other image source is allowed.
- Note: one line of small text, such as a source. props: text (1 to 300).
- Divider: a line. No props.
- Actions: a row of buttons. children: 1 to 5 Button or LinkButton elements.
- LinkButton: opens a page. props: label (1 to 75); url (https, up to 3000).
- Button: props: label (1 to 75); style (optional, primary or danger). The first press of any button in the UI ends the choice, and its label arrives as the user's next message.

## Limits per UI

At most 100 elements, one Table or Comparison, and two charts. Table and comparison cells hold at most 10000 characters together. When a UI does not fit the channel, show_ui says so.

## Rules

- Values are written out. A UI holds no state, bindings ($state, $item and the like), conditions, repeats or events.
- Use a component when it shows the answer better than prose: a comparison, numbers over time, a status summary, or a choice between a few options. Answer a simple question in plain text.
- Keep it small: one Card with the few elements that matter beats many cards.
- The UI shows after the text you wrote before the call. Do not repeat its content in your reply.

## Example

{ "root": "deploys", "elements": {
  "deploys": { "type": "Card", "props": { "title": "Deploys this week" }, "children": ["per-day", "choose"] },
  "per-day": { "type": "Chart", "props": { "kind": "bar", "title": "Deploys per day", "categories": ["Mon", "Tue", "Wed"], "series": [{ "name": "prod", "values": [3, 5, 2] }] } },
  "choose": { "type": "Actions", "children": ["roll-back", "keep"] },
  "roll-back": { "type": "Button", "props": { "label": "Roll back Wednesday", "style": "danger" } },
  "keep": { "type": "Button", "props": { "label": "Keep it" } }
} }
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::generated_ui::generated_ui_schema::{ELEMENT_TYPES, parse_spec};

    #[test]
    fn names_every_type() {
        for name in ELEMENT_TYPES {
            assert!(
                UI_REFERENCE.contains(&format!("- {name}:")),
                "{name} is missing"
            );
        }
    }

    #[test]
    fn its_example_is_a_valid_ui() {
        let example = UI_REFERENCE.split("## Example\n\n").nth(1).unwrap();
        let spec: serde_json::Value = serde_json::from_str(example.trim()).unwrap();
        assert!(parse_spec(&spec).is_ok());
    }
}
