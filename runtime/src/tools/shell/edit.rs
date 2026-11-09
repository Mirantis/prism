//! `apply_edit` ported from the upstream Lens Agents shell sandbox's file
//! handlers.
//!
//! Exact-match replacement with a whitespace-tolerant line-trimmed
//! fallback. Behavior mirrors upstream verbatim.

/// The edited content, or why the edit was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditOutcome {
    Ok { content: String },
    Error { message: String },
}

pub fn apply_edit(
    content: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> EditOutcome {
    if old_string == new_string {
        return EditOutcome::Error {
            message: "oldString and newString are identical".to_string(),
        };
    }

    // Exact match
    if content.contains(old_string) {
        if replace_all {
            return EditOutcome::Ok {
                content: split_join(content, old_string, new_string),
            };
        }
        let match_count = count_occurrences(content, old_string);
        if match_count > 1 {
            return EditOutcome::Error {
                message: format!(
                    "oldString has {match_count} matches — use replaceAll or provide more context to make it unique"
                ),
            };
        }
        // replacen(1) — replace only the first occurrence
        let idx = content.find(old_string).unwrap_or(0);
        return EditOutcome::Ok {
            content: format!(
                "{}{}{}",
                &content[..idx],
                new_string,
                &content[idx + old_string.len()..]
            ),
        };
    }

    // Line-trimmed match (whitespace-tolerant)
    let line_matches = line_trimmed_matches(content, old_string);
    if !line_matches.is_empty() {
        if replace_all {
            return EditOutcome::Error {
                message: "replaceAll requires exact match — the match was found via whitespace-tolerant search"
                    .to_string(),
            };
        }
        // Ambiguity is an error on this path too, as it is for an exact match:
        // editing the first of several places is a silent wrong edit.
        if line_matches.len() > 1 {
            return EditOutcome::Error {
                message: format!(
                    "oldString has {} whitespace-tolerant matches — provide more context to make it unique",
                    line_matches.len()
                ),
            };
        }
        let (start, end) = line_matches[0];
        return EditOutcome::Ok {
            content: format!("{}{}{}", &content[..start], new_string, &content[end..]),
        };
    }

    EditOutcome::Error {
        message: "oldString not found in file".to_string(),
    }
}

/// `content.split(needle).join(replacement)`. An empty needle splits between
/// characters, with nothing before the first or after the last.
fn split_join(content: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        let chars: Vec<String> = content.chars().map(String::from).collect();
        return chars.join(replacement);
    }
    content.split(needle).collect::<Vec<_>>().join(replacement)
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.matches(needle).count()
}

/// JavaScript's `String.prototype.trim`: white space and line terminators.
fn js_trim(text: &str) -> &str {
    let is_js_space = |c: char| {
        matches!(
            c,
            '\u{0009}'
                | '\u{000A}'
                | '\u{000B}'
                | '\u{000C}'
                | '\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200A}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202F}'
                    | '\u{205F}'
                    | '\u{3000}'
                    | '\u{FEFF}'
        )
    };
    text.trim_matches(is_js_space)
}

/// Every place `find` matches `content` line by line after trimming each line,
/// as byte ranges of `content`.
fn line_trimmed_matches(content: &str, find: &str) -> Vec<(usize, usize)> {
    let content_lines: Vec<&str> = content.split('\n').collect();
    let mut search_lines: Vec<&str> = find.split('\n').collect();
    let mut found = Vec::new();

    // Upstream drops a trailing empty line from the search pattern so
    // `"b\nc\n"` matches two lines, not "two lines plus a blank".
    if search_lines.len() > 1 && search_lines.last() == Some(&"") {
        search_lines.pop();
    }

    if search_lines.len() > content_lines.len() {
        return found;
    }

    for i in 0..=(content_lines.len() - search_lines.len()) {
        let matches = (0..search_lines.len())
            .all(|j| js_trim(content_lines[i + j]) == js_trim(search_lines[j]));
        if matches {
            // Each preceding line contributes (line length + 1) for its newline.
            let start: usize = content_lines[..i].iter().map(|line| line.len() + 1).sum();
            let matched = &content_lines[i..i + search_lines.len()];
            let matched_len: usize = matched.iter().map(|line| line.len()).sum();
            // newlines between matched lines (n-1 of them)
            let end = start + matched_len + matched.len().saturating_sub(1);
            found.push((start, end));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(outcome: EditOutcome) -> String {
        match outcome {
            EditOutcome::Ok { content } => content,
            EditOutcome::Error { message } => panic!("{message}"),
        }
    }

    fn refused(outcome: EditOutcome) -> String {
        match outcome {
            EditOutcome::Error { message } => message,
            EditOutcome::Ok { content } => panic!("edited: {content}"),
        }
    }

    #[test]
    fn replaces_a_single_occurrence_exactly() {
        assert_eq!(
            ok(apply_edit("hello world", "hello", "goodbye", false)),
            "goodbye world"
        );
    }

    #[test]
    fn replaces_all_occurrences_when_replace_all_is_true() {
        assert_eq!(ok(apply_edit("aa bb aa", "aa", "cc", true)), "cc bb cc");
    }

    #[test]
    fn rejects_multiple_matches_when_replace_all_is_false() {
        assert_eq!(
            refused(apply_edit("aa bb aa", "aa", "cc", false)),
            "oldString has 2 matches — use replaceAll or provide more context to make it unique"
        );
    }

    #[test]
    fn rejects_identical_old_and_new_strings() {
        assert_eq!(
            refused(apply_edit("hello", "hello", "hello", false)),
            "oldString and newString are identical"
        );
    }

    #[test]
    fn errors_when_old_string_is_not_present() {
        assert_eq!(
            refused(apply_edit("hello", "xyz", "abc", false)),
            "oldString not found in file"
        );
    }

    #[test]
    fn falls_back_to_a_line_trimmed_match_when_the_exact_match_fails() {
        let content = "  function foo() {\n    return 1;\n  }";
        let edited = ok(apply_edit(
            content,
            "function foo() {\nreturn 1;\n}",
            "function bar() {\nreturn 2;\n}",
            false,
        ));
        assert!(edited.contains("function bar()"));
    }

    #[test]
    fn rejects_an_ambiguous_line_trimmed_match_instead_of_editing_the_first_one() {
        let content = "  - item\n  - other\n\n  - item\n  - other";
        let message = refused(apply_edit(content, "- item\n- other", "- changed", false));
        assert!(message.contains("2 whitespace-tolerant matches"));
    }

    #[test]
    fn keeps_the_exact_match_path_when_both_exact_and_trimmed_would_match() {
        assert_eq!(
            ok(apply_edit("  hello\n", "hello", "goodbye", true)),
            "  goodbye\n"
        );
    }
}
