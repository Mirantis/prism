//! Images a message places in its own text: markdown `![alt](target)` written
//! outside code. A stored message names each placed image as `attachment:<id>`,
//! one of its own attachments, and the channels show it at that position.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::services::attachment_service::{AttachmentCategory, AttachmentMeta};

pub const ATTACHMENT_SCHEME: &str = "attachment:";

/// One image reference. Offsets are byte offsets into the content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRef {
    /// Offset of the `!`.
    pub start: usize,
    /// Offset just past the closing `)`.
    pub end: usize,
    pub alt: String,
    pub target: String,
}

static IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^\s()]+)(?:\s+"[^"\n]*")?\s*\)"#).unwrap()
});
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
});
static URL_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").unwrap());
static FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^ {0,3}(`{3,}|~{3,})[^\n]*$").unwrap());
static BACKTICKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`+").unwrap());
static LIST_ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)").unwrap());

/// The image references in `content`, in order, skipping what a markdown
/// renderer shows as text: fenced, indented and inline code, and an escaped `\!`.
pub fn find_image_refs(content: &str) -> Vec<ImageRef> {
    if !content.contains("![") {
        return Vec::new();
    }
    let code = code_ranges(content);
    let mut refs = Vec::new();
    for captures in IMAGE.captures_iter(content) {
        let whole = captures.get(0).expect("a match has group 0");
        let start = whole.start();
        if code.iter().any(|&(from, to)| start >= from && start < to) {
            continue;
        }
        if escaped(content, start) {
            continue;
        }
        let raw = &captures[2];
        let target = if raw.starts_with('<') {
            raw[1..raw.len() - 1].trim()
        } else {
            raw
        };
        if target.is_empty() {
            continue;
        }
        refs.push(ImageRef {
            start,
            end: whole.end(),
            alt: captures[1].to_string(),
            target: target.to_string(),
        });
    }
    refs
}

/// The attachment id an `attachment:<id>` target names, or `None` for any other target.
pub fn attachment_ref_id(target: &str) -> Option<&str> {
    let id = target.strip_prefix(ATTACHMENT_SCHEME)?;
    UUID.is_match(id).then_some(id)
}

/// True for a target on the agent's filesystem: one with no URL scheme.
pub fn is_local_path(target: &str) -> bool {
    !URL_SCHEME.is_match(target)
}

pub fn attachment_image(alt: &str, attachment_id: &str) -> String {
    format!("![{alt}]({ATTACHMENT_SCHEME}{attachment_id})")
}

/// `content` with each reference that `replace` answers for swapped for its answer.
pub fn replace_image_refs(
    content: &str,
    refs: &[ImageRef],
    mut replace: impl FnMut(&ImageRef) -> Option<String>,
) -> String {
    let mut out = String::with_capacity(content.len());
    let mut at = 0;
    for image in refs {
        let Some(replacement) = replace(image) else {
            continue;
        };
        out.push_str(&content[at..image.start]);
        out.push_str(&replacement);
        at = image.end;
    }
    out.push_str(&content[at..]);
    out
}

/// The images `content` shows inline: each attachment it references whose
/// category is `image` is marked `inline`.
pub fn place_attachments(content: &str, attachments: Vec<AttachmentMeta>) -> Vec<AttachmentMeta> {
    let placed: HashSet<String> = find_image_refs(content)
        .iter()
        .filter_map(|image| attachment_ref_id(&image.target).map(str::to_string))
        .collect();
    if placed.is_empty() {
        return attachments;
    }
    attachments
        .into_iter()
        .map(|mut a| {
            if placed.contains(&a.id) && a.category == AttachmentCategory::Image {
                a.inline = Some(true);
            }
            a
        })
        .collect()
}

/// `[from, to)` offsets of fenced code blocks and inline code spans.
fn code_ranges(content: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut open: Option<(u8, usize, usize)> = None;
    for captures in FENCE.captures_iter(content) {
        let line = captures.get(0).expect("a match has group 0");
        let marker = &captures[1];
        match open {
            None => {
                open = Some((marker.as_bytes()[0], marker.len(), line.start()));
            }
            Some((ch, length, start)) => {
                let closes = marker.as_bytes()[0] == ch
                    && marker.len() >= length
                    && line.as_str().trim() == marker;
                if closes {
                    ranges.push((start, line.end()));
                    open = None;
                }
            }
        }
    }
    if let Some((_, _, start)) = open {
        ranges.push((start, content.len()));
    }
    let indented = indented_code(content, &ranges);
    ranges.extend(indented);

    let runs: Vec<(usize, usize)> = BACKTICKS
        .find_iter(content)
        .map(|run| (run.start(), run.len()))
        .filter(|&(start, _)| !ranges.iter().any(|&(from, to)| start >= from && start < to))
        .collect();
    let mut i = 0;
    while i < runs.len() {
        let (opening, length) = runs[i];
        if let Some(closing) = (i + 1..runs.len()).find(|&j| runs[j].1 == length) {
            ranges.push((opening, runs[closing].0 + runs[closing].1));
            i = closing;
        }
        i += 1;
    }
    ranges
}

/// True when an odd run of backslashes precedes `at`, which makes that character literal.
fn escaped(content: &str, at: usize) -> bool {
    content.as_bytes()[..at]
        .iter()
        .rev()
        .take_while(|&&b| b == b'\\')
        .count()
        % 2
        == 1
}

fn is_indented(line: &str) -> bool {
    line.starts_with("    ") || line.starts_with('\t')
}

/// `[from, to)` offsets of indented code blocks: lines indented four spaces (or
/// a tab) that follow a blank line, outside a fence. A list's indented lines
/// continue the list item, so a list since the last unindented paragraph ends
/// the search there.
fn indented_code(content: &str, fences: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut at = 0;
    let mut after_blank = true;
    let mut in_list = false;
    let mut block: Option<(usize, usize)> = None;
    for line in content.split('\n') {
        let start = at;
        at += line.len() + 1;
        if fences.iter().any(|&(from, to)| start >= from && start < to) {
            after_blank = false;
            continue;
        }
        if line.trim().is_empty() {
            after_blank = true;
            continue;
        }
        if is_indented(line) && !in_list && (after_blank || block.is_some()) {
            match &mut block {
                Some(open) => open.1 = start + line.len(),
                None => block = Some((start, start + line.len())),
            }
            after_blank = false;
            continue;
        }
        if let Some(open) = block.take() {
            ranges.push(open);
        }
        if !is_indented(line) {
            in_list = LIST_ITEM.is_match(line);
        }
        after_blank = false;
    }
    if let Some(open) = block {
        ranges.push(open);
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90";
    const OTHER: &str = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

    fn targets(content: &str) -> Vec<String> {
        find_image_refs(content)
            .into_iter()
            .map(|r| r.target)
            .collect()
    }

    fn meta(id: &str, category: AttachmentCategory) -> AttachmentMeta {
        AttachmentMeta {
            id: id.into(),
            filename: "f".into(),
            media_type: "image/png".into(),
            size_bytes: 1,
            category,
            expired: false,
            inline: None,
        }
    }

    #[test]
    fn finds_each_image_with_its_alt_text_target_and_offsets_in_order() {
        let content = format!(
            "Rates fell.\n\n![Euribor, past year](charts/euribor.png)\n\nThen ![b](attachment:{ID}) too."
        );
        let refs = find_image_refs(&content);
        let pairs: Vec<(String, String)> = refs
            .iter()
            .map(|r| (r.alt.clone(), r.target.clone()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("Euribor, past year".into(), "charts/euribor.png".into()),
                ("b".into(), format!("attachment:{ID}")),
            ]
        );
        assert_eq!(
            &content[refs[0].start..refs[0].end],
            "![Euribor, past year](charts/euribor.png)"
        );
    }

    #[test]
    fn reads_an_angle_bracket_target_with_spaces_and_ignores_a_title() {
        assert_eq!(
            targets(r#"![chart](</work/my chart.png> "Rates")"#),
            vec!["/work/my chart.png"]
        );
    }

    #[test]
    fn skips_an_escaped_image_which_the_renderer_shows_as_text() {
        let content = format!(r"\![chart](attachment:{ID}) and \\![real](d.png)");
        assert_eq!(targets(&content), vec!["d.png"]);
    }

    #[test]
    fn skips_an_image_in_an_indented_code_block_but_not_in_a_list_item_or_a_continued_paragraph() {
        let content = [
            "    ![at the start](a.png)".to_string(),
            "".into(),
            "Example:".into(),
            "".into(),
            format!("    ![indented](attachment:{ID})"),
            "    more code".into(),
            "".into(),
            "A paragraph".into(),
            "    ![continued](b.png)".into(),
            "".into(),
            "- an item".into(),
            "".into(),
            "    ![in the item](c.png)".into(),
            "".into(),
            "Done.".into(),
            "".into(),
            "\t![tab](e.png)".into(),
        ]
        .join("\n");
        assert_eq!(targets(&content), vec!["b.png", "c.png"]);
        let image = meta(ID, AttachmentCategory::Image);
        assert_eq!(
            place_attachments(&content, vec![image.clone()]),
            vec![image]
        );
    }

    #[test]
    fn skips_images_inside_fenced_code_blocks_and_inline_code() {
        let content = [
            "```markdown",
            "![in a fence](a.png)",
            "```",
            "Write `![inline](b.png)` to place one.",
            "~~~",
            "![tilde fence](c.png)",
            "~~~",
            "![real](d.png)",
        ]
        .join("\n");
        assert_eq!(targets(&content), vec!["d.png"]);
    }

    #[test]
    fn treats_an_unclosed_fence_as_code_to_the_end() {
        assert!(find_image_refs("```\n![x](a.png)").is_empty());
    }

    #[test]
    fn ignores_a_link_that_is_not_an_image() {
        assert!(find_image_refs("[report](report.pdf)").is_empty());
    }

    #[test]
    fn reads_an_attachment_id_only_from_a_well_formed_reference() {
        assert_eq!(attachment_ref_id(&format!("attachment:{ID}")), Some(ID));
        assert_eq!(attachment_ref_id("attachment:not-an-id"), None);
        assert_eq!(attachment_ref_id("chart.png"), None);
    }

    #[test]
    fn tells_a_path_on_the_agent_filesystem_from_a_url() {
        assert!(is_local_path("chart.png"));
        assert!(is_local_path("/home/node/out/chart.png"));
        assert!(!is_local_path("https://example.com/a.png"));
        assert!(!is_local_path("data:image/png;base64,AAAA"));
        assert!(!is_local_path(&format!("attachment:{ID}")));
    }

    #[test]
    fn swaps_the_references_it_answers_for_and_keeps_the_rest_of_the_text() {
        let content = "A ![one](a.png) B ![two](b.png) C";
        let refs = find_image_refs(content);
        let out = replace_image_refs(content, &refs, |r| {
            (r.target == "a.png").then(|| attachment_image(&r.alt, ID))
        });
        assert_eq!(out, format!("A ![one](attachment:{ID}) B ![two](b.png) C"));
    }

    #[test]
    fn marks_each_image_the_text_references_as_inline_and_nothing_else() {
        let image = meta(ID, AttachmentCategory::Image);
        let pdf = meta(OTHER, AttachmentCategory::Pdf);
        let mut inline = image.clone();
        inline.inline = Some(true);
        assert_eq!(
            place_attachments(
                &format!("See ![chart](attachment:{ID})"),
                vec![image.clone(), pdf.clone()]
            ),
            vec![inline, pdf.clone()]
        );
        // A file that is not an image stays under the text.
        assert_eq!(
            place_attachments(&format!("![brief](attachment:{OTHER})"), vec![pdf.clone()]),
            vec![pdf]
        );
        // A reference written as code places nothing.
        assert_eq!(
            place_attachments(&format!("`![chart](attachment:{ID})`"), vec![image.clone()]),
            vec![image]
        );
    }
}
