//! The popup under the composer: slash commands, or `/attach` path suggestions.

use super::layout::{El, col, row, styled};
use crate::term::style::{Color, Style};

pub struct PopupItem {
    pub name: String,
    pub description: String,
}

const MAX_VISIBLE: usize = 8;

/// The first visible row of a list of `len` items windowed around `selected`.
pub fn window_start(selected: usize, len: usize, visible: usize) -> usize {
    selected
        .saturating_sub(visible / 2)
        .min(len.saturating_sub(visible))
}

pub fn command_popup(items: &[PopupItem], selected: usize) -> Option<El> {
    if items.is_empty() {
        return None;
    }
    let start = window_start(selected, items.len(), MAX_VISIBLE);
    let rows = items
        .iter()
        .enumerate()
        .skip(start)
        .take(MAX_VISIBLE)
        .map(|(i, item)| {
            let is_selected = i == selected;
            let style = if is_selected {
                Style::new().fg(Color::Cyan).bold()
            } else {
                Style::default()
            };
            let marker = if is_selected { "▸ " } else { "  " };
            row(vec![
                styled(format!("{marker}{}", item.name), style),
                styled(format!("  {}", item.description), Style::new().dim()),
            ])
            .el()
        })
        .collect();
    Some(col(rows).pad_x(2).el())
}
