//! Validation of a value against the JSON Schema a zod schema produced, with zod's
//! results: the same issues in the same words and order, and the same parsed value
//! (keys in schema order, unknown keys stripped, defaults filled in).
//!
//! The walk covers the keywords zod emits for the schemas the runtime writes. A
//! keyword it does not model (`pattern`, `format`, `$ref`, …) is still enforced by a
//! JSON Schema validator over the input, which reports a `custom` issue.

use serde_json::{Map, Value, json};

use super::errors::SchemaIssuesError;
use super::json::js_stringify;

const SAFE_INT: f64 = 9_007_199_254_740_991.0;

/// A compiled zod-produced schema.
pub(crate) struct ZodValidator {
    schema: Value,
    fallback: Option<jsonschema::Validator>,
}

impl ZodValidator {
    pub(crate) fn new(schema: &Value) -> Self {
        let relaxed = without_closed_objects(schema);
        let fallback = jsonschema::validator_for(&relaxed).ok();
        Self {
            schema: schema.clone(),
            fallback,
        }
    }

    /// The parsed value, or the issues zod would report.
    pub(crate) fn parse(&self, value: &Value) -> Result<Value, SchemaIssuesError> {
        let mut issues = Vec::new();
        let out = walk(&self.schema, value, &[], &mut issues);
        if !issues.is_empty() {
            return Err(SchemaIssuesError::new(issues));
        }
        if let Some(validator) = &self.fallback {
            let custom: Vec<Value> = validator
                .iter_errors(value)
                .map(|err| {
                    json!({
                        "code": "custom",
                        "path": pointer_path(&err.instance_path.to_string()),
                        "message": err.to_string(),
                    })
                })
                .collect();
            if !custom.is_empty() {
                return Err(SchemaIssuesError::new(custom));
            }
        }
        Ok(out)
    }
}

/// The schema with `additionalProperties: false` removed: the SDK closes every
/// object it converts, while zod strips unknown keys rather than refusing them.
fn without_closed_objects(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, value) in map {
                if key == "additionalProperties" && value == &Value::Bool(false) {
                    continue;
                }
                out.insert(key.clone(), without_closed_objects(value));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(without_closed_objects).collect()),
        other => other.clone(),
    }
}

fn pointer_path(pointer: &str) -> Value {
    let parts: Vec<Value> = pointer
        .split('/')
        .skip(1)
        .map(|segment| {
            let text = segment.replace("~1", "/").replace("~0", "~");
            match text.parse::<u64>() {
                Ok(n) if !text.starts_with('0') || text == "0" => json!(n),
                _ => Value::String(text),
            }
        })
        .collect();
    Value::Array(parts)
}

fn path_value(path: &[Value]) -> Value {
    Value::Array(path.to_vec())
}

fn with(path: &[Value], segment: Value) -> Vec<Value> {
    let mut next = path.to_vec();
    next.push(segment);
    next
}

/// zod's name for the type of a received value.
fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn is_record(schema: &Map<String, Value>) -> bool {
    !schema.contains_key("properties")
        && matches!(schema.get("additionalProperties"), Some(Value::Object(_)))
}

/// zod's name for an expected JSON Schema type.
fn expected_name(ty: &str, schema: &Map<String, Value>) -> &'static str {
    match ty {
        "string" => "string",
        "number" | "integer" => "number",
        "boolean" => "boolean",
        "array" => "array",
        "null" => "null",
        "object" => {
            if is_record(schema) {
                "record"
            } else {
                "object"
            }
        }
        _ => "unknown",
    }
}

fn matches_type(ty: &str, value: &Value) -> bool {
    match ty {
        "string" => value.is_string(),
        "number" | "integer" => value.is_number(),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn primitive_text(value: &Value) -> String {
    match value {
        Value::String(_) => js_stringify(value),
        Value::Number(n) => match n.as_f64() {
            Some(f) => super::json::js_number_text(f),
            None => n.to_string(),
        },
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        other => js_stringify(other),
    }
}

fn invalid_type(expected: &str, value: Option<&Value>, path: &[Value]) -> Value {
    json!({
        "expected": expected,
        "code": "invalid_type",
        "path": path_value(path),
        "message": format!("Invalid input: expected {}, received {}", expected, received(value)),
    })
}

fn invalid_value(values: &[Value], path: &[Value]) -> Value {
    let message = if values.len() == 1 {
        format!("Invalid input: expected {}", primitive_text(&values[0]))
    } else {
        format!(
            "Invalid option: expected one of {}",
            values
                .iter()
                .map(primitive_text)
                .collect::<Vec<_>>()
                .join("|")
        )
    };
    json!({
        "code": "invalid_value",
        "values": values,
        "path": path_value(path),
        "message": message,
    })
}

fn size_issue(origin: &str, small: bool, limit: f64, inclusive: bool, path: &[Value]) -> Value {
    let op = match (small, inclusive) {
        (true, true) => ">=",
        (true, false) => ">",
        (false, true) => "<=",
        (false, false) => "<",
    };
    let limit_text = super::json::js_number_text(limit);
    let message = match origin {
        "string" => format!(
            "{}: expected string to have {}{} characters",
            if small { "Too small" } else { "Too big" },
            op,
            limit_text
        ),
        "array" => format!(
            "{}: expected array to have {}{} items",
            if small { "Too small" } else { "Too big" },
            op,
            limit_text
        ),
        _ => format!(
            "{}: expected {} to be {}{}",
            if small { "Too small" } else { "Too big" },
            origin,
            op,
            limit_text
        ),
    };
    let mut issue = Map::new();
    issue.insert("origin".into(), json!(origin));
    issue.insert(
        "code".into(),
        json!(if small { "too_small" } else { "too_big" }),
    );
    issue.insert(
        if small { "minimum" } else { "maximum" }.into(),
        crate::support::js::number(limit),
    );
    issue.insert("inclusive".into(), json!(inclusive));
    issue.insert("path".into(), path_value(path));
    issue.insert("message".into(), json!(message));
    Value::Object(issue)
}

fn union_issue(branch_issues: Vec<Vec<Value>>, path: &[Value]) -> Value {
    json!({
        "code": "invalid_union",
        "errors": branch_issues.into_iter().map(Value::Array).collect::<Vec<_>>(),
        "path": path_value(path),
        "message": "Invalid input",
    })
}

/// The types a schema names, and whether `null` is one of them.
fn types_of(schema: &Map<String, Value>) -> Option<(Vec<String>, bool)> {
    match schema.get("type")? {
        Value::String(ty) => Some((vec![ty.clone()], ty == "null")),
        Value::Array(list) => {
            let names: Vec<String> = list
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            let nullable = names.iter().any(|n| n == "null");
            Some((
                names.into_iter().filter(|n| n != "null").collect(),
                nullable,
            ))
        }
        _ => None,
    }
}

/// The issue zod reports when a required value is missing.
fn missing(schema: &Value, path: &[Value], issues: &mut Vec<Value>) {
    let Value::Object(map) = schema else { return };
    if let Some(Value::Array(values)) = map.get("enum") {
        issues.push(invalid_value(values, path));
        return;
    }
    if let Some(value) = map.get("const") {
        issues.push(invalid_value(std::slice::from_ref(value), path));
        return;
    }
    if let Some(Value::Array(branches)) = map.get("anyOf").or_else(|| map.get("oneOf")) {
        if let Some(inner) = nullable_inner(branches) {
            missing(inner, path, issues);
            return;
        }
        let branch_issues = branches
            .iter()
            .map(|branch| {
                let mut sub = Vec::new();
                missing(branch, &[], &mut sub);
                sub
            })
            .collect();
        issues.push(union_issue(branch_issues, path));
        return;
    }
    let Some((types, _)) = types_of(map) else {
        return;
    };
    if types.len() == 1 {
        issues.push(invalid_type(expected_name(&types[0], map), None, path));
    } else if types.len() > 1 {
        let branch_issues = types
            .iter()
            .map(|ty| vec![invalid_type(expected_name(ty, map), None, &[])])
            .collect();
        issues.push(union_issue(branch_issues, path));
    }
}

/// The non-null branch of `anyOf: [X, { type: 'null' }]`, zod's `.nullable()`.
fn nullable_inner(branches: &[Value]) -> Option<&Value> {
    if branches.len() != 2 {
        return None;
    }
    let is_null = |v: &Value| {
        v.get("type") == Some(&Value::String("null".into()))
            && v.as_object().map(|m| m.len()) == Some(1)
    };
    if is_null(&branches[1]) {
        Some(&branches[0])
    } else if is_null(&branches[0]) {
        Some(&branches[1])
    } else {
        None
    }
}

fn number_of(map: &Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64)
}

fn walk(schema: &Value, value: &Value, path: &[Value], issues: &mut Vec<Value>) -> Value {
    let Value::Object(map) = schema else {
        return value.clone();
    };

    if let Some(Value::Array(branches)) = map.get("anyOf").or_else(|| map.get("oneOf")) {
        if let Some(inner) = nullable_inner(branches) {
            if value.is_null() {
                return Value::Null;
            }
            return walk(inner, value, path, issues);
        }
        let mut branch_issues = Vec::new();
        for branch in branches {
            let mut sub = Vec::new();
            let out = walk(branch, value, &[], &mut sub);
            if sub.is_empty() {
                return out;
            }
            branch_issues.push(sub);
        }
        issues.push(union_issue(branch_issues, path));
        return value.clone();
    }

    if let Some(Value::Array(values)) = map.get("enum") {
        if !values.contains(value) {
            issues.push(invalid_value(values, path));
        }
        return value.clone();
    }
    if let Some(expected) = map.get("const") {
        if expected != value {
            issues.push(invalid_value(std::slice::from_ref(expected), path));
        }
        return value.clone();
    }

    let Some((types, nullable)) = types_of(map) else {
        return value.clone();
    };
    if value.is_null() && nullable {
        return Value::Null;
    }
    let ty = if types.len() <= 1 {
        let ty = types.first().cloned().unwrap_or_else(|| "null".to_string());
        if !matches_type(&ty, value) {
            issues.push(invalid_type(expected_name(&ty, map), Some(value), path));
            return value.clone();
        }
        ty
    } else {
        match types.iter().find(|ty| matches_type(ty, value)) {
            Some(ty) => ty.clone(),
            None => {
                let branch_issues = types
                    .iter()
                    .map(|ty| vec![invalid_type(expected_name(ty, map), Some(value), &[])])
                    .collect();
                issues.push(union_issue(branch_issues, path));
                return value.clone();
            }
        }
    };

    match ty.as_str() {
        "string" => {
            let text = value.as_str().unwrap_or_default();
            let length = crate::support::js::len16(text) as f64;
            if let Some(min) = number_of(map, "minLength")
                && length < min
            {
                issues.push(size_issue("string", true, min, true, path));
            }
            if let Some(max) = number_of(map, "maxLength")
                && length > max
            {
                issues.push(size_issue("string", false, max, true, path));
            }
            value.clone()
        }
        "number" | "integer" => {
            let n = value.as_f64().unwrap_or_default();
            if ty == "integer" && (n.fract() != 0.0 || n.abs() > SAFE_INT) {
                issues.push(json!({
                    "expected": "int",
                    "format": "safeint",
                    "code": "invalid_type",
                    "path": path_value(path),
                    "message": "Invalid input: expected int, received number",
                }));
                return value.clone();
            }
            let safe_bound = |limit: f64| ty == "integer" && limit.abs() == SAFE_INT;
            if let Some(min) = number_of(map, "minimum").filter(|l| !safe_bound(*l))
                && n < min
            {
                issues.push(size_issue("number", true, min, true, path));
            }
            if let Some(min) = number_of(map, "exclusiveMinimum")
                && n <= min
            {
                issues.push(size_issue("number", true, min, false, path));
            }
            if let Some(max) = number_of(map, "maximum").filter(|l| !safe_bound(*l))
                && n > max
            {
                issues.push(size_issue("number", false, max, true, path));
            }
            if let Some(max) = number_of(map, "exclusiveMaximum")
                && n >= max
            {
                issues.push(size_issue("number", false, max, false, path));
            }
            value.clone()
        }
        "array" => {
            let items = value.as_array().cloned().unwrap_or_default();
            let out: Vec<Value> = match map.get("items") {
                Some(item_schema @ Value::Object(_)) => items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| walk(item_schema, item, &with(path, json!(i)), issues))
                    .collect(),
                Some(Value::Array(tuple)) => items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| match tuple.get(i) {
                        Some(s) => walk(s, item, &with(path, json!(i)), issues),
                        None => item.clone(),
                    })
                    .collect(),
                _ => items.clone(),
            };
            let length = items.len() as f64;
            if let Some(min) = number_of(map, "minItems")
                && length < min
            {
                issues.push(size_issue("array", true, min, true, path));
            }
            if let Some(max) = number_of(map, "maxItems")
                && length > max
            {
                issues.push(size_issue("array", false, max, true, path));
            }
            Value::Array(out)
        }
        "object" => {
            let input = value.as_object().cloned().unwrap_or_default();
            let required: Vec<&str> = match map.get("required") {
                Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).collect(),
                _ => Vec::new(),
            };
            let mut out = Map::new();
            let properties = match map.get("properties") {
                Some(Value::Object(props)) => Some(props),
                _ => None,
            };
            if let Some(props) = properties {
                for (key, prop) in props {
                    let child = with(path, json!(key));
                    match input.get(key) {
                        Some(v) => {
                            out.insert(key.clone(), walk(prop, v, &child, issues));
                        }
                        None => {
                            if let Some(default) = prop.get("default") {
                                out.insert(key.clone(), default.clone());
                            } else if required.contains(&key.as_str()) {
                                missing(prop, &child, issues);
                            }
                        }
                    }
                }
            }
            if let Some(extra @ Value::Object(_)) = map.get("additionalProperties") {
                for (key, v) in &input {
                    if properties.is_some_and(|p| p.contains_key(key)) {
                        continue;
                    }
                    out.insert(key.clone(), walk(extra, v, &with(path, json!(key)), issues));
                }
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Value {
        json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "city": { "type": "string" },
                "unit": { "default": "c", "type": "string" },
                "n": { "type": "number", "minimum": 1 },
                "e": { "type": "string", "enum": ["a", "b"] },
                "nul": { "type": ["string", "null"] }
            },
            "required": ["city", "e"],
            "additionalProperties": false
        })
    }

    #[test]
    fn fills_defaults_orders_keys_and_strips_unknown_ones() {
        let v = ZodValidator::new(&schema());
        let out = v.parse(&json!({ "e": "a", "zz": 1, "city": "x" })).unwrap();
        assert_eq!(js_stringify(&out), r#"{"city":"x","unit":"c","e":"a"}"#);
    }

    #[test]
    fn reports_issues_in_zod_words() {
        let v = ZodValidator::new(&schema());
        let err = v.parse(&json!({ "city": 1, "n": 0 })).unwrap_err();
        assert_eq!(
            js_stringify(&Value::Array(err.issues.clone())),
            r#"[{"expected":"string","code":"invalid_type","path":["city"],"message":"Invalid input: expected string, received number"},{"origin":"number","code":"too_small","minimum":1,"inclusive":true,"path":["n"],"message":"Too small: expected number to be >=1"},{"code":"invalid_value","values":["a","b"],"path":["e"],"message":"Invalid option: expected one of \"a\"|\"b\""}]"#
        );
        assert!(
            err.message
                .starts_with("[\n  {\n    \"expected\": \"string\"")
        );
    }

    #[test]
    fn accepts_null_for_a_nullable_field() {
        let v = ZodValidator::new(&schema());
        assert!(
            v.parse(&json!({ "city": "x", "e": "b", "nul": null }))
                .is_ok()
        );
    }
}
