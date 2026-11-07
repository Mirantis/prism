//! The built-in tools as the TypeScript runtime sends them to a provider
//! (`tests/fixtures/tool-schemas.json`), for the tests that check a factory's
//! definitions against them.

use serde_json::Value;

use crate::ai::ToolSet;
use crate::ai::tool::prepare_tools;

const FIXTURE: &str = include_str!("../../tests/fixtures/tool-schemas.json");

/// The fixture's entries of one group, such as `memory` or `cron:chat`.
pub(crate) fn fixture_group(group: &str) -> Vec<Value> {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("the fixture is JSON");
    fixture
        .get(group)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("the fixture has no group {group}"))
        .clone()
}

/// The tools as a provider receives them: `{ type, name, inputSchema, description?,
/// providerOptions? }`, in tool set order.
pub(crate) fn definitions(tools: &ToolSet) -> Vec<Value> {
    prepare_tools(Some(tools), None)
        .unwrap_or_default()
        .iter()
        .map(|tool| serde_json::to_value(tool).expect("a tool serializes"))
        .collect()
}

/// Asserts that the tools equal the fixture group, value for value and byte for byte.
pub(crate) fn assert_matches_fixture(group: &str, tools: &ToolSet) {
    let expected = fixture_group(group);
    let actual = definitions(tools);
    assert_eq!(
        actual, expected,
        "the {group} tools differ from the fixture"
    );
    assert_eq!(
        serde_json::to_string(&actual).unwrap(),
        serde_json::to_string(&expected).unwrap(),
        "the {group} tools' key order differs from the fixture"
    );
}
