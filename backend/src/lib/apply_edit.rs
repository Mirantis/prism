//! Targeted find-and-replace editing utility.
//!
//! Ported from the upstream Mirantis Agent Platform shell sandbox client with simplification:
//! no `replaceAll` parameter — ambiguous matches always error.

use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};

use crate::support::js::{len16, trim as js_trim};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOperation {
    pub old_text: String,
    pub new_text: String,
}

/// `{ success: true, content }` or `{ success: false, error }` on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditResult {
    Success { content: String },
    Failure { error: String },
}

impl Serialize for EditResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        match self {
            EditResult::Success { content } => {
                map.serialize_entry("success", &true)?;
                map.serialize_entry("content", content)?;
            }
            EditResult::Failure { error } => {
                map.serialize_entry("success", &false)?;
                map.serialize_entry("error", error)?;
            }
        }
        map.end()
    }
}

fn failure(error: String) -> EditResult {
    EditResult::Failure { error }
}

/// Apply a single find-and-replace edit to `content`.
///
/// 1. Try exact match — if found exactly once, replace it.
///    If found multiple times, return an error (ambiguous).
/// 2. Fall back to line-trimmed (whitespace-tolerant) matching, with the same
///    ambiguity rule: more than one match is an error.
/// 3. If nothing matches, return an error.
pub fn apply_edit(content: &str, old_text: &str, new_text: &str) -> EditResult {
    if old_text == new_text {
        return failure("oldText and newText are identical".to_string());
    }

    // Try exact match first
    if content.contains(old_text) {
        let count = split_count(content, old_text) - 1;
        if count > 1 {
            return failure(format!(
                "oldText has {count} matches — provide more context to make it unique"
            ));
        }
        return EditResult::Success {
            content: js_replace_first(content, old_text, new_text),
        };
    }

    // Fall back to line-trimmed matching
    let matches = line_trimmed_matches(content, old_text);
    if matches.len() > 1 {
        return failure(format!(
            "oldText has {} whitespace-tolerant matches — provide more context to make it unique",
            matches.len()
        ));
    }
    if let Some(&(start, end)) = matches.first() {
        return EditResult::Success {
            content: format!("{}{}{}", &content[..start], new_text, &content[end..]),
        };
    }

    failure("oldText not found in content".to_string())
}

/// Apply an array of edits sequentially. Stops on first failure.
pub fn apply_edits(content: &str, edits: &[EditOperation]) -> EditResult {
    let mut current = content.to_string();

    for (i, edit) in edits.iter().enumerate() {
        match apply_edit(&current, &edit.old_text, &edit.new_text) {
            EditResult::Failure { error } => {
                return failure(format!("Edit {}/{} failed: {}", i + 1, edits.len(), error));
            }
            EditResult::Success { content } => current = content,
        }
    }

    EditResult::Success { content: current }
}

/// `content.split(separator).length`, including JavaScript's split on an empty
/// separator, which splits into UTF-16 code units.
fn split_count(content: &str, separator: &str) -> i64 {
    if separator.is_empty() {
        return len16(content) as i64;
    }
    content.matches(separator).count() as i64 + 1
}

/// `content.replace(pattern, replacement)` with a string pattern: the first
/// occurrence only, and the replacement's `$$`, `$&`, `` $` `` and `$'` patterns
/// expanded as JavaScript expands them.
fn js_replace_first(content: &str, pattern: &str, replacement: &str) -> String {
    let Some(start) = content.find(pattern) else {
        return content.to_string();
    };
    let end = start + pattern.len();
    let before = &content[..start];
    let matched = &content[start..end];
    let after = &content[end..];

    let mut expanded = String::with_capacity(replacement.len());
    let mut chars = replacement.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '$' {
            expanded.push(ch);
            continue;
        }
        match chars.peek() {
            Some('$') => {
                chars.next();
                expanded.push('$');
            }
            Some('&') => {
                chars.next();
                expanded.push_str(matched);
            }
            Some('`') => {
                chars.next();
                expanded.push_str(before);
            }
            Some('\'') => {
                chars.next();
                expanded.push_str(after);
            }
            _ => expanded.push('$'),
        }
    }
    format!("{before}{expanded}{after}")
}

/// Every place `find` matches `content` line by line after trimming each line,
/// as byte ranges of `content`.
fn line_trimmed_matches(content: &str, find: &str) -> Vec<(usize, usize)> {
    let content_lines: Vec<&str> = content.split('\n').collect();
    let mut search_lines: Vec<&str> = find.split('\n').collect();
    let mut found = Vec::new();

    // Remove trailing empty line from search (common when copying text)
    if search_lines.len() > 1 && search_lines.last() == Some(&"") {
        search_lines.pop();
    }

    let last_start = content_lines.len() as isize - search_lines.len() as isize;
    let mut i = 0isize;
    while i <= last_start {
        let base = i as usize;
        let matches = search_lines
            .iter()
            .enumerate()
            .all(|(j, line)| js_trim(content_lines[base + j]) == js_trim(line));

        if matches {
            let start: usize = content_lines[..base]
                .iter()
                .map(|line| line.len() + 1)
                .sum();
            let mut end = start;
            for k in 0..search_lines.len() {
                end += content_lines[base + k].len();
                if k < search_lines.len() - 1 {
                    end += 1;
                }
            }
            found.push((start, end));
        }
        i += 1;
    }

    found
}
