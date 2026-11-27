//! The username and password for a sign-in the agent asked for.
//!
//! What is typed here goes to the runtime, which enters it in the agent's browser
//! and submits the form. Nothing is written to the conversation.

use super::{PanelAction, PanelMsg, spawn_request};
use crate::event::Ctx;
use crate::protocol::SignInRequest;
use crate::term::input::KeyEvent;
use crate::term::style::{Color, Style};
use crate::ui::layout::{BorderKind, El, col, row, styled, text_line};
use crate::ui::text_input::TextInput;

pub enum Msg {
    Done(Result<(), String>),
}

pub struct SignInPanel {
    username: TextInput,
    password: TextInput,
    focused: usize,
    submitting: bool,
    error: Option<String>,
}

impl SignInPanel {
    pub fn new(request: &SignInRequest) -> SignInPanel {
        SignInPanel {
            username: TextInput::default(),
            password: TextInput::default(),
            focused: if request.password_only { 1 } else { 0 },
            submitting: false,
            error: None,
        }
    }

    fn submit(&mut self, request: &SignInRequest, ctx: &Ctx) {
        if self.password.value.is_empty() {
            self.error = Some("A password is required.".into());
            return;
        }
        self.submitting = true;
        self.error = None;
        let (id, username, password) = (
            request.id.clone(),
            self.username.value.clone(),
            self.password.value.clone(),
        );
        let api = ctx.api.clone();
        spawn_request(
            ctx,
            async move {
                api.sign_in_for_computer(&id, &username, &password)
                    .await
                    .map_err(|e| e.message)
            },
            |result| PanelMsg::SignIn(Msg::Done(result)),
        );
    }

    pub fn on_msg(&mut self, msg: Msg) -> PanelAction {
        let Msg::Done(result) = msg;
        self.submitting = false;
        match result {
            Ok(()) => {
                self.username.reset("");
                self.password.reset("");
                PanelAction::Close
            }
            Err(e) => {
                self.error = Some(e);
                PanelAction::None
            }
        }
    }

    pub fn handle_key(&mut self, ev: &KeyEvent, request: &SignInRequest, ctx: &Ctx) -> PanelAction {
        if !self.submitting {
            let field = if self.focused == 0 {
                &mut self.username
            } else {
                &mut self.password
            };
            field.handle(ev, true);
        }
        let k = &ev.key;
        if self.submitting {
            return PanelAction::None;
        }
        if k.escape {
            return PanelAction::Close;
        }
        if k.ret {
            self.submit(request, ctx);
            return PanelAction::None;
        }
        if request.password_only {
            return PanelAction::None;
        }
        if k.tab || k.up || k.down {
            self.focused = 1 - self.focused;
            let field = if self.focused == 0 {
                &mut self.username
            } else {
                &mut self.password
            };
            let value = field.value.clone();
            field.reset(&value);
        }
        PanelAction::None
    }

    pub fn view(&self, request: &SignInRequest) -> El {
        let label = |text: &str, focused: bool| {
            let style = if focused {
                Style::new().fg(Color::Cyan).bold()
            } else {
                Style::default()
            };
            row(vec![styled(text.to_string(), style)]).width(12).el()
        };
        let mut children = vec![
            styled("Prism needs a sign-in", Style::new().bold().fg(Color::Cyan)),
            styled(request.reason.clone(), Style::default()),
        ];
        if !request.password_only {
            children.push(
                row(vec![
                    label("Username", self.focused == 0),
                    text_line(self.username.line(
                        self.focused == 0 && !self.submitting,
                        true,
                        None,
                    )),
                ])
                .margin_top(1)
                .el(),
            );
        }
        children.push(
            row(vec![
                label("Password", self.focused == 1),
                text_line(self.password.line(
                    self.focused == 1 && !self.submitting,
                    true,
                    Some('•'),
                )),
            ])
            .el(),
        );
        let note = match &request.site {
            Some(site) => {
                format!("Prism types these into {site} and signs in. It never sees the password.")
            }
            None => {
                "Prism types these into the page it is on and signs in. It never sees the password."
                    .into()
            }
        };
        children.push(
            col(vec![styled(note, Style::new().dim())])
                .margin_top(1)
                .el(),
        );
        if let Some(error) = &self.error {
            children.push(styled(error.clone(), Style::new().fg(Color::Red)));
        }
        let footer = if self.submitting {
            "signing in…"
        } else {
            "tab to move · enter to sign in · esc to close"
        };
        children.push(
            row(vec![styled(footer, Style::new().dim())])
                .margin_top(1)
                .el(),
        );
        col(children)
            .border(BorderKind::Round, Color::Cyan)
            .pad_x(1)
            .el()
    }
}
