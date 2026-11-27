//! Strings with embedded SGR sequences: chalk-style styling, and parsing such a
//! string back into styled lines.
//!
//! The markdown renderer keeps marked-terminal's string pipeline, which styles
//! text with escape codes and then reflows and indents the escaped strings, so
//! its output reads the same. The finished string is parsed into `Line`s here.

use super::style::{Color, Style};
use super::text::{Line, Span};

/// One chalk style: the codes that open and close it.
#[derive(Clone, Copy)]
pub struct Sgr {
    open: &'static str,
    close: &'static str,
}

pub const RESET: Sgr = Sgr {
    open: "0",
    close: "0",
};
pub const BOLD: Sgr = Sgr {
    open: "1",
    close: "22",
};
pub const DIM: Sgr = Sgr {
    open: "2",
    close: "22",
};
pub const ITALIC: Sgr = Sgr {
    open: "3",
    close: "23",
};
pub const UNDERLINE: Sgr = Sgr {
    open: "4",
    close: "24",
};
pub const STRIKE: Sgr = Sgr {
    open: "9",
    close: "29",
};
pub const RED: Sgr = Sgr {
    open: "31",
    close: "39",
};
pub const GREEN: Sgr = Sgr {
    open: "32",
    close: "39",
};
pub const YELLOW: Sgr = Sgr {
    open: "33",
    close: "39",
};
pub const BLUE: Sgr = Sgr {
    open: "34",
    close: "39",
};
pub const MAGENTA: Sgr = Sgr {
    open: "35",
    close: "39",
};
pub const GRAY: Sgr = Sgr {
    open: "90",
    close: "39",
};

/// Wrap `text` in `styles`, outermost first, as `chalk.a.b.c(text)` does: a
/// nested close of a style reopens it, and every line break closes the styles
/// before it and reopens them after it.
///
/// The codes are written at every colour level, so a layout that measures or
/// splits the string is the same with colour off. `Style` leaves them out when
/// the line is encoded for a terminal without colour.
pub fn paint(styles: &[Sgr], text: &str) -> String {
    if text.is_empty() || styles.is_empty() {
        return text.to_string();
    }
    let open_all: String = styles.iter().map(|s| format!("\x1b[{}m", s.open)).collect();
    let close_all: String = styles
        .iter()
        .rev()
        .map(|s| format!("\x1b[{}m", s.close))
        .collect();
    let mut out = text.to_string();
    if out.contains('\x1b') {
        for style in styles.iter().rev() {
            let open = format!("\x1b[{}m", style.open);
            let close = format!("\x1b[{}m", style.close);
            out = out.replace(&close, &format!("{close}{open}"));
        }
    }
    if out.contains('\n') {
        let mut encased = String::with_capacity(out.len() + 16);
        let mut rest = out.as_str();
        while let Some(i) = rest.find('\n') {
            let (line, cr) = match rest[..i].strip_suffix('\r') {
                Some(l) => (l, "\r\n"),
                None => (&rest[..i], "\n"),
            };
            encased.push_str(line);
            encased.push_str(&close_all);
            encased.push_str(cr);
            encased.push_str(&open_all);
            rest = &rest[i + 1..];
        }
        encased.push_str(rest);
        out = encased;
    }
    format!("{open_all}{out}{close_all}")
}

/// Remove every SGR sequence.
pub fn strip(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for d in chars.by_ref() {
                if d.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Parse a string with SGR sequences into lines of styled spans.
pub fn parse(text: &str) -> Vec<Line> {
    let mut lines = vec![Line::new()];
    let mut style = Style::default();
    let mut buf = String::new();
    let flush = |buf: &mut String, lines: &mut Vec<Line>, style: Style| {
        if !buf.is_empty() {
            lines
                .last_mut()
                .unwrap()
                .push(Span::new(std::mem::take(buf), style));
        }
    };
    let bytes: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // An SGR sequence styles the text after it; every other escape sequence is dropped whole.
        if c == '\x1b' {
            let (end, sgr) = escape_end(&bytes, i);
            if let Some(params) = sgr {
                flush(&mut buf, &mut lines, style);
                apply_sgr(&mut style, &normalize_sgr(&params));
            }
            i = end;
            continue;
        }
        if c == '\n' {
            flush(&mut buf, &mut lines, style);
            lines.push(Line::new());
            i += 1;
            continue;
        }
        // A carriage return, a bell, a backspace or a C1 control would move or signal the terminal.
        if c.is_control() && c != '\t' {
            i += 1;
            continue;
        }
        buf.push(c);
        i += 1;
    }
    flush(&mut buf, &mut lines, style);
    lines
}

/// `text` without its escape sequences and without any control character but tab.
/// The last guard before text reaches the terminal: span text never carries a sequence.
pub fn drop_controls(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.chars().any(|c| c.is_control() && c != '\t') {
        return std::borrow::Cow::Borrowed(text);
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\x1b' {
            i = escape_end(&chars, i).0;
            continue;
        }
        if !c.is_control() || c == '\t' {
            out.push(c);
        }
        i += 1;
    }
    std::borrow::Cow::Owned(out)
}

fn apply_sgr(style: &mut Style, params: &str) {
    let codes: Vec<i64> = if params.is_empty() {
        vec![0]
    } else {
        params.split(';').map(|p| p.parse().unwrap_or(0)).collect()
    };
    let mut i = 0;
    while i < codes.len() {
        match codes[i] {
            0 => *style = Style::default(),
            1 => style.bold = true,
            2 => style.dim = true,
            3 => style.italic = true,
            4 => style.underline = true,
            7 => style.inverse = true,
            9 => style.strikethrough = true,
            22 => {
                style.bold = false;
                style.dim = false;
            }
            23 => style.italic = false,
            24 => style.underline = false,
            27 => style.inverse = false,
            29 => style.strikethrough = false,
            30 => style.fg = Some(Color::Black),
            31 => style.fg = Some(Color::Red),
            32 => style.fg = Some(Color::Green),
            33 => style.fg = Some(Color::Yellow),
            34 => style.fg = Some(Color::Blue),
            35 => style.fg = Some(Color::Magenta),
            36 => style.fg = Some(Color::Cyan),
            37 => style.fg = Some(Color::White),
            90 => style.fg = Some(Color::Gray),
            91..=97 => style.fg = Some(Color::Basic((codes[i] - 82) as u8)),
            39 => style.fg = None,
            40..=47 => style.bg = Some(Color::Basic((codes[i] - 40) as u8)),
            100..=107 => style.bg = Some(Color::Basic((codes[i] - 92) as u8)),
            49 => style.bg = None,
            38 => style.fg = extended_color(&codes, &mut i).or(style.fg),
            48 => style.bg = extended_color(&codes, &mut i).or(style.bg),
            _ => {}
        }
        i += 1;
    }
}

/// The colour of a `38;5;n` or `38;2;r;g;b` code at `codes[*i]`, moving `i` to its last part.
fn extended_color(codes: &[i64], i: &mut usize) -> Option<Color> {
    match codes.get(*i + 1) {
        Some(5) if *i + 2 < codes.len() => {
            *i += 2;
            Some(Color::Palette(codes[*i] as u8))
        }
        Some(2) if *i + 4 < codes.len() => {
            let c = Color::Rgb(
                codes[*i + 2] as u8,
                codes[*i + 3] as u8,
                codes[*i + 4] as u8,
            );
            *i += 4;
            Some(c)
        }
        _ => None,
    }
}

/// Ink's `sanitizeAnsi` on one span of a `<Text>`: CRLF becomes LF, an SGR sequence
/// styles the text after it, and every other escape sequence and every control
/// character but tab and newline is dropped. A code that closes one of `base`'s
/// attributes opens it again, as chalk's nesting does.
pub fn sanitize(span: &Span) -> Vec<Span> {
    let dirty = |c: char| c.is_control() && c != '\t' && c != '\n';
    if !span.text.chars().any(dirty) {
        return vec![span.clone()];
    }
    let base = span.style;
    let chars: Vec<char> = span.text.replace("\r\n", "\n").chars().collect();
    let mut out = Vec::new();
    let mut style = base;
    let mut buf = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c != '\x1b' {
            if !dirty(c) {
                buf.push(c);
            }
            i += 1;
            continue;
        }
        let (end, sgr) = escape_end(&chars, i);
        let normalized = sgr.as_deref().map(normalize_sgr);
        // A sequence whose every parameter was dropped is dropped too.
        if let (Some(params), Some(normalized)) = (sgr, normalized)
            && (params.is_empty() || !normalized.is_empty())
        {
            out.push(Span::new(std::mem::take(&mut buf), style));
            apply_sgr(&mut style, &normalized);
            reopen(&mut style, base, &normalized);
        }
        i = end;
    }
    out.push(Span::new(buf, style));
    out.retain(|s| !s.text.is_empty());
    out
}

/// The index after the escape sequence at `chars[start]`, and its parameters when
/// it is an SGR sequence Ink keeps.
fn escape_end(chars: &[char], start: usize) -> (usize, Option<String>) {
    let at = |i: usize| chars.get(i).copied();
    match at(start + 1) {
        Some('[') => {
            let mut i = start + 2;
            while at(i).is_some_and(|c| ('\x30'..='\x3f').contains(&c)) {
                i += 1;
            }
            let params: String = chars[start + 2..i].iter().collect();
            let intermediate = at(i).is_some_and(|c| ('\x20'..='\x2f').contains(&c));
            while at(i).is_some_and(|c| ('\x20'..='\x2f').contains(&c)) {
                i += 1;
            }
            let sgr = at(i) == Some('m')
                && !intermediate
                && params
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == ':' || c == ';');
            ((i + 1).min(chars.len()), sgr.then_some(params))
        }
        Some(']' | 'P' | '_' | '^' | 'X') => {
            let mut i = start + 2;
            while i < chars.len() {
                if chars[i] == '\x07' {
                    return (i + 1, None);
                }
                if chars[i] == '\x1b' && at(i + 1) == Some('\\') {
                    return (i + 2, None);
                }
                i += 1;
            }
            (i, None)
        }
        Some(_) => {
            let mut i = start + 1;
            while at(i).is_some_and(|c| ('\x20'..='\x2f').contains(&c)) {
                i += 1;
            }
            ((i + 1).min(chars.len()), None)
        }
        None => (start + 1, None),
    }
}

/// Ink's `normalizeParameter` over every parameter: a colon form becomes its
/// semicolon form, an underline style plain underline, and anything else is dropped.
fn normalize_sgr(params: &str) -> String {
    let kept: Vec<String> = params
        .split(';')
        .filter_map(|p| {
            let mut parts: Vec<&str> = p.split(':').collect();
            if parts.len() == 1 {
                return Some(p.to_string());
            }
            match (parts[0], parts[1]) {
                ("4", "0" | "") => Some("24".into()),
                ("4", _) => Some("4".into()),
                ("38" | "48", "5") if parts.len() == 3 => Some(parts.join(";")),
                ("38" | "48", "2") => {
                    if parts.len() == 6 && matches!(parts[2], "" | "0") {
                        parts.remove(2);
                    }
                    (parts.len() == 5).then(|| parts.join(";"))
                }
                _ => None,
            }
        })
        .collect();
    kept.join(";")
}

/// Open again each of `base`'s attributes that `params` closed.
fn reopen(style: &mut Style, base: Style, params: &str) {
    for code in params.split(';') {
        match code {
            "22" => {
                style.bold |= base.bold;
                style.dim |= base.dim;
            }
            "23" => style.italic |= base.italic,
            "24" => style.underline |= base.underline,
            "27" => style.inverse |= base.inverse,
            "29" => style.strikethrough |= base.strikethrough,
            "39" => style.fg = style.fg.or(base.fg),
            "49" => style.bg = style.bg.or(base.bg),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_styles_and_lines() {
        let lines = parse("a\x1b[1mb\x1b[22m\nc");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text(), "ab");
        assert!(lines[0].spans[1].style.bold);
        assert_eq!(lines[1].text(), "c");
    }

    #[test]
    fn paints_like_chalk() {
        assert_eq!(
            paint(&[RESET], "x\n\ny"),
            "\x1b[0mx\x1b[0m\n\x1b[0m\x1b[0m\n\x1b[0my\x1b[0m"
        );
    }

    #[test]
    fn parse_drops_every_sequence_but_sgr() {
        let lines = parse(
            "a\x1b]52;c;aGk=\x07b\x1b]0;title\x1b\\c\x1bPq\x1b\\d\x1bce\x08f\x07\x1b[2J\x1b[1mg",
        );
        let text: String = lines[0].spans.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(text, "abcdefg");
        assert!(lines[0].spans.last().unwrap().style.bold);
        assert!(!lines[0].encoded().contains(']'));
    }

    #[test]
    fn drops_controls_before_the_terminal() {
        assert_eq!(drop_controls("plain\ttext"), "plain\ttext");
        assert_eq!(drop_controls("a\x1b[2Jb\x1b]0;t\x07c\x07\u{9b}d"), "abcd");
    }

    #[test]
    fn sanitizes_text_like_ink() {
        let text = |spans: &[Span]| spans.iter().map(|s| s.text.as_str()).collect::<String>();
        let plain = sanitize(&Span::plain(
            "/help\r ok\r\n\x07x\x1b[2J\x1b]8;;u\x1b\\y\tz",
        ));
        assert_eq!(text(&plain), "/help ok\nxy\tz");

        let colored = sanitize(&Span::plain("a\x1b[31mb\x1b[38:5:2mc\x1b[49;0md"));
        assert_eq!(text(&colored), "abcd");
        assert_eq!(colored[1].style.fg, Some(Color::Red));
        assert_eq!(colored[2].style.fg, Some(Color::Palette(2)));
        assert!(colored[3].style.is_plain());

        // A close code inside dim text keeps the text dim, as chalk nests styles.
        let dim = sanitize(&Span::new("a\x1b[1mb\x1b[22mc", Style::new().dim()));
        assert!(dim[1].style.bold && dim[1].style.dim);
        assert!(dim[2].style.dim && !dim[2].style.bold);
    }

    #[test]
    fn strips_sequences() {
        assert_eq!(strip("\x1b[33mx\x1b[39m"), "x");
    }
}
