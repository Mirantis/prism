//! What each key does: Ctrl+C everywhere, the screen that has the keyboard, and
//! the composer with its popup and history.

use super::{App, Panel};
use crate::attachments::latest_turn_attachments;
use crate::commands::{self, CommandContext, find_exact, parse_command_line};
use crate::event::AppEvent;
use crate::panels::PanelAction;
use crate::panels::resume::Pick;
use crate::protocol::{MAX_MESSAGE_CHARS, Role, TurnState};
use crate::shell_command::{format_shell_record, run_shell_command, shell_command_of};
use crate::term::input::{KeyEvent, key_event};
use crate::term::text::js_len;
use crate::ui::text_input::Edit;

impl App {
    pub(super) fn on_input_event(&mut self, event: &str) {
        let Some(ev) = key_event(event) else { return };
        if self.suspended || self.shutting_down {
            return;
        }
        // Ctrl+C works everywhere, a panel included.
        if ev.is_ctrl('c') {
            self.shutting_down = true;
            return;
        }
        if let Some(list) = &mut self.resume {
            if self.resuming {
                return;
            }
            match list.handle_key(&ev) {
                Pick::Select(thread_id) => self.select_resumed(thread_id),
                Pick::Cancel => self.shutting_down = true,
                Pick::None => {}
            }
            return;
        }
        if self.show_sign_in() {
            let ctx = self.ctx.clone();
            if let (Some(panel), Some(request)) = (&mut self.sign_in_panel, &self.sign_in)
                && panel.handle_key(&ev, request, &ctx) == PanelAction::Close
            {
                self.close_sign_in();
            }
            return;
        }
        if let Some(panel) = &mut self.panel {
            let ctx = self.ctx.clone();
            let action = match panel {
                Panel::Schedules(p) => p.handle_key(&ev, &ctx),
                Panel::Config(p) => p.handle_key(&ev, &ctx, self.columns, self.rows),
                Panel::Webhooks(p) => p.handle_key(&ev, &ctx),
            };
            if action == PanelAction::Close {
                self.close_panel();
            }
            return;
        }
        self.on_chat_key(&ev);
    }

    fn select_resumed(&mut self, thread_id: String) {
        // The picker's own row shows a percentage before the next turn is measured.
        self.context_usage = self
            .resume
            .as_ref()
            .and_then(|r| r.sessions.iter().find(|s| s.id == thread_id))
            .and_then(|s| s.context_usage.clone());
        self.active_thread_id = Some(thread_id.clone());
        self.resuming = true;
        let outs = self.adapter.resume_thread(&thread_id);
        self.apply_outs(outs);
    }

    fn on_chat_key(&mut self, ev: &KeyEvent) {
        let edit = self.composer.handle(ev, !self.cfg.hide_cursor);
        match edit {
            Edit::Changed => {
                // Typing leaves history browsing.
                self.history_index = None;
                self.clamp_command_index();
            }
            Edit::Submit => {
                let value = self.composer.value.clone();
                self.on_submit(&value);
                self.clamp_command_index();
                return;
            }
            Edit::None => {}
        }
        let k = &ev.key;
        // Escape while the conversation works stops it.
        if k.escape && self.turn_state() != TurnState::Idle {
            if !self.adapter.cancel() {
                self.append_system("Not connected, so the response could not be stopped.");
                return;
            }
            if self.turn_state() == TurnState::Queued {
                self.append_system("⏹ Response stopped");
            }
            return;
        }
        // Ctrl+O toggles the tool calls of the newest agent message that has any.
        if ev.is_ctrl('o') {
            let latest = self.entries.iter().rev().map(|e| &e.message).find(|m| {
                m.role == Role::Agent && m.tool_calls.as_array().is_some_and(|a| !a.is_empty())
            });
            if let Some(m) = latest {
                let id = m.id.clone();
                self.expanded_message_id = if self.expanded_message_id.as_deref() == Some(&id) {
                    None
                } else {
                    Some(id)
                };
            }
            return;
        }
        let popup_len = self.popup_len();
        if (self.slash_mode() || self.attach_mode()) && popup_len > 0 {
            if k.up {
                self.command_index = (self.command_index + popup_len - 1) % popup_len;
            } else if k.down {
                self.command_index = (self.command_index + 1) % popup_len;
            } else if k.tab {
                if self.slash_mode() {
                    self.accept_highlighted_command();
                } else if let Some(s) = self.path_suggestions().get(self.safe_index()) {
                    // A directory keeps completing inside it; a file is ready to submit.
                    let value = format!(
                        "{}{}{}",
                        Self::attach_prefix(),
                        s.insert,
                        if s.is_directory { "" } else { " " }
                    );
                    self.composer.reset(&value);
                    self.clamp_command_index();
                }
            }
            return;
        }
        if k.up {
            if self.history.is_empty() {
                return;
            }
            // Up enters history only from an empty composer, so a draft is never lost.
            if self.history_index.is_none() && !self.composer.value.is_empty() {
                return;
            }
            let next = match self.history_index {
                None => self.history.len() - 1,
                Some(i) => i.saturating_sub(1),
            };
            self.history_index = Some(next);
            let value = self.history[next].clone();
            self.composer.reset(&value);
            self.clamp_command_index();
            return;
        }
        if k.down {
            let Some(i) = self.history_index else { return };
            let next = i + 1;
            if next >= self.history.len() {
                self.history_index = None;
                self.composer.reset("");
            } else {
                self.history_index = Some(next);
                let value = self.history[next].clone();
                self.composer.reset(&value);
            }
            self.clamp_command_index();
        }
    }

    /// The highlighted slash command into the composer as "<name> ". The trailing
    /// space ends slash mode, so the popup closes and arguments can follow.
    fn accept_highlighted_command(&mut self) {
        let commands = self.filtered_commands();
        let Some(chosen) = commands.get(self.safe_index()) else {
            return;
        };
        let value = format!("{} ", chosen.name);
        self.composer.reset(&value);
    }

    fn on_submit(&mut self, text: &str) {
        // With the slash popup open, Enter accepts the highlighted row and sends nothing.
        if self.slash_mode() && !self.filtered_commands().is_empty() {
            self.accept_highlighted_command();
            return;
        }
        let trimmed = text.trim().to_string();
        // A message of files alone is still a send.
        if trimmed.is_empty() && self.staged.is_empty() {
            return;
        }
        if !trimmed.is_empty() && self.history.last() != Some(&trimmed) {
            self.history.push(trimmed.clone());
        }
        self.history_index = None;

        // `! <command>` runs in this terminal; the command and its output go to the agent.
        if let Some(command) = shell_command_of(&trimmed) {
            self.composer.set_value("");
            if command.is_empty() {
                self.append_system("Type a shell command after !, for example: ! aws sso login");
                return;
            }
            let ctx = self.ctx.clone();
            tokio::spawn(async move {
                match ctx.suspended(move || run_shell_command(&command)).await {
                    Ok(run) => ctx.send(AppEvent::SendMessage(format_shell_record(&run))),
                    Err(e) => ctx.send(AppEvent::System(format!("Could not run the command: {e}"))),
                }
            });
            return;
        }

        // A registered command runs here instead of going to the agent. Staged files wait for a chat send.
        if trimmed.starts_with('/') {
            let (head, args, raw_args) = parse_command_line(&trimmed);
            if let Some(cmd) = find_exact(&head) {
                self.composer.set_value("");
                self.run_command(cmd.id, args, raw_args);
                return;
            }
        }

        // The draft stays in the composer, so nothing typed is lost.
        let chars = js_len(&trimmed);
        if chars > MAX_MESSAGE_CHARS {
            self.append_system(&format!(
                "That message has {chars} characters. The limit is {MAX_MESSAGE_CHARS}."
            ));
            return;
        }
        self.composer.set_value("");
        let to_send = std::mem::take(&mut self.staged);
        self.send_message(trimmed, to_send);
    }

    fn run_command(&mut self, id: commands::CommandId, args: Vec<String>, raw_args: String) {
        let messages: Vec<_> = self.entries.iter().map(|e| &e.message).collect();
        let c = CommandContext {
            ctx: self.ctx.clone(),
            last_message_content: self.entries.last().map(|e| e.message.content.clone()),
            args,
            raw_args,
            thread_id: self.active_thread_id.clone(),
            recent_attachments: latest_turn_attachments(&messages),
            staged_attachments: self.staged.clone(),
        };
        let ctx = self.ctx.clone();
        tokio::spawn(async move {
            let result = commands::run(id, c).await;
            if !result.is_empty() {
                ctx.send(AppEvent::System(result));
            }
        });
    }
}
