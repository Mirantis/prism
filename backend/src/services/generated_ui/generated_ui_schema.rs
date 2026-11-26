//! What a generated UI may hold: the catalog's limits, the `show_ui` input schema,
//! and the check that turns the tool's input into a UI or into the issues the
//! agent fixes. `docs/websocket-protocol.md` states the same rules for clients.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use indexmap::IndexMap;
use regex::Regex;
use serde_json::{Value, json};

use crate::ai::{Schema, json_schema_with_validator};
use crate::protocol::chat_protocol::{
    GeneratedUiBlock, GeneratedUiElement, UiChartKind, UiChartProps, UiComparisonProps,
    UiTableProps,
};

pub const SHOW_UI_TOOL_NAME: &str = "show_ui";
pub const UI_REFERENCE_TOOL_NAME: &str = "ui_reference";

pub const GENERATED_UI_VERSION: u32 = 1;
pub const MAX_ELEMENTS: usize = 100;
pub const MAX_TABLES: usize = 1;
pub const MAX_CHARTS: usize = 2;
pub const MAX_TABLE_CHARS: usize = 10_000;
pub const MAX_ACTIONS_CHILDREN: usize = 5;

/// The element types, in the order the reference lists them.
pub const ELEMENT_TYPES: [&str; 14] = [
    "Card",
    "Heading",
    "Text",
    "Fields",
    "Table",
    "Chart",
    "Comparison",
    "Checklist",
    "Image",
    "Note",
    "Divider",
    "Actions",
    "LinkButton",
    "Button",
];

pub const IMAGE_SCHEME: &str = "attachment:";

static ELEMENT_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[A-Za-z0-9_-]{1,64}$").expect("the id pattern compiles"));

/// A spec that passed every check: the root and the elements, in the agent's order.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSpec {
    pub root: String,
    pub elements: IndexMap<String, GeneratedUiElement>,
}

impl ParsedSpec {
    /// The stored block for this spec.
    pub fn into_block(self, id: String) -> GeneratedUiBlock {
        GeneratedUiBlock {
            version: GENERATED_UI_VERSION,
            id,
            root: self.root,
            elements: self.elements,
            pressed: None,
        }
    }
}

/// The JSON Schema the model reads. Every rule beyond the element shape is checked
/// by [`parse_spec`], which answers with issues the agent can act on.
fn show_ui_json_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "root": { "type": "string", "description": "The id of the element drawn first." },
            "elements": {
                "type": "object",
                "description": "Each element by its id. Call ui_reference for the types, their props and their limits.",
                "additionalProperties": {
                    "type": "object",
                    "properties": {
                        "type": { "type": "string", "enum": ELEMENT_TYPES },
                        "props": { "type": "object" },
                        "children": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["type"]
                }
            }
        },
        "required": ["root", "elements"],
        "additionalProperties": false
    })
}

/// The tool's input schema. `execute` receives the input as the model sent it, so
/// [`parse_spec`] reports every problem in one result.
pub fn show_ui_input_schema() -> Schema {
    json_schema_with_validator(show_ui_json_schema(), Arc::new(|value| Ok(value.clone())))
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Collects the issues of one spec, each prefixed with where it is.
#[derive(Default)]
struct Issues(Vec<String>);

impl Issues {
    fn add(&mut self, at: &str, message: impl Into<String>) {
        self.0.push(format!("{at}: {}", message.into()));
    }

    /// A text that has to hold `min..=max` UTF-16 code units.
    fn length(&mut self, at: &str, text: &str, min: usize, max: usize) {
        let length = utf16_len(text);
        if length < min || length > max {
            self.add(
                at,
                format!("must be {min} to {max} characters, not {length}"),
            );
        }
    }

    fn count(&mut self, at: &str, count: usize, min: usize, max: usize) {
        if count < min || count > max {
            self.add(at, format!("must have {min} to {max} entries, not {count}"));
        }
    }
}

/// Keys a json-render spec uses for state, repeats, conditions and events. The
/// catalog is static, so each one is an issue.
fn binding_issues(at: &str, value: &Value, issues: &mut Issues) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                if key.starts_with('$') {
                    issues.add(
                        at,
                        format!(
                            "`{key}` is a data binding, and a UI holds none: write the values themselves"
                        ),
                    );
                    continue;
                }
                binding_issues(&format!("{at}.{key}"), inner, issues);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                binding_issues(&format!("{at}[{index}]"), item, issues);
            }
        }
        _ => {}
    }
}

fn check_table(at: &str, table: &UiTableProps, issues: &mut Issues) -> usize {
    issues.count(&format!("{at}.props.columns"), table.columns.len(), 1, 20);
    issues.count(&format!("{at}.props.rows"), table.rows.len(), 1, 99);
    for (index, row) in table.rows.iter().enumerate() {
        if row.len() != table.columns.len() {
            issues.add(
                &format!("{at}.props.rows[{index}]"),
                format!(
                    "must have one cell per column ({}), not {}",
                    table.columns.len(),
                    row.len()
                ),
            );
        }
    }
    table
        .columns
        .iter()
        .chain(table.rows.iter().flatten())
        .map(|cell| utf16_len(cell))
        .sum()
}

fn check_comparison(at: &str, comparison: &UiComparisonProps, issues: &mut Issues) -> usize {
    issues.count(&format!("{at}.props.rows"), comparison.rows.len(), 1, 99);
    issues.count(
        &format!("{at}.props.options"),
        comparison.options.len(),
        2,
        4,
    );
    for (index, option) in comparison.options.iter().enumerate() {
        let option_at = format!("{at}.props.options[{index}]");
        issues.length(&format!("{option_at}.title"), &option.title, 1, 100);
        if option.values.len() != comparison.rows.len() {
            issues.add(
                &format!("{option_at}.values"),
                format!(
                    "must have one value per row ({}), not {}",
                    comparison.rows.len(),
                    option.values.len()
                ),
            );
        }
    }
    comparison
        .rows
        .iter()
        .chain(comparison.options.iter().map(|option| &option.title))
        .chain(comparison.options.iter().flat_map(|option| &option.values))
        .map(|cell| utf16_len(cell))
        .sum()
}

fn check_unique(at: &str, names: &[String], issues: &mut Issues) {
    let mut seen = HashSet::new();
    for name in names {
        if !seen.insert(name) {
            issues.add(
                at,
                format!("\"{name}\" appears twice; names must be unique"),
            );
        }
    }
}

fn check_chart(at: &str, chart: &UiChartProps, issues: &mut Issues) {
    issues.length(&format!("{at}.props.title"), &chart.title, 1, 50);
    for (field, label) in [("xLabel", &chart.x_label), ("yLabel", &chart.y_label)] {
        if let Some(label) = label {
            issues.length(&format!("{at}.props.{field}"), label, 1, 50);
        }
    }
    let max_categories = if chart.kind == UiChartKind::Pie {
        12
    } else {
        20
    };
    issues.count(
        &format!("{at}.props.categories"),
        chart.categories.len(),
        1,
        max_categories,
    );
    for (index, category) in chart.categories.iter().enumerate() {
        issues.length(&format!("{at}.props.categories[{index}]"), category, 1, 20);
    }
    check_unique(&format!("{at}.props.categories"), &chart.categories, issues);
    let max_series = if chart.kind == UiChartKind::Pie {
        1
    } else {
        12
    };
    issues.count(
        &format!("{at}.props.series"),
        chart.series.len(),
        1,
        max_series,
    );
    let names: Vec<String> = chart.series.iter().map(|s| s.name.clone()).collect();
    check_unique(&format!("{at}.props.series"), &names, issues);
    for (index, series) in chart.series.iter().enumerate() {
        let series_at = format!("{at}.props.series[{index}]");
        issues.length(&format!("{series_at}.name"), &series.name, 1, 20);
        if series.values.len() != chart.categories.len() {
            issues.add(
                &format!("{series_at}.values"),
                format!(
                    "must have one value per category ({}), not {}",
                    chart.categories.len(),
                    series.values.len()
                ),
            );
        }
        if series.values.iter().any(|value| !value.is_finite()) {
            issues.add(&format!("{series_at}.values"), "must be finite numbers");
        }
        if chart.kind == UiChartKind::Pie && series.values.iter().any(|value| *value <= 0.0) {
            issues.add(
                &format!("{series_at}.values"),
                "a pie chart's values must be greater than 0",
            );
        }
    }
}

fn check_image(at: &str, attachment: &str, issues: &mut Issues) {
    let id = attachment.strip_prefix(IMAGE_SCHEME).unwrap_or_default();
    if uuid::Uuid::parse_str(id).is_err() {
        issues.add(
            &format!("{at}.props.attachment"),
            "must be attachment:<id>, the id share_file gave for an image you shared in this turn",
        );
    }
}

fn check_url(at: &str, url: &str, issues: &mut Issues) {
    let https = url::Url::parse(url).is_ok_and(|parsed| parsed.scheme() == "https");
    if !https || utf16_len(url) > 3_000 {
        issues.add(at, "must be an https URL of at most 3000 characters");
    }
}

/// The props rules of one element. Answers how many table characters it holds.
fn check_props(at: &str, element: &GeneratedUiElement, issues: &mut Issues) -> usize {
    match element {
        GeneratedUiElement::Card { props, .. } => {
            if let Some(title) = &props.title {
                issues.length(&format!("{at}.props.title"), title, 1, 150);
            }
        }
        GeneratedUiElement::Heading { props } => {
            issues.length(&format!("{at}.props.text"), &props.text, 1, 150);
        }
        GeneratedUiElement::Text { props } => {
            issues.length(&format!("{at}.props.text"), &props.text, 1, 12_000);
        }
        GeneratedUiElement::Note { props } => {
            issues.length(&format!("{at}.props.text"), &props.text, 1, 300);
        }
        GeneratedUiElement::Fields { props } => {
            issues.count(&format!("{at}.props.fields"), props.fields.len(), 1, 10);
            for (index, field) in props.fields.iter().enumerate() {
                let field_at = format!("{at}.props.fields[{index}]");
                issues.length(&format!("{field_at}.label"), &field.label, 1, 100);
                issues.length(&format!("{field_at}.value"), &field.value, 1, 1_900);
            }
        }
        GeneratedUiElement::Table { props } => return check_table(at, props, issues),
        GeneratedUiElement::Comparison { props } => return check_comparison(at, props, issues),
        GeneratedUiElement::Chart { props } => check_chart(at, props, issues),
        GeneratedUiElement::Checklist { props } => {
            issues.count(&format!("{at}.props.items"), props.items.len(), 1, 50);
            for (index, item) in props.items.iter().enumerate() {
                issues.length(
                    &format!("{at}.props.items[{index}].text"),
                    &item.text,
                    1,
                    300,
                );
            }
        }
        GeneratedUiElement::Image { props } => {
            check_image(at, &props.attachment, issues);
            issues.length(&format!("{at}.props.alt"), &props.alt, 1, 2_000);
        }
        GeneratedUiElement::LinkButton { props } => {
            issues.length(&format!("{at}.props.label"), &props.label, 1, 75);
            check_url(&format!("{at}.props.url"), &props.url, issues);
        }
        GeneratedUiElement::Button { props } => {
            issues.length(&format!("{at}.props.label"), &props.label, 1, 75);
        }
        GeneratedUiElement::Divider {} | GeneratedUiElement::Actions { .. } => {}
    }
    0
}

fn is_button(element: &GeneratedUiElement) -> bool {
    matches!(
        element,
        GeneratedUiElement::Button { .. } | GeneratedUiElement::LinkButton { .. }
    )
}

/// Which child a parent may hold, or why it may not.
fn child_issue(parent: &GeneratedUiElement, child: &GeneratedUiElement) -> Option<&'static str> {
    match parent {
        GeneratedUiElement::Actions { .. } if !is_button(child) => {
            Some("an Actions holds only Button and LinkButton elements")
        }
        GeneratedUiElement::Card { .. } if is_button(child) => {
            Some("a Button or LinkButton sits inside an Actions, not directly in a Card")
        }
        GeneratedUiElement::Card { .. } if matches!(child, GeneratedUiElement::Card { .. }) => {
            Some("a Card cannot hold another Card")
        }
        _ => None,
    }
}

/// The tree rules: every id exists, every element but the root has exactly one
/// parent and can be reached from the root, and each parent holds what it may.
fn check_tree(spec: &ParsedSpec, issues: &mut Issues) {
    let Some(root) = spec.elements.get(&spec.root) else {
        issues.add("root", format!("\"{}\" is not an element id", spec.root));
        return;
    };
    if is_button(root) {
        issues.add("root", "a Button or LinkButton sits inside an Actions");
    }
    let mut parents: HashMap<&str, &str> = HashMap::new();
    for (id, element) in &spec.elements {
        let at = format!("elements.{id}");
        if let GeneratedUiElement::Actions { children } = element {
            issues.count(
                &format!("{at}.children"),
                children.len(),
                1,
                MAX_ACTIONS_CHILDREN,
            );
        }
        if let GeneratedUiElement::Card { children, .. } = element
            && children.is_empty()
        {
            issues.add(
                &format!("{at}.children"),
                "a Card holds at least one element",
            );
        }
        for child_id in element.children() {
            let Some(child) = spec.elements.get(child_id) else {
                issues.add(
                    &format!("{at}.children"),
                    format!("\"{child_id}\" is not an element id"),
                );
                continue;
            };
            if child_id == &spec.root {
                issues.add(&format!("{at}.children"), "the root cannot be a child");
                continue;
            }
            if let Some(first) = parents.insert(child_id.as_str(), id.as_str()) {
                issues.add(
                    &format!("{at}.children"),
                    format!("\"{child_id}\" is already a child of \"{first}\"; each element has one parent"),
                );
                continue;
            }
            if let Some(issue) = child_issue(element, child) {
                issues.add(
                    &format!("{at}.children"),
                    format!("\"{child_id}\": {issue}"),
                );
            }
        }
    }
    for id in spec.elements.keys() {
        if id != &spec.root && !parents.contains_key(id.as_str()) {
            issues.add(
                &format!("elements.{id}"),
                "is not a child of any element; every element but the root has a parent",
            );
        }
    }
}

/// The `show_ui` input as a UI, or every issue in it.
pub fn parse_spec(input: &Value) -> Result<ParsedSpec, Vec<String>> {
    let mut issues = Issues::default();
    let root = input.get("root").and_then(Value::as_str);
    let elements = input.get("elements").and_then(Value::as_object);
    let (Some(root), Some(elements)) = (root, elements) else {
        return Err(vec![
            "input: must be { root, elements }, with root an element id and elements an object of elements by id".to_string(),
        ]);
    };
    issues.count("elements", elements.len(), 1, MAX_ELEMENTS);

    let mut parsed = IndexMap::new();
    let (mut tables, mut charts, mut table_chars) = (0, 0, 0);
    for (id, value) in elements {
        let at = format!("elements.{id}");
        if !ELEMENT_ID.is_match(id) {
            issues.add(
                &at,
                "an element id is 1 to 64 characters of A-Z, a-z, 0-9, _ and -",
            );
        }
        let before = issues.0.len();
        binding_issues(&at, value, &mut issues);
        if issues.0.len() > before {
            continue;
        }
        let element: GeneratedUiElement = match serde_json::from_value(value.clone()) {
            Ok(element) => element,
            Err(error) => {
                issues.add(&at, error.to_string());
                continue;
            }
        };
        table_chars += check_props(&at, &element, &mut issues);
        match element {
            GeneratedUiElement::Table { .. } | GeneratedUiElement::Comparison { .. } => tables += 1,
            GeneratedUiElement::Chart { .. } => charts += 1,
            _ => {}
        }
        parsed.insert(id.clone(), element);
    }
    if tables > MAX_TABLES {
        issues.add("elements", "a UI holds at most one Table or Comparison");
    }
    if charts > MAX_CHARTS {
        issues.add(
            "elements",
            format!("a UI holds at most {MAX_CHARTS} charts, not {charts}"),
        );
    }
    if table_chars > MAX_TABLE_CHARS {
        issues.add(
            "elements",
            format!("the table cells hold {table_chars} characters together; the most is {MAX_TABLE_CHARS}"),
        );
    }
    let spec = ParsedSpec {
        root: root.to_string(),
        elements: parsed,
    };
    if issues.0.is_empty() {
        check_tree(&spec, &mut issues);
    }
    if issues.0.is_empty() {
        Ok(spec)
    } else {
        Err(issues.0)
    }
}

/// A stored block, or `None` when the first block of a row is not one this version reads.
pub fn parse_block(block: &Value) -> Option<GeneratedUiBlock> {
    if block.get("type").and_then(Value::as_str) != Some("generated_ui") {
        return None;
    }
    let parsed: GeneratedUiBlock = serde_json::from_value(block.clone()).ok()?;
    (parsed.version == GENERATED_UI_VERSION).then_some(parsed)
}

/// Whether a row's blocks hold a generated UI, of any version.
pub fn is_generated_ui(blocks: Option<&Value>) -> bool {
    blocks
        .and_then(|blocks| blocks.get(0))
        .and_then(|block| block.get("type"))
        .and_then(Value::as_str)
        == Some("generated_ui")
}

/// The attachment ids of a UI's images, in element order.
pub fn image_attachment_ids(elements: &IndexMap<String, GeneratedUiElement>) -> Vec<String> {
    elements
        .values()
        .filter_map(|element| match element {
            GeneratedUiElement::Image { props } => props
                .attachment
                .strip_prefix(IMAGE_SCHEME)
                .map(str::to_string),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
#[path = "generated_ui_schema_tests.rs"]
mod tests;
