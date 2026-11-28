//! The frame: what the session draws, built fresh from its state.

use super::{App, Panel};
use crate::attachments::format_file_size;
use crate::protocol::TurnState;
use crate::term::style::{Color, Style};
use crate::term::text::Line;
use crate::ui::command_popup::{PopupItem, command_popup};
use crate::ui::header::header;
use crate::ui::layout::{BorderKind, El, col, frame, row, styled, text_line};
use crate::ui::llm_warning::llm_provider_warning;
use crate::ui::message_list::{MessageListProps, Screen, message_list};
use crate::ui::spinner::spinner_row;
use crate::ui::status_bar::{StatusBarProps, status_bar};

fn spinner_label(turn: TurnState) -> &'static str {
    match turn {
        TurnState::Running => "thinking… (esc to stop · enter sends)",
        TurnState::Queued => "waiting for another conversation to finish… (esc to cancel)",
        TurnState::Idle => "compacting conversation…",
    }
}

impl App {
    pub(super) fn frame(&mut self) -> Vec<Line> {
        let el = self.view();
        frame(&el, self.columns)
    }

    fn view(&self) -> El {
        if self.shutting_down {
            return col(vec![styled(
                "Shutting down…",
                Style::new().fg(Color::Yellow),
            )])
            .pad_x(1)
            .pad_y(1)
            .el();
        }
        if let Some(list) = &self.resume {
            return list.view(self.columns);
        }
        // A child process owns the terminal: draw nothing.
        if self.suspended {
            return col(vec![]).el();
        }
        let show_sign_in = self.show_sign_in();
        let mut children = vec![header(&self.cfg.agent_name)];
        if let Some(warning) = self.llm_provider.as_ref().and_then(llm_provider_warning) {
            children.push(warning);
        }
        if show_sign_in && let (Some(panel), Some(request)) = (&self.sign_in_panel, &self.sign_in) {
            children.push(panel.view(request));
        }
        if let Some(panel) = &self.panel {
            if !show_sign_in {
                children.push(match panel {
                    Panel::Schedules(p) => p.view(true, self.spinner_frame),
                    Panel::Config(p) => p.view(self.columns, self.rows, self.spinner_frame),
                    Panel::Webhooks(p) => p.view(true, self.spinner_frame),
                });
            }
        } else if !show_sign_in {
            children.extend(self.chat_view());
        }
        if !self.cfg.hide_status_bar {
            // The model the runtime actually ran wins over the local settings copy.
            let model_id = self
                .context_usage
                .as_ref()
                .map(|u| u.model_id.as_str())
                .unwrap_or(&self.cfg.model_id);
            children.push(status_bar(StatusBarProps {
                model_id,
                error: self.status_error.as_ref().map(|d| d.as_deref()),
                context_used_percent: self.context_usage.as_ref().map(|u| u.used_percent),
                update_available_version: self.update_available.as_deref(),
            }));
        }
        col(children).pad_x(1).el()
    }

    fn chat_view(&self) -> Vec<El> {
        let screen = Screen {
            columns: self.columns,
            rows: self.rows,
            graphics: self.graphics,
            images: &self.images,
            markdown: &self.markdown,
            rows_cache: &self.rows_cache,
        };
        let mut out = vec![message_list(
            MessageListProps {
                agent_name: &self.cfg.agent_name,
                me: self.me.as_ref(),
                entries: &self.entries,
                expanded_message_id: self.expanded_message_id.as_deref(),
            },
            &screen,
            // Inside the root's one-column padding on each side.
            self.columns.saturating_sub(2),
        )];
        if !self.staged.is_empty() {
            let files: Vec<String> = self
                .staged
                .iter()
                .map(|a| format!("📎 {} ({})", a.filename, format_file_size(a.size_bytes)))
                .collect();
            out.push(
                row(vec![styled(
                    format!("{}  ·  /detach to remove", files.join("  ")),
                    Style::new().dim(),
                )])
                .pad_x(2)
                .el(),
            );
        }
        let turn = self.turn_state();
        out.push(spinner_row(
            turn != TurnState::Idle || self.compacting,
            spinner_label(turn),
            self.spinner_frame,
        ));
        out.push(
            row(vec![
                col(vec![styled("›", Style::new().fg(Color::Cyan).bold())])
                    .margin_right(1)
                    .el(),
                text_line(self.composer.line(true, !self.cfg.hide_cursor, None)),
            ])
            .border(BorderKind::Round, Color::Cyan)
            .pad_x(1)
            .el(),
        );
        if self.slash_mode() || self.attach_mode() {
            let items: Vec<PopupItem> = if self.slash_mode() {
                self.filtered_commands()
                    .iter()
                    .map(|c| PopupItem {
                        name: c.name.into(),
                        description: c.description.into(),
                    })
                    .collect()
            } else {
                self.path_suggestions()
                    .iter()
                    .map(|s| PopupItem {
                        description: if s.is_directory {
                            "dir".into()
                        } else {
                            String::new()
                        },
                        name: s.display.clone(),
                    })
                    .collect()
            };
            if let Some(popup) = command_popup(&items, self.safe_index()) {
                out.push(popup);
            }
        }
        out
    }
}
