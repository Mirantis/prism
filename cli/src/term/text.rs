//! Styled text: spans, lines, display width and word wrapping.
//!
//! `wrap` follows `wrap-ansi` with `{ trim: false, hard: true }`, the wrapping
//! Ink applies to every `<Text>`, so a line breaks where it broke before.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use super::style::Style;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub style: Style,
}

impl Span {
    pub fn new(text: impl Into<String>, style: Style) -> Span {
        Span {
            text: text.into(),
            style,
        }
    }
    pub fn plain(text: impl Into<String>) -> Span {
        Span {
            text: text.into(),
            style: Style::default(),
        }
    }
}

/// One row of styled text, with no line break in it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Line {
    pub spans: Vec<Span>,
}

impl Line {
    pub fn new() -> Line {
        Line { spans: Vec::new() }
    }
    pub fn from_spans(spans: Vec<Span>) -> Line {
        let mut line = Line::new();
        for span in spans {
            line.push(span);
        }
        line
    }
    pub fn styled(text: impl Into<String>, style: Style) -> Line {
        Line::from_spans(vec![Span::new(text, style)])
    }
    pub fn plain(text: impl Into<String>) -> Line {
        Line::styled(text, Style::default())
    }
    /// Append a span, merging it into the last one when the style is the same.
    pub fn push(&mut self, span: Span) {
        if span.text.is_empty() {
            return;
        }
        if let Some(last) = self.spans.last_mut()
            && last.style == span.style
        {
            last.text.push_str(&span.text);
            return;
        }
        self.spans.push(span);
    }
    pub fn append(&mut self, other: Line) {
        for span in other.spans {
            self.push(span);
        }
    }
    pub fn width(&self) -> usize {
        self.spans.iter().map(|s| str_width(&s.text)).sum()
    }
    #[cfg(test)]
    pub fn text(&self) -> String {
        self.spans.iter().map(|s| s.text.as_str()).collect()
    }
    pub fn is_empty(&self) -> bool {
        self.spans.iter().all(|s| s.text.is_empty())
    }
    /// Pad with spaces to `width` columns.
    pub fn pad_to(&mut self, width: usize) {
        let w = self.width();
        if w < width {
            self.push(Span::plain(" ".repeat(width - w)));
        }
    }
    /// Draw `src` from column `start`, over whatever this line has there, as Ink's
    /// output grid takes the later write. Cells after `src` stay.
    pub fn overlay(&mut self, start: usize, src: Line) {
        let (mut head, rest) = self.split_at_column(start);
        let (_, tail) = rest.split_at_column(src.width());
        head.pad_to(start);
        head.append(src);
        head.append(tail);
        *self = head;
    }
    /// The cells before column `at` and the cells from it on. A wide character cut
    /// in two becomes spaces on both sides.
    fn split_at_column(&self, at: usize) -> (Line, Line) {
        let (mut head, mut tail) = (Line::new(), Line::new());
        let mut column = 0;
        for span in &self.spans {
            let mut before = String::new();
            let mut after = String::new();
            for g in span.text.graphemes(true) {
                let w = grapheme_width(g);
                if column + w <= at {
                    before.push_str(g);
                } else if column >= at {
                    after.push_str(g);
                } else {
                    before.push_str(&" ".repeat(at - column));
                    after.push_str(&" ".repeat(column + w - at));
                }
                column += w;
            }
            head.push(Span::new(before, span.style));
            tail.push(Span::new(after, span.style));
        }
        (head, tail)
    }
    /// Drop trailing spaces that draw nothing, as Ink trims each output line.
    pub fn trim_end(&mut self) {
        while let Some(last) = self.spans.last_mut() {
            if last.style.shows_blank() {
                return;
            }
            let trimmed = last.text.trim_end_matches(' ').len();
            if trimmed == 0 {
                self.spans.pop();
                continue;
            }
            last.text.truncate(trimmed);
            return;
        }
    }
    /// Encode as the bytes a terminal draws.
    pub fn encode(&self, out: &mut String) {
        for span in &self.spans {
            span.style.open(out);
            out.push_str(&super::ansi::drop_controls(&span.text));
            span.style.close(out);
        }
    }
    pub fn encoded(&self) -> String {
        let mut out = String::new();
        self.encode(&mut out);
        out
    }
}

/// Display width of a string, in terminal columns.
pub fn str_width(s: &str) -> usize {
    if s.is_ascii() {
        return s.bytes().filter(|b| *b >= 0x20 && *b != 0x7f).count();
    }
    s.graphemes(true).map(grapheme_width).sum()
}

fn grapheme_width(g: &str) -> usize {
    if g.chars().all(|c| c.is_control()) {
        return 0;
    }
    UnicodeWidthStr::width(g)
}

/// Split styled text into lines at each `\n` (a `\r\n` counts as one).
pub fn split_lines(spans: &[Span]) -> Vec<Line> {
    let mut lines = vec![Line::new()];
    for span in spans {
        let text = span.text.replace("\r\n", "\n");
        let mut first = true;
        for piece in text.split('\n') {
            if !first {
                lines.push(Line::new());
            }
            first = false;
            lines.last_mut().unwrap().push(Span::new(piece, span.style));
        }
    }
    lines
}

/// One grapheme with its style and width.
#[derive(Clone)]
struct Token<'a> {
    text: &'a str,
    width: usize,
    style: Style,
}

fn tokens(line: &Line) -> Vec<Token<'_>> {
    let mut out = Vec::new();
    for span in &line.spans {
        for g in span.text.graphemes(true) {
            out.push(Token {
                text: g,
                width: grapheme_width(g),
                style: span.style,
            });
        }
    }
    out
}

const TAB_SIZE: usize = 8;

fn expand_tabs(line: &Line) -> Line {
    if !line.spans.iter().any(|s| s.text.contains('\t')) {
        return line.clone();
    }
    let mut out = Line::new();
    let mut visible = 0;
    for span in &line.spans {
        let mut piece = String::new();
        for g in span.text.graphemes(true) {
            if g == "\t" {
                let spaces = TAB_SIZE - (visible % TAB_SIZE);
                piece.push_str(&" ".repeat(spaces));
                visible += spaces;
            } else {
                piece.push_str(g);
                visible += grapheme_width(g);
            }
        }
        out.push(Span::new(piece, span.style));
    }
    out
}

/// Word-wrap one line to `columns`, as `wrap-ansi` does with `{ trim: false, hard: true }`.
/// The width may be a fraction of a column, as Ink measures a text at the width Yoga
/// gives it, and `wrap-ansi` compares and divides by that fraction.
fn wrap_line_at(line: &Line, columns: f64) -> Vec<Line> {
    if columns <= 0.0 {
        return vec![line.clone()];
    }
    let line = expand_tabs(line);
    let toks = tokens(&line);
    // Split into words on single spaces; a space belongs to no word.
    let mut words: Vec<Vec<Token<'_>>> = vec![Vec::new()];
    let mut space_styles: Vec<Style> = Vec::new();
    for t in toks {
        if t.text == " " {
            space_styles.push(t.style);
            words.push(Vec::new());
        } else {
            words.last_mut().unwrap().push(t);
        }
    }
    let mut rows: Vec<Vec<Token<'_>>> = vec![Vec::new()];
    let mut row_len = 0usize;
    for (index, word) in words.iter().enumerate() {
        let word_width: usize = word.iter().map(|t| t.width).sum();
        if index != 0 {
            if row_len as f64 >= columns {
                rows.push(Vec::new());
                row_len = 0;
            }
            rows.last_mut().unwrap().push(Token {
                text: " ",
                width: 1,
                style: space_styles[index - 1],
            });
            row_len += 1;
        }
        if word_width as f64 > columns {
            let remaining = columns - row_len as f64;
            let this_line = 1.0 + ((word_width as f64 - remaining - 1.0) / columns).floor();
            let next_line = ((word_width as f64 - 1.0) / columns).floor();
            if next_line < this_line {
                rows.push(Vec::new());
                row_len = 0;
            }
            row_len = wrap_word(&mut rows, word, columns, row_len);
            continue;
        }
        if (row_len + word_width) as f64 > columns && row_len > 0 && word_width > 0 {
            rows.push(Vec::new());
            row_len = 0;
        }
        rows.last_mut().unwrap().extend(word.iter().cloned());
        row_len += word_width;
    }
    rows.into_iter()
        .map(|row| {
            let mut l = Line::new();
            for t in row {
                l.push(Span::new(t.text, t.style));
            }
            l
        })
        .collect()
}

fn wrap_word<'a>(
    rows: &mut Vec<Vec<Token<'a>>>,
    word: &[Token<'a>],
    columns: f64,
    row_width: usize,
) -> usize {
    let mut visible = row_width;
    for (index, t) in word.iter().enumerate() {
        if t.width > 0 && visible > 0 && (visible + t.width) as f64 > columns {
            rows.push(Vec::new());
            visible = 0;
        }
        rows.last_mut().unwrap().push(t.clone());
        visible += t.width;
        if visible as f64 == columns && index < word.len() - 1 {
            rows.push(Vec::new());
            visible = 0;
        }
    }
    if visible == 0 && !rows.last().unwrap().is_empty() && rows.len() > 1 {
        let last = rows.pop().unwrap();
        rows.last_mut().unwrap().extend(last);
    }
    rows.last().unwrap().iter().map(|t| t.width).sum()
}

/// Wrap every line, keeping the line breaks already in the text.
pub fn wrap_lines(lines: &[Line], columns: usize) -> Vec<Line> {
    wrap_lines_at(lines, columns as f64)
}

/// `wrap_lines` at a width that may be a fraction of a column.
pub fn wrap_lines_at(lines: &[Line], columns: f64) -> Vec<Line> {
    let mut out = Vec::new();
    for line in lines {
        out.extend(wrap_line_at(line, columns));
    }
    out
}

/// The length of a string as JavaScript counts it (UTF-16 code units).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, n)` in UTF-16 units, never splitting a character.
pub fn js_slice_to(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units + c.len_utf16() > n {
            return &s[..i];
        }
        units += c.len_utf16();
    }
    s
}

/// `s.slice(n)` in UTF-16 units.
pub fn js_slice_from(s: &str, n: usize) -> &str {
    let head = js_slice_to(s, n);
    &s[head.len()..]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrap(s: &str, w: usize) -> Vec<String> {
        wrap_line_at(&Line::plain(s), w as f64)
            .iter()
            .map(|l| l.text())
            .collect()
    }

    #[test]
    fn wraps_on_words() {
        assert_eq!(wrap("hello world foo", 11), vec!["hello world", " foo"]);
        assert_eq!(wrap("aaaa bbbb", 4), vec!["aaaa", " ", "bbbb"]);
        assert_eq!(wrap("abc", 10), vec!["abc"]);
    }

    #[test]
    fn hard_breaks_long_words() {
        assert_eq!(wrap("abcdefghij", 4), vec!["abcd", "efgh", "ij"]);
        assert_eq!(wrap("ab cdefghij", 4), vec!["ab ", "cdef", "ghij"]);
        assert_eq!(wrap("x yyyyyyyyy", 4), vec!["x yy", "yyyy", "yyy"]);
        assert_eq!(
            wrap("one two three four five", 7),
            vec!["one two", " three ", "four ", "five"]
        );
        assert_eq!(wrap("a  b", 1), vec!["a", " ", " ", "b"]);
    }

    #[test]
    fn measures_wide_characters() {
        assert_eq!(str_width("📎 a"), 4);
        assert_eq!(str_width("▌ You"), 5);
    }
}
