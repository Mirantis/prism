//! Text styles and the SGR sequences that draw them.
//!
//! The colour depth follows the terminal the way `supports-color` reads it: a
//! named colour is always its basic SGR code, and a hex colour is truecolor,
//! the 256-colour palette or the 16-colour palette by what the terminal takes.

use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Color {
    Black,
    Red,
    Green,
    Yellow,
    Blue,
    Magenta,
    Cyan,
    White,
    Gray,
    Rgb(u8, u8, u8),
    /// Always drawn as truecolor, whatever the terminal's depth: a kitty image id,
    /// or a truecolor code in the text itself.
    Exact(u8, u8, u8),
    /// One of the 16 basic colours by number, as a code in the text names it.
    Basic(u8),
    /// An entry of the 256-colour palette, as a code in the text names it.
    Palette(u8),
}

impl Color {
    /// `#rrggbb`.
    pub const fn hex(value: u32) -> Color {
        Color::Rgb((value >> 16) as u8, (value >> 8) as u8, value as u8)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Style {
    pub fg: Option<Color>,
    pub bg: Option<Color>,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub strikethrough: bool,
}

impl Style {
    pub const fn new() -> Style {
        Style {
            fg: None,
            bg: None,
            bold: false,
            dim: false,
            italic: false,
            underline: false,
            inverse: false,
            strikethrough: false,
        }
    }
    pub const fn fg(mut self, color: Color) -> Style {
        self.fg = Some(color);
        self
    }
    pub const fn bold(mut self) -> Style {
        self.bold = true;
        self
    }
    pub const fn dim(mut self) -> Style {
        self.dim = true;
        self
    }
    pub const fn italic(mut self) -> Style {
        self.italic = true;
        self
    }
    pub const fn inverse(mut self) -> Style {
        self.inverse = true;
        self
    }
    pub fn is_plain(&self) -> bool {
        *self == Style::default()
    }
    /// A trailing space in this style shows on screen, so it is not trimmed.
    pub fn shows_blank(&self) -> bool {
        self.inverse || self.underline || self.strikethrough || self.bg.is_some()
    }
    /// Append the sequence that opens this style.
    pub fn open(&self, out: &mut String) {
        if self.is_plain() {
            return;
        }
        if color_level() == 0 {
            if let Some(Color::Exact(r, g, b)) = self.fg {
                out.push_str(&format!("\x1b[38;2;{r};{g};{b}m"));
            }
            return;
        }
        let mut codes: Vec<String> = Vec::with_capacity(4);
        if self.bold {
            codes.push("1".into());
        }
        if self.dim {
            codes.push("2".into());
        }
        if self.italic {
            codes.push("3".into());
        }
        if self.underline {
            codes.push("4".into());
        }
        if self.inverse {
            codes.push("7".into());
        }
        if self.strikethrough {
            codes.push("9".into());
        }
        if let Some(color) = self.fg {
            codes.push(fg_code(color));
        }
        if let Some(color) = self.bg {
            codes.push(bg_code(color));
        }
        out.push_str("\x1b[");
        out.push_str(&codes.join(";"));
        out.push('m');
    }

    /// Append the sequence that closes this style.
    pub fn close(&self, out: &mut String) {
        if self.is_plain() {
            return;
        }
        if color_level() == 0 {
            if let Some(Color::Exact(..)) = self.fg {
                out.push_str("\x1b[39m");
            }
            return;
        }
        out.push_str("\x1b[0m");
    }
}

fn fg_code(color: Color) -> String {
    match color {
        Color::Black => "30".into(),
        Color::Red => "31".into(),
        Color::Green => "32".into(),
        Color::Yellow => "33".into(),
        Color::Blue => "34".into(),
        Color::Magenta => "35".into(),
        Color::Cyan => "36".into(),
        Color::White => "37".into(),
        Color::Gray => "90".into(),
        Color::Exact(r, g, b) => format!("38;2;{r};{g};{b}"),
        Color::Basic(n) if n < 8 => (30 + n).to_string(),
        Color::Basic(n) => (82 + n).to_string(),
        Color::Palette(n) => format!("38;5;{n}"),
        Color::Rgb(r, g, b) => match color_level() {
            3 => format!("38;2;{r};{g};{b}"),
            2 => format!("38;5;{}", rgb_to_ansi256(r, g, b)),
            _ => ansi16(r, g, b).to_string(),
        },
    }
}

/// The background code of a colour: its foreground code in the background range.
fn bg_code(color: Color) -> String {
    let fg = fg_code(color);
    if let Some(rest) = fg.strip_prefix("38;") {
        return format!("48;{rest}");
    }
    (fg.parse::<u8>().unwrap_or(39) + 10).to_string()
}

/// chalk's `rgbToAnsi256`.
fn rgb_to_ansi256(r: u8, g: u8, b: u8) -> u8 {
    if r == g && g == b {
        if r < 8 {
            return 16;
        }
        if r > 248 {
            return 231;
        }
        return (((r as f64 - 8.0) / 247.0) * 24.0).round() as u8 + 232;
    }
    let scale = |v: u8| (v as f64 / 255.0 * 5.0).round() as u8;
    16 + 36 * scale(r) + 6 * scale(g) + scale(b)
}

/// chalk's `rgbToAnsi` (16 colours).
fn ansi16(r: u8, g: u8, b: u8) -> u8 {
    let value = (r.max(g).max(b) as f64 / 255.0 * 100.0 / 50.0).round() as u8;
    if value == 0 {
        return 30;
    }
    let mut code = 30
        + (((b as f64 / 255.0).round() as u8) << 2
            | ((g as f64 / 255.0).round() as u8) << 1
            | (r as f64 / 255.0).round() as u8);
    if value == 2 {
        code += 60;
    }
    code
}

static LEVEL: OnceLock<u8> = OnceLock::new();

/// The colour depth: 0 none, 1 sixteen colours, 2 the 256-colour palette, 3 truecolor.
pub fn color_level() -> u8 {
    *LEVEL.get_or_init(detect_level)
}

fn detect_level() -> u8 {
    let env = |name: &str| std::env::var(name).ok();
    if let Some(force) = env("FORCE_COLOR") {
        return match force.as_str() {
            "0" | "false" => 0,
            "2" => 2,
            "3" => 3,
            _ => 1,
        };
    }
    let term = env("TERM").unwrap_or_default();
    if term == "dumb" {
        return 0;
    }
    if cfg!(windows) && term.is_empty() {
        return 3;
    }
    if env("CI").is_some() {
        if env("GITHUB_ACTIONS").is_some() || env("GITEA_ACTIONS").is_some() {
            return 3;
        }
        return if term.is_empty() { 0 } else { 1 };
    }
    if env("COLORTERM").as_deref() == Some("truecolor")
        || env("COLORTERM").as_deref() == Some("24bit")
    {
        return 3;
    }
    if matches!(term.as_str(), "xterm-kitty" | "xterm-ghostty" | "wezterm") {
        return 3;
    }
    match env("TERM_PROGRAM").as_deref() {
        Some("iTerm.app") => return 3,
        Some("Apple_Terminal") => return 2,
        _ => {}
    }
    let lower = term.to_ascii_lowercase();
    if lower.ends_with("-256") || lower.ends_with("-256color") {
        return 2;
    }
    let basic = ["screen", "xterm", "vt100", "vt220", "rxvt"];
    if basic.iter().any(|p| lower.starts_with(p))
        || ["color", "ansi", "cygwin", "linux"]
            .iter()
            .any(|p| lower.contains(p))
        || env("COLORTERM").is_some()
    {
        return 1;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi256_matches_chalk() {
        assert_eq!(rgb_to_ansi256(0x7c, 0x3a, 0xed), 99);
        assert_eq!(rgb_to_ansi256(128, 128, 128), 244);
        assert_eq!(rgb_to_ansi256(0, 0, 0), 16);
    }
}
