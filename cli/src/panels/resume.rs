//! The `--resume` picker: the previous conversations, newest first.

use std::path::Path;

use crate::protocol::ThreadSummary;
use crate::relative_time::format_relative_time;
use crate::term::input::KeyEvent;
use crate::term::style::{Color, Style};
use crate::ui::command_popup::window_start;
use crate::ui::layout::{El, col, styled};

const MAX_VISIBLE: usize = 5;

pub enum Pick {
    None,
    Select(String),
    Cancel,
}

pub struct ResumeList {
    pub sessions: Vec<ThreadSummary>,
    pub cwd: String,
    selected: usize,
}

/// "<basename> (<branch>)" when the thread has a workspace root and a branch.
fn describe_workspace(session: &ThreadSummary) -> String {
    let Some(root) = &session.workspace_root else {
        return String::new();
    };
    let base = Path::new(root)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.clone());
    match &session.branch {
        Some(branch) => format!("{base} ({branch})"),
        None => base,
    }
}

impl ResumeList {
    pub fn new(sessions: Vec<ThreadSummary>, cwd: String) -> ResumeList {
        ResumeList {
            sessions,
            cwd,
            selected: 0,
        }
    }

    pub fn handle_key(&mut self, ev: &KeyEvent) -> Pick {
        let k = &ev.key;
        if k.up {
            self.selected = self.selected.saturating_sub(1);
        } else if k.down {
            self.selected = (self.selected + 1).min(self.sessions.len().saturating_sub(1));
        } else if k.ret {
            if let Some(s) = self.sessions.get(self.selected) {
                return Pick::Select(s.id.clone());
            }
        } else if k.escape {
            return Pick::Cancel;
        }
        Pick::None
    }

    pub fn view(&self, columns: usize) -> El {
        let start = window_start(self.selected, self.sessions.len(), MAX_VISIBLE);
        let rows = self
            .sessions
            .iter()
            .enumerate()
            .skip(start)
            .take(MAX_VISIBLE)
            .map(|(i, session)| {
                let selected = i == self.selected;
                let workspace = describe_workspace(session);
                let title = session
                    .title
                    .clone()
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| session.id.clone());
                let style = if selected {
                    Style::new().fg(Color::Cyan).bold()
                } else {
                    Style::default()
                };
                let when = format_relative_time(&session.updated_at);
                let place = if workspace.is_empty() {
                    String::new()
                } else {
                    format!(" · {workspace}")
                };
                col(vec![
                    styled(
                        format!("{}{title}", if selected { "❯ " } else { "  " }),
                        style,
                    ),
                    styled(format!("  {when}{place}"), Style::new().dim()),
                ])
                .margin_bottom(1)
                .el()
            })
            .collect();
        col(vec![
            styled("─".repeat(columns), Style::new().dim()),
            col(vec![
                styled(
                    format!(
                        "Resume session ({} of {})",
                        self.selected + 1,
                        self.sessions.len()
                    ),
                    Style::default(),
                ),
                styled(format!("  {}", self.cwd), Style::new().dim()),
                col(rows).margin_top(1).el(),
            ])
            .pad_x(2)
            .el(),
        ])
        .el()
    }
}
