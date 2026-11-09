//! Tool Names
//!
//! The single owner of "what a tool may be called when it reaches a model".
//!
//! Every provider constrains the name of a tool it is offered, and the binding
//! constraint is a length one: exceed it and the *whole request* is rejected.
//! Names an MCP server advertises are not ours to choose, and one arriving
//! pre-namespaced with a 36-character UUID is enough to blow the budget.
//!
//! Two callers, and they must agree byte for byte:
//!
//! - `lib/tool_collection.rs` caps the assembled tool set — the last point
//!   before a request, so it covers built-ins, platform MCP, plugin MCP, the Task
//!   tool, and the voice-meeting bridge that re-declares the same keys;
//! - `prompts/context_builder.rs` runs stored names from history through the
//!   same function, so history matches the tools block on replay.
//!
//! That agreement is why [`to_model_tool_name`] is a pure, deterministic function
//! of the name alone, and idempotent, which is what makes running it on both sides
//! safe.
//!
//! An MCP tool's `execute` closes over the name the *server* gave it, so the map
//! key is only ever what we show the model: renaming the key leaves the call to
//! the server untouched.

use crate::ai::ToolSet;
use crate::{log_debug, log_warn};
use indexmap::IndexMap;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::LazyLock;

/// Bedrock Converse caps `toolSpec.name` at 64 characters. Anthropic's Messages
/// API allows 128 and the OpenAI Responses API 64, so 64 is the binding
/// constraint — and Bedrock is this runtime's default provider.
pub const MAX_TOOL_NAME: usize = 64;

/// How many characters of digest a shortened name carries.
const DIGEST_LENGTH: usize = 7;

static DISALLOWED_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_-]+").expect("disallowed-run pattern"));
static UNDERSCORE_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"_{2,}").expect("underscore-run pattern"));
static EDGE_UNDERSCORES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^_+|_+$").expect("edge pattern"));
static TRAILING_UNDERSCORES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"_+$").expect("trailing pattern"));
static SAFE_START: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_]").expect("safe-start pattern"));

/// The lowercase hex SHA-256 of `text`.
fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// One `__`-separated part of a name, reduced to the character set every
/// provider accepts.
pub fn sanitize_tool_name_segment(segment: &str) -> String {
    let cleaned = DISALLOWED_RUN.replace_all(segment, "_");
    // Collapse runs so `__` stays unambiguous as the joiner.
    let cleaned = UNDERSCORE_RUN.replace_all(&cleaned, "_");
    let cleaned = EDGE_UNDERSCORES.replace_all(&cleaned, "");
    // A segment of pure punctuation cleans down to nothing — a plugin directory
    // literally named "___" or "...", say, since directory names are not held to
    // the spec's manifest-name pattern. Dropping it would take the whole
    // namespace with it, so two such plugins would collide on one tool name and
    // one would be silently discarded. A digest keeps every segment contributing
    // exactly one stable token.
    if cleaned.is_empty() {
        format!("x{}", &sha256_hex(segment)[..6])
    } else {
        cleaned.into_owned()
    }
}

/// The name a model may be shown for a tool, given whatever it is called at
/// source.
///
/// Sanitized per `__`-separated segment, guarded against a leading digit, and
/// capped. An over-long name is truncated and suffixed with a digest of the full
/// name, so two long names that share a prefix stay distinct and each one is
/// stable across restarts — the tools block must keep its shape between
/// processes or the prompt cache misses on every boot.
///
/// Splitting on the joiner first is important: [`sanitize_tool_name_segment`]
/// collapses runs of underscores, so running it over an already-joined name
/// would eat the `__` joiners and merge the namespace into the tool's own name.
pub fn to_model_tool_name(name: &str) -> String {
    let base = name
        .split("__")
        .map(sanitize_tool_name_segment)
        .collect::<Vec<_>>()
        .join("__");
    // A name starting with a digit reads as an array index, and JavaScript
    // enumerates integer-like keys first regardless of insertion order — which
    // would silently break the ordering the cache depends on.
    let safe = if SAFE_START.is_match(&base) {
        base
    } else {
        format!("t_{base}")
    };
    // Every character is ASCII after sanitizing, so bytes count as UTF-16 units.
    if safe.len() <= MAX_TOOL_NAME {
        return safe;
    }
    let digest = &sha256_hex(&safe)[..DIGEST_LENGTH];
    let head = &safe[..MAX_TOOL_NAME - DIGEST_LENGTH - 1];
    format!("{}_{}", TRAILING_UNDERSCORES.replace(head, ""), digest)
}

/// Rename anything in an assembled tool set that a provider would reject.
///
/// Insertion order is preserved, because it is part of the prompt-cache prefix:
/// `with_tools_cache_control` marks the *last* key, and the tools block goes out
/// in this order.
///
/// `reserved` holds the names the caller's own tools own (empty for none). A
/// rename that lands on one is dropped rather than allowed through, because a
/// remote tool answering to a first-party name is worse than losing it — and
/// arrival order cannot be relied on to prevent it: `Task` is added after the MCP
/// maps merge, and an integer-like remote key enumerates ahead of everything
/// regardless of when it was inserted. A name the *mode* withheld belongs in the
/// set too; its slot is empty, not free. A collision between two renamed tools
/// keeps the first.
pub fn cap_tool_names(tools: ToolSet, source: &str, reserved: &HashSet<String>) -> ToolSet {
    let mut result: ToolSet = IndexMap::new();

    for (name, tool) in tools {
        let capped = to_model_tool_name(&name);
        if capped != name {
            if reserved.contains(&capped) {
                log_warn!(
                    "[Tools] {}: dropping tool \"{}\" — its model-facing name \"{}\" belongs to a built-in",
                    source,
                    name,
                    capped
                );
                continue;
            }
            log_debug!(
                "[Tools] {}: \"{}\" is offered to the model as \"{}\"",
                source,
                name,
                capped
            );
        }
        if result.contains_key(&capped) {
            log_warn!(
                "[Tools] {}: dropping tool \"{}\" — its model-facing name \"{}\" is already taken",
                source,
                name,
                capped
            );
            continue;
        }
        result.insert(capped, tool);
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_valid_name_unchanged() {
        assert_eq!(to_model_tool_name("shell_exec"), "shell_exec");
        assert_eq!(
            to_model_tool_name("plugin__server__tool"),
            "plugin__server__tool"
        );
    }

    #[test]
    fn sanitizes_each_segment_and_guards_a_leading_digit() {
        assert_eq!(
            to_model_tool_name("my plugin__srv.v2__do it"),
            "my_plugin__srv_v2__do_it"
        );
        assert_eq!(to_model_tool_name("1tool"), "t_1tool");
        assert!(sanitize_tool_name_segment("...").starts_with('x'));
        assert_eq!(sanitize_tool_name_segment("...").len(), 7);
    }

    #[test]
    fn caps_a_long_name_with_a_stable_digest() {
        let long = format!("{}__{}", "a".repeat(40), "b".repeat(40));
        let capped = to_model_tool_name(&long);
        assert_eq!(capped.len(), MAX_TOOL_NAME);
        assert_eq!(capped, to_model_tool_name(&long));
        assert_eq!(to_model_tool_name(&capped), capped);
    }

    #[test]
    fn gives_the_names_the_typescript_runtime_gave() {
        assert_eq!(
            to_model_tool_name(&format!("{}__{}", "a".repeat(40), "b".repeat(40))),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa__bbbbbbbbbbbbbb_f469866"
        );
        assert_eq!(to_model_tool_name("...__x"), "xab5df6__x");
        assert_eq!(
            to_model_tool_name(
                "0123e4567-e89b-12d3-a456-426614174000__github__create_pull_request_review_comment"
            ),
            "t_0123e4567-e89b-12d3-a456-426614174000__github__create_809b466"
        );
    }

    /// A platform MCP name from the failure this rule exists for (70 characters).
    const NEXUS_ATLASSIAN: &str =
        "75166a14-fd0b-4bbb-b6d6-ddbd008bb95b__atlassian__addCommentToJiraIssue";

    fn accepted(name: &str) -> bool {
        !name.is_empty()
            && name.len() <= MAX_TOOL_NAME
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    }

    fn make_tool(description: &str) -> crate::ai::Tool {
        crate::ai::Tool {
            description: Some(description.to_string()),
            ..Default::default()
        }
    }

    fn set(entries: &[(&str, &str)]) -> ToolSet {
        entries
            .iter()
            .map(|(name, description)| (name.to_string(), make_tool(description)))
            .collect()
    }

    fn reserved(names: &[&str]) -> HashSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn replaces_anything_outside_the_charset_and_keeps_punctuation_distinct() {
        assert_eq!(sanitize_tool_name_segment("read:file"), "read_file");
        assert_eq!(sanitize_tool_name_segment("my.plugin"), "my_plugin");
        let a = sanitize_tool_name_segment("___");
        assert_ne!(a, sanitize_tool_name_segment("..."));
        assert_eq!(sanitize_tool_name_segment("___"), a);
    }

    #[test]
    fn keeps_the_double_underscore_joiners() {
        assert_eq!(
            to_model_tool_name("my.plugin__srv__read:file"),
            "my_plugin__srv__read_file"
        );
        assert_eq!(
            to_model_tool_name("12306__srv__search"),
            "t_12306__srv__search"
        );
        for name in ["shell_exec", "memory_search", "Task", "demo__probe__search"] {
            assert_eq!(to_model_tool_name(name), name);
        }
    }

    #[test]
    fn shortens_the_over_long_platform_name() {
        let capped = to_model_tool_name(NEXUS_ATLASSIAN);
        assert_eq!(NEXUS_ATLASSIAN.len(), 70);
        assert_eq!(
            capped,
            "t_75166a14-fd0b-4bbb-b6d6-ddbd008bb95b__atlassian__addCo_b897e9d"
        );
        assert!(accepted(&capped));
    }

    #[test]
    fn keeps_two_long_names_with_a_shared_prefix_distinct() {
        let long = "a".repeat(70);
        let a = to_model_tool_name(&format!("{long}_one"));
        let b = to_model_tool_name(&format!("{long}_two"));
        assert_ne!(a, b);
        assert_eq!(a.len(), MAX_TOOL_NAME);
        assert_eq!(b.len(), MAX_TOOL_NAME);
    }

    #[test]
    fn is_idempotent() {
        let names = [
            NEXUS_ATLASSIAN.to_string(),
            "a".repeat(200),
            "x__".repeat(30),
            "shell_exec".to_string(),
            format!("{}__{}", "a".repeat(54), "b".repeat(20)),
            format!("{}__{}", "a".repeat(53), "b".repeat(20)),
            format!("{}__{}", "a".repeat(55), "b".repeat(20)),
        ];
        for name in names {
            let once = to_model_tool_name(&name);
            assert_eq!(to_model_tool_name(&once), once);
            assert!(accepted(&once), "{once}");
        }
    }

    #[test]
    fn never_emits_a_name_a_provider_would_reject() {
        let long = "a".repeat(500);
        for name in [
            NEXUS_ATLASSIAN,
            long.as_str(),
            "...",
            "9",
            "server..name__tool with spaces",
            "__leading__and__trailing__",
            "ünïcödé__tööl",
        ] {
            assert!(accepted(&to_model_tool_name(name)), "{name}");
        }
    }

    #[test]
    fn caps_only_what_does_not_fit_and_keeps_the_order() {
        let capped = cap_tool_names(
            set(&[
                ("shell_exec", "shell_exec"),
                (NEXUS_ATLASSIAN, "mcp"),
                ("memory_search", "memory_search"),
                ("Task", "Task"),
            ]),
            "test",
            &HashSet::new(),
        );
        assert_eq!(
            capped.keys().cloned().collect::<Vec<_>>(),
            [
                "shell_exec".to_string(),
                to_model_tool_name(NEXUS_ATLASSIAN),
                "memory_search".to_string(),
                "Task".to_string(),
            ]
        );
        assert_eq!(
            capped[&to_model_tool_name(NEXUS_ATLASSIAN)]
                .description
                .as_deref(),
            Some("mcp")
        );
    }

    #[test]
    fn keeps_the_incumbent_when_a_sanitized_name_is_taken() {
        let capped = cap_tool_names(
            set(&[("shell_exec", "built-in"), ("shell.exec", "remote")]),
            "test",
            &HashSet::new(),
        );
        assert_eq!(capped.keys().collect::<Vec<_>>(), ["shell_exec"]);
        assert_eq!(
            capped["shell_exec"].description.as_deref(),
            Some("built-in")
        );
    }

    #[test]
    fn drops_a_rename_onto_a_reserved_name_whatever_the_order() {
        let capped = cap_tool_names(
            set(&[("Task.", "remote"), ("Task", "the real one")]),
            "test",
            &reserved(&["Task"]),
        );
        assert_eq!(capped.keys().collect::<Vec<_>>(), ["Task"]);
        assert_eq!(capped["Task"].description.as_deref(), Some("the real one"));

        let owner = cap_tool_names(
            set(&[("shell_exec", "built-in")]),
            "test",
            &reserved(&["shell_exec"]),
        );
        assert_eq!(owner["shell_exec"].description.as_deref(), Some("built-in"));
    }

    #[test]
    fn refuses_a_rename_into_a_name_the_mode_withheld() {
        let capped = cap_tool_names(
            set(&[("share.file", "remote"), ("kubectl", "kubectl")]),
            "test",
            &reserved(&["share_file"]),
        );
        assert_eq!(capped.keys().collect::<Vec<_>>(), ["kubectl"]);
    }
}
