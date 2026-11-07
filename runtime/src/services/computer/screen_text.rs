//! Words on the screen, with where they are: Tesseract over a grab of the display, so a
//! target with a label can be clicked at its exact centre instead of at a coordinate the
//! model estimated. Measured against the truth, the model's estimates miss a menu row
//! about one time in four and a window button almost always; OCR does not.
//!
//! The grab is upscaled before OCR. The desktop's font is nine pixels tall at native
//! size, which Tesseract breaks into fragments; at twice the size it reads the words whole.
//! Boxes come back divided by that factor, in screen pixels.

use std::cmp::Ordering;
use std::time::Duration;

use bytes::Bytes;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::child_process::{Pipes, StopSignal, spawn_child};
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
    let args = ["stdin", "stdout", "--psm", "11", "tsv"];
    let tsv = pipe_through("tesseract", &args, png, "OCR timed out").await?;
    Ok(parse_tsv(&String::from_utf8_lossy(&tsv), scale))
}

/// Feed `input` to a program on its stdin and answer what it writes to stdout. The
/// program runs in this process's environment, with its stderr ignored, and is killed
/// with SIGKILL when it runs past `OCR_TIMEOUT_MS`, failing with `timed_out`. An exit
/// other than 0 fails with `<file> exited with <code>`.
async fn pipe_through(
    file: &str,
    args: &[&str],
    input: Bytes,
    timed_out: &str,
) -> anyhow::Result<Vec<u8>> {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let env: IndexMap<String, String> = std::env::vars().collect();
    let (proc, pipes) = spawn_child(
        file,
        &args,
        &env,
        Pipes {
            stdin: true,
            stdout: true,
            stderr: false,
        },
    )?;
    let mut stdin = pipes.stdin;
    let mut stdout = pipes.stdout;
    let run = async {
        let write = async {
            if let Some(mut pipe) = stdin.take() {
                let _ = pipe.write_all(&input).await;
                let _ = pipe.shutdown().await;
            }
        };
        let read = async {
            let mut out = Vec::new();
            if let Some(pipe) = stdout.as_mut() {
                let _ = pipe.read_to_end(&mut out).await;
            }
            out
        };
        let ((), out) = tokio::join!(write, read);
        (out, proc.wait().await)
    };
    match tokio::time::timeout(Duration::from_millis(OCR_TIMEOUT_MS), run).await {
        Err(_) => {
            proc.kill(StopSignal::Kill);
            anyhow::bail!("{timed_out}")
        }
        Ok((out, exit)) => {
            if exit.code != Some(0) {
                let code = exit
                    .code
                    .map_or_else(|| "null".to_string(), |code| code.to_string());
                anyhow::bail!("{file} exited with {code}");
            }
            Ok(out)
        }
    }
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
    let filter = format!("scale=iw*{scale}:ih*{scale}");
    let args = [
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vf",
        &filter,
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
    ];
    let png = pipe_through("ffmpeg", &args, jpeg, "upscale timed out").await?;
    Ok(Bytes::from(png))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::computer::screen_size::math_round;

    /// Rows Tesseract produced for the About dialog on the desktop, grabbed at twice the
    /// size: header, then level page block par line word left top width height conf text.
    /// Level 5 rows are words; the two rows before them are what a grab also returns and
    /// this drops.
    fn tsv() -> String {
        [
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
            "5\t1\t2\t1\t1\t6\t1260\t88\t8\t8\t29.915310\t.",
            "4\t1\t5\t1\t1\t0\t1724\t262\t309\t21\t-1\t",
            "5\t1\t5\t1\t2\t1\t1707\t310\t30\t18\t95.482529\tOS",
            "5\t1\t5\t1\t2\t2\t1756\t310\t60\t18\t96.713371\tName",
            "5\t1\t5\t1\t2\t3\t1843\t308\t94\t21\t96.563179\tDebian",
            "5\t1\t5\t1\t2\t4\t1955\t308\t142\t21\t96.098534\tGNU/Linux",
            "5\t1\t5\t1\t2\t5\t2116\t309\t29\t20\t96.214478\t12",
            "5\t1\t5\t1\t2\t6\t2166\t308\t152\t26\t96.214478\t(bookworm)",
            "5\t1\t5\t1\t3\t1\t1707\t356\t30\t18\t96.452904\tOS",
            "5\t1\t5\t1\t3\t2\t1755\t356\t61\t24\t95.875023\tType",
            "5\t1\t5\t1\t3\t3\t1843\t354\t93\t21\t96.339973\t64-bit",
            "5\t1\t5\t1\t4\t1\t1644\t400\t172\t20\t96.417061\tDistributor",
            "5\t1\t5\t1\t4\t2\t1843\t400\t94\t21\t96.466576\tDebian",
            "5\t1\t6\t1\t1\t2\t1627\t470\t61\t20\t96.730331\tXfce",
            "5\t1\t6\t1\t1\t3\t1706\t470\t110\t20\t96.156990\tVersion",
            "5\t1\t6\t1\t1\t4\t1843\t471\t62\t20\t96.215294\t4.18",
            "5\t1\t6\t1\t2\t1\t1643\t518\t47\t18\t92.887886\tGTK",
            "5\t1\t6\t1\t2\t2\t1706\t516\t110\t20\t95.718300\tVersion",
            "5\t1\t6\t1\t2\t3\t1843\t517\t110\t20\t95.718300\t3.24.38",
        ]
        .join("\n")
    }

    #[test]
    fn keeps_confident_words_only_divided_back_to_screen_pixels() {
        let words = parse_tsv(&tsv(), 2);
        let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "OS",
                "Name",
                "Debian",
                "GNU/Linux",
                "12",
                "(bookworm)",
                "OS",
                "Type",
                "64-bit",
                "Distributor",
                "Debian",
                "Xfce",
                "Version",
                "4.18",
                "GTK",
                "Version",
                "3.24.38",
            ]
        );
        assert_eq!(
            (words[2].left, words[2].top, words[2].width, words[2].height),
            (921.5, 154.0, 47.0, 10.5)
        );
    }

    #[test]
    fn joins_each_line_left_to_right_and_orders_lines_top_to_bottom() {
        assert_eq!(
            read_lines(&parse_tsv(&tsv(), 2)),
            vec![
                "OS Name Debian GNU/Linux 12 (bookworm)",
                "OS Type 64-bit",
                "Distributor Debian",
                "Xfce Version 4.18",
                "GTK Version 3.24.38",
            ]
        );
    }

    #[test]
    fn finds_a_phrase_as_consecutive_words_on_one_line_and_centres_on_the_run() {
        let words = parse_tsv(&tsv(), 2);
        let found = find_text(&words, "GNU/Linux 12");
        assert_eq!(found[0].text, "GNU/Linux 12");
        assert_eq!(math_round(found[0].x), 1025.0);
        assert_eq!(math_round(found[0].y), 159.0);
    }

    #[test]
    fn ignores_case_and_punctuation_in_the_query_and_on_screen() {
        let words = parse_tsv(&tsv(), 2);
        assert_eq!(find_text(&words, "debian gnu/linux").len(), 1);
        assert_eq!(find_text(&words, "OS NAME").len(), 1);
    }

    #[test]
    fn does_not_join_words_from_different_lines() {
        assert!(find_text(&parse_tsv(&tsv(), 2), "Debian Xfce").is_empty());
    }

    #[test]
    fn matches_a_single_word_that_a_label_starts_with_when_nothing_matches_whole() {
        let words = parse_tsv(&tsv(), 2);
        assert_eq!(find_text(&words, "Distrib").len(), 1);
        assert!(find_text(&words, "Di").is_empty());
    }

    #[test]
    fn answers_empty_for_text_that_is_not_on_screen() {
        assert!(find_text(&parse_tsv(&tsv(), 2), "Web Browser").is_empty());
    }
}
