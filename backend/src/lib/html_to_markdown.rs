//! A web page's HTML as markdown: the page's main text when Readability finds it, else
//! the whole body. Links and images point at absolute addresses, so the agent can read
//! a linked page next.
//!
//! An HTML5 parser builds the page's tree, so the text of a page that leaves out the
//! optional `<html>`, `<head>` or `<body>` tag is in the body. Readability runs on a
//! copy of that tree with every `<base>` removed, because Readability changes the
//! document it parses and resolves every link against the document's base, which the
//! converter does within its budget.
//!
//! The converter is turndown 7.2 with the GFM plugin, as the TypeScript runtime ran it:
//! the same whitespace collapsing, rules, escaping and joins, on a tree parsed as domino
//! parses it (scripting on, so `<noscript>` holds text) and serialized as domino
//! serializes it where turndown keeps a table as HTML.

use std::sync::LazyLock;

use html5ever::tendril::TendrilSink;
use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::support::js::{is_js_whitespace, len16, slice16, trim as js_trim};

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
///
/// Fails where turndown throws: on a table without a row, and on a tree nested
/// deeper than the converter follows.
pub fn html_to_markdown(html: &str, page_url: &str) -> anyhow::Result<MarkdownPage> {
    let tree = Dom::parse(html);
    let href = tree
        .find(tree.root(), |el| {
            el.local == "base" && el.attr("href").is_some()
        })
        .and_then(|base| tree.element(base).and_then(|el| el.attr("href")));
    let base = base_url(href, page_url);
    let document_title = one_line(&tree.document_title());

    // A copy, since Readability changes the document it parses. Readability resolves
    // every link against the document's base, which the converter does within its
    // budget, so the copy has no `<base>`.
    let html_element = tree.first_element_child(tree.root());
    let article = html_element.and_then(|root| readable_article(&tree.outer_html(root)));

    let mut converter = Converter::new(&base, page_url, len16(html) as i64);
    if let Some(article) = article {
        let title = one_line(&article.title);
        return Ok(MarkdownPage {
            title: if title.is_empty() {
                document_title
            } else {
                title
            },
            markdown: js_trim(&converter.turndown(&article.content)?).to_string(),
            extractor: MarkdownExtractor::Readability,
        });
    }
    let body = html_element
        .and_then(|root| {
            tree.children(root).into_iter().find(|&child| {
                tree.element(child)
                    .is_some_and(|el| el.html && (el.local == "body" || el.local == "frameset"))
            })
        })
        .ok_or_else(|| anyhow::anyhow!("Cannot read properties of null (reading 'innerHTML')"))?;
    Ok(MarkdownPage {
        title: document_title,
        markdown: js_trim(&converter.turndown(&tree.inner_html(body))?).to_string(),
        extractor: MarkdownExtractor::WholePage,
    })
}

/// What Readability found: its title and content, when the content has text.
struct ReadableArticle {
    title: String,
    content: String,
}

fn readable_article(document_html: &str) -> Option<ReadableArticle> {
    let copy = dom_query::Document::from(document_html);
    copy.select("base").remove();
    let mut readability = dom_smoothie::Readability::with_document(copy, None, None).ok()?;
    let article = readability.parse().ok()?;
    if article.content.is_empty() || js_trim(&article.text_content).is_empty() {
        return None;
    }
    Some(ReadableArticle {
        title: article.title,
        content: article.content.to_string(),
    })
}

/// A title from the page's metadata keeps its line breaks, so they are collapsed here.
fn one_line(title: &str) -> String {
    let collapsed = JS_WHITESPACE.replace_all(title, " ");
    slice16(js_trim(&collapsed), 0, MAX_TITLE_CHARS)
}

/// JavaScript's `\s+`.
static JS_WHITESPACE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+")
        .unwrap()
});

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

/// How deep the converter follows nested elements. turndown recurses once per level
/// and fails past the JavaScript stack; a tree deeper than this fails the same way.
const MAX_DEPTH: usize = 2_000;

// ============================================================================
// The tree, as domino builds it
// ============================================================================

const HTML_NS: &str = "http://www.w3.org/1999/xhtml";
const SVG_NS: &str = "http://www.w3.org/2000/svg";
const MATHML_NS: &str = "http://www.w3.org/1998/Math/MathML";

type NodeId = usize;

#[derive(Debug, Clone)]
struct ElementData {
    /// `nodeName`: the uppercase name of an HTML element, else the qualified name.
    name: String,
    /// `localName`.
    local: String,
    /// The name serialization writes: the local name of an HTML, SVG or MathML
    /// element, else the qualified name.
    tag: String,
    html: bool,
    /// Qualified names and values, in document order.
    attrs: Vec<(String, String)>,
    /// A `<template>`'s contents, which are not its children.
    content: Option<NodeId>,
}

impl ElementData {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone)]
enum Kind {
    Document,
    Fragment,
    Element(ElementData),
    Text(String),
    Comment(String),
    Other,
}

#[derive(Debug, Clone)]
struct DomNode {
    kind: Kind,
    parent: Option<NodeId>,
    first: Option<NodeId>,
    last: Option<NodeId>,
    prev: Option<NodeId>,
    next: Option<NodeId>,
}

struct Dom {
    nodes: Vec<DomNode>,
}

impl Dom {
    /// The document `html` parses into with scripting on, as domino's `createDocument`.
    fn parse(html: &str) -> Dom {
        let opts = html5ever::ParseOpts {
            tree_builder: html5ever::tree_builder::TreeBuilderOpts {
                scripting_enabled: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let document = html5ever::parse_document(dom_query::Document::default(), opts).one(html);
        Dom::from_document(&document)
    }

    fn from_document(document: &dom_query::Document) -> Dom {
        let mut dom = Dom { nodes: Vec::new() };
        let root = dom.push(Kind::Document, None);
        // (source, parent in this tree)
        let mut stack: Vec<(dom_query::NodeRef<'_>, NodeId)> = document
            .root()
            .children()
            .into_iter()
            .rev()
            .map(|child| (child, root))
            .collect();
        while let Some((source, parent)) = stack.pop() {
            let (kind, template) = dom.kind_of(&source);
            let id = dom.push(kind, Some(parent));
            if let Some(contents) = template {
                let fragment = dom.push_detached(Kind::Fragment);
                if let Kind::Element(el) = &mut dom.nodes[id].kind {
                    el.content = Some(fragment);
                }
                let content = dom_query::NodeRef::new(contents, &document.tree);
                for child in content.children().into_iter().rev() {
                    stack.push((child, fragment));
                }
            }
            for child in source.children().into_iter().rev() {
                stack.push((child, id));
            }
        }
        dom
    }

    /// The kind of a parsed node, and the contents node of a template.
    fn kind_of(&self, source: &dom_query::NodeRef<'_>) -> (Kind, Option<dom_query::NodeId>) {
        source
            .query(|node| match &node.data {
                dom_query::NodeData::Element(el) => {
                    let ns: &str = &el.name.ns;
                    let local = el.name.local.to_string();
                    let qualified = match &el.name.prefix {
                        Some(prefix) => format!("{prefix}:{local}"),
                        None => local.clone(),
                    };
                    let html = ns == HTML_NS;
                    let name = if html {
                        qualified.to_ascii_uppercase()
                    } else {
                        qualified.clone()
                    };
                    let tag = if html || ns == SVG_NS || ns == MATHML_NS {
                        local.clone()
                    } else {
                        qualified
                    };
                    let attrs = el
                        .attrs
                        .iter()
                        .map(|attr| {
                            let name = match &attr.name.prefix {
                                Some(prefix) => format!("{prefix}:{}", attr.name.local),
                                None => attr.name.local.to_string(),
                            };
                            (name, attr.value.to_string())
                        })
                        .collect();
                    (
                        Kind::Element(ElementData {
                            name,
                            local,
                            tag,
                            html,
                            attrs,
                            content: None,
                        }),
                        el.template_contents,
                    )
                }
                dom_query::NodeData::Text { contents } => (Kind::Text(contents.to_string()), None),
                dom_query::NodeData::Comment { contents } => {
                    (Kind::Comment(contents.to_string()), None)
                }
                _ => (Kind::Other, None),
            })
            .unwrap_or((Kind::Other, None))
    }

    fn push_detached(&mut self, kind: Kind) -> NodeId {
        self.nodes.push(DomNode {
            kind,
            parent: None,
            first: None,
            last: None,
            prev: None,
            next: None,
        });
        self.nodes.len() - 1
    }

    /// A new last child of `parent`.
    fn push(&mut self, kind: Kind, parent: Option<NodeId>) -> NodeId {
        let id = self.push_detached(kind);
        if let Some(parent) = parent {
            self.nodes[id].parent = Some(parent);
            match self.nodes[parent].last {
                Some(last) => {
                    self.nodes[last].next = Some(id);
                    self.nodes[id].prev = Some(last);
                }
                None => self.nodes[parent].first = Some(id),
            }
            self.nodes[parent].last = Some(id);
        }
        id
    }

    fn root(&self) -> NodeId {
        0
    }

    fn element(&self, id: NodeId) -> Option<&ElementData> {
        match &self.nodes[id].kind {
            Kind::Element(el) => Some(el),
            _ => None,
        }
    }

    fn text(&self, id: NodeId) -> Option<&str> {
        match &self.nodes[id].kind {
            Kind::Text(text) => Some(text),
            _ => None,
        }
    }

    /// `nodeName`.
    fn node_name(&self, id: NodeId) -> &str {
        match &self.nodes[id].kind {
            Kind::Element(el) => &el.name,
            Kind::Text(_) => "#text",
            Kind::Comment(_) => "#comment",
            Kind::Document => "#document",
            Kind::Fragment => "#document-fragment",
            Kind::Other => "",
        }
    }

    fn children(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut child = self.nodes[id].first;
        while let Some(c) = child {
            out.push(c);
            child = self.nodes[c].next;
        }
        out
    }

    fn first_element_child(&self, id: NodeId) -> Option<NodeId> {
        self.children(id)
            .into_iter()
            .find(|&c| self.element(c).is_some())
    }

    fn last_element_child(&self, id: NodeId) -> Option<NodeId> {
        let mut child = self.nodes[id].last;
        while let Some(c) = child {
            if self.element(c).is_some() {
                return Some(c);
            }
            child = self.nodes[c].prev;
        }
        None
    }

    /// The descendants of `id` in tree order, `id` excluded.
    fn descendants(&self, id: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        let mut current = self.nodes[id].first;
        std::iter::from_fn(move || {
            let node = current?;
            current = self.nodes[node].first.or_else(|| {
                let mut up = Some(node);
                while let Some(n) = up {
                    if n == id {
                        return None;
                    }
                    if let Some(next) = self.nodes[n].next {
                        return Some(next);
                    }
                    up = self.nodes[n].parent;
                }
                None
            });
            Some(node)
        })
    }

    /// The first descendant element of `id` that `matches`, in tree order.
    fn find(&self, id: NodeId, matches: impl Fn(&ElementData) -> bool) -> Option<NodeId> {
        self.descendants(id)
            .find(|&d| self.element(d).is_some_and(&matches))
    }

    /// `getElementsByTagName(name)` is not empty, for an uppercase HTML name.
    fn has_descendant_named(&self, id: NodeId, names: &[&str]) -> bool {
        self.descendants(id).any(|d| {
            self.element(d)
                .is_some_and(|el| names.contains(&el.name.as_str()))
        })
    }

    /// `textContent`.
    fn text_content(&self, id: NodeId) -> String {
        if let Some(text) = self.text(id) {
            return text.to_string();
        }
        let mut out = String::new();
        for d in self.descendants(id) {
            if let Some(text) = self.text(d) {
                out.push_str(text);
            }
        }
        out
    }

    /// The text nodes of `id`'s `textContent`, in order.
    fn text_parts(&self, id: NodeId) -> Vec<&str> {
        if let Some(text) = self.text(id) {
            return vec![text];
        }
        self.descendants(id).filter_map(|d| self.text(d)).collect()
    }

    /// `document.title` as domino reads it: the first `title` element's text with
    /// ASCII whitespace collapsed and one space stripped from each end.
    fn document_title(&self) -> String {
        let Some(title) = self.find(self.root(), |el| el.local == "title") else {
            return String::new();
        };
        static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t\n\r\x0C]+").unwrap());
        let collapsed = SPACE
            .replace_all(&self.text_content(title), " ")
            .into_owned();
        let stripped = collapsed.strip_prefix(' ').unwrap_or(&collapsed);
        stripped.strip_suffix(' ').unwrap_or(stripped).to_string()
    }

    /// Detaches `id` and returns `nextSibling || parentNode`.
    fn remove(&mut self, id: NodeId) -> Option<NodeId> {
        let DomNode {
            parent, prev, next, ..
        } = self.nodes[id].clone();
        let after = next.or(parent);
        match prev {
            Some(p) => self.nodes[p].next = next,
            None => {
                if let Some(parent) = parent {
                    self.nodes[parent].first = next;
                }
            }
        }
        match next {
            Some(n) => self.nodes[n].prev = prev,
            None => {
                if let Some(parent) = parent {
                    self.nodes[parent].last = prev;
                }
            }
        }
        let node = &mut self.nodes[id];
        node.parent = None;
        node.prev = None;
        node.next = None;
        after
    }

    // ------------------------------------------------------------ serializing

    fn outer_html(&self, id: NodeId) -> String {
        let mut out = String::new();
        self.serialize_node(id, &mut out);
        out
    }

    fn inner_html(&self, id: NodeId) -> String {
        let mut out = String::new();
        self.serialize_children(id, &mut out);
        out
    }

    fn serialize_children(&self, id: NodeId, out: &mut String) {
        let source = match self.element(id).and_then(|el| el.content) {
            Some(content) => content,
            None => id,
        };
        for child in self.children(source) {
            self.serialize_node(child, out);
        }
    }

    /// domino's `serializeOne`.
    fn serialize_node(&self, id: NodeId, out: &mut String) {
        match &self.nodes[id].kind {
            Kind::Element(el) => {
                out.push('<');
                out.push_str(&el.tag);
                for (name, value) in &el.attrs {
                    out.push(' ');
                    out.push_str(name);
                    out.push_str("=\"");
                    push_escaped(out, value, true);
                    out.push('"');
                }
                out.push('>');
                if el.html && SERIALIZED_EMPTY.contains(&el.tag.as_str()) {
                    return;
                }
                let mut inner = String::new();
                self.serialize_children(id, &mut inner);
                if RAW_CONTENT.contains(&el.tag.to_uppercase().as_str()) {
                    inner = escape_matching_closing_tag(&inner, &el.tag);
                }
                out.push_str(&inner);
                out.push_str("</");
                out.push_str(&el.tag);
                out.push('>');
            }
            Kind::Text(text) => {
                let raw = self.nodes[id]
                    .parent
                    .and_then(|p| self.element(p))
                    .is_some_and(|parent| {
                        parent.html
                            && (RAW_CONTENT.contains(&parent.name.as_str())
                                || parent.name == "NOSCRIPT")
                    });
                if raw {
                    out.push_str(text);
                } else {
                    push_escaped(out, text, false);
                }
            }
            Kind::Comment(text) => {
                static CLOSING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(--!?)>").unwrap());
                out.push_str("<!--");
                out.push_str(&CLOSING.replace_all(text, "$1&gt;"));
                out.push_str("-->");
            }
            Kind::Document | Kind::Fragment => self.serialize_children(id, out),
            Kind::Other => {}
        }
    }
}

/// Elements whose text domino serializes unescaped.
const RAW_CONTENT: [&str; 7] = [
    "STYLE",
    "SCRIPT",
    "XMP",
    "IFRAME",
    "NOEMBED",
    "NOFRAMES",
    "PLAINTEXT",
];

/// HTML elements domino serializes without content or an end tag.
const SERIALIZED_EMPTY: [&str; 18] = [
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input",
    "keygen", "link", "meta", "param", "source", "track", "wbr",
];

fn push_escaped(out: &mut String, text: &str, attribute: bool) {
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            '"' if attribute => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
}

/// Every `</tag` in raw text, any ASCII case, with its `<` written `&lt;`.
fn escape_matching_closing_tag(raw: &str, tag: &str) -> String {
    let closing = format!("</{tag}");
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut last = 0;
    let mut at = 0;
    while let Some(found) = raw[at..].find("</") {
        let start = at + found;
        let end = start + closing.len();
        if end <= bytes.len() && bytes[start..end].eq_ignore_ascii_case(closing.as_bytes()) {
            out.push_str(&raw[last..start]);
            out.push_str("&lt;");
            last = start + 1;
        }
        at = start + 1;
    }
    out.push_str(&raw[last..]);
    out
}

// ============================================================================
// turndown
// ============================================================================

const BLOCK_ELEMENTS: [&str; 49] = [
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "AUDIO",
    "BLOCKQUOTE",
    "BODY",
    "CANVAS",
    "CENTER",
    "DD",
    "DIR",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "FRAMESET",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HGROUP",
    "HR",
    "HTML",
    "ISINDEX",
    "LI",
    "MAIN",
    "MENU",
    "NAV",
    "NOFRAMES",
    "NOSCRIPT",
    "OL",
    "OUTPUT",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
];

const VOID_ELEMENTS: [&str; 16] = [
    "AREA", "BASE", "BR", "COL", "COMMAND", "EMBED", "HR", "IMG", "INPUT", "KEYGEN", "LINK",
    "META", "PARAM", "SOURCE", "TRACK", "WBR",
];

const MEANINGFUL_WHEN_BLANK: [&str; 11] = [
    "A", "TABLE", "THEAD", "TBODY", "TFOOT", "TH", "TD", "IFRAME", "SCRIPT", "AUDIO", "VIDEO",
];

impl Dom {
    fn is_block(&self, id: NodeId) -> bool {
        BLOCK_ELEMENTS.contains(&self.node_name(id))
    }

    fn is_void(&self, id: NodeId) -> bool {
        VOID_ELEMENTS.contains(&self.node_name(id))
    }

    fn is_pre(&self, id: NodeId) -> bool {
        self.node_name(id) == "PRE"
    }

    fn attr(&self, id: NodeId, name: &str) -> Option<&str> {
        self.element(id).and_then(|el| el.attr(name))
    }
}

/// turndown's `collapseWhitespace`: runs of ASCII whitespace become one space, and
/// the spaces block boundaries make redundant are removed, outside `<pre>`.
fn collapse_whitespace(dom: &mut Dom, element: NodeId) {
    if dom.nodes[element].first.is_none() || dom.is_pre(element) {
        return;
    }
    static RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \r\n\t]+").unwrap());

    let mut prev_text: Option<NodeId> = None;
    let mut keep_leading_ws = false;
    let mut prev: Option<NodeId> = None;
    let mut node = next_node(dom, prev, element);
    while let Some(current) = node {
        if current == element {
            break;
        }
        match &dom.nodes[current].kind {
            Kind::Text(data) => {
                let mut text = RUN.replace_all(data, " ").into_owned();
                let after_space = prev_text
                    .map(|p| dom.text(p).is_some_and(|t| t.ends_with(' ')))
                    .unwrap_or(true);
                if after_space && !keep_leading_ws && text.starts_with(' ') {
                    text.remove(0);
                }
                if text.is_empty() {
                    node = dom.remove(current);
                    continue;
                }
                dom.nodes[current].kind = Kind::Text(text);
                prev_text = Some(current);
            }
            Kind::Element(_) => {
                if dom.is_block(current) || dom.node_name(current) == "BR" {
                    if let Some(p) = prev_text {
                        trim_one_trailing_space(dom, p);
                    }
                    prev_text = None;
                    keep_leading_ws = false;
                } else if dom.is_void(current) || dom.is_pre(current) {
                    // Avoid trimming space around non-block, non-BR void elements and inline PRE.
                    prev_text = None;
                    keep_leading_ws = true;
                } else if prev_text.is_some() {
                    // Drop protection if set previously.
                    keep_leading_ws = false;
                }
            }
            _ => {
                node = dom.remove(current);
                continue;
            }
        }
        let following = next_node(dom, prev, current);
        prev = Some(current);
        node = following;
    }
    if let Some(p) = prev_text {
        trim_one_trailing_space(dom, p);
        if dom.text(p).is_some_and(str::is_empty) {
            dom.remove(p);
        }
    }
}

fn trim_one_trailing_space(dom: &mut Dom, id: NodeId) {
    if let Kind::Text(text) = &mut dom.nodes[id].kind
        && text.ends_with(' ')
    {
        text.pop();
    }
}

/// The node after `current` in collapse order, given the node before it.
fn next_node(dom: &Dom, prev: Option<NodeId>, current: NodeId) -> Option<NodeId> {
    let node = &dom.nodes[current];
    if prev.is_some_and(|p| dom.nodes[p].parent == Some(current)) || dom.is_pre(current) {
        return node.next.or(node.parent);
    }
    node.first.or(node.next).or(node.parent)
}

/// The whitespace at the edges of a node's text, as turndown's `edgeWhitespace` splits it.
#[derive(Debug, Default, PartialEq, Eq)]
struct Edges {
    leading: String,
    leading_ascii: String,
    leading_non_ascii: String,
    trailing: String,
    trailing_non_ascii: String,
    trailing_ascii: String,
}

fn is_ascii_ws(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\r' | '\n')
}

fn edge_whitespace(parts: &[&str]) -> Edges {
    let chars = || parts.iter().flat_map(|p| p.chars());
    let leading: String = chars().take_while(|&c| is_js_whitespace(c)).collect();
    let leading_ascii: String = leading.chars().take_while(|&c| is_ascii_ws(c)).collect();
    let leading_non_ascii = leading[leading_ascii.len()..].to_string();
    let all_whitespace = chars().all(is_js_whitespace);
    if all_whitespace {
        return Edges {
            leading,
            leading_ascii,
            leading_non_ascii,
            ..Default::default()
        };
    }
    let mut trailing_rev: Vec<char> = Vec::new();
    for part in parts.iter().rev() {
        let mut done = false;
        for c in part.chars().rev() {
            if !is_js_whitespace(c) {
                done = true;
                break;
            }
            trailing_rev.push(c);
        }
        if done {
            break;
        }
    }
    let trailing: String = trailing_rev.iter().rev().collect();
    let ascii_count = trailing_rev.iter().take_while(|&&c| is_ascii_ws(c)).count();
    let split = trailing.len()
        - trailing_rev[..ascii_count]
            .iter()
            .map(|c| c.len_utf8())
            .sum::<usize>();
    Edges {
        leading,
        leading_ascii,
        leading_non_ascii,
        trailing_non_ascii: trailing[..split].to_string(),
        trailing_ascii: trailing[split..].to_string(),
        trailing,
    }
}

/// The text a rule's output joins to, with the newlines either side reconciled:
/// at most two, as many as the larger side had.
fn join(output: &mut String, replacement: &str) {
    let trailing = output.len() - output.trim_end_matches('\n').len();
    output.truncate(output.len() - trailing);
    let s2 = replacement.trim_start_matches('\n');
    let leading = replacement.len() - s2.len();
    let newlines = trailing.max(leading).min(2);
    for _ in 0..newlines {
        output.push('\n');
    }
    output.push_str(s2);
}

fn trim_newlines(text: &str) -> &str {
    text.trim_start_matches('\n').trim_end_matches('\n')
}

static ESCAPES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"\\", r"\\"),
        (r"\*", r"\*"),
        (r"^-", r"\-"),
        (r"^\+ ", r"\+ "),
        (r"^(=+)", r"\$1"),
        (r"^(#{1,6}) ", r"\$1 "),
        (r"`", r"\`"),
        (r"^~~~", r"\~~~"),
        (r"\[", r"\["),
        (r"\]", r"\]"),
        (r"^>", r"\>"),
        (r"_", r"\_"),
        (r"^([0-9]+)\. ", r"$1\. "),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(pattern).unwrap(), replacement))
    .collect()
});

/// turndown's `escapeMarkdown`.
fn escape_markdown(text: &str) -> String {
    let mut out = text.to_string();
    for (pattern, replacement) in ESCAPES.iter() {
        if pattern.is_match(&out) {
            out = pattern.replace_all(&out, *replacement).into_owned();
        }
    }
    out
}

/// What a node becomes when no rule matches, when blank, or when kept as HTML.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)] // turndown's rule names.
enum Rule {
    Blank,
    Image,
    Link,
    TaskListItem,
    TableSection,
    Table,
    TableRow,
    TableCell,
    Strikethrough,
    HighlightedCodeBlock,
    Paragraph,
    LineBreak,
    Heading,
    Blockquote,
    List,
    ListItem,
    FencedCodeBlock,
    HorizontalRule,
    Emphasis,
    Strong,
    Code,
    Keep,
    Remove,
    Default,
}

/// The `TypeError` turndown throws reading `parentNode` of a table's missing first row.
const NO_ROW_ERROR: &str = "Cannot read properties of undefined (reading 'parentNode')";

static HIGHLIGHT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"highlight-(?:text|source)-([a-z0-9]+)").unwrap());

struct Converter {
    base: String,
    /// The page's address before any `#`.
    page: String,
    /// What is left of the address budget, in UTF-16 units.
    budget: i64,
}

impl Converter {
    fn new(base: &str, page_url: &str, address_budget: i64) -> Converter {
        Converter {
            base: base.to_string(),
            page: page_url.split('#').next().unwrap_or("").to_string(),
            budget: address_budget,
        }
    }

    /// The addresses of links and images share one budget: the page's length in
    /// characters. Each resolution pays for what it parses (the href, plus the base for
    /// a relative href), or for its result when that is longer. So a long `<base href>`
    /// repeated in every link cannot make the work or the result larger than the page.
    /// A link or image that the budget cannot pay for keeps its text and loses its address.
    fn resolve(&mut self, href: Option<&str>) -> Option<String> {
        let value = js_trim(href?);
        if value.is_empty() {
            return None;
        }
        let relative = !SCHEME.is_match(value);
        let cost = if relative {
            len16(&self.base) + len16(value)
        } else {
            len16(value)
        } as i64;
        if cost > self.budget {
            return None;
        }
        let url = if relative {
            Url::parse(&self.base).ok().and_then(|b| b.join(value).ok())
        } else {
            Url::parse(value).ok()
        };
        self.budget -= cost.max(url.as_ref().map_or(0, |u| len16(u.as_str()) as i64));
        let url = url?;
        if self.budget < 0 || (url.scheme() != "http" && url.scheme() != "https") {
            return None;
        }
        Some(url.to_string())
    }

    /// turndown's `turndown(input)` on a string.
    fn turndown(&mut self, input: &str) -> anyhow::Result<String> {
        if input.is_empty() {
            return Ok(String::new());
        }
        // DOM parsers arrange elements in the <head> and <body>. Wrapping in a custom
        // element ensures elements are reliably arranged in a single element.
        let mut dom = Dom::parse(&format!(
            "<x-turndown id=\"turndown-root\">{input}</x-turndown>"
        ));
        let Some(root) = dom.find(dom.root(), |el| el.attr("id") == Some("turndown-root")) else {
            return Ok(String::new());
        };
        collapse_whitespace(&mut dom, root);
        let mut is_code = vec![false; dom.nodes.len()];
        let output = self.process(&dom, root, &mut is_code, 0)?;
        static LEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\t\r\n]+").unwrap());
        let output = LEADING.replace(&output, "");
        Ok(output
            .trim_end_matches(|c: char| is_js_whitespace(c))
            .to_string())
    }

    /// turndown's `process`: each child's replacement, joined.
    fn process(
        &mut self,
        dom: &Dom,
        parent: NodeId,
        is_code: &mut Vec<bool>,
        depth: usize,
    ) -> anyhow::Result<String> {
        if depth > MAX_DEPTH {
            anyhow::bail!("Maximum call stack size exceeded");
        }
        let mut output = String::new();
        for node in dom.children(parent) {
            is_code[node] = dom.node_name(node) == "CODE" || is_code[parent];
            let replacement = match &dom.nodes[node].kind {
                Kind::Text(text) => {
                    if is_code[node] {
                        text.clone()
                    } else {
                        escape_markdown(text)
                    }
                }
                Kind::Element(_) => self.replacement_for_node(dom, node, is_code, depth)?,
                _ => String::new(),
            };
            join(&mut output, &replacement);
        }
        Ok(output)
    }

    fn replacement_for_node(
        &mut self,
        dom: &Dom,
        node: NodeId,
        is_code: &mut Vec<bool>,
        depth: usize,
    ) -> anyhow::Result<String> {
        let rule = self.rule_for(dom, node)?;
        let mut content = self.process(dom, node, is_code, depth + 1)?;
        let (leading, trailing) = flanking_whitespace(dom, node);
        if !leading.is_empty() || !trailing.is_empty() {
            content = js_trim(&content).to_string();
        }
        let replaced = self.replacement(rule, &content, dom, node)?;
        Ok(format!("{leading}{replaced}{trailing}"))
    }

    /// turndown's `forNode`: blank, then the rules in order, then keep, then remove.
    fn rule_for(&self, dom: &Dom, node: NodeId) -> anyhow::Result<Rule> {
        if is_blank(dom, node) {
            return Ok(Rule::Blank);
        }
        let name = dom.node_name(node).to_lowercase();
        let el = dom.element(node).expect("an element");
        let parent_name = |n: NodeId| dom.nodes[n].parent.map_or("", |p| dom.node_name(p));
        let rule = match name.as_str() {
            "img" => Rule::Image,
            "a" => Rule::Link,
            _ if is_checkbox(el) && parent_name(node) == "LI" => Rule::TaskListItem,
            "thead" | "tbody" | "tfoot" => Rule::TableSection,
            _ if dom.node_name(node) == "TABLE" && is_heading_row(dom, first_row(dom, node)?) => {
                Rule::Table
            }
            "tr" => Rule::TableRow,
            "th" | "td" => Rule::TableCell,
            "del" | "s" | "strike" => Rule::Strikethrough,
            _ if dom.node_name(node) == "DIV"
                && HIGHLIGHT.is_match(el.attr("class").unwrap_or(""))
                && dom.nodes[node]
                    .first
                    .is_some_and(|c| dom.node_name(c) == "PRE") =>
            {
                Rule::HighlightedCodeBlock
            }
            "p" => Rule::Paragraph,
            "br" => Rule::LineBreak,
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => Rule::Heading,
            "blockquote" => Rule::Blockquote,
            "ul" | "ol" => Rule::List,
            "li" => Rule::ListItem,
            _ if dom.node_name(node) == "PRE"
                && dom.nodes[node]
                    .first
                    .is_some_and(|c| dom.node_name(c) == "CODE") =>
            {
                Rule::FencedCodeBlock
            }
            "hr" => Rule::HorizontalRule,
            "em" | "i" => Rule::Emphasis,
            "strong" | "b" => Rule::Strong,
            _ if dom.node_name(node) == "CODE" && !is_code_block(dom, node) => Rule::Code,
            // Tables with no heading row are kept as HTML.
            _ if dom.node_name(node) == "TABLE" => Rule::Keep,
            _ if DROPPED_ELEMENTS.contains(&name.as_str()) => Rule::Remove,
            _ => Rule::Default,
        };
        Ok(rule)
    }

    fn replacement(
        &mut self,
        rule: Rule,
        content: &str,
        dom: &Dom,
        node: NodeId,
    ) -> anyhow::Result<String> {
        let block = dom.is_block(node);
        Ok(match rule {
            Rule::Blank => {
                if block {
                    "\n\n".to_string()
                } else {
                    String::new()
                }
            }
            Rule::Image => {
                let alt = js_trim(dom.attr(node, "alt").unwrap_or("")).to_string();
                if alt.is_empty() {
                    return Ok(String::new());
                }
                match self.resolve(dom.attr(node, "src")) {
                    Some(src) => format!("![{alt}]({src})"),
                    None => alt,
                }
            }
            Rule::Link => {
                let text = js_trim(content);
                if text.is_empty() {
                    return Ok(String::new());
                }
                match self.resolve(dom.attr(node, "href")) {
                    Some(href) if href.split('#').next() != Some(self.page.as_str()) => {
                        format!("[{text}]({href})")
                    }
                    _ => text.to_string(),
                }
            }
            Rule::TaskListItem => {
                let checked = dom.element(node).is_some_and(|el| {
                    el.html
                        && (el.local == "input" || el.local == "menuitem")
                        && el.attr("checked").is_some()
                });
                format!("{} ", if checked { "[x]" } else { "[ ]" })
            }
            Rule::TableSection => content.to_string(),
            Rule::Table => format!("\n\n{}\n\n", content.replacen("\n\n", "\n", 1)),
            Rule::TableRow => {
                let mut border_cells = String::new();
                if is_heading_row(dom, node) {
                    for child in dom.children(node) {
                        let Some(el) = dom.element(child) else {
                            anyhow::bail!("node.childNodes[i].getAttribute is not a function");
                        };
                        let align = el.attr("align").unwrap_or("").to_lowercase();
                        let border = match align.as_str() {
                            "left" => ":--",
                            "right" => "--:",
                            "center" => ":-:",
                            _ => "---",
                        };
                        border_cells.push_str(&cell(border, dom, child));
                    }
                }
                if border_cells.is_empty() {
                    format!("\n{content}")
                } else {
                    format!("\n{content}\n{border_cells}")
                }
            }
            Rule::TableCell => cell(content, dom, node),
            Rule::Strikethrough => format!("~{content}~"),
            Rule::HighlightedCodeBlock => {
                let class = dom.attr(node, "class").unwrap_or("");
                let language = HIGHLIGHT
                    .captures(class)
                    .map_or("", |c| c.get(1).map_or("", |m| m.as_str()));
                let first = dom.nodes[node].first.expect("a first child");
                format!("\n\n```{language}\n{}\n```\n\n", dom.text_content(first))
            }
            Rule::Paragraph => format!("\n\n{content}\n\n"),
            Rule::LineBreak => "  \n".to_string(),
            Rule::Heading => {
                let level: usize = dom.node_name(node)[1..].parse().unwrap_or(1);
                format!("\n\n{} {content}\n\n", "#".repeat(level))
            }
            Rule::Blockquote => {
                let quoted = prefix_lines(trim_newlines(content), "> ");
                format!("\n\n{quoted}\n\n")
            }
            Rule::List => {
                let parent = dom.nodes[node].parent;
                let last_in_item = parent.is_some_and(|p| {
                    dom.node_name(p) == "LI" && dom.last_element_child(p) == Some(node)
                });
                if last_in_item {
                    format!("\n{content}")
                } else {
                    format!("\n\n{content}\n\n")
                }
            }
            Rule::ListItem => list_item(content, dom, node),
            Rule::FencedCodeBlock => {
                let code_el = dom.nodes[node].first.expect("a first child");
                let language = code_language(dom.attr(code_el, "class").unwrap_or(""));
                let code = dom.text_content(code_el);
                let fence = "`".repeat(fence_size(&code));
                let body = code.strip_suffix('\n').unwrap_or(&code);
                format!("\n\n{fence}{language}\n{body}\n{fence}\n\n")
            }
            Rule::HorizontalRule => "\n\n* * *\n\n".to_string(),
            Rule::Emphasis => {
                if js_trim(content).is_empty() {
                    String::new()
                } else {
                    format!("_{content}_")
                }
            }
            Rule::Strong => {
                if js_trim(content).is_empty() {
                    String::new()
                } else {
                    format!("**{content}**")
                }
            }
            Rule::Code => inline_code(content),
            Rule::Keep => {
                let html = dom.outer_html(node);
                if block {
                    format!("\n\n{html}\n\n")
                } else {
                    html
                }
            }
            Rule::Remove => String::new(),
            Rule::Default => {
                if block {
                    format!("\n\n{content}\n\n")
                } else {
                    content.to_string()
                }
            }
        })
    }
}

/// turndown's `isBlank`.
fn is_blank(dom: &Dom, node: NodeId) -> bool {
    !dom.is_void(node)
        && !MEANINGFUL_WHEN_BLANK.contains(&dom.node_name(node))
        && dom
            .text_parts(node)
            .iter()
            .all(|part| part.chars().all(is_js_whitespace))
        && !dom.has_descendant_named(node, &VOID_ELEMENTS)
        && !dom.has_descendant_named(node, &MEANINGFUL_WHEN_BLANK)
}

/// turndown's `flankingWhitespace`: the whitespace kept outside the node's markdown.
fn flanking_whitespace(dom: &Dom, node: NodeId) -> (String, String) {
    if dom.is_block(node) {
        return (String::new(), String::new());
    }
    let edges = edge_whitespace(&dom.text_parts(node));
    let mut leading = edges.leading;
    let mut trailing = edges.trailing;
    // Abandon leading ASCII whitespace if left-flanked by ASCII whitespace.
    if !edges.leading_ascii.is_empty() && is_flanked_by_whitespace(dom, node, true) {
        leading = edges.leading_non_ascii;
    }
    // Abandon trailing ASCII whitespace if right-flanked by ASCII whitespace.
    if !edges.trailing_ascii.is_empty() && is_flanked_by_whitespace(dom, node, false) {
        trailing = edges.trailing_non_ascii;
    }
    (leading, trailing)
}

fn is_flanked_by_whitespace(dom: &Dom, node: NodeId, left: bool) -> bool {
    let sibling = if left {
        dom.nodes[node].prev
    } else {
        dom.nodes[node].next
    };
    let Some(sibling) = sibling else {
        return false;
    };
    let text = match &dom.nodes[sibling].kind {
        Kind::Text(text) => text.clone(),
        Kind::Element(_) if !dom.is_block(sibling) => dom.text_content(sibling),
        _ => return false,
    };
    if left {
        text.ends_with(' ')
    } else {
        text.starts_with(' ')
    }
}

/// The `type` IDL attribute is `checkbox`: an input's or menu item's type read
/// without case, or a type that other elements reflect as written.
fn is_checkbox(el: &ElementData) -> bool {
    if !el.html {
        return false;
    }
    let value = el.attr("type");
    match el.local.as_str() {
        "input" | "menuitem" => value.is_some_and(|v| v.eq_ignore_ascii_case("checkbox")),
        "a" | "area" | "embed" | "li" | "link" | "ol" | "object" | "param" | "script" | "style"
        | "ul" | "source" => value == Some("checkbox"),
        _ => false,
    }
}

/// `table.rows[0]`, which domino reads as the first `tr` below the table.
fn first_row(dom: &Dom, table: NodeId) -> anyhow::Result<NodeId> {
    dom.find(table, |el| {
        if el.html {
            el.local.eq_ignore_ascii_case("tr")
        } else {
            el.name == "tr"
        }
    })
    .ok_or_else(|| anyhow::anyhow!(NO_ROW_ERROR))
}

/// A row is a heading row when its parent is a THEAD, or when it is the first
/// child of the table or of its first TBODY (possibly after a blank THEAD) and
/// every cell is a TH.
fn is_heading_row(dom: &Dom, tr: NodeId) -> bool {
    let Some(parent) = dom.nodes[tr].parent else {
        return false;
    };
    if dom.node_name(parent) == "THEAD" {
        return true;
    }
    dom.nodes[parent].first == Some(tr)
        && (dom.node_name(parent) == "TABLE" || is_first_tbody(dom, parent))
        && dom
            .children(tr)
            .into_iter()
            .all(|c| dom.node_name(c) == "TH")
}

fn is_first_tbody(dom: &Dom, element: NodeId) -> bool {
    if dom.node_name(element) != "TBODY" {
        return false;
    }
    match dom.nodes[element].prev {
        None => true,
        Some(prev) => {
            dom.node_name(prev) == "THEAD"
                && dom
                    .text_parts(prev)
                    .iter()
                    .all(|part| part.chars().all(is_js_whitespace))
        }
    }
}

fn cell(content: &str, dom: &Dom, node: NodeId) -> String {
    let first = dom.nodes[node]
        .parent
        .and_then(|p| dom.nodes[p].first)
        .is_some_and(|f| f == node);
    let prefix = if first { "| " } else { " " };
    format!("{prefix}{content} |")
}

/// The inline code rule does not take the only `<code>` of a `<pre>`.
fn is_code_block(dom: &Dom, node: NodeId) -> bool {
    let has_siblings = dom.nodes[node].prev.is_some() || dom.nodes[node].next.is_some();
    let parent_pre = dom.nodes[node]
        .parent
        .is_some_and(|p| dom.node_name(p) == "PRE");
    parent_pre && !has_siblings
}

/// The line terminators JavaScript's `^` and `.` know.
fn is_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `text.replace(/^/gm, prefix)`.
fn prefix_lines(text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len() + prefix.len());
    out.push_str(prefix);
    for ch in text.chars() {
        out.push(ch);
        if is_line_terminator(ch) {
            out.push_str(prefix);
        }
    }
    out
}

fn list_item(content: &str, dom: &Dom, node: NodeId) -> String {
    let mut prefix = "-   ".to_string();
    if let Some(parent) = dom.nodes[node].parent
        && dom.node_name(parent) == "OL"
    {
        let index = dom
            .children(parent)
            .into_iter()
            .filter(|&c| dom.element(c).is_some())
            .position(|c| c == node)
            .map_or(-1.0, |i| i as f64);
        let number = match dom.attr(parent, "start").filter(|s| !s.is_empty()) {
            Some(start) => crate::support::js::number_from(start).unwrap_or(f64::NAN) + index,
            None => index + 1.0,
        };
        prefix = format!("{}.  ", crate::support::js::number_text(number));
    }
    let is_paragraph = content.ends_with('\n');
    let mut body = trim_newlines(content).to_string();
    if is_paragraph {
        body.push('\n');
    }
    let indent = format!("\n{}", " ".repeat(len16(&prefix)));
    let body = body.replace('\n', &indent);
    let tail = if dom.nodes[node].next.is_some() {
        "\n"
    } else {
        ""
    };
    format!("{prefix}{body}{tail}")
}

/// `/language-(\S+)/` on a class list: the first `language-` followed by text.
fn code_language(class: &str) -> String {
    for (at, _) in class.match_indices("language-") {
        let name: String = class[at + "language-".len()..]
            .chars()
            .take_while(|&c| !is_js_whitespace(c))
            .collect();
        if !name.is_empty() {
            return name;
        }
    }
    String::new()
}

/// The fence length: three backticks, or one more than the longest run of three or
/// more that starts a line of the code.
fn fence_size(code: &str) -> usize {
    let mut size = 3;
    let mut at_line_start = true;
    let mut run = 0usize;
    let mut counting = false;
    for ch in code.chars().chain(std::iter::once('\0')) {
        if counting {
            if ch == '`' {
                run += 1;
                continue;
            }
            if run >= 3 && run >= size {
                size = run + 1;
            }
            counting = false;
        }
        if at_line_start && ch == '`' {
            counting = true;
            run = 1;
            at_line_start = false;
            continue;
        }
        at_line_start = is_line_terminator(ch);
    }
    size
}

/// turndown's inline code rule.
fn inline_code(content: &str) -> String {
    if content.is_empty() {
        return String::new();
    }
    static NEWLINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n|\r").unwrap());
    let content = NEWLINE.replace_all(content, " ").into_owned();
    let extra = if needs_extra_space(&content) { " " } else { "" };
    let runs: Vec<usize> = content
        .split(|c| c != '`')
        .filter(|run| !run.is_empty())
        .map(str::len)
        .collect();
    let mut delimiter = 1;
    while runs.contains(&delimiter) {
        delimiter += 1;
    }
    let delimiter = "`".repeat(delimiter);
    format!("{delimiter}{extra}{content}{extra}{delimiter}")
}

/// `/^`|^ .*?[^ ].* $|`$/`: a backtick at either end, or a space at both ends around
/// a non-space with no line break on either side of it.
fn needs_extra_space(content: &str) -> bool {
    if content.starts_with('`') || content.ends_with('`') {
        return true;
    }
    let chars: Vec<char> = content.chars().collect();
    if chars.len() < 3 || chars[0] != ' ' || chars[chars.len() - 1] != ' ' {
        return false;
    }
    let middle = &chars[1..chars.len() - 1];
    match middle.iter().filter(|&&c| is_line_terminator(c)).count() {
        0 => middle.iter().any(|&c| c != ' '),
        1 => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convert(html: &str) -> String {
        Converter::new(
            "https://example.com/page",
            "https://example.com/page",
            1_000_000,
        )
        .turndown(html)
        .unwrap()
    }

    #[test]
    fn writes_headings_paragraphs_and_emphasis() {
        assert_eq!(
            convert("<h1>Title</h1><p>Some <em>soft</em> and <strong>bold</strong> text.</p>"),
            "# Title\n\nSome _soft_ and **bold** text."
        );
    }

    #[test]
    fn writes_lists_with_turndowns_spacing() {
        assert_eq!(
            convert(
                "<ul><li>one</li><li>two</li></ul><ol start=\"3\"><li>three</li><li>four</li></ol>"
            ),
            "-   one\n-   two\n\n3.  three\n4.  four"
        );
    }

    #[test]
    fn writes_fenced_code_with_its_language() {
        assert_eq!(
            convert("<pre><code class=\"language-rust\">fn main() {}\n</code></pre>"),
            "```rust\nfn main() {}\n```"
        );
        assert_eq!(fence_size("```\nx\n````"), 5);
    }

    #[test]
    fn writes_inline_code_around_backticks() {
        assert_eq!(
            convert("<p>Run <code>a`b</code> now</p>"),
            "Run ``a`b`` now"
        );
        assert_eq!(inline_code("`x"), "`` `x ``");
    }

    #[test]
    fn escapes_markdown_in_text() {
        assert_eq!(
            convert("<p>1. not a list *star* [x] _u_</p>"),
            "1\\. not a list \\*star\\* \\[x\\] \\_u\\_"
        );
    }

    #[test]
    fn writes_a_gfm_table_with_a_heading_row() {
        assert_eq!(
            convert(
                "<table><thead><tr><th>A</th><th align=\"right\">B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>"
            ),
            "| A | B |\n| --- | --: |\n| 1 | 2 |"
        );
    }

    #[test]
    fn keeps_a_table_without_a_heading_row_as_html() {
        assert_eq!(
            convert("<table><tr><td>a &amp; b</td></tr></table>"),
            "<table><tbody><tr><td>a &amp; b</td></tr></tbody></table>"
        );
    }

    #[test]
    fn fails_as_turndown_does_on_a_table_without_a_row() {
        let err = Converter::new("https://example.com/", "https://example.com/", 100)
            .turndown("<table><caption>x</caption></table>")
            .unwrap_err();
        assert_eq!(err.to_string(), NO_ROW_ERROR);
    }

    #[test]
    fn resolves_links_and_drops_ones_to_the_same_page() {
        let mut converter = Converter::new(
            "https://example.com/docs/page",
            "https://example.com/docs/page#top",
            10_000,
        );
        assert_eq!(
            converter
                .turndown("<p><a href=\"next\">Next</a> <a href=\"#s\">Here</a> <a href=\"mailto:x@example.com\">Mail</a> <a href=\"/x\"> </a></p>")
                .unwrap(),
            "[Next](https://example.com/docs/next) Here Mail"
        );
    }

    #[test]
    fn keeps_image_alt_text_and_drops_images_without_it() {
        assert_eq!(
            convert("<p><img src=\"/a.png\" alt=\" A cat \"><img src=\"/b.png\"></p>"),
            "![A cat](https://example.com/a.png)"
        );
    }

    #[test]
    fn drops_the_address_the_budget_cannot_pay_for() {
        let mut converter = Converter::new("https://example.com/", "https://example.com/", 30);
        assert_eq!(
            converter
                .turndown("<p><a href=\"/one\">One</a> <a href=\"/two\">Two</a></p>")
                .unwrap(),
            "[One](https://example.com/one) Two"
        );
    }

    #[test]
    fn drops_scripts_styles_and_pictures() {
        assert_eq!(
            convert(
                "<p>Text</p><script>var x = 1;</script><style>p{}</style><svg><text>pic</text></svg><noscript>Enable JS</noscript>"
            ),
            "Text"
        );
    }

    #[test]
    fn collapses_whitespace_between_inline_elements() {
        assert_eq!(convert("<p>  a   <b> b </b>  c\n\n d </p>"), "a **b** c d");
    }

    #[test]
    fn quotes_blockquotes_line_by_line() {
        assert_eq!(
            convert("<blockquote><p>a</p><p>b</p></blockquote>"),
            "> a\n> \n> b"
        );
    }

    #[test]
    fn splits_edge_whitespace_as_turndown_does() {
        let edges = edge_whitespace(&[" \u{a0}x", "y\u{a0} \n"]);
        assert_eq!(edges.leading_ascii, " ");
        assert_eq!(edges.leading_non_ascii, "\u{a0}");
        assert_eq!(edges.trailing_non_ascii, "\u{a0}");
        assert_eq!(edges.trailing_ascii, " \n");
        let blank = edge_whitespace(&[" \u{a0} "]);
        assert_eq!(blank.leading, " \u{a0} ");
        assert_eq!(blank.trailing, "");
    }

    #[test]
    fn uses_the_documents_base_and_title() {
        let page = html_to_markdown(
            "<html><head><title> A\n title </title><base href=\"/sub/\"></head><body><p>Short <a href=\"x\">link</a></p></body></html>",
            "https://example.com/a/b",
        )
        .unwrap();
        assert_eq!(page.title, "A title");
        assert_eq!(page.extractor, MarkdownExtractor::Readability);
        assert_eq!(page.markdown, "Short [link](https://example.com/sub/x)");
    }

    #[test]
    fn cuts_a_long_title_to_one_line() {
        assert_eq!(
            one_line(&format!(" a\n{}", "b".repeat(300)))
                .chars()
                .count(),
            200
        );
    }

    /// The pages saved under `tests/fixtures/html_to_markdown`, each with what the
    /// TypeScript runtime made of it.
    #[test]
    fn converts_saved_pages_as_the_typescript_runtime_did() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/html_to_markdown");
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("html") {
                continue;
            }
            let expected: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(path.with_extension("json")).unwrap(),
            )
            .unwrap();
            let html = std::fs::read_to_string(&path).unwrap();
            let page = html_to_markdown(&html, expected["url"].as_str().unwrap()).unwrap();
            assert_eq!(page.title, expected["title"].as_str().unwrap(), "{path:?}");
            assert_eq!(
                page.extractor.as_str(),
                expected["extractor"].as_str().unwrap(),
                "{path:?}"
            );
            if expected["exact"].as_bool() == Some(true) {
                pretty_assertions::assert_eq!(
                    page.markdown,
                    expected["markdown"].as_str().unwrap()
                );
            }
            checked += 1;
        }
        assert!(checked > 0);
    }

    /// Readability's content of the saved pages, with what the TypeScript converter
    /// made of it, so the converter is checked apart from the extractor.
    #[test]
    fn converts_article_content_as_turndown_did() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/html_to_markdown");
        let mut checked = 0;
        for entry in std::fs::read_dir(dir.join("converter")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("content") {
                continue;
            }
            let stem = path.file_stem().unwrap().to_str().unwrap();
            let page: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join(format!("{stem}.json"))).unwrap(),
            )
            .unwrap();
            let url = page["url"].as_str().unwrap();
            let content = std::fs::read_to_string(&path).unwrap();
            let expected = std::fs::read_to_string(path.with_extension("md")).unwrap();
            let markdown = Converter::new(url, url, 1_000_000_000)
                .turndown(&content)
                .unwrap();
            pretty_assertions::assert_eq!(js_trim(&markdown), expected, "{path:?}");
            checked += 1;
        }
        assert!(checked > 0);
    }
}
