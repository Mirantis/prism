//! The config panel: the agent's identity, and its seven workspace documents,
//! rendered as markdown in a pane that scrolls.

use super::{PanelAction, PanelMsg, load_error_view, loading_view, spawn_request};
use crate::api::AgentDetails;
use crate::event::Ctx;
use crate::markdown::render_markdown;
use crate::term::input::KeyEvent;
use crate::term::style::{Color, Style};
use crate::term::text::Line;
use crate::ui::layout::{El, col, row, styled, text_line};

const DOCS: [(&str, &str); 7] = [
    ("Soul", "soulMd"),
    ("User", "userMd"),
    ("Memory", "memoryMd"),
    ("Heartbeat", "heartbeatMd"),
    ("Vision", "visionMd"),
    ("Agent", "agentMd"),
    ("Bootstrap", "bootstrapMd"),
];

pub enum Msg {
    Loaded(Result<AgentDetails, String>),
}

pub struct ConfigPanel {
    details: Option<AgentDetails>,
    loading: bool,
    error: Option<String>,
    selected: usize,
    list_focused: bool,
    scroll: usize,
}

impl ConfigPanel {
    pub fn open(ctx: &Ctx) -> ConfigPanel {
        let mut panel = ConfigPanel {
            details: None,
            loading: true,
            error: None,
            selected: 0,
            list_focused: true,
            scroll: 0,
        };
        panel.load(ctx);
        panel
    }

    pub fn busy(&self) -> bool {
        self.loading
    }

    fn load(&mut self, ctx: &Ctx) {
        self.loading = true;
        self.error = None;
        let api = ctx.api.clone();
        spawn_request(
            ctx,
            async move { api.get_details().await.map_err(|e| e.message) },
            |result| PanelMsg::Config(Msg::Loaded(result)),
        );
    }

    pub fn on_msg(&mut self, msg: Msg) {
        match msg {
            Msg::Loaded(Ok(d)) => {
                self.details = Some(d);
                self.loading = false;
            }
            Msg::Loaded(Err(e)) => {
                self.error = Some(e);
                self.loading = false;
            }
        }
    }

    fn content_width(columns: usize) -> usize {
        40.max(columns.saturating_sub(24 + 2 + 2))
    }

    fn window_size(rows: usize) -> usize {
        8.max(rows.saturating_sub(10))
    }

    fn lines(&self, columns: usize) -> Vec<Line> {
        let Some(details) = &self.details else {
            return Vec::new();
        };
        let raw = details.doc(DOCS[self.selected].1);
        if raw.trim().is_empty() {
            return Vec::new();
        }
        render_markdown(&raw, Self::content_width(columns))
    }

    pub fn handle_key(
        &mut self,
        ev: &KeyEvent,
        ctx: &Ctx,
        columns: usize,
        rows: usize,
    ) -> PanelAction {
        let k = &ev.key;
        if k.escape {
            return PanelAction::Close;
        }
        if self.error.is_some() {
            if ev.input == "r" {
                self.load(ctx);
            }
            return PanelAction::None;
        }
        if k.tab {
            self.list_focused = !self.list_focused;
            return PanelAction::None;
        }
        if k.right {
            self.list_focused = false;
            return PanelAction::None;
        }
        if k.left {
            self.list_focused = true;
            return PanelAction::None;
        }
        if self.list_focused {
            let before = self.selected;
            if k.up {
                self.selected = self.selected.saturating_sub(1);
            } else if k.down {
                self.selected = (self.selected + 1).min(DOCS.len() - 1);
            }
            if self.selected != before {
                self.scroll = 0;
            }
            return PanelAction::None;
        }
        let window = Self::window_size(rows);
        let max_offset = self.lines(columns).len().saturating_sub(window);
        if k.up {
            self.scroll = self.scroll.saturating_sub(1);
        } else if k.down {
            self.scroll = (self.scroll + 1).min(max_offset);
        } else if k.page_up {
            self.scroll = self.scroll.saturating_sub(window);
        } else if k.page_down {
            self.scroll = (self.scroll + window).min(max_offset);
        }
        PanelAction::None
    }

    pub fn view(&self, columns: usize, rows: usize, frame: usize) -> El {
        if self.loading {
            return loading_view("Loading config…", Style::default(), frame);
        }
        let (Some(details), None) = (&self.details, &self.error) else {
            return load_error_view(self.error.as_deref(), "Failed to load config");
        };
        let lines = self.lines(columns);
        let window = Self::window_size(rows);
        let max_offset = lines.len().saturating_sub(window);
        let offset = self.scroll.min(max_offset);
        let heartbeat_every = format!(
            "every {}m",
            (details.heartbeat_interval_ms / 60_000.0).round() as i64
        );
        let list_focused = self.list_focused;
        let scroll_info = if lines.len() > window {
            format!(
                "  {}–{} / {}",
                offset + 1,
                (offset + window).min(lines.len()),
                lines.len()
            )
        } else {
            String::new()
        };
        let dim = Style::new().dim();
        let mut files = vec![styled(
            format!("{}Files", if list_focused { "▌ " } else { "  " }),
            if list_focused {
                Style::new().bold().fg(Color::Cyan)
            } else {
                Style::new().bold().dim()
            },
        )];
        for (i, (label, _)) in DOCS.iter().enumerate() {
            let is_selected = i == self.selected;
            let mut style = Style::default();
            if is_selected && list_focused {
                style = style.fg(Color::Cyan).bold();
            }
            if !list_focused {
                style = style.dim();
            }
            files.push(styled(
                format!("{}{label}", if is_selected { "▸ " } else { "  " }),
                style,
            ));
        }
        let left = col(vec![
            styled(details.name.clone(), Style::new().bold()),
            styled(
                format!(
                    "Model {}",
                    details.model.clone().unwrap_or_else(|| "default".into())
                ),
                dim,
            ),
            styled(
                format!(
                    "Heartbeat model {}",
                    details
                        .heartbeat_model
                        .clone()
                        .unwrap_or_else(|| "(main)".into())
                ),
                dim,
            ),
            styled(
                format!(
                    "Cron model {}",
                    details
                        .cron_model
                        .clone()
                        .unwrap_or_else(|| "(main)".into())
                ),
                dim,
            ),
            styled(format!("Timezone {}", details.timezone), dim),
            styled(
                format!("Heartbeat {} {heartbeat_every}", details.heartbeat_status),
                dim,
            ),
            col(files).margin_top(1).el(),
        ])
        .width(24)
        .margin_right(2)
        .el();
        let mut right = vec![styled(
            format!(
                "{}{}{scroll_info}",
                if list_focused { "  " } else { "▌ " },
                DOCS[self.selected].0
            ),
            if list_focused {
                Style::new().bold().dim()
            } else {
                Style::new().bold().fg(Color::Cyan)
            },
        )];
        if lines.is_empty() {
            right.push(styled("(empty)", dim));
        } else {
            right.extend(lines.into_iter().skip(offset).take(window).map(text_line));
        }
        let mut hint = if list_focused {
            "↑↓ select · →/tab content · esc close".to_string()
        } else {
            "↑↓ scroll · ←/tab files · esc close".to_string()
        };
        if DOCS[self.selected].1 == "agentMd" {
            hint.push_str(" · esc then /agent-guide to edit");
        }
        col(vec![
            row(vec![left, col(right).grow().el()]).el(),
            styled(hint, dim),
        ])
        .pad_x(1)
        .el()
    }
}
