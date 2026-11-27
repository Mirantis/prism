//! The webhooks panel: list the subscriptions, pause and resume them, and edit
//! everything but the name and the sender authentication. The prompt is
//! multi-line, so it is edited in `$EDITOR`; the other fields are edited in place.

use serde_json::json;

use super::{
    Column, ListPanel, Load, PanelAction, PanelMsg, error_text, load_error_view, loading_view,
    spawn_request,
};
use crate::api::{SlackChannel, WebhookSubscription};
use crate::editor::{EditResult, edit_text, resolve_editor};
use crate::event::Ctx;
use crate::term::input::KeyEvent;
use crate::term::style::{Color, Style};
use crate::ui::layout::{BorderKind, El, col, row, styled, text_line};
use crate::ui::spinner::spinner;
use crate::ui::text_input::TextInput;

const DELIVER_TARGETS: [&str; 5] = ["all", "chat", "slack", "teams", "none"];

/// A target that a newer runtime added shows as its stored value.
fn deliver_label(target: &str) -> String {
    match target {
        "all" => "All channels".into(),
        "chat" => "Chat".into(),
        "slack" => "Slack".into(),
        "teams" => "Microsoft Teams".into(),
        "none" => "None".into(),
        other => other.into(),
    }
}

const LABEL_WIDTH: usize = 16;
const PROMPT_PREVIEW_LINES: usize = 4;
const COLUMNS: [Column; 4] = [
    Column {
        header: "NAME",
        width: Some(26),
    },
    Column {
        header: "DELIVER TO",
        width: Some(18),
    },
    Column {
        header: "MODE",
        width: Some(10),
    },
    Column {
        header: "ACTIVE",
        width: None,
    },
];

/// An edit form row. A Slack channel row is named for its channel id.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Field {
    Description,
    Events,
    DeliverTo,
    Channel(String),
    DeliverOnly,
    Prompt,
}

struct ChannelOption {
    id: String,
    label: String,
    is_main: bool,
    is_linked: bool,
}

/// The linked channels, then each chosen channel that was unlinked since.
fn channel_options(linked: &[SlackChannel], chosen: &[String]) -> Vec<ChannelOption> {
    let mut out: Vec<ChannelOption> = linked
        .iter()
        .map(|c| ChannelOption {
            id: c.channel_id.clone(),
            label: format!(
                "#{}",
                c.channel_name
                    .clone()
                    .unwrap_or_else(|| c.channel_id.clone())
            ),
            is_main: c.is_main,
            is_linked: true,
        })
        .collect();
    for id in chosen {
        if !linked.iter().any(|c| &c.channel_id == id) {
            out.push(ChannelOption {
                id: id.clone(),
                label: id.clone(),
                is_main: false,
                is_linked: false,
            });
        }
    }
    out
}

/// The edit form's rows in focus order. Channel rows show for the Slack target only.
fn field_order(deliver_to: &str, options: &[ChannelOption]) -> Vec<Field> {
    let mut order = vec![Field::Description, Field::Events, Field::DeliverTo];
    if deliver_to == "slack" {
        order.extend(options.iter().map(|o| Field::Channel(o.id.clone())));
    }
    order.push(Field::DeliverOnly);
    order.push(Field::Prompt);
    order
}

fn step_field(order: &[Field], field: &Field, step: isize) -> Field {
    let at = order
        .iter()
        .position(|f| f == field)
        .map(|i| i as isize)
        .unwrap_or(-1);
    let len = order.len() as isize;
    order[((at + step + len) % len) as usize].clone()
}

struct Form {
    description: TextInput,
    events: TextInput,
    deliver_to: String,
    slack_channel_ids: Vec<String>,
    deliver_only: bool,
    prompt: String,
}

pub enum Msg {
    Loaded(Result<(Vec<WebhookSubscription>, Vec<SlackChannel>), String>),
    Toggled(Result<WebhookSubscription, String>),
    Saved(Result<WebhookSubscription, String>),
    PromptEdited(Result<EditResult, String>),
}

pub struct WebhooksPanel {
    editing: bool,
    load: Load,
    error: Option<String>,
    subscriptions: Vec<WebhookSubscription>,
    slack_channels: Vec<SlackChannel>,
    selected: usize,
    toggling: bool,
    form: Option<Form>,
    focused: Field,
    submitting: bool,
    /// True while the editor owns the terminal.
    handing_off: bool,
    /// The temp file of the last prompt edit.
    prompt_file: Option<EditResult>,
}

impl WebhooksPanel {
    pub fn open(ctx: &Ctx) -> WebhooksPanel {
        let mut panel = WebhooksPanel {
            editing: false,
            load: Load::Loading,
            error: None,
            subscriptions: Vec::new(),
            slack_channels: Vec::new(),
            selected: 0,
            toggling: false,
            form: None,
            focused: Field::Description,
            submitting: false,
            handing_off: false,
            prompt_file: None,
        };
        panel.reload(ctx);
        panel
    }

    pub fn busy(&self) -> bool {
        self.load == Load::Loading || self.submitting
    }

    pub fn listening(&self) -> bool {
        !self.handing_off
    }

    fn reload(&mut self, ctx: &Ctx) {
        self.load = Load::Loading;
        self.error = None;
        let api = ctx.api.clone();
        let request = async move {
            tokio::try_join!(api.list_webhook_subscriptions(), api.list_slack_channels())
                .map_err(|e| error_text(&e))
        };
        spawn_request(ctx, request, |result| {
            PanelMsg::Webhooks(Msg::Loaded(result))
        });
    }

    /// Store a change to one subscription, and report what the runtime answered.
    fn update(
        ctx: &Ctx,
        id: String,
        update: serde_json::Value,
        message: fn(Result<WebhookSubscription, String>) -> Msg,
    ) {
        let api = ctx.api.clone();
        spawn_request(
            ctx,
            async move {
                api.update_webhook_subscription(&id, update)
                    .await
                    .map_err(|e| error_text(&e))
            },
            move |result| PanelMsg::Webhooks(message(result)),
        );
    }

    fn selected_sub(&self) -> Option<&WebhookSubscription> {
        self.subscriptions.get(self.selected)
    }

    fn options(&self) -> Vec<ChannelOption> {
        let chosen = self
            .selected_sub()
            .map(|s| s.slack_channel_ids.clone())
            .unwrap_or_default();
        channel_options(&self.slack_channels, &chosen)
    }

    fn replace(&mut self, updated: WebhookSubscription) {
        for s in &mut self.subscriptions {
            if s.id == updated.id {
                *s = updated.clone();
            }
        }
    }

    fn close_edit(&mut self) {
        if let Some(file) = self.prompt_file.take() {
            file.discard();
        }
        self.form = None;
        self.submitting = false;
        self.error = None;
        self.editing = false;
    }

    pub fn on_msg(&mut self, msg: Msg) {
        match msg {
            Msg::Loaded(Ok((list, channels))) => {
                self.selected = if list.is_empty() {
                    0
                } else {
                    self.selected.min(list.len() - 1)
                };
                self.subscriptions = list;
                self.slack_channels = channels;
                self.load = Load::Ready;
            }
            Msg::Loaded(Err(e)) => {
                self.error = Some(e);
                self.load = Load::Error;
            }
            Msg::Toggled(result) => {
                self.toggling = false;
                match result {
                    Ok(updated) => self.replace(updated),
                    Err(e) => self.error = Some(e),
                }
            }
            Msg::Saved(Ok(updated)) => {
                self.replace(updated);
                self.close_edit();
            }
            Msg::Saved(Err(message)) => {
                let kept = self.prompt_file.take();
                self.error = Some(match kept {
                    Some(file) => {
                        format!("{message}\nYour edit is kept at {}", file.file.display())
                    }
                    None => message,
                });
                self.submitting = false;
            }
            Msg::PromptEdited(result) => {
                self.handing_off = false;
                match result {
                    Ok(edit) if edit.changed => {
                        if let Some(old) = self.prompt_file.take() {
                            old.discard();
                        }
                        if let Some(form) = &mut self.form {
                            form.prompt = edit.text.trim().to_string();
                        }
                        self.prompt_file = Some(edit);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        self.error = Some(format!("Could not open {}: {e}", resolve_editor()))
                    }
                }
            }
        }
    }

    fn toggle_selected(&mut self, ctx: &Ctx) {
        let Some(sub) = self.selected_sub().cloned() else {
            return;
        };
        if self.toggling {
            return;
        }
        self.toggling = true;
        self.error = None;
        Self::update(
            ctx,
            sub.id,
            json!({ "isActive": !sub.is_active }),
            Msg::Toggled,
        );
    }

    fn open_edit(&mut self) {
        let Some(s) = self.selected_sub().cloned() else {
            return;
        };
        self.form = Some(Form {
            description: TextInput::new(s.description.as_deref().unwrap_or("")),
            events: TextInput::new(s.events.as_deref().unwrap_or("")),
            deliver_to: s.deliver_to.clone(),
            slack_channel_ids: s.slack_channel_ids.clone(),
            deliver_only: s.deliver_only,
            prompt: s.prompt.clone().unwrap_or_default(),
        });
        self.focused = Field::Description;
        self.error = None;
        self.editing = true;
    }

    fn save(&mut self, ctx: &Ctx) {
        let (Some(sub), Some(form)) = (self.selected_sub().cloned(), &self.form) else {
            return;
        };
        if self.submitting {
            return;
        }
        self.submitting = true;
        self.error = None;
        // An empty string clears the stored value.
        let update = json!({
            "description": form.description.value.trim(),
            "events": form.events.value.trim(),
            "prompt": form.prompt.trim(),
            "deliverTo": form.deliver_to,
            "slackChannelIds": if form.deliver_to == "slack" { form.slack_channel_ids.clone() } else { Vec::new() },
            "deliverOnly": form.deliver_only,
        });
        Self::update(ctx, sub.id, update, Msg::Saved);
    }

    fn edit_prompt(&mut self, ctx: &Ctx) {
        let Some(form) = &self.form else { return };
        self.handing_off = true;
        self.error = None;
        let prompt = form.prompt.clone();
        let task = ctx.clone();
        let request = async move {
            task.suspended(move || edit_text(&prompt, ".md"))
                .await
                .map_err(|e| e.to_string())
        };
        spawn_request(ctx, request, |result| {
            PanelMsg::Webhooks(Msg::PromptEdited(result))
        });
    }

    fn cycle_deliver_to(&mut self, step: isize) {
        let Some(form) = &mut self.form else { return };
        let at = DELIVER_TARGETS
            .iter()
            .position(|t| *t == form.deliver_to)
            .map(|i| i as isize)
            .unwrap_or(-1);
        let len = DELIVER_TARGETS.len() as isize;
        let next = DELIVER_TARGETS[((at + step + len) % len) as usize];
        form.deliver_to = next.to_string();
        // Deliver only posts the template, so it needs a target.
        if next == "none" {
            form.deliver_only = false;
        }
    }

    pub fn handle_key(&mut self, ev: &KeyEvent, ctx: &Ctx) -> PanelAction {
        if !self.listening() {
            return PanelAction::None;
        }
        let k = &ev.key;
        if self.editing
            && let Some(form) = &mut self.form
        {
            match self.focused {
                Field::Description => {
                    form.description.handle(ev, true);
                }
                Field::Events => {
                    form.events.handle(ev, true);
                }
                _ => {}
            }
        }
        if self.load == Load::Error {
            if ev.input == "r" {
                self.reload(ctx);
            } else if k.escape {
                return PanelAction::Close;
            }
            return PanelAction::None;
        }
        if self.load == Load::Loading {
            return PanelAction::None;
        }
        if !self.editing {
            if k.escape {
                return PanelAction::Close;
            } else if k.up {
                self.selected = self.selected.saturating_sub(1);
            } else if k.down {
                self.selected = (self.selected + 1).min(self.subscriptions.len().saturating_sub(1));
            } else if k.ret {
                self.open_edit();
            } else if ev.input == " " {
                self.toggle_selected(ctx);
            }
            return PanelAction::None;
        }
        if self.submitting {
            return PanelAction::None;
        }
        if k.escape {
            self.close_edit();
            return PanelAction::None;
        }
        if k.ret {
            self.save(ctx);
            return PanelAction::None;
        }
        let order = field_order(
            self.form
                .as_ref()
                .map(|f| f.deliver_to.as_str())
                .unwrap_or(""),
            &self.options(),
        );
        if (k.tab && k.shift) || k.up {
            self.set_focus(step_field(&order, &self.focused, -1));
            return PanelAction::None;
        }
        if k.tab || k.down {
            self.set_focus(step_field(&order, &self.focused, 1));
            return PanelAction::None;
        }
        match self.focused.clone() {
            Field::DeliverTo => {
                if k.left {
                    self.cycle_deliver_to(-1);
                } else if k.right || ev.input == " " {
                    self.cycle_deliver_to(1);
                }
            }
            Field::Channel(id) if ev.input == " " => {
                if let Some(form) = &mut self.form {
                    if form.slack_channel_ids.contains(&id) {
                        form.slack_channel_ids.retain(|c| c != &id);
                    } else {
                        form.slack_channel_ids.push(id);
                    }
                }
            }
            Field::DeliverOnly if ev.input == " " => {
                if let Some(form) = &mut self.form
                    && form.deliver_to != "none"
                {
                    form.deliver_only = !form.deliver_only;
                }
            }
            Field::Prompt if ev.input == " " => self.edit_prompt(ctx),
            _ => {}
        }
        PanelAction::None
    }

    fn set_focus(&mut self, field: Field) {
        if let Some(form) = &mut self.form {
            match field {
                Field::Description => {
                    let v = form.description.value.clone();
                    form.description.reset(&v);
                }
                Field::Events => {
                    let v = form.events.value.clone();
                    form.events.reset(&v);
                }
                _ => {}
            }
        }
        self.focused = field;
    }

    pub fn view(&self, input_active: bool, frame: usize) -> El {
        if self.load == Load::Loading {
            return loading_view("Loading webhooks…", Style::new().dim(), frame);
        }
        if self.load == Load::Error {
            return load_error_view(self.error.as_deref(), "Failed to load webhooks");
        }
        if self.editing
            && let (Some(form), Some(sub)) = (&self.form, self.selected_sub())
        {
            return self.edit_view(form, sub, input_active && self.listening(), frame);
        }
        self.list_view()
    }

    fn edit_view(
        &self,
        form: &Form,
        sub: &WebhookSubscription,
        listening: bool,
        frame: usize,
    ) -> El {
        let focus_style = |field: &Field| {
            if &self.focused == field {
                Style::new().fg(Color::Cyan).bold()
            } else {
                Style::default()
            }
        };
        let label = |field: Field, text: &str| {
            row(vec![styled(text.to_string(), focus_style(&field))])
                .width(LABEL_WIDTH)
                .el()
        };
        let options = self.options();
        let prompt_lines: Vec<&str> = if form.prompt.is_empty() {
            Vec::new()
        } else {
            form.prompt.split('\n').collect()
        };
        let hidden = prompt_lines.len() as isize - PROMPT_PREVIEW_LINES as isize;
        let key_hint = match &self.focused {
            Field::DeliverTo => Some("←→ change"),
            Field::DeliverOnly | Field::Channel(_) => Some("space toggle"),
            Field::Prompt => Some("space open in editor"),
            _ => None,
        };
        let mut children = vec![
            styled(
                format!("Edit webhook {}", sub.name),
                Style::new().bold().fg(Color::Cyan),
            ),
            row(vec![
                label(Field::Description, "Description"),
                text_line(form.description.line(
                    listening && self.focused == Field::Description,
                    true,
                    None,
                )),
            ])
            .margin_top(1)
            .el(),
            row(vec![
                label(Field::Events, "Events"),
                text_line(
                    form.events
                        .line(listening && self.focused == Field::Events, true, None),
                ),
            ])
            .el(),
            row(vec![
                label(Field::DeliverTo, "May post to"),
                styled(
                    format!("‹ {} ›", deliver_label(&form.deliver_to)),
                    Style::default(),
                ),
            ])
            .el(),
        ];
        if form.deliver_to == "slack" && options.is_empty() {
            children.push(
                row(vec![
                    row(vec![styled("Slack channels", Style::default())])
                        .width(LABEL_WIDTH)
                        .el(),
                    styled(
                        "none linked: posts to your DM, else the main channel",
                        Style::new().dim(),
                    ),
                ])
                .el(),
            );
        }
        if form.deliver_to == "slack" {
            for (i, option) in options.iter().enumerate() {
                let field = Field::Channel(option.id.clone());
                let first = if i == 0 {
                    label(field.clone(), "Slack channels")
                } else {
                    row(vec![]).width(LABEL_WIDTH).el()
                };
                let mark = if form.slack_channel_ids.contains(&option.id) {
                    "[x]"
                } else {
                    "[ ]"
                };
                let mut cells = vec![
                    first,
                    styled(format!("{mark} {}", option.label), focus_style(&field)),
                ];
                if option.is_main {
                    cells.push(styled(" main", Style::new().dim()));
                }
                if !option.is_linked {
                    cells.push(styled(" not linked", Style::new().dim()));
                }
                children.push(row(cells).el());
            }
        }
        let only_style = if form.deliver_to == "none" {
            Style::new().dim()
        } else {
            Style::default()
        };
        children.push(
            row(vec![
                label(Field::DeliverOnly, "Deliver only"),
                styled(
                    format!(
                        "{} Skip the agent, deliver the template directly",
                        if form.deliver_only { "[x]" } else { "[ ]" }
                    ),
                    only_style,
                ),
            ])
            .el(),
        );
        let mut preview: Vec<El> = Vec::new();
        if prompt_lines.is_empty() {
            preview.push(styled("(empty: the raw payload)", Style::new().dim()));
        } else {
            // An empty line still keeps a row.
            preview.extend(prompt_lines.iter().take(PROMPT_PREVIEW_LINES).map(|l| {
                styled(
                    if l.is_empty() {
                        " ".to_string()
                    } else {
                        l.to_string()
                    },
                    Style::default(),
                )
            }));
        }
        if hidden > 0 {
            preview.push(styled(
                format!(
                    "… {hidden} more {}",
                    if hidden == 1 { "line" } else { "lines" }
                ),
                Style::new().dim(),
            ));
        }
        children.push(
            row(vec![
                label(
                    Field::Prompt,
                    if form.deliver_only {
                        "Template"
                    } else {
                        "Prompt"
                    },
                ),
                col(preview).el(),
            ])
            .el(),
        );
        let mut notes = vec![styled(
            "Events is a comma-separated allowlist; empty accepts every event. Prompts substitute {field.path} and {__raw__}.",
            Style::new().dim(),
        )];
        if form.deliver_to == "slack" && !options.is_empty() {
            notes.push(styled(
                "With no Slack channel checked, Slack delivery goes to your DM, else the main channel.",
                Style::new().dim(),
            ));
        }
        children.push(col(notes).margin_top(1).el());
        if let Some(error) = &self.error {
            children.push(styled(error.clone(), Style::new().fg(Color::Red)));
        }
        let footer = if self.submitting {
            row(vec![spinner(frame), styled(" saving…", Style::new().dim())]).el()
        } else {
            let hint = key_hint.map(|h| format!(" · {h}")).unwrap_or_default();
            styled(
                format!("tab/↑↓ move{hint} · enter save · esc cancel"),
                Style::new().dim(),
            )
        };
        children.push(row(vec![footer]).margin_top(1).el());
        col(children)
            .border(BorderKind::Round, Color::Cyan)
            .pad_x(1)
            .el()
    }

    fn list_view(&self) -> El {
        let rows = self
            .subscriptions
            .iter()
            .map(|s| {
                let active = Style::new().fg(if s.is_active {
                    Color::Green
                } else {
                    Color::Red
                });
                vec![
                    (s.name.clone(), Style::default()),
                    (deliver_label(&s.deliver_to), Style::default()),
                    (
                        (if s.deliver_only { "direct" } else { "agent" }).to_string(),
                        Style::default(),
                    ),
                    ((if s.is_active { "✓" } else { "✗" }).to_string(), active),
                ]
            })
            .collect();
        let hint = if self.subscriptions.is_empty() {
            "esc close"
        } else {
            "↑↓ select · enter edit · space pause/resume · esc close"
        };
        ListPanel {
            title: "Webhooks",
            columns: &COLUMNS,
            rows,
            selected: self.selected,
            empty: "No webhook subscriptions. Create one on the Web UI's Webhooks page.",
            error: self.error.as_deref(),
            hint,
        }
        .view()
    }
}
