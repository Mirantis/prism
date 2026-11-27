//! The chat header: the Prism mark in a rounded box beside the agent's name.

use super::layout::{BorderKind, El, col, row, styled, text};
use crate::term::style::{Color, Style};
use crate::term::text::Span;

// Block-element rendition of the Prism mark with the "Prism" wordmark baked in.
const LOGO_ROWS: [&str; 8] = [
    "       ▗▙",
    "       ▄▄▖",
    "      ▟▛▀▀      ▄▖  ▘",
    "     ▟▛  ▝█▖    ▙▌▛▘▌▛▘▛▛▌",
    "    ▝▛    ▝█▖   ▌ ▌ ▌▄▌▌▌▌",
    "   ▟▖      ▝█▖",
    "  ▄▝█▄▄▄▄▄ ▟▛▗▖",
    " ▝▀▘▝▀▀▀▀▘▝▀ ▀▀",
];

const GRADIENT_START: u32 = 0xe97500;
const GRADIENT_END: u32 = 0xbf00ba;

fn lerp(a: u32, b: u32, t: f64) -> u8 {
    (a as f64 + (b as f64 - a as f64) * t).round() as u8
}

fn lerp_color(t: f64) -> Color {
    let channel = |shift: u32| {
        lerp(
            (GRADIENT_START >> shift) & 0xff,
            (GRADIENT_END >> shift) & 0xff,
            t,
        )
    };
    Color::Rgb(channel(16), channel(8), channel(0))
}

/// One logo row, its gradient running diagonally across the glyph.
fn color_row(row: &str, row_index: usize) -> El {
    let chars: Vec<char> = row.chars().collect();
    let total = chars.len() + LOGO_ROWS.len() - 1;
    let spans = chars
        .iter()
        .enumerate()
        .map(|(col_index, ch)| {
            if *ch == ' ' {
                return Span::plain(" ");
            }
            let t = (col_index + row_index) as f64 / (total - 1) as f64;
            Span::new(ch.to_string(), Style::new().fg(lerp_color(t)))
        })
        .collect();
    text(spans)
}

pub fn header(agent_name: &str) -> El {
    let logo = col(LOGO_ROWS
        .iter()
        .enumerate()
        .map(|(i, r)| color_row(r, i))
        .collect())
    .el();
    row(vec![
        logo,
        styled(
            format!("chat with {agent_name}  ·  ctrl+c to exit"),
            Style::new().dim(),
        ),
    ])
    .border(BorderKind::Round, Color::Magenta)
    .pad_x(2)
    .margin_bottom(1)
    .align_center()
    .space_between()
    .el()
}
