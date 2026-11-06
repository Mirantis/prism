//! Channel-agnostic text chunking.
//!
//! Every channel formatter splits long output the same way: paragraph
//! boundaries first, then sentences / newlines / spaces, hard split as the last
//! resort. Lengths and cut positions count UTF-16 code units, as the channels'
//! own limits do.

use std::sync::LazyLock;

use regex::Regex;

use crate::support::js::len16;

static PARAGRAPH_BREAK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n\n+").expect("valid regex"));

/// `String.prototype.trim`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// Split content into chunks respecting paragraph boundaries.
pub fn split_content(text: &str, max_length: usize) -> Vec<String> {
    let mut sections: Vec<String> = Vec::new();
    let mut current_section = String::new();

    // Split by double newlines (paragraphs)
    for para in PARAGRAPH_BREAK.split(text) {
        // Check if adding this paragraph would exceed the limit
        let would_be = if current_section.is_empty() {
            para.to_string()
        } else {
            format!("{current_section}\n\n{para}")
        };

        if len16(&would_be) <= max_length {
            current_section = would_be;
        } else {
            // Save current section and start new one
            if !js_trim(&current_section).is_empty() {
                sections.push(js_trim(&current_section).to_string());
            }

            // If single paragraph is too long, split it further
            if len16(para) > max_length {
                let mut chunks = split_long_text(para, max_length);
                current_section = chunks.pop().unwrap_or_default();
                sections.extend(chunks);
            } else {
                current_section = para.to_string();
            }
        }
    }

    // Add remaining content
    if !js_trim(&current_section).is_empty() {
        sections.push(js_trim(&current_section).to_string());
    }

    sections
}

/// `String.prototype.lastIndexOf(needle, from)` over UTF-16 code units.
fn last_index_of(hay: &[u16], needle: &[u16], from: i64) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    let start = (from.max(0) as usize).min(hay.len() - needle.len());
    (0..=start)
        .rev()
        .find(|&i| &hay[i..i + needle.len()] == needle)
}

/// Split very long text by sentences or words.
///
/// Every chunk is at most `max_length` characters: the cut is at `split_point + 1`,
/// so boundaries are searched from `max_length - 1` and the hard split lands
/// exactly on `max_length` (a boundary found at `max_length` itself would
/// overshoot the contract by one character).
pub fn split_long_text(text: &str, max_length: usize) -> Vec<String> {
    let sentence: Vec<u16> = ". ".encode_utf16().collect();
    let newline: Vec<u16> = "\n".encode_utf16().collect();
    let space: Vec<u16> = " ".encode_utf16().collect();
    let from = max_length as i64 - 1;
    let half = max_length as f64 / 2.0;

    let mut chunks = Vec::new();
    let mut remaining = text.to_string();

    while len16(&remaining) > max_length {
        let units: Vec<u16> = remaining.encode_utf16().collect();
        let too_early = |point: Option<usize>| point.is_none_or(|p| (p as f64) < half);
        // Try to split at sentence boundary
        let mut split_point = last_index_of(&units, &sentence, from);
        if too_early(split_point) {
            // Try newline
            split_point = last_index_of(&units, &newline, from);
        }
        if too_early(split_point) {
            // Try space
            split_point = last_index_of(&units, &space, from);
        }
        // Hard split
        let split_point = split_point.unwrap_or(max_length.saturating_sub(1));

        let cut = (split_point + 1).min(units.len());
        let head = String::from_utf16_lossy(&units[..cut]);
        let tail = String::from_utf16_lossy(&units[cut..]);
        chunks.push(js_trim(&head).to_string());
        remaining = js_trim(&tail).to_string();
    }

    if !remaining.is_empty() {
        chunks.push(remaining);
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_paragraphs_together_until_the_limit() {
        assert_eq!(
            split_content("one\n\ntwo\n\n\nthree", 9),
            vec!["one\n\ntwo", "three"]
        );
    }

    #[test]
    fn splits_a_long_paragraph_at_a_sentence_and_keeps_every_chunk_within_the_limit() {
        let text = "First sentence here. Second sentence follows. Third one.";
        let chunks = split_long_text(text, 25);
        assert!(chunks.iter().all(|c| len16(c) <= 25), "{chunks:?}");
        assert_eq!(chunks[0], "First sentence here.");
    }

    #[test]
    fn hard_splits_text_without_a_boundary() {
        assert_eq!(split_long_text("abcdefghij", 4), vec!["abcd", "efgh", "ij"]);
    }
}
