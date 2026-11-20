//! What a question card may hold: the limits, and the shapes the `ask_questions`
//! tool, the stored block and the answer route accept.
//!
//! Each shape is the JSON Schema `askQuestionsInputSchema`, `questionCardBlockSchema`
//! and `answerBodySchema` produce, checked as zod checks them. The checks a JSON
//! Schema cannot hold run around it: the trims before, and the option-label rules
//! after, in the order zod reports them.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use serde_json::{Value, json};

use crate::ai::{Schema, SchemaIssuesError, json_schema_with_validator, zod_schema};
use crate::protocol::chat_protocol::{QuestionCardAnswer, QuestionCardBlock};
use crate::support::js;

pub const ASK_QUESTIONS_TOOL_NAME: &str = "ask_questions";

pub const MAX_QUESTIONS: usize = 7;
pub const MAX_OPTIONS: usize = 4;
pub const MAX_OTHER_CHARS: u64 = 500;

/// One question, as the tool input and the stored block both write it.
fn question_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "text": { "type": "string", "minLength": 1, "maxLength": 300, "description": "The question." },
            "header": { "description": "A short topic label, such as \"Budget\".", "type": "string", "maxLength": 40 },
            "options": {
                "minItems": 2,
                "maxItems": 4,
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "The answer, in a few words." },
                        "detail": { "description": "One line on what this answer means.", "type": "string", "maxLength": 200 }
                    },
                    "required": ["label"],
                    "additionalProperties": false
                }
            },
            "recommended": { "description": "The label of the option you recommend, written exactly as that label.", "type": "string" },
            "allowOther": { "default": true, "description": "Offer \"Other…\" with a text field.", "type": "boolean" },
            "multiSelect": { "default": false, "description": "Let the user choose several options.", "type": "boolean" }
        },
        "required": ["text", "options"],
        "additionalProperties": false
    })
}

fn questions_schema() -> Value {
    json!({ "minItems": 1, "maxItems": MAX_QUESTIONS, "type": "array", "items": question_schema() })
}

fn answer_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "options": {
                "maxItems": MAX_OPTIONS,
                "type": "array",
                "items": { "type": "integer", "minimum": 0, "maximum": 9007199254740991_u64 }
            },
            "other": { "type": "string", "maxLength": MAX_OTHER_CHARS }
        },
        "required": ["options"],
        "additionalProperties": false
    })
}

/// The `ask_questions` input as the provider receives it.
pub fn ask_questions_json_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "intro": { "description": "One short plain-text line shown above the questions.", "type": "string", "maxLength": 300 },
            "questions": questions_schema()
        },
        "required": ["questions"],
        "additionalProperties": false
    })
}

static ASK_QUESTIONS: LazyLock<Schema> = LazyLock::new(|| zod_schema(ask_questions_json_schema()));

static BLOCK: LazyLock<Schema> = LazyLock::new(|| {
    zod_schema(json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "type": { "type": "string", "const": "question_card" },
            "id": { "type": "string" },
            "status": { "type": "string", "enum": ["waiting", "answered", "answered_in_chat"] },
            "intro": { "type": "string", "maxLength": 300 },
            "questions": questions_schema(),
            "otherMaxLength": { "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991_u64 },
            "answers": { "type": "array", "items": answer_schema() },
            "answeredBy": {
                "anyOf": [
                    {
                        "type": "object",
                        "properties": { "id": { "type": "string" }, "name": { "type": "string" } },
                        "required": ["id", "name"],
                        "additionalProperties": false
                    },
                    { "type": "null" }
                ]
            }
        },
        "required": ["type", "id", "status", "questions", "otherMaxLength"],
        "additionalProperties": false
    }))
});

static ANSWER_BODY: LazyLock<Schema> = LazyLock::new(|| {
    zod_schema(json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "answers": { "minItems": 1, "maxItems": MAX_QUESTIONS, "type": "array", "items": answer_schema() }
        },
        "required": ["answers"],
        "additionalProperties": false
    }))
});

/// `String.prototype.trim` on the string at `key`, as zod's `.trim()` does before its length checks.
fn trim_field(object: &mut Value, key: &str) {
    if let Some(Value::String(text)) = object.get_mut(key) {
        *text = js::trim(text).to_string();
    }
}

fn trim_questions(value: &mut Value) {
    let Some(questions) = value.get_mut("questions").and_then(Value::as_array_mut) else {
        return;
    };
    for question in questions.iter_mut().filter(|q| q.is_object()) {
        trim_field(question, "text");
        trim_field(question, "header");
        let Some(options) = question.get_mut("options").and_then(Value::as_array_mut) else {
            continue;
        };
        for option in options.iter_mut().filter(|o| o.is_object()) {
            trim_field(option, "label");
            trim_field(option, "detail");
        }
    }
}

fn trim_answers(answers: Option<&mut Value>) {
    let Some(answers) = answers.and_then(Value::as_array_mut) else {
        return;
    };
    for answer in answers.iter_mut().filter(|a| a.is_object()) {
        trim_field(answer, "other");
    }
}

/// The issues of the question's own rules: distinct labels, and a recommended
/// option that is one of them. None when its options are not readable labels.
fn question_rule_issues(question: &Value, index: usize) -> Vec<Value> {
    let Some(options) = question.get("options").and_then(Value::as_array) else {
        return Vec::new();
    };
    let labels: Option<Vec<&str>> = options
        .iter()
        .map(|option| option.get("label").and_then(Value::as_str))
        .collect();
    let Some(labels) = labels else {
        return Vec::new();
    };
    let mut issues = Vec::new();
    let distinct: HashSet<&str> = labels.iter().copied().collect();
    if distinct.len() != labels.len() {
        issues.push(json!({
            "code": "custom",
            "path": ["questions", index, "options"],
            "message": "Each option label must be different."
        }));
    }
    if let Some(recommended) = question.get("recommended").and_then(Value::as_str)
        && !labels.contains(&recommended)
    {
        issues.push(json!({
            "code": "custom",
            "path": ["questions", index, "recommended"],
            "message": "recommended must equal one option label."
        }));
    }
    issues
}

/// The question index an issue belongs to, when its path is under `questions[i]`.
fn question_of(issue: &Value) -> Option<u64> {
    let path = issue.get("path")?.as_array()?;
    (path.first()?.as_str()? == "questions")
        .then(|| path.get(1).and_then(Value::as_u64))
        .flatten()
}

fn is_questions_issue(issue: &Value) -> bool {
    issue
        .get("path")
        .and_then(Value::as_array)
        .and_then(|path| path.first())
        .and_then(Value::as_str)
        == Some("questions")
}

/// Parses `value` (already trimmed) against `schema`, then runs each question's
/// rules. zod runs a question's rules after its own fields and before the next
/// question, and skips them when a field has the wrong type.
fn parse_with_rules(schema: &Schema, value: &Value) -> anyhow::Result<Value> {
    let (parsed, mut issues) = match schema.validate(value) {
        Ok(parsed) => (Some(parsed), Vec::new()),
        Err(error) => match error.downcast::<SchemaIssuesError>() {
            Ok(issues) => (None, issues.issues),
            Err(error) => return Err(error),
        },
    };
    let questions = value
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (index, question) in questions.iter().enumerate() {
        let own = |issue: &&Value| question_of(issue) == Some(index as u64);
        if issues
            .iter()
            .filter(own)
            .any(|issue| issue.get("code").and_then(Value::as_str) == Some("invalid_type"))
        {
            continue;
        }
        let rules = question_rule_issues(question, index);
        if rules.is_empty() {
            continue;
        }
        let at = issues
            .iter()
            .rposition(|issue| question_of(issue).is_some_and(|i| i <= index as u64))
            .map(|last| last + 1)
            .or_else(|| issues.iter().position(is_questions_issue))
            .unwrap_or(issues.len());
        issues.splice(at..at, rules);
    }
    match parsed {
        Some(parsed) if issues.is_empty() => Ok(parsed),
        _ => Err(SchemaIssuesError::new(issues).into()),
    }
}

/// `askQuestionsInputSchema.parse`: the input with its strings trimmed and its
/// defaults filled in, or zod's issues.
pub fn parse_ask_questions_input(value: &Value) -> anyhow::Result<Value> {
    let mut trimmed = value.clone();
    if trimmed.is_object() {
        trim_field(&mut trimmed, "intro");
        trim_questions(&mut trimmed);
    }
    parse_with_rules(&ASK_QUESTIONS, &trimmed)
}

/// The tool's input schema: the JSON Schema the provider reads, checked as zod checks it.
pub fn ask_questions_input_schema() -> Schema {
    json_schema_with_validator(
        ask_questions_json_schema(),
        Arc::new(parse_ask_questions_input),
    )
}

/// A card as a message stores it, or `None` when the block is not a well-formed
/// card. Other routes can store any block, so a read checks the shape.
pub fn parse_question_card(block: &Value) -> Option<QuestionCardBlock> {
    let mut trimmed = block.clone();
    if !trimmed.is_object() {
        return None;
    }
    trim_questions(&mut trimmed);
    trim_answers(trimmed.get_mut("answers"));
    let parsed = parse_with_rules(&BLOCK, &trimmed).ok()?;
    serde_json::from_value(parsed).ok()
}

/// The answer route's body: one entry per question, in the card's order.
pub fn parse_answer_body(body: &Value) -> Option<Vec<QuestionCardAnswer>> {
    let mut trimmed = body.clone();
    if trimmed.is_object() {
        trim_answers(trimmed.get_mut("answers"));
    }
    let parsed = ANSWER_BODY.validate(&trimmed).ok()?;
    serde_json::from_value(parsed.get("answers")?.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(label: &str) -> Value {
        json!({ "label": label })
    }

    fn question(over: Value) -> Value {
        let mut question = json!({ "text": "Which one?", "options": [option("A"), option("B")] });
        for (key, value) in over.as_object().unwrap() {
            question[key] = value.clone();
        }
        question
    }

    fn accepts(input: Value) -> bool {
        parse_ask_questions_input(&input).is_ok()
    }

    #[test]
    fn defaults_allow_other_on_and_multi_select_off() {
        let parsed =
            parse_ask_questions_input(&json!({ "questions": [question(json!({}))] })).unwrap();
        assert_eq!(parsed["questions"][0]["allowOther"], json!(true));
        assert_eq!(parsed["questions"][0]["multiSelect"], json!(false));
    }

    #[test]
    fn refuses_what_the_schema_refuses() {
        let five: Vec<Value> = ["A", "B", "C", "D", "E"].map(option).to_vec();
        let cases = [
            ("no questions", json!({ "questions": [] })),
            (
                "eight questions",
                json!({ "questions": vec![question(json!({})); 8] }),
            ),
            (
                "one option",
                json!({ "questions": [question(json!({ "options": [option("A")] }))] }),
            ),
            (
                "five options",
                json!({ "questions": [question(json!({ "options": five }))] }),
            ),
            (
                "question text over 300",
                json!({ "questions": [question(json!({ "text": "x".repeat(301) }))] }),
            ),
            (
                "a header over 40",
                json!({ "questions": [question(json!({ "header": "x".repeat(41) }))] }),
            ),
            (
                "a label over 80",
                json!({ "questions": [question(json!({ "options": [option(&"x".repeat(81)), option("B")] }))] }),
            ),
            (
                "a detail over 200",
                json!({ "questions": [question(json!({ "options": [{ "label": "A", "detail": "x".repeat(201) }, option("B")] }))] }),
            ),
            (
                "an intro over 300",
                json!({ "intro": "x".repeat(301), "questions": [question(json!({}))] }),
            ),
            (
                "two options with one label",
                json!({ "questions": [question(json!({ "options": [option("A"), option("A")] }))] }),
            ),
            (
                "a recommended option that is not offered",
                json!({ "questions": [question(json!({ "recommended": "C" }))] }),
            ),
        ];
        for (name, input) in cases {
            assert!(!accepts(input), "accepts {name}");
        }
    }

    #[test]
    fn takes_every_field_at_its_limit() {
        let question = json!({
            "text": "x".repeat(300),
            "header": "x".repeat(40),
            "options": [
                { "label": "a".repeat(80), "detail": "x".repeat(200) },
                { "label": "b".repeat(80) },
                { "label": "c".repeat(80) },
                { "label": "d".repeat(80) }
            ],
            "recommended": "a".repeat(80)
        });
        assert!(accepts(
            json!({ "intro": "x".repeat(300), "questions": vec![question; 7] })
        ));
    }

    #[test]
    fn reports_the_issues_in_the_order_zod_reports_them() {
        // Captured from zod: a question's own rules follow its fields and precede the next question.
        let q = question;
        let input = json!({
            "intro": "y".repeat(301),
            "questions": [
                q(json!({})),
                q(json!({ "options": [option("A"), option("A")] })),
                q(json!({})), q(json!({})), q(json!({})), q(json!({})), q(json!({})),
                q(json!({ "text": "" }))
            ]
        });
        let error = parse_ask_questions_input(&input).unwrap_err();
        let issues = error.downcast::<SchemaIssuesError>().unwrap().issues;
        assert_eq!(
            Value::Array(issues),
            json!([
                { "origin": "string", "code": "too_big", "maximum": 300, "inclusive": true, "path": ["intro"], "message": "Too big: expected string to have <=300 characters" },
                { "code": "custom", "path": ["questions", 1, "options"], "message": "Each option label must be different." },
                { "origin": "string", "code": "too_small", "minimum": 1, "inclusive": true, "path": ["questions", 7, "text"], "message": "Too small: expected string to have >=1 characters" },
                { "origin": "array", "code": "too_big", "maximum": 7, "inclusive": true, "path": ["questions"], "message": "Too big: expected array to have <=7 items" }
            ])
        );
    }

    #[test]
    fn skips_the_label_rules_of_a_question_with_a_field_of_the_wrong_type() {
        let input = json!({ "questions": [question(json!({ "options": [{ "label": 1 }, option("A")], "recommended": "Z" }))] });
        let issues = parse_ask_questions_input(&input)
            .unwrap_err()
            .downcast::<SchemaIssuesError>()
            .unwrap()
            .issues;
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0]["code"], json!("invalid_type"));
    }

    #[test]
    fn trims_the_text_fields_before_their_limits() {
        let parsed = parse_ask_questions_input(&json!({
            "intro": "  A few decisions.  ",
            "questions": [{ "text": "  Which? ", "options": [{ "label": " A " }, { "label": "B" }], "recommended": "A" }]
        }))
        .unwrap();
        assert_eq!(parsed["intro"], json!("A few decisions."));
        assert_eq!(parsed["questions"][0]["text"], json!("Which?"));
        assert_eq!(parsed["questions"][0]["options"][0]["label"], json!("A"));
    }

    #[test]
    fn reads_the_answer_body_as_the_route_takes_it() {
        let parse = |body: Value| parse_answer_body(&body);
        assert!(parse(json!({})).is_none());
        assert!(parse(json!({ "answers": [] })).is_none());
        assert!(parse(json!({ "answers": vec![json!({ "options": [] }); 8] })).is_none());
        assert!(parse(json!({ "answers": [{ "options": [-1] }] })).is_none());
        assert!(parse(json!({ "answers": [{ "options": [0.5] }] })).is_none());
        assert!(parse(json!({ "answers": [{ "options": [0, 1, 2, 3, 4] }] })).is_none());
        assert!(
            parse(json!({ "answers": [{ "options": [], "other": "x".repeat(501) }] })).is_none()
        );
        assert_eq!(
            parse(json!({ "answers": [{ "options": [], "other": "x".repeat(500) }] })).unwrap()[0]
                .other
                .as_deref()
                .map(str::len),
            Some(500)
        );
        assert_eq!(
            parse(json!({ "answers": [{ "options": [1] }] })).unwrap()[0].options,
            vec![1]
        );
    }

    #[test]
    fn reads_a_stored_card_and_refuses_a_malformed_one() {
        let card = json!({
            "type": "question_card",
            "id": "card-1",
            "status": "waiting",
            "otherMaxLength": 500,
            "questions": [{ "text": "Pick?", "options": [option("A"), option("B")], "allowOther": true, "multiSelect": false }]
        });
        let parsed = parse_question_card(&card).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), card);
        assert!(parse_question_card(&json!({ "type": "question_card", "id": "forged", "status": "waiting", "questions": "none" })).is_none());
        assert!(
            parse_question_card(&json!({ "type": "coding_agent_sign_in", "id": "x" })).is_none()
        );
    }
}
