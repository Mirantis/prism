//! `normalizeOpenAIJsonSchema`: JSON Schema as OpenAI structured outputs accept it.
//!
//! OpenAI does not support the JSON Schema `propertyNames` keyword. Property names
//! in JSON objects are always strings, so string-based constraints are left to
//! client-side validation after removing the keyword. A non-string property name
//! schema is refused.
//!
//! OpenAI also does not support regex lookaround in JSON Schema `pattern` values.
//! Those patterns are removed and left to client-side validation.
//!
//! Zod 4 represents recursive references as singleton `allOf` schemas. OpenAI does
//! not support `allOf`, but a singleton local reference is rewritten to a direct
//! reference without changing its validation behavior.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::ai::errors::UnsupportedFunctionalityError;
use crate::ai::provider::Warning;

#[derive(Default)]
struct Normalizer {
    removed_property_names: bool,
    removed_lookaround_pattern: bool,
}

/// The schema as OpenAI takes it, and the warnings for what was removed.
pub fn normalize_openai_json_schema(
    schema: &Value,
) -> Result<(Value, Vec<Warning>), UnsupportedFunctionalityError> {
    let mut normalizer = Normalizer::default();
    let normalized = normalizer.normalize_definition(schema, true)?;

    let mut warnings = Vec::new();
    if normalizer.removed_property_names {
        warnings.push(Warning::Compatibility {
            feature: "JSON Schema propertyNames".to_string(),
            details: Some(
                "OpenAI does not support JSON Schema propertyNames. It was removed before sending the schema, so OpenAI will not enforce property-name constraints."
                    .to_string(),
            ),
        });
    }
    if normalizer.removed_lookaround_pattern {
        warnings.push(Warning::Compatibility {
            feature: "JSON Schema pattern with regex lookaround".to_string(),
            details: Some(
                "OpenAI does not support regex lookaround in JSON Schema patterns. The pattern was removed before sending the schema, so OpenAI will not enforce that constraint."
                    .to_string(),
            ),
        });
    }
    Ok((normalized, warnings))
}

/// `value != null` in JavaScript.
fn present(schema: &Map<String, Value>, key: &str) -> bool {
    schema.get(key).is_some_and(|v| !v.is_null())
}

impl Normalizer {
    fn normalize_definition(
        &mut self,
        definition: &Value,
        is_root: bool,
    ) -> Result<Value, UnsupportedFunctionalityError> {
        match definition {
            Value::Object(schema) => self.normalize_schema(schema, is_root),
            other => Ok(other.clone()),
        }
    }

    fn normalize_record(&mut self, record: &Value) -> Result<Value, UnsupportedFunctionalityError> {
        let Value::Object(entries) = record else {
            return Ok(record.clone());
        };
        let mut out = Map::new();
        for (key, schema) in entries {
            out.insert(key.clone(), self.normalize_definition(schema, false)?);
        }
        Ok(Value::Object(out))
    }

    fn normalize_list(&mut self, list: &Value) -> Result<Value, UnsupportedFunctionalityError> {
        match list {
            Value::Array(items) => Ok(Value::Array(
                items
                    .iter()
                    .map(|item| self.normalize_definition(item, false))
                    .collect::<Result<_, _>>()?,
            )),
            other => self.normalize_definition(other, false),
        }
    }

    fn normalize_schema(
        &mut self,
        schema: &Map<String, Value>,
        is_root: bool,
    ) -> Result<Value, UnsupportedFunctionalityError> {
        if let Some(property_names) = schema.get("propertyNames").filter(|v| !v.is_null()) {
            let is_string_schema = property_names
                .as_object()
                .is_some_and(|p| p.get("type") == Some(&Value::String("string".to_string())));
            if !is_string_schema {
                return Err(UnsupportedFunctionalityError::new(
                    "JSON Schema propertyNames that does not use a string schema",
                ));
            }
            self.removed_property_names = true;
        }

        let mut normalized = schema.clone();
        normalized.shift_remove("propertyNames");

        if let Some(Value::String(pattern)) = normalized.get("pattern")
            && contains_regex_lookaround(pattern)
        {
            normalized.shift_remove("pattern");
            self.removed_lookaround_pattern = true;
        }

        for key in ["properties", "patternProperties"] {
            if present(&normalized, key) {
                let record = self.normalize_record(&normalized[key])?;
                normalized.insert(key.to_string(), record);
            }
        }
        for key in ["additionalProperties", "additionalItems"] {
            if present(&normalized, key) {
                let definition = self.normalize_definition(&normalized[key], false)?;
                normalized.insert(key.to_string(), definition);
            }
        }
        if present(&normalized, "items") {
            let items = self.normalize_list(&normalized["items"])?;
            normalized.insert("items".to_string(), items);
        }
        for key in ["contains", "not"] {
            if present(&normalized, key) {
                let definition = self.normalize_definition(&normalized[key], false)?;
                normalized.insert(key.to_string(), definition);
            }
        }
        for key in ["allOf", "anyOf", "oneOf"] {
            if present(&normalized, key) {
                let list = self.normalize_list(&normalized[key])?;
                normalized.insert(key.to_string(), list);
            }
        }
        for key in ["definitions", "$defs"] {
            if present(&normalized, key) {
                let record = self.normalize_record(&normalized[key])?;
                normalized.insert(key.to_string(), record);
            }
        }
        if let Some(Value::Object(dependencies)) = normalized.get("dependencies").cloned() {
            let mut out = Map::new();
            for (key, dependency) in dependencies {
                let value = match dependency {
                    Value::Array(_) => dependency,
                    other => self.normalize_definition(&other, false)?,
                };
                out.insert(key, value);
            }
            normalized.insert("dependencies".to_string(), Value::Object(out));
        }
        for key in ["if", "then", "else"] {
            if present(&normalized, key) {
                let definition = self.normalize_definition(&normalized[key], false)?;
                normalized.insert(key.to_string(), definition);
            }
        }

        let Some(reference) = singleton_reference(&normalized) else {
            return Ok(Value::Object(normalized));
        };

        let mut without_all_of = normalized.clone();
        without_all_of.shift_remove("allOf");

        if !is_root {
            // A one-item allOf has the same validation behavior as its reference.
            without_all_of.insert("$ref".to_string(), Value::String(reference));
            return Ok(Value::Object(without_all_of));
        }

        // OpenAI requires an object at the schema root, so a local root reference
        // is expanded instead of being sent as a direct $ref.
        let Some(referenced) = local_reference_schema(&reference, &normalized) else {
            return Ok(Value::Object(normalized));
        };
        let mut merged = referenced;
        for (key, value) in without_all_of {
            merged.insert(key, value);
        }
        Ok(Value::Object(merged))
    }
}

/// The `$ref` of an `allOf` holding exactly one `{ $ref }`. An intersection is not
/// rewritten: only a single reference is equivalent to a direct `$ref`.
fn singleton_reference(schema: &Map<String, Value>) -> Option<String> {
    let Value::Array(all_of) = schema.get("allOf")? else {
        return None;
    };
    if all_of.len() != 1 {
        return None;
    }
    let only = all_of[0].as_object()?;
    if only.len() != 1 {
        return None;
    }
    only.get("$ref")?.as_str().map(str::to_string)
}

static LOCAL_REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#/(definitions|\$defs)/(.+)$").unwrap());

fn local_reference_schema(reference: &str, schema: &Map<String, Value>) -> Option<Map<String, Value>> {
    let captures = LOCAL_REFERENCE.captures(reference)?;
    let keyword = &captures[1];
    let name = captures[2].replace("~1", "/").replace("~0", "~");
    let definition = schema.get(keyword)?.as_object()?.get(&name)?;
    definition.as_object().cloned()
}

/// Whether a regular expression source has a lookahead or lookbehind outside a
/// character class. Positions count UTF-16 code units, as JavaScript indexes.
fn contains_regex_lookaround(pattern: &str) -> bool {
    let units: Vec<u16> = pattern.encode_utf16().collect();
    let at = |i: usize| units.get(i).copied();
    let mut escaped = false;
    let mut in_character_class = false;
    for (index, &unit) in units.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        match unit {
            0x5c => {
                escaped = true;
                continue;
            }
            0x5b => {
                in_character_class = true;
                continue;
            }
            0x5d => {
                in_character_class = false;
                continue;
            }
            _ => {}
        }
        if !in_character_class && unit == 0x28 && at(index + 1) == Some(0x3f) {
            let prefix = at(index + 2);
            if prefix == Some(0x3d) || prefix == Some(0x21) {
                return true;
            }
            if prefix == Some(0x3c) && matches!(at(index + 3), Some(0x3d) | Some(0x21)) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::json::js_stringify;
    use serde_json::json;

    #[test]
    fn removes_property_names_and_lookaround_patterns_with_warnings() {
        let (schema, warnings) = normalize_openai_json_schema(&json!({
            "type": "object",
            "properties": {
                "a": { "type": "string", "pattern": "(?<=x)y" },
                "b": { "type": "string", "pattern": "[(?=]" },
                "m": { "type": "object", "propertyNames": { "type": "string" } }
            }
        }))
        .unwrap();
        assert_eq!(
            js_stringify(&schema),
            r#"{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string","pattern":"[(?=]"},"m":{"type":"object"}}}"#
        );
        assert_eq!(warnings.len(), 2);
    }

    #[test]
    fn refuses_property_names_that_are_not_strings() {
        let err = normalize_openai_json_schema(&json!({ "propertyNames": { "type": "number" } }))
            .unwrap_err();
        assert_eq!(
            err.message,
            "'JSON Schema propertyNames that does not use a string schema' functionality not supported."
        );
    }

    #[test]
    fn rewrites_singleton_references() {
        let (schema, _) = normalize_openai_json_schema(&json!({
            "allOf": [{ "$ref": "#/$defs/a~1b" }],
            "$defs": { "a/b": { "type": "object", "properties": { "x": { "allOf": [{ "$ref": "#/$defs/a~1b" }] } } } }
        }))
        .unwrap();
        assert_eq!(
            js_stringify(&schema),
            r##"{"type":"object","properties":{"x":{"$ref":"#/$defs/a~1b"}},"$defs":{"a/b":{"type":"object","properties":{"x":{"$ref":"#/$defs/a~1b"}}}}}"##
        );
    }
}
