//! The full-screen panels a command opens, and the sign-in and resume screens.
//! Each keeps its own state, takes keys while it has the screen, and runs its
//! requests in the background, reporting back as a `PanelMsg`.

pub mod config;
pub mod resume;
pub mod schedules;
pub mod sign_in;
pub mod webhooks;

use std::future::Future;

use chrono::{DateTime, Local};

use crate::api::ApiError;
use crate::event::{AppEvent, Ctx};
use crate::term::style::{Color, Style};
use crate::ui::layout::{BorderKind, El, col, row, styled};
use crate::ui::spinner::spinner;

pub enum PanelMsg {
    Schedules(schedules::Msg),
    Config(config::Msg),
    Webhooks(webhooks::Msg),
    SignIn(sign_in::Msg),
}

/// Where a panel's list stands.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Load {
    Loading,
    Ready,
    Error,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PanelAction {
    None,
    Close,
}

/// Cut to fit a fixed-width column, leaving a gap and room for an ellipsis.
pub fn fit(s: &str, width: usize) -> String {
    let max = width - 2;
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// `err.detail ?? err.message`, the text a panel shows for a failed request.
pub fn error_text(err: &ApiError) -> String {
    err.detail_or_message()
}

/// Run `request` in the background and hand its result to the panel as a message.
pub fn spawn_request<T: Send + 'static>(
    ctx: &Ctx,
    request: impl Future<Output = T> + Send + 'static,
    message: impl FnOnce(T) -> PanelMsg + Send + 'static,
) {
    let ctx = ctx.clone();
    tokio::spawn(async move {
        let result = request.await;
        ctx.send(AppEvent::Panel(message(result)));
    });
}

/// A spinner and what the panel is loading.
pub fn loading_view(label: &str, style: Style, frame: usize) -> El {
    row(vec![spinner(frame), styled(format!(" {label}"), style)])
        .pad_x(1)
        .pad_y(1)
        .el()
}

/// Why the panel could not load, and how to retry.
pub fn load_error_view(error: Option<&str>, fallback: &str) -> El {
    col(vec![
        styled(error.unwrap_or(fallback), Style::new().fg(Color::Red)),
        styled("press r to retry · esc to close", Style::new().dim()),
    ])
    .pad_x(1)
    .pad_y(1)
    .el()
}

/// A column of a list panel: its header, and its width, or `None` for the rest of the row.
pub struct Column {
    pub header: &'static str,
    pub width: Option<usize>,
}

/// A bordered list: the title, the column headers, one row of cells per item with a
/// marker on the selected one, an error, and the key hint.
pub struct ListPanel<'a> {
    pub title: &'a str,
    pub columns: &'a [Column],
    /// Each row's cells, as text and style, in column order.
    pub rows: Vec<Vec<(String, Style)>>,
    pub selected: usize,
    pub empty: &'a str,
    pub error: Option<&'a str>,
    pub hint: &'a str,
}

impl ListPanel<'_> {
    pub fn view(self) -> El {
        let cell = |text: String, style: Style, width: Option<usize>| match width {
            Some(w) => row(vec![styled(fit(&text, w), style)]).width(w).el(),
            None => styled(text, style),
        };
        let head = Style::new().bold().dim();
        let mut header = vec![row(vec![]).width(2).el()];
        header.extend(
            self.columns
                .iter()
                .map(|c| cell(c.header.into(), head, c.width)),
        );
        let mut children = vec![
            styled(self.title, Style::new().bold().fg(Color::Cyan)),
            row(header).margin_top(1).el(),
        ];
        if self.rows.is_empty() {
            children.push(
                row(vec![styled(self.empty, Style::new().dim())])
                    .margin_top(1)
                    .el(),
            );
        }
        for (i, cells) in self.rows.into_iter().enumerate() {
            let selected = i == self.selected;
            let marker = if selected { "▸" } else { " " };
            let mut line = vec![
                row(vec![styled(marker, Style::new().fg(Color::Cyan).bold())])
                    .width(2)
                    .el(),
            ];
            for ((text, style), column) in cells.into_iter().zip(self.columns) {
                let style = Style {
                    bold: style.bold || selected,
                    ..style
                };
                line.push(cell(text, style, column.width));
            }
            children.push(row(line).el());
        }
        if let Some(error) = self.error {
            children.push(styled(error, Style::new().fg(Color::Red)));
        }
        children.push(
            row(vec![styled(self.hint, Style::new().dim())])
                .margin_top(1)
                .el(),
        );
        col(children)
            .border(BorderKind::Round, Color::Cyan)
            .pad_x(1)
            .el()
    }
}

/// An ISO time as `Date.prototype.toLocaleString()` shows it in en-US, or `None` if it does not parse.
pub fn format_local_time(iso: &str) -> Option<String> {
    let t = DateTime::parse_from_rfc3339(iso)
        .ok()?
        .with_timezone(&Local);
    Some(t.format("%-m/%-d/%Y, %-I:%M:%S %p").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_a_column() {
        assert_eq!(fit("short", 22), "short");
        assert_eq!(fit("a very long schedule name here", 12), "a very lo…");
    }
}
