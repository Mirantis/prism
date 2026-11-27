//! Markdown to terminal text, the way `marked` with `marked-terminal` renders it.
//!
//! Parsing is pulldown-cmark's. Rendering keeps marked-terminal's pipeline: each
//! block becomes an escaped string followed by a blank line, paragraphs and
//! headings reflow to the width, lists and code blocks indent by four spaces, a
//! tight list item prints its text as written, and tables draw with cli-table3's
//! box characters. The finished string is parsed into styled lines.
//!
//! An image the message places with an `attachment:` reference becomes a marker
//! that holds its index, so the chat can draw the picture at that place.

use std::sync::LazyLock;

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use regex::Regex;

use crate::term::ansi::{
    self, BLUE, BOLD, DIM, GRAY, GREEN, ITALIC, MAGENTA, RED, RESET, STRIKE, UNDERLINE, YELLOW,
    paint,
};
use crate::term::text::{Line, js_len};

const TAB: &str = "    ";
const HARD_RETURN: char = '\r';
const MARKER_OPEN: char = '\u{E000}';
const MARKER_CLOSE: char = '\u{E001}';

static MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new("\u{E000}(\\d+)\u{E001}").unwrap());
static PLACED_IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[([^\]]*)\]\((attachment:[^)\s]+)\)").unwrap());

/// A piece of a rendered message: text, or an image the message places there.
#[derive(Clone, Debug, PartialEq)]
pub enum MessagePart {
    Text(Vec<Line>),
    Image { href: String, alt: String },
}

/// The width of the chat column: the terminal less the chat's padding and a margin.
pub fn chat_column_width(columns: usize) -> usize {
    let columns = if columns == 0 { 100 } else { columns };
    40.max(columns.saturating_sub(6))
}

/// Markdown rendered at `width` columns. An image the text places reads as its description.
pub fn render_markdown(content: &str, width: usize) -> Vec<Line> {
    let (rendered, placed) = render_with_markers(content, width);
    let replaced = MARKER.replace_all(&rendered, |caps: &regex::Captures| {
        let index: usize = caps[1].parse().unwrap_or(usize::MAX);
        placed
            .get(index)
            .map(|(_, alt)| format!("[image: {alt}]"))
            .unwrap_or_default()
    });
    ansi::parse(&replaced)
}

/// Markdown rendered at `width` columns, split around the images it places. An
/// image is a block of its own: text beside it goes above or below it.
pub fn render_message_parts(content: &str, width: usize) -> Vec<MessagePart> {
    let (rendered, placed) = render_with_markers(content, width);
    let mut parts = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    let flush = |lines: &mut Vec<String>, parts: &mut Vec<MessagePart>| {
        if !lines.is_empty() {
            parts.push(MessagePart::Text(ansi::parse(&lines.join("\n"))));
            lines.clear();
        }
    };
    static LEADING: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^((?:\x1b\[[0-9;]*m)*) +").unwrap());
    static TRAILING: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r" +((?:\x1b\[[0-9;]*m)*)$").unwrap());
    for line in rendered.split('\n') {
        if !MARKER.is_match(line) {
            lines.push(line.to_string());
            continue;
        }
        // Split into text pieces and marker indexes, alternating.
        let mut pieces: Vec<String> = Vec::new();
        let mut last = 0;
        for caps in MARKER.captures_iter(line) {
            let whole = caps.get(0).unwrap();
            pieces.push(line[last..whole.start()].to_string());
            pieces.push(caps[1].to_string());
            last = whole.end();
        }
        pieces.push(line[last..].to_string());
        let count = pieces.len();
        for (i, piece) in pieces.into_iter().enumerate() {
            if i % 2 == 1 {
                let Some((href, alt)) = piece.parse::<usize>().ok().and_then(|n| placed.get(n))
                else {
                    continue;
                };
                flush(&mut lines, &mut parts);
                parts.push(MessagePart::Image {
                    href: href.clone(),
                    alt: alt.clone(),
                });
            } else if !ansi::strip(&piece).trim().is_empty() {
                let mut text = piece;
                if i > 0 {
                    text = LEADING.replace(&text, "$1").into_owned();
                }
                if i < count - 1 {
                    text = TRAILING.replace(&text, "$1").into_owned();
                }
                lines.push(text);
            }
        }
    }
    flush(&mut lines, &mut parts);
    parts
}

/// The rendered string with a marker for each image it places, and those images.
fn render_with_markers(content: &str, width: usize) -> (String, Vec<(String, String)>) {
    let source: String = content
        .chars()
        .filter(|c| *c != MARKER_OPEN && *c != MARKER_CLOSE)
        .collect();
    let blocks = parse_blocks(&source);
    let mut r = Renderer {
        width: width.max(40),
        placed: Vec::new(),
    };
    let mut out = String::new();
    for block in &blocks {
        out.push_str(&r.block(block));
    }
    (out.trim_end().to_string(), r.placed)
}

// ---------------------------------------------------------------- the tree

#[derive(Debug)]
enum Inline {
    Text(String),
    Code(String),
    Strong(Vec<Inline>),
    Em(Vec<Inline>),
    Del(Vec<Inline>),
    Link { href: String, children: Vec<Inline> },
    Image { href: String, alt: String },
    SoftBreak,
    HardBreak,
    Html(String),
}

#[derive(Debug)]
enum Block {
    Para(Vec<Inline>),
    Heading(usize, Vec<Inline>),
    Code(String),
    Quote(Vec<Block>),
    List {
        ordered: bool,
        items: Vec<Item>,
    },
    Rule,
    Table {
        head: Vec<Vec<Inline>>,
        rows: Vec<Vec<Vec<Inline>>>,
    },
    Html(String),
}

#[derive(Debug, Default)]
struct Item {
    blocks: Vec<Block>,
    loose: bool,
    task: Option<bool>,
    /// A tight item's text as written.
    text: Option<String>,
}

enum Frame {
    Blocks(Vec<Block>),
    Quote(Vec<Block>),
    List {
        ordered: bool,
        items: Vec<Item>,
    },
    Item {
        item: Item,
        range: Option<(usize, usize)>,
    },
    Para(Vec<Inline>),
    Heading(usize, Vec<Inline>),
    Strong(Vec<Inline>),
    Em(Vec<Inline>),
    Del(Vec<Inline>),
    Link(String, Vec<Inline>),
    Image(String, String),
    Code(String),
    Html(String),
    Table {
        head: Vec<Vec<Inline>>,
        rows: Vec<Vec<Vec<Inline>>>,
        in_head: bool,
    },
    Row(Vec<Vec<Inline>>),
    Cell(Vec<Inline>),
}

fn heading_level(level: HeadingLevel) -> usize {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn push_inline(stack: &mut [Frame], inline: Inline) {
    match stack.last_mut() {
        Some(
            Frame::Para(v)
            | Frame::Heading(_, v)
            | Frame::Strong(v)
            | Frame::Em(v)
            | Frame::Del(v)
            | Frame::Link(_, v)
            | Frame::Cell(v),
        ) => v.push(inline),
        Some(Frame::Image(_, alt)) => alt.push_str(&inline_plain(&inline)),
        Some(Frame::Item { .. }) => {}
        _ => {}
    }
}

fn inline_plain(inline: &Inline) -> String {
    match inline {
        Inline::Text(s) | Inline::Code(s) | Inline::Html(s) => s.clone(),
        Inline::Strong(v) | Inline::Em(v) | Inline::Del(v) | Inline::Link { children: v, .. } => {
            v.iter().map(inline_plain).collect()
        }
        Inline::Image { alt, .. } => alt.clone(),
        Inline::SoftBreak | Inline::HardBreak => "\n".into(),
    }
}

fn push_block(stack: &mut [Frame], block: Block) {
    match stack.last_mut() {
        Some(Frame::Blocks(v) | Frame::Quote(v)) => v.push(block),
        Some(Frame::Item { item, .. }) => item.blocks.push(block),
        _ => {}
    }
}

fn parse_blocks(source: &str) -> Vec<Block> {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut stack: Vec<Frame> = vec![Frame::Blocks(Vec::new())];
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        // A tight item's text is the source of its inline content.
        if let Some(Frame::Item { range: r, .. }) = stack.last_mut() {
            let inline_event = matches!(
                event,
                Event::Text(_)
                    | Event::Code(_)
                    | Event::InlineHtml(_)
                    | Event::SoftBreak
                    | Event::HardBreak
            ) || matches!(
                &event,
                Event::Start(
                    Tag::Emphasis
                        | Tag::Strong
                        | Tag::Strikethrough
                        | Tag::Link { .. }
                        | Tag::Image { .. }
                )
            );
            if inline_event {
                *r = Some(match *r {
                    None => (range.start, range.end),
                    Some((s, e)) => (s.min(range.start), e.max(range.end)),
                });
                if !matches!(event, Event::Start(_)) {
                    continue;
                }
            }
        }
        match event {
            Event::Start(tag) => {
                let frame = match tag {
                    Tag::Paragraph => {
                        if let Some(Frame::Item { item, .. }) = stack.last_mut() {
                            item.loose = true;
                        }
                        Frame::Para(Vec::new())
                    }
                    Tag::Heading { level, .. } => Frame::Heading(heading_level(level), Vec::new()),
                    Tag::BlockQuote(_) => Frame::Quote(Vec::new()),
                    Tag::CodeBlock(_) => Frame::Code(String::new()),
                    Tag::HtmlBlock => Frame::Html(String::new()),
                    Tag::List(start) => Frame::List {
                        ordered: start.is_some(),
                        items: Vec::new(),
                    },
                    Tag::Item => Frame::Item {
                        item: Item::default(),
                        range: None,
                    },
                    Tag::Table(_) => Frame::Table {
                        head: Vec::new(),
                        rows: Vec::new(),
                        in_head: false,
                    },
                    Tag::TableHead => {
                        if let Some(Frame::Table { in_head, .. }) = stack.last_mut() {
                            *in_head = true;
                        }
                        Frame::Row(Vec::new())
                    }
                    Tag::TableRow => Frame::Row(Vec::new()),
                    Tag::TableCell => Frame::Cell(Vec::new()),
                    Tag::Emphasis => Frame::Em(Vec::new()),
                    Tag::Strong => Frame::Strong(Vec::new()),
                    Tag::Strikethrough => Frame::Del(Vec::new()),
                    Tag::Link { dest_url, .. } => Frame::Link(dest_url.to_string(), Vec::new()),
                    Tag::Image { dest_url, .. } => {
                        Frame::Image(dest_url.to_string(), String::new())
                    }
                    _ => Frame::Para(Vec::new()),
                };
                stack.push(frame);
            }
            Event::End(tag) => {
                let Some(frame) = stack.pop() else { continue };
                match (tag, frame) {
                    (TagEnd::Paragraph, Frame::Para(v)) => push_block(&mut stack, Block::Para(v)),
                    (TagEnd::Heading(_), Frame::Heading(level, v)) => {
                        push_block(&mut stack, Block::Heading(level, v))
                    }
                    (TagEnd::BlockQuote(_), Frame::Quote(v)) => {
                        push_block(&mut stack, Block::Quote(v))
                    }
                    (TagEnd::CodeBlock, Frame::Code(mut s)) => {
                        if s.ends_with('\n') {
                            s.pop();
                        }
                        push_block(&mut stack, Block::Code(s));
                    }
                    (TagEnd::HtmlBlock, Frame::Html(s)) => push_block(&mut stack, Block::Html(s)),
                    (TagEnd::List(_), Frame::List { ordered, items }) => {
                        push_block(&mut stack, Block::List { ordered, items })
                    }
                    (TagEnd::Item, Frame::Item { mut item, range }) => {
                        if !item.loose
                            && let Some((s, e)) = range
                        {
                            item.text = Some(item_text(&source[s..e]));
                        }
                        if let Some(Frame::List { items, .. }) = stack.last_mut() {
                            items.push(item);
                        }
                    }
                    (TagEnd::TableHead, Frame::Row(cells)) => {
                        if let Some(Frame::Table { head, in_head, .. }) = stack.last_mut() {
                            *head = cells;
                            *in_head = false;
                        }
                    }
                    (TagEnd::TableRow, Frame::Row(cells)) => {
                        if let Some(Frame::Table { rows, .. }) = stack.last_mut() {
                            rows.push(cells);
                        }
                    }
                    (TagEnd::TableCell, Frame::Cell(v)) => {
                        if let Some(Frame::Row(cells)) = stack.last_mut() {
                            cells.push(v);
                        }
                    }
                    (TagEnd::Table, Frame::Table { head, rows, .. }) => {
                        push_block(&mut stack, Block::Table { head, rows })
                    }
                    (TagEnd::Emphasis, Frame::Em(v)) => push_inline(&mut stack, Inline::Em(v)),
                    (TagEnd::Strong, Frame::Strong(v)) => {
                        push_inline(&mut stack, Inline::Strong(v))
                    }
                    (TagEnd::Strikethrough, Frame::Del(v)) => {
                        push_inline(&mut stack, Inline::Del(v))
                    }
                    (TagEnd::Link, Frame::Link(href, children)) => {
                        push_inline(&mut stack, Inline::Link { href, children })
                    }
                    (TagEnd::Image, Frame::Image(href, alt)) => {
                        push_inline(&mut stack, Inline::Image { href, alt })
                    }
                    (_, Frame::Para(v)) => {
                        for i in v {
                            push_inline(&mut stack, i);
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(t) => match stack.last_mut() {
                Some(Frame::Code(s) | Frame::Html(s)) => s.push_str(&t),
                _ => push_inline(&mut stack, Inline::Text(t.to_string())),
            },
            Event::Code(t) => push_inline(&mut stack, Inline::Code(t.to_string())),
            Event::Html(t) => match stack.last_mut() {
                Some(Frame::Html(s)) => s.push_str(&t),
                _ => push_block(&mut stack, Block::Html(t.to_string())),
            },
            Event::InlineHtml(t) => push_inline(&mut stack, Inline::Html(t.to_string())),
            Event::SoftBreak => push_inline(&mut stack, Inline::SoftBreak),
            Event::HardBreak => push_inline(&mut stack, Inline::HardBreak),
            Event::Rule => push_block(&mut stack, Block::Rule),
            Event::TaskListMarker(checked) => {
                if let Some(Frame::Item { item, .. }) = stack.last_mut() {
                    item.task = Some(checked);
                }
            }
            _ => {}
        }
    }
    match stack.into_iter().next() {
        Some(Frame::Blocks(v)) => v,
        _ => Vec::new(),
    }
}

/// A tight item's source with each continuation line's indentation removed, as marked keeps it.
fn item_text(raw: &str) -> String {
    raw.split('\n')
        .enumerate()
        .map(|(i, l)| {
            if i == 0 {
                l.to_string()
            } else {
                l.trim_start().to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------- rendering

struct Renderer {
    width: usize,
    placed: Vec<(String, String)>,
}

fn section(text: &str) -> String {
    format!("{text}\n\n")
}

fn indentify(indent: &str, text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    format!(
        "{indent}{}",
        text.split('\n')
            .collect::<Vec<_>>()
            .join(&format!("\n{indent}"))
    )
}

fn unescape_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

impl Renderer {
    fn mark(&mut self, href: &str, alt: &str) -> String {
        let alt = alt.trim();
        self.placed.push((
            href.to_string(),
            if alt.is_empty() {
                "image".into()
            } else {
                alt.into()
            },
        ));
        format!("{MARKER_OPEN}{}{MARKER_CLOSE}", self.placed.len() - 1)
    }

    fn inlines(&mut self, inlines: &[Inline]) -> String {
        inlines.iter().map(|i| self.inline(i)).collect()
    }

    fn inline(&mut self, inline: &Inline) -> String {
        match inline {
            Inline::Text(s) => s.clone(),
            Inline::Code(s) => paint(&[YELLOW], s),
            Inline::Strong(v) => {
                let inner = self.inlines(v);
                paint(&[BOLD], &inner)
            }
            Inline::Em(v) => {
                let inner = self.inlines(v).replace(HARD_RETURN, "\n");
                paint(&[ITALIC], &inner)
            }
            Inline::Del(v) => {
                let inner = self.inlines(v);
                paint(&[DIM, GRAY, STRIKE], &inner)
            }
            Inline::Link { href, children } => {
                let text = self.inlines(children);
                let has_text = !text.is_empty() && text != *href;
                let mut out = String::new();
                if has_text {
                    out.push_str(&text);
                    out.push_str(" (");
                }
                out.push_str(&paint(&[BLUE, UNDERLINE], href));
                if has_text {
                    out.push(')');
                }
                paint(&[BLUE], &out)
            }
            Inline::Image { href, alt } => {
                if href.starts_with("attachment:") {
                    self.mark(href, alt)
                } else {
                    format!("![{alt}]({href})")
                }
            }
            Inline::SoftBreak => "\n".into(),
            Inline::HardBreak => HARD_RETURN.to_string(),
            Inline::Html(s) => paint(&[GRAY], s),
        }
    }

    fn block(&mut self, block: &Block) -> String {
        match block {
            Block::Para(v) => {
                let text = unescape_entities(&self.inlines(v));
                section(&reflow_text(&paint(&[RESET], &text), self.width))
            }
            Block::Heading(level, v) => {
                let text = unescape_entities(&self.inlines(v));
                let text = format!("{} {text}", "#".repeat(*level));
                let text = reflow_text(&text, self.width);
                let styled = if *level == 1 {
                    paint(&[MAGENTA, UNDERLINE, BOLD], &text)
                } else {
                    paint(&[GREEN, BOLD], &text)
                };
                section(&styled)
            }
            // marked-terminal colours code with highlight.js, which leaves the words of
            // most commands in the default colour, so a block is drawn plain.
            Block::Code(code) => section(&indentify(TAB, code)),
            Block::Quote(blocks) => {
                let inner: String = blocks.iter().map(|b| self.block(b)).collect();
                section(&paint(&[GRAY, ITALIC], &indentify(TAB, inner.trim())))
            }
            Block::List { ordered, items } => {
                let mut body = String::new();
                for item in items {
                    body.push_str(&self.list_item(item));
                }
                let body = list(&body, *ordered);
                section(&fix_nested_lists(&indent_lines(TAB, &body)))
            }
            Block::Rule => {
                let rule = "-".repeat(self.width.saturating_sub(1));
                section(&paint(&[RESET], &rule))
            }
            Block::Table { head, rows } => {
                let head: Vec<String> = head
                    .iter()
                    .map(|c| unescape_entities(&self.inlines(c)))
                    .collect();
                let rows: Vec<Vec<String>> = rows
                    .iter()
                    .map(|r| {
                        r.iter()
                            .map(|c| unescape_entities(&self.inlines(c)))
                            .collect()
                    })
                    .collect();
                section(&paint(&[RESET], &table(&head, &rows)))
            }
            Block::Html(s) => paint(&[GRAY], s),
        }
    }

    fn list_item(&mut self, item: &Item) -> String {
        let mut text = String::new();
        if let Some(checked) = item.task {
            text.push_str(&format!("[{}]  ", if checked { 'X' } else { ' ' }));
        }
        if let Some(raw) = &item.text {
            // The text as written; an image it places still becomes a marker.
            let raw = PLACED_IMAGE
                .replace_all(raw, |caps: &regex::Captures| {
                    let alt = caps[1].to_string();
                    let href = caps[2].to_string();
                    self.mark(&href, &alt)
                })
                .into_owned();
            text.push_str(&raw);
        }
        for block in &item.blocks {
            text.push_str(&self.block(block));
        }
        // The text is trimmed before it is styled, so a styled item keeps no blank line at its end.
        let text = if text.contains('\n') {
            text.trim().to_string()
        } else {
            text
        };
        format!("\n* {}", paint(&[RESET], &unescape_entities(&text)))
    }
}

/// marked-terminal's `reflowText`: re-break escaped text at `width`, keeping hard breaks.
fn reflow_text(text: &str, width: usize) -> String {
    static ESCAPE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\x1b\[\d{1,3}(?:;\d{1,3})*m").unwrap());
    static SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t\n]+").unwrap());
    let mut reflowed: Vec<String> = Vec::new();
    for section in text.split(['\r']).flat_map(|s| s.split("<br />")) {
        // Fragments alternate between text and escape codes.
        let mut fragments: Vec<&str> = Vec::new();
        let mut last = 0;
        for m in ESCAPE.find_iter(section) {
            fragments.push(&section[last..m.start()]);
            fragments.push(m.as_str());
            last = m.end();
        }
        fragments.push(&section[last..]);
        let mut column = 0usize;
        let mut current = String::new();
        let mut last_was_escape = false;
        for fragment in fragments {
            if fragment.is_empty() {
                last_was_escape = false;
                continue;
            }
            if js_len(&ansi::strip(fragment)) == 0 {
                current.push_str(fragment);
                last_was_escape = true;
                continue;
            }
            for word in SPLIT.split(fragment) {
                let len = js_len(word);
                let add_space = column != 0 && !last_was_escape;
                let space = usize::from(add_space);
                if column + len + space > width {
                    if len <= width {
                        reflowed.push(std::mem::take(&mut current));
                        current = word.to_string();
                        column = len;
                    } else {
                        let chars: Vec<char> = word.chars().collect();
                        let head_len = width.saturating_sub(column + space).min(chars.len());
                        if add_space {
                            current.push(' ');
                        }
                        current.extend(&chars[..head_len]);
                        reflowed.push(std::mem::take(&mut current));
                        column = 0;
                        let mut rest = &chars[head_len..];
                        while !rest.is_empty() {
                            let take = width.min(rest.len());
                            if take < width {
                                current = rest[..take].iter().collect();
                                column = take;
                                break;
                            }
                            reflowed.push(rest[..take].iter().collect());
                            rest = &rest[take..];
                        }
                    }
                } else {
                    if add_space {
                        current.push(' ');
                        column += 1;
                    }
                    current.push_str(word);
                    column += len;
                }
                last_was_escape = false;
            }
        }
        if js_len(&ansi::strip(&current)) > 0 {
            reflowed.push(current);
        }
    }
    reflowed.join("\n")
}

fn indent_lines(indent: &str, text: &str) -> String {
    static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|\n)(.+)").unwrap());
    LINE.replace_all(text, |caps: &regex::Captures| {
        format!("{}{indent}{}", &caps[1], &caps[2])
    })
    .into_owned()
}

fn fix_nested_lists(body: &str) -> String {
    static NESTED: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)(\S(?: |  )?)((?:    )+)((?:\*|\d+\.)(?:.*)+)$").unwrap()
    });
    NESTED
        .replace_all(body, |caps: &regex::Captures| {
            format!("{}\n{TAB}{}{}", &caps[1], &caps[2], &caps[3])
        })
        .into_owned()
}

fn is_pointed_line(line: &str) -> bool {
    static POINTED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(?:    )*(?:\*|\d+\.)").unwrap());
    POINTED.is_match(line)
}

fn list(body: &str, ordered: bool) -> String {
    let body = body.trim();
    let lines = body.split('\n').filter(|l| !l.is_empty());
    if !ordered {
        return lines
            .map(|l| {
                if is_pointed_line(l) {
                    l.to_string()
                } else {
                    format!("  {l}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    let mut num = 0;
    lines
        .map(|line| {
            if is_pointed_line(line) {
                num += 1;
                line.replacen("* ", &format!("{num}. "), 1)
            } else {
                format!("{}{line}", " ".repeat(format!("{num}. ").len()))
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// cli-table3 with its default style: grey borders, red headers, a rule between rows.
fn table(head: &[String], rows: &[Vec<String>]) -> String {
    use crate::term::text::str_width;
    let columns = rows
        .iter()
        .map(Vec::len)
        .chain(std::iter::once(head.len()))
        .max()
        .unwrap_or(0);
    let mut widths = vec![0usize; columns];
    for row in std::iter::once(head).chain(rows.iter().map(Vec::as_slice)) {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(str_width(&ansi::strip(cell)));
        }
    }
    let border = |s: &str| paint(&[GRAY], s);
    let rule = |left: &str, mid: &str, right: &str| {
        let segments: Vec<String> = widths.iter().map(|w| "─".repeat(w + 2)).collect();
        border(&format!("{left}{}{right}", segments.join(mid)))
    };
    let row_line = |cells: &[String], is_head: bool| {
        let mut out = border("│");
        for (i, w) in widths.iter().enumerate() {
            let cell = cells.get(i).cloned().unwrap_or_default();
            let pad = w - str_width(&ansi::strip(&cell));
            let content = if is_head && !cell.is_empty() {
                paint(&[RED], &cell)
            } else {
                cell
            };
            out.push_str(&format!(" {content}{} ", " ".repeat(pad)));
            out.push_str(&border("│"));
        }
        out
    };
    let mut lines = vec![rule("┌", "┬", "┐"), row_line(head, true)];
    for row in rows {
        lines.push(rule("├", "┼", "┤"));
        lines.push(row_line(row, false));
    }
    lines.push(rule("└", "┴", "┘"));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(content: &str, width: usize) -> Vec<String> {
        render_markdown(content, width)
            .iter()
            .map(Line::text)
            .collect()
    }

    #[test]
    fn reflows_a_paragraph() {
        let words = "word ".repeat(20);
        let lines = plain(words.trim(), 40);
        assert!(lines.iter().all(|l| l.chars().count() <= 40));
        assert_eq!(lines.join(" ").split_whitespace().count(), 20);
    }

    #[test]
    fn keeps_heading_prefixes_and_list_bullets() {
        assert_eq!(
            plain("# Title\n\n- one\n- two", 40),
            vec!["# Title", "", "    * one", "    * two"]
        );
    }

    #[test]
    fn numbers_an_ordered_list() {
        assert_eq!(
            plain("1. one\n2. two", 40),
            vec!["    1. one", "    2. two"]
        );
    }

    #[test]
    fn prints_a_tight_items_text_as_written() {
        assert_eq!(plain("- **bold** item", 40), vec!["    * **bold** item"]);
    }

    #[test]
    fn indents_code_blocks() {
        assert_eq!(plain("```\nlet x = 1;\n```", 40), vec!["    let x = 1;"]);
    }

    #[test]
    fn shows_link_targets() {
        assert_eq!(
            plain("[site](https://example.com)", 40),
            vec!["site (https://example.com)"]
        );
    }

    #[test]
    fn draws_tables() {
        let lines = plain("| a | b |\n|---|---|\n| 1 | 2 |", 40);
        assert_eq!(
            lines,
            vec![
                "┌───┬───┐",
                "│ a │ b │",
                "├───┼───┤",
                "│ 1 │ 2 │",
                "└───┴───┘"
            ]
        );
    }

    #[test]
    fn describes_placed_images_in_text() {
        assert_eq!(
            plain("before ![chart](attachment:abc) after", 40),
            vec!["before [image: chart] after"]
        );
    }

    #[test]
    fn matches_marked_terminal_on_block_quirks() {
        assert_eq!(
            plain("- one\n\n- two\n\n  para", 40),
            vec!["    * one", "    * two", "      ", "      para"]
        );
        assert_eq!(
            plain("1. a\n   - nested\n   - more\n2. b", 40),
            vec![
                "    1. a",
                "        * nested",
                "       ",
                "        * more",
                "    2. b"
            ]
        );
        assert_eq!(
            plain("> quote line\n> second", 40),
            vec!["    quote line second"]
        );
        assert_eq!(
            plain("para one\nstill one\n\npara two  \nhard", 40),
            vec!["para one still one", "", "para two", "hard"]
        );
        assert_eq!(plain("## Sub *em* `code`", 40), vec!["## Sub em code"]);
        assert_eq!(plain("---", 40), vec!["-".repeat(39)]);
        assert_eq!(
            plain("- [x] done\n- [ ] todo", 40),
            vec!["    * [X]  done", "    * [ ]  todo"]
        );
        assert_eq!(
            plain("- top\n  - inner\n- next", 40),
            vec!["    * top", "        * inner", "    * next"]
        );
    }

    #[test]
    fn splits_parts_around_placed_images() {
        let parts = render_message_parts("one\n\n![c](attachment:x)\n\ntwo", 40);
        assert_eq!(parts.len(), 3);
        assert_eq!(
            parts[1],
            MessagePart::Image {
                href: "attachment:x".into(),
                alt: "c".into()
            }
        );
    }
}
