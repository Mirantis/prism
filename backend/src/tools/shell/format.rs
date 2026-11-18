//! `format_file_content` ported from the upstream Mirantis Agent Platform shell sandbox's
//! file handlers.
//!
//! Returns the file with each line prefixed by its 1-indexed line
//! number, optionally sliced via offset/limit. Lines longer than
//! MAX_LINE_LENGTH are truncated with a marker — matches upstream.

use crate::support::js::{len16, slice16};

pub const DEFAULT_READ_LIMIT: usize = 2000;
pub const MAX_LINE_LENGTH: usize = 2000;

pub fn format_file_content(raw: &str, offset: Option<i64>, limit: Option<i64>) -> String {
    let lines: Vec<&str> = raw.split('\n').collect();
    let start_line = offset.unwrap_or(1).max(1) as usize;
    let max_lines = limit
        .map(|l| l.max(0) as usize)
        .unwrap_or(DEFAULT_READ_LIMIT);

    if start_line > lines.len() {
        return format!(
            "(file has {} lines, offset {start_line} is past end)",
            lines.len()
        );
    }

    let slice_end = (start_line - 1).saturating_add(max_lines).min(lines.len());
    let slice = &lines[start_line - 1..slice_end];
    let numbered = slice
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let line_num = start_line + i;
            if len16(line) > MAX_LINE_LENGTH {
                format!(
                    "{line_num}: {}... (truncated)",
                    slice16(line, 0, MAX_LINE_LENGTH)
                )
            } else {
                format!("{line_num}: {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    let end_line = start_line - 1 + slice.len();
    let total_lines = lines.len();
    if end_line < total_lines {
        return format!(
            "{numbered}\n(showing lines {start_line}-{end_line} of {total_lines}, use offset to read more)"
        );
    }
    numbered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_every_line_starting_at_1() {
        let result = format_file_content("line1\nline2\nline3\n", None, None);
        assert!(result.contains("1: line1"));
        assert!(result.contains("2: line2"));
        assert!(result.contains("3: line3"));
    }

    #[test]
    fn respects_offset_and_limit() {
        let result = format_file_content("a\nb\nc\nd\ne\n", Some(3), Some(2));
        assert_eq!(
            result,
            "3: c\n4: d\n(showing lines 3-4 of 6, use offset to read more)"
        );
    }

    #[test]
    fn reports_past_end_when_offset_exceeds_file_length() {
        assert_eq!(
            format_file_content("a\nb\n", Some(100), None),
            "(file has 3 lines, offset 100 is past end)"
        );
    }

    #[test]
    fn truncates_lines_longer_than_max_line_length() {
        let result = format_file_content(&"x".repeat(3000), None, None);
        assert_eq!(result, format!("1: {}... (truncated)", "x".repeat(2000)));
    }
}
