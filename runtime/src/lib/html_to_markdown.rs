//! A web page's HTML as markdown: the page's main text when Readability finds it, else
//! the whole body. Links and images point at absolute addresses, so the agent can read
//! a linked page next.
//!
//! An HTML5 parser builds the page's tree, so the text of a page that leaves out the
//! optional `<html>`, `<head>` or `<body>` tag is in the body. Readability runs on a
//! copy of that tree with every `<base>` removed, because Readability changes the
//! document it parses and resolves every link against the document's base, which the
//! converter does within its budget.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::support::js::slice16;

/// A title longer than this is cut.
pub const MAX_TITLE_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkdownPage {
    /// One line of at most `MAX_TITLE_CHARS` characters.
    pub title: String,
    pub markdown: String,
    /// `readability` for the main text, `whole_page` for the body when Readability finds none.
    pub extractor: MarkdownExtractor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkdownExtractor {
    Readability,
    WholePage,
}

impl MarkdownExtractor {
    pub fn as_str(&self) -> &'static str {
        match self {
            MarkdownExtractor::Readability => "readability",
            MarkdownExtractor::WholePage => "whole_page",
        }
    }
}

/// The page as markdown.
///
/// The base is the page's own `<base href>` resolved against `page_url`, else
/// `page_url`. When Readability finds an article with text, the title is the
/// article's title made one line (else the document's), the markdown is the
/// article's content converted and trimmed, and the extractor is `readability`.
/// Otherwise the title is the document's, the markdown is the body converted and
/// trimmed, and the extractor is `whole_page`.
///
/// The converter writes ATX headings, fenced code blocks, `-` bullets and GFM
/// tables, and drops the `DROPPED_ELEMENTS`. Links and images share one address
/// budget of `html`'s length in UTF-16 units: each resolution pays for what it
/// parses (the href, plus the base for a relative href, `SCHEME` telling them
/// apart), or for its result when that is longer, and an address the budget
/// cannot pay for, or that is not http or https, is dropped. A link keeps its
/// trimmed text and its address (`[text](href)`); a link with no text is dropped,
/// and a link to a place on this page (same address before `#`) keeps only its
/// text. An image keeps its trimmed alt text and its address (`![alt](src)`), or
/// only the alt without an address; an image without alt text is dropped.
pub fn html_to_markdown(html: &str, page_url: &str) -> MarkdownPage {
    todo!()
}

/// JavaScript's `\s`.
static JS_WHITESPACE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+")
        .unwrap()
});

/// A title from the page's metadata keeps its line breaks, so they are collapsed here.
fn one_line(title: &str) -> String {
    let collapsed = JS_WHITESPACE.replace_all(title, " ");
    let trimmed =
        collapsed.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    slice16(trimmed, 0, MAX_TITLE_CHARS)
}

/// The page's own `<base href>`, resolved against its address, else the address.
fn base_url(href: Option<&str>, page_url: &str) -> String {
    let Some(href) = href.filter(|h| !h.is_empty()) else {
        return page_url.to_string();
    };
    match Url::parse(page_url).and_then(|base| base.join(href)) {
        Ok(url) => url.to_string(),
        Err(_) => page_url.to_string(),
    }
}

/// An href that starts with a scheme is absolute, so parsing it needs no base.
static SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z\d+.-]*:").unwrap());

/// Elements whose content is code, styling or a picture, never text for a reader.
const DROPPED_ELEMENTS: [&str; 9] = [
    "script", "style", "noscript", "template", "iframe", "svg", "canvas", "object", "embed",
];
