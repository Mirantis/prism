//! `format_file_content` ported from the upstream Lens Agents shell sandbox's
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
