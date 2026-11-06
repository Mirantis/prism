//! Words on the screen, with where they are: Tesseract over a grab of the display, so a
//! target with a label can be clicked at its exact centre instead of at a coordinate the
//! model estimated. Measured against the truth, the model's estimates miss a menu row
//! about one time in four and a window button almost always; OCR does not.
//!
//! The grab is upscaled before OCR. The desktop's font is nine pixels tall at native
//! size, which Tesseract breaks into fragments; at twice the size it reads the words whole.
//! Boxes come back divided by that factor, in screen pixels.

use std::cmp::Ordering;

use bytes::Bytes;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::support::js;

/// One word Tesseract read, in screen pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScreenWord {
    pub text: String,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub confidence: f64,
    /// Which line of text it belongs to, so a phrase is matched within one line.
    pub line: String,
}

/// A run of words matching a query, in screen pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextMatch {
    /// The matched words as read.
    pub text: String,
    /// The whole line they sit in, for telling matches apart.
    pub line: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Words read with less confidence than this are noise, not labels.
const MIN_CONFIDENCE: f64 = 30.0;
const OCR_TIMEOUT_MS: u64 = 20_000;

/// Run Tesseract on a PNG of the display scaled up `scale` times; boxes come back in screen
/// pixels.
///
/// Page segmentation mode 11 is sparse text: find words wherever they are, in no assumed
/// layout, which is what a desktop with a menu, a panel and windows is. Fails with
/// `OCR timed out` after `OCR_TIMEOUT_MS`, and with `tesseract exited with <code>`.
pub async fn read_screen_words(png: Bytes, scale: i64) -> anyhow::Result<Vec<ScreenWord>> {
    todo!()
}

/// Tesseract's TSV: level, page, block, paragraph, line, word, left, top, width, height,
/// confidence, text. Level 5 rows are words.
pub fn parse_tsv(tsv: &str, scale: i64) -> Vec<ScreenWord> {
    let scale = scale as f64;
    let number = |text: &str| js::number_from(text).unwrap_or(f64::NAN);
    let mut words = Vec::new();
    for row in tsv.split('\n').skip(1) {
        let cols: Vec<&str> = row.split('\t').collect();
        if cols.len() < 12 || cols[0] != "5" {
            continue;
        }
        let text = cols[11].trim();
        let confidence = number(cols[10]);
        if text.is_empty() || !(confidence >= MIN_CONFIDENCE) {
            continue;
        }
        words.push(ScreenWord {
            text: text.to_string(),
            left: number(cols[6]) / scale,
            top: number(cols[7]) / scale,
            width: number(cols[8]) / scale,
            height: number(cols[9]) / scale,
            confidence,
            line: format!("{}-{}-{}", cols[2], cols[3], cols[4]),
        });
    }
    words
}

/// Enlarge a JPEG `scale` times into a PNG for OCR, through ffmpeg on pipes. For a picture
/// that did not come off the display, such as the user's shared screen. Fails with
/// `upscale timed out` after `OCR_TIMEOUT_MS`, and with `ffmpeg exited with <code>`.
pub async fn upscale_for_ocr(jpeg: Bytes, scale: i64) -> anyhow::Result<Bytes> {
    todo!()
}

fn cmp(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

/// The words grouped by line, in the order each line was first seen.
fn group_lines(words: &[ScreenWord]) -> IndexMap<&str, Vec<&ScreenWord>> {
    let mut lines: IndexMap<&str, Vec<&ScreenWord>> = IndexMap::new();
    for word in words {
        lines.entry(word.line.as_str()).or_default().push(word);
    }
    lines
}

/// The words as lines of text, top to bottom, each line's words left to right.
pub fn read_lines(words: &[ScreenWord]) -> Vec<String> {
    let mut lines: Vec<Vec<&ScreenWord>> = group_lines(words).into_values().collect();
    for line in &mut lines {
        line.sort_by(|a, b| cmp(a.left, b.left));
    }
    lines.sort_by(|a, b| cmp(a[0].top, b[0].top).then(cmp(a[0].left, b[0].left)));
    lines
        .into_iter()
        .map(|line| {
            line.iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect()
}

/// Letters and digits only, lower case: "Run Program..." and "run program" are one thing.
fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// Where `query` appears on the screen, top to bottom.
///
/// A phrase matches consecutive words on one line, each word compared with punctuation
/// and case removed. A single word that matches nothing whole also matches a word that
/// starts with it, since a label can be cut by a window edge or read short.
pub fn find_text(words: &[ScreenWord], query: &str) -> Vec<TextMatch> {
    let wanted: Vec<String> = query
        .trim()
        .split_whitespace()
        .map(normalize)
        .filter(|w| !w.is_empty())
        .collect();
    if wanted.is_empty() {
        return Vec::new();
    }

    let mut lines: Vec<Vec<&ScreenWord>> = group_lines(words).into_values().collect();
    let mut matches = Vec::new();
    for line in &mut lines {
        line.sort_by(|a, b| cmp(a.left, b.left));
        let mut start = 0;
        while start + wanted.len() <= line.len() {
            let run = &line[start..start + wanted.len()];
            if run
                .iter()
                .zip(&wanted)
                .all(|(word, want)| normalize(&word.text) == *want)
            {
                matches.push(text_box(run, line));
            }
            start += 1;
        }
    }
    if matches.is_empty() && wanted.len() == 1 && js::len16(&wanted[0]) >= 3 {
        for line in &lines {
            for word in line {
                if normalize(&word.text).starts_with(&wanted[0]) {
                    matches.push(text_box(&[*word], line));
                }
            }
        }
    }
    matches.sort_by(|a, b| cmp(a.y, b.y).then(cmp(a.x, b.x)));
    matches
}

fn text_box(run: &[&ScreenWord], line: &[&ScreenWord]) -> TextMatch {
    let left = run.iter().map(|w| w.left).fold(f64::INFINITY, f64::min);
    let top = run.iter().map(|w| w.top).fold(f64::INFINITY, f64::min);
    let right = run
        .iter()
        .map(|w| w.left + w.width)
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = run
        .iter()
        .map(|w| w.top + w.height)
        .fold(f64::NEG_INFINITY, f64::max);
    TextMatch {
        text: run
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        line: line
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" "),
        x: (left + right) / 2.0,
        y: (top + bottom) / 2.0,
        width: right - left,
        height: bottom - top,
    }
}
