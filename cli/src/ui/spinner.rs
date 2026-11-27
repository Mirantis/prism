//! The in-flight indicator: a braille spinner, and the row that holds it above
//! the composer. The row keeps its line when idle, so the composer does not jump
//! at turn boundaries while someone types into it.

use super::layout::{El, row, styled};
use crate::term::style::{Color, Style};

// The braille frames and the 80 ms interval are the `dots` spinner from
// cli-spinners (MIT). See `THIRD_PARTY_NOTICES`.
pub const FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
pub const INTERVAL_MS: u64 = 80;

pub fn spinner(frame: usize) -> El {
    styled(FRAMES[frame % FRAMES.len()], Style::new().fg(Color::Cyan))
}

pub fn spinner_row(active: bool, label: &str, frame: usize) -> El {
    let children = if active {
        vec![
            spinner(frame),
            styled(format!(" {label}"), Style::new().dim().italic()),
        ]
    } else {
        Vec::new()
    };
    row(children).pad_x(2).min_height(1).el()
}
