//! A small flexbox layout for terminal frames: columns, rows, padding, margins,
//! borders and fixed widths. It covers the box shapes the screens use, with the
//! rules Ink's Yoga layout applies to them: text wraps at its box's width, a row
//! child shrinks in proportion to its basis, edges round to whole columns as
//! Yoga rounds them, and every line is trimmed.

use crate::term::ansi::sanitize;
use crate::term::style::{Color, Style};
use crate::term::text::{Line, Span, split_lines, wrap_lines, wrap_lines_at};

#[derive(Clone, Copy, Debug, Default)]
pub struct Edges {
    pub top: usize,
    pub right: usize,
    pub bottom: usize,
    pub left: usize,
}

#[derive(Clone, Copy, Debug)]
pub enum BorderKind {
    Round,
    Single,
}

#[derive(Clone, Copy, Debug)]
pub struct Border {
    pub kind: BorderKind,
    pub color: Color,
    pub top: bool,
    pub right: bool,
    pub bottom: bool,
    pub left: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dir {
    Col,
    Row,
}

#[derive(Debug)]
pub struct BoxEl {
    dir: Dir,
    children: Vec<El>,
    padding: Edges,
    margin: Edges,
    border: Option<Border>,
    width: Option<usize>,
    min_height: usize,
    space_between: bool,
    align_center: bool,
    grow: bool,
}

#[derive(Debug)]
pub enum El {
    /// Lines of text, wrapped at the width of the box that holds them.
    Text(Vec<Line>),
    /// Lines drawn as they are, never wrapped (kitty image placeholders).
    Raw(Vec<Line>),
    Box(BoxEl),
}

impl From<BoxEl> for El {
    fn from(b: BoxEl) -> El {
        El::Box(b)
    }
}

/// Text that may hold line breaks, cleaned as Ink cleans a `<Text>`'s content.
/// Empty text takes no row, as in Ink.
pub fn text(spans: Vec<Span>) -> El {
    let spans: Vec<Span> = spans.iter().flat_map(sanitize).collect();
    if spans.iter().all(|s| s.text.is_empty()) {
        return El::Text(Vec::new());
    }
    El::Text(split_lines(&spans))
}

pub fn text_line(line: Line) -> El {
    text(line.spans)
}

pub fn styled(s: impl Into<String>, style: Style) -> El {
    text(vec![Span::new(s, style)])
}

#[cfg(test)]
pub fn plain(s: impl Into<String>) -> El {
    styled(s, Style::default())
}

fn new_box(dir: Dir, children: Vec<El>) -> BoxEl {
    BoxEl {
        dir,
        children,
        padding: Edges::default(),
        margin: Edges::default(),
        border: None,
        width: None,
        min_height: 0,
        space_between: false,
        align_center: false,
        grow: false,
    }
}

pub fn col(children: Vec<El>) -> BoxEl {
    new_box(Dir::Col, children)
}

pub fn row(children: Vec<El>) -> BoxEl {
    new_box(Dir::Row, children)
}

impl BoxEl {
    pub fn pad_x(mut self, n: usize) -> Self {
        self.padding.left = n;
        self.padding.right = n;
        self
    }
    pub fn pad_y(mut self, n: usize) -> Self {
        self.padding.top = n;
        self.padding.bottom = n;
        self
    }
    pub fn pad_left(mut self, n: usize) -> Self {
        self.padding.left = n;
        self
    }
    pub fn margin_top(mut self, n: usize) -> Self {
        self.margin.top = n;
        self
    }
    pub fn margin_bottom(mut self, n: usize) -> Self {
        self.margin.bottom = n;
        self
    }
    pub fn margin_y(mut self, n: usize) -> Self {
        self.margin.top = n;
        self.margin.bottom = n;
        self
    }
    pub fn margin_right(mut self, n: usize) -> Self {
        self.margin.right = n;
        self
    }
    pub fn border(self, kind: BorderKind, color: Color) -> Self {
        self.border_sides(kind, color, true)
    }
    pub fn border_left_only(self, kind: BorderKind, color: Color) -> Self {
        self.border_sides(kind, color, false)
    }
    /// The left edge always; the other three with `all`.
    fn border_sides(mut self, kind: BorderKind, color: Color, all: bool) -> Self {
        self.border = Some(Border {
            kind,
            color,
            top: all,
            right: all,
            bottom: all,
            left: true,
        });
        self
    }
    pub fn width(mut self, n: usize) -> Self {
        self.width = Some(n);
        self
    }
    pub fn min_height(mut self, n: usize) -> Self {
        self.min_height = n;
        self
    }
    pub fn space_between(mut self) -> Self {
        self.space_between = true;
        self
    }
    pub fn align_center(mut self) -> Self {
        self.align_center = true;
        self
    }
    pub fn grow(mut self) -> Self {
        self.grow = true;
        self
    }
    pub fn el(self) -> El {
        El::Box(self)
    }

    fn border_edges(&self) -> Edges {
        match self.border {
            None => Edges::default(),
            Some(b) => Edges {
                top: b.top as usize,
                right: b.right as usize,
                bottom: b.bottom as usize,
                left: b.left as usize,
            },
        }
    }
}

fn margin_of(el: &El) -> Edges {
    match el {
        El::Box(b) => b.margin,
        _ => Edges::default(),
    }
}

/// The width an element takes when nothing constrains it.
pub fn natural_width(el: &El) -> usize {
    match el {
        El::Text(lines) | El::Raw(lines) => lines.iter().map(Line::width).max().unwrap_or(0),
        El::Box(b) => {
            if let Some(w) = b.width {
                return w;
            }
            let border = b.border_edges();
            let frame = b.padding.left + b.padding.right + border.left + border.right;
            let content = match b.dir {
                Dir::Col => b
                    .children
                    .iter()
                    .map(|c| {
                        let m = margin_of(c);
                        natural_width(c) + m.left + m.right
                    })
                    .max()
                    .unwrap_or(0),
                Dir::Row => b
                    .children
                    .iter()
                    .map(|c| {
                        let m = margin_of(c);
                        natural_width(c) + m.left + m.right
                    })
                    .sum(),
            };
            content + frame
        }
    }
}

/// Lay out `el` in `avail` columns. Lines may be narrower than `avail`.
pub fn render(el: &El, avail: usize) -> Vec<Line> {
    layout(el, 0.0, avail as f32)
}

/// Lay out `el` with its left edge at column `x` of the frame and `width` columns,
/// both unrounded as Yoga computes them. Each node rounds its own width from these,
/// so a text inside a box at a fractional column can be a column wider than the box.
/// The lines start at the node's own left edge.
fn layout(el: &El, x: f32, width: f32) -> Vec<Line> {
    match el {
        El::Text(lines) => {
            let columns = rounded_width(x, width, true);
            let mut out = if lines.iter().all(|l| l.width() <= columns) {
                lines.clone()
            } else {
                wrap_lines(lines, columns)
            };
            // The rows a text takes are what it measures at its unrounded width.
            out.resize(out.len().max(measured_height(el, width)), Line::new());
            out
        }
        El::Raw(lines) => lines.clone(),
        El::Box(b) => render_box(b, x, width),
    }
}

fn render_box(b: &BoxEl, x: f32, width: f32) -> Vec<Line> {
    // A fixed width is the box's basis; a row that shrinks the box gives it less.
    let outer_size = b.width.map_or(width, |w| (w as f32).min(width));
    let outer = rounded_width(x, outer_size, false);
    let border = b.border_edges();
    let frame = b.padding.left + b.padding.right + border.left + border.right;
    let inner_x = x + (b.padding.left + border.left) as f32;
    let inner = (outer_size - frame as f32).max(0.0);
    let mut content = match b.dir {
        Dir::Col => render_col(&b.children, inner_x, inner),
        Dir::Row => render_row(b, inner_x, inner),
    };
    let frame_height = b.padding.top + b.padding.bottom + border.top + border.bottom;
    while content.len() + frame_height < b.min_height {
        content.push(Line::new());
    }
    let mut lines = Vec::with_capacity(content.len() + frame_height);
    for _ in 0..b.padding.top {
        lines.push(Line::new());
    }
    lines.extend(content);
    for _ in 0..b.padding.bottom {
        lines.push(Line::new());
    }
    let left_pad = " ".repeat(b.padding.left);
    let Some(bd) = b.border else {
        if b.padding.left == 0 {
            return lines;
        }
        return lines
            .into_iter()
            .map(|l| {
                if l.is_empty() {
                    return l;
                }
                let mut out = Line::plain(left_pad.clone());
                out.append(l);
                out
            })
            .collect();
    };
    let chars = match bd.kind {
        BorderKind::Round => ['╭', '─', '╮', '│', '╰', '╯'],
        BorderKind::Single => ['┌', '─', '┐', '│', '└', '┘'],
    };
    let style = Style::new().fg(bd.color);
    let horizontal = outer.saturating_sub(border.left + border.right);
    // A top or bottom edge: its corners where the side edges meet it.
    let edge = |left: char, right: char| {
        let mut s = String::new();
        if bd.left {
            s.push(left);
        }
        s.push_str(&chars[1].to_string().repeat(horizontal));
        if bd.right {
            s.push(right);
        }
        Line::styled(s, style)
    };
    let mut out = Vec::with_capacity(lines.len() + 2);
    if bd.top {
        out.push(edge(chars[0], chars[2]));
    }
    let body_width = outer.saturating_sub(border.left + border.right);
    for l in lines {
        let mut row = Line::new();
        if bd.left {
            row.push(Span::new(chars[3].to_string(), style));
        }
        row.push(Span::plain(left_pad.clone()));
        row.append(l);
        if bd.right {
            row.pad_to(body_width + border.left);
            row.push(Span::new(chars[3].to_string(), style));
        }
        out.push(row);
    }
    if bd.bottom {
        out.push(edge(chars[4], chars[5]));
    }
    out
}

fn render_col(children: &[El], x: f32, inner: f32) -> Vec<Line> {
    let mut lines = Vec::new();
    for child in children {
        let m = margin_of(child);
        for _ in 0..m.top {
            lines.push(Line::new());
        }
        let width = (inner - (m.left + m.right) as f32).max(0.0);
        let rendered = layout(child, x + m.left as f32, width);
        if m.left == 0 {
            lines.extend(rendered);
        } else {
            let indent = " ".repeat(m.left);
            lines.extend(rendered.into_iter().map(|l| {
                let mut out = Line::plain(indent.clone());
                out.append(l);
                out
            }));
        }
        for _ in 0..m.bottom {
            lines.push(Line::new());
        }
    }
    lines
}

fn render_row(b: &BoxEl, row_x: f32, inner: f32) -> Vec<Line> {
    let children = &b.children;
    if children.is_empty() {
        return Vec::new();
    }
    let margins: Vec<Edges> = children.iter().map(margin_of).collect();
    // Yoga works in f32, and the sizes below follow its arithmetic so the edges round
    // to the same columns.
    let mut sizes: Vec<f32> = children.iter().map(|c| basis(c, inner)).collect();
    let margin_sum: f32 = margins.iter().map(|m| (m.left + m.right) as f32).sum();
    let free = inner - sizes.iter().sum::<f32>() - margin_sum;
    let mut gap = 0.0f32;
    if free < 0.0 {
        // Every child has `flexShrink: 1`, so each gives up space in proportion to its basis.
        let total: f32 = -sizes.iter().sum::<f32>();
        if total < 0.0 {
            for size in &mut sizes {
                *size = (*size + free / total * -*size).max(0.0);
            }
        }
    } else if let Some(i) = children
        .iter()
        .position(|c| matches!(c, El::Box(bx) if bx.grow))
    {
        sizes[i] += free;
    } else if b.space_between && children.len() > 1 {
        gap = free / (children.len() - 1) as f32;
    }
    // Each child is laid out at its unrounded column, and drawn at its position in the
    // row rounded as Yoga rounds a position: a text's down, a box's to the nearest.
    let mut x = 0.0f32;
    let mut lefts = Vec::with_capacity(children.len());
    let mut rendered: Vec<Vec<Line>> = Vec::with_capacity(children.len());
    for (i, (child, m)) in children.iter().zip(&margins).enumerate() {
        if i > 0 {
            x += gap;
        }
        x += m.left as f32;
        lefts.push(round_to_grid(x, false, is_measured(child)) as usize);
        let mut lines = vec![Line::new(); m.top];
        lines.extend(layout(child, row_x + x, sizes[i]));
        lines.extend(std::iter::repeat_n(Line::new(), m.bottom));
        rendered.push(lines);
        x += sizes[i] + m.right as f32;
    }
    let height = rendered.iter().map(Vec::len).max().unwrap_or(0);
    let mut out = vec![Line::new(); height];
    for (lines, &left) in rendered.iter().zip(&lefts) {
        let offset = if b.align_center {
            yoga_center(height, lines.len())
        } else {
            0
        };
        for (y, line) in out.iter_mut().enumerate() {
            line.pad_to(left);
            if y >= offset
                && let Some(src) = lines.get(y - offset)
                && !src.is_empty()
            {
                line.overlay(left, src.clone());
            }
        }
    }
    out
}

/// A text node, which Yoga measures and rounds as text.
fn is_measured(el: &El) -> bool {
    matches!(el, El::Text(_))
}

/// The width Yoga measures a row child at before flexing, with at most `avail`
/// columns: a text wrapped at `avail` gives its widest line, a fixed width is that
/// width, and a box is as wide as its children measure, at most `avail`.
fn basis(el: &El, avail: f32) -> f32 {
    match el {
        El::Text(lines) => {
            let natural = natural_width(el) as f32;
            if natural <= avail {
                return natural;
            }
            ink_wrap(lines, avail)
                .iter()
                .map(Line::width)
                .max()
                .unwrap_or(0) as f32
        }
        El::Raw(_) => (natural_width(el) as f32).min(avail),
        El::Box(b) => {
            if let Some(w) = b.width {
                return w as f32;
            }
            let border = b.border_edges();
            let frame = (b.padding.left + b.padding.right + border.left + border.right) as f32;
            let inner = (avail - frame).max(0.0);
            let measured = b.children.iter().map(|c| {
                let m = (margin_of(c).left + margin_of(c).right) as f32;
                basis(c, (inner - m).max(0.0)) + m
            });
            let content = match b.dir {
                Dir::Col => measured.fold(0.0, f32::max),
                Dir::Row => measured.sum(),
            };
            (content + frame).min(avail)
        }
    }
}

/// The rows a text measures at a flexed width that may be a fraction of a column.
fn measured_height(el: &El, size: f32) -> usize {
    let El::Text(lines) = el else { return 0 };
    if natural_width(el) as f32 <= size {
        return lines.len();
    }
    ink_wrap(lines, size).len()
}

/// Ink's `wrapText` at a width Yoga gives: no room keeps the text as it is, and a
/// fraction of one column counts as the column.
fn ink_wrap(lines: &[Line], width: f32) -> Vec<Line> {
    if width <= 0.0 {
        return lines.to_vec();
    }
    wrap_lines_at(lines, f64::from(width.max(1.0)))
}

/// The whole columns a node at frame column `left` that is `size` wide takes, as
/// Yoga's pixel-grid rounding gives them. A text's left edge rounds down and its right
/// edge rounds up, so a text keeps every column it touches and can overlap the next child.
fn rounded_width(left: f32, size: f32, text: bool) -> usize {
    let fractional = !close(size.round(), size);
    let start = round_to_grid(left, false, text);
    let end = round_to_grid(left + size, text && fractional, text && !fractional);
    (end - start).max(0.0) as usize
}

/// Yoga's `roundValueToPixelGrid` at a point scale of 1.
fn round_to_grid(value: f32, ceil: bool, floor: bool) -> f32 {
    let fraction = value % 1.0;
    let whole = value - fraction;
    if close(fraction, 0.0) {
        whole
    } else if close(fraction, 1.0) || ceil {
        whole + 1.0
    } else if floor {
        whole
    } else {
        whole
            + if fraction > 0.5 || close(fraction, 0.5) {
                1.0
            } else {
                0.0
            }
    }
}

/// Yoga's `inexactEquals`.
fn close(a: f32, b: f32) -> bool {
    (a - b).abs() < 0.0001
}

/// The top offset Yoga gives a child of `child` rows centred in `parent` rows: a half row rounds down.
fn yoga_center(parent: usize, child: usize) -> usize {
    parent.saturating_sub(child) / 2
}

/// Lay out a frame at the terminal's width, every line trimmed.
pub fn frame(el: &El, columns: usize) -> Vec<Line> {
    let mut lines = render(el, columns);
    for l in &mut lines {
        l.trim_end();
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(lines: &[Line]) -> Vec<String> {
        lines.iter().map(|l| l.text()).collect()
    }

    #[test]
    fn draws_a_round_border_with_padding() {
        let el = col(vec![plain("hi")])
            .border(BorderKind::Round, Color::Cyan)
            .pad_x(1)
            .el();
        assert_eq!(
            texts(&frame(&el, 8)),
            vec!["╭──────╮", "│ hi   │", "╰──────╯"]
        );
    }

    #[test]
    fn wraps_text_inside_padding() {
        let el = col(vec![plain("one two three")]).pad_x(1).el();
        assert_eq!(texts(&frame(&el, 9)), vec![" one two", "  three"]);
    }

    #[test]
    fn fixed_width_cells_line_up() {
        let el = row(vec![col(vec![plain("Name")]).width(6).el(), plain("value")]).el();
        assert_eq!(texts(&frame(&el, 20)), vec!["Name  value"]);
    }

    #[test]
    fn shrinks_text_like_yoga() {
        // Frames Ink 8 drew for these rows in a 74-column row: the shrunk name's right
        // edge rounds up past the next text's left edge, which draws over it.
        let rename = row(vec![
            plain("  /rename"),
            plain("  Rename the agent (up to 64 characters: letters, digits, spaces and - ' . &)"),
        ])
        .el();
        assert_eq!(
            texts(&frame(&rename, 74)),
            vec![
                "  /renam  Rename the agent (up to 64 characters: letters, digits, spaces",
                "        and - ' . &)",
            ]
        );
        let heartbeat = row(vec![
            plain("  /heartbeat-model"),
            plain("  Set the heartbeat model (id or \"reset\" to use the main model)"),
        ])
        .el();
        assert_eq!(
            texts(&frame(&heartbeat, 74)),
            vec![
                "                  Set the heartbeat model (id or \"reset\" to use the main",
                "/heartbeat-modelmodel)",
            ]
        );
        // At 68 the name measures three rows at its fractional width, and draws two.
        assert_eq!(
            texts(&frame(&heartbeat, 68)),
            vec![
                "                 Set the heartbeat model (id or \"reset\" to use the",
                "/heartbeat-modemain model)",
                "",
            ]
        );
    }

    #[test]
    fn min_height_keeps_an_empty_row() {
        let el = col(vec![row(vec![]).pad_x(2).min_height(1).el(), plain("x")]).el();
        assert_eq!(texts(&frame(&el, 10)), vec!["", "x"]);
    }
}
