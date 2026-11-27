//! Channel-agnostic text chunking.
//!
//! Every channel formatter splits long output the same way: paragraph
//! boundaries first, then sentences / newlines / spaces, hard split as the last
//! resort. Lengths and cut positions count UTF-16 code units, as the channels'
//! own limits do.

use std::sync::LazyLock;

use regex::Regex;

use crate::support::js::{len16, trim as js_trim};

static PARAGRAPH_BREAK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n\n+").expect("valid regex"));

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
    fn keeps_short_content_as_a_single_chunk() {
        assert_eq!(split_content("hello world", 100), vec!["hello world"]);
    }

    #[test]
    fn splits_at_paragraph_boundaries() {
        let para1 = "a".repeat(60);
        let para2 = "b".repeat(60);
        assert_eq!(
            split_content(&format!("{para1}\n\n{para2}"), 100),
            vec![para1, para2]
        );
    }

    #[test]
    fn packs_paragraphs_that_fit_together_into_one_chunk() {
        assert_eq!(
            split_content("one\n\ntwo\n\nthree", 100),
            vec!["one\n\ntwo\n\nthree"]
        );
    }

    #[test]
    fn splits_an_over_long_paragraph_at_a_sentence_boundary() {
        let text = format!("{}. {}", "x".repeat(70), "y".repeat(50));
        let chunks = split_content(&text, 100);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].ends_with('.'));
    }

    #[test]
    fn drops_nothing_chunks_rejoin_to_the_original_words() {
        let text = (0..30)
            .map(|i| format!("word{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        let joined = split_content(&text, 40).join(" ");
        assert_eq!(
            joined.split_whitespace().collect::<Vec<_>>(),
            text.split_whitespace().collect::<Vec<_>>()
        );
    }

    #[test]
    fn hard_splits_text_with_no_natural_boundaries() {
        let text = "z".repeat(250);
        let chunks = split_long_text(&text, 100);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn never_emits_a_chunk_longer_than_max_length_hard_split_included() {
        for chunk in split_long_text(&"z".repeat(250), 100) {
            assert!(len16(&chunk) <= 100);
        }

        // A sentence boundary landing exactly on maxLength must not overshoot.
        let boundary = split_long_text(&format!("{}. {}", "a".repeat(99), "b".repeat(50)), 100);
        for chunk in boundary {
            assert!(len16(&chunk) <= 100);
        }
    }

    #[test]
    fn prefers_a_newline_over_a_mid_word_split() {
        let text = format!("{}\n{}", "a".repeat(80), "b".repeat(80));
        let chunks = split_long_text(&text, 100);
        assert_eq!(chunks[0], "a".repeat(80));
    }
}
