//! The schedules panel: list, create, edit and delete scheduled tasks.

use serde_json::{Map, Value, json};

use super::{
    Column, ListPanel, Load, PanelAction, PanelMsg, error_text, format_local_time, load_error_view,
    loading_view, spawn_request,
};
use crate::api::CronTask;
use crate::event::Ctx;
use crate::term::input::KeyEvent;
use crate::term::style::{Color, Style};
use crate::term::text::Span;
use crate::ui::layout::{BorderKind, El, col, row, styled, text, text_line};
use crate::ui::spinner::spinner;
use crate::ui::text_input::TextInput;

const COLUMNS: [Column; 4] = [
    Column {
        header: "NAME",
        width: Some(22),
    },
    Column {
        header: "SCHEDULE",
        width: Some(22),
    },
    Column {
        header: "NEXT RUN",
        width: Some(22),
    },
    Column {
        header: "ACTIVE",
        width: Some(8),
    },
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    List,
    Form,
    ConfirmDelete,
}

pub enum Msg {
    Loaded(Result<Vec<CronTask>, String>),
    Saved(Result<(), String>),
    Deleted(Result<(), String>),
}

pub struct SchedulesPanel {
    mode: Mode,
    load: Load,
    error: Option<String>,
    tasks: Vec<CronTask>,
    selected: usize,
    editing: Option<CronTask>,
    fields: [TextInput; 3],
    focused: usize,
    submitting: bool,
}

fn next_run(iso: Option<&str>) -> String {
    iso.and_then(format_local_time)
        .unwrap_or_else(|| "—".into())
}

impl SchedulesPanel {
    pub fn open(ctx: &Ctx) -> SchedulesPanel {
        let mut panel = SchedulesPanel {
            mode: Mode::List,
            load: Load::Loading,
            error: None,
            tasks: Vec::new(),
            selected: 0,
            editing: None,
            fields: Default::default(),
            focused: 0,
            submitting: false,
        };
        panel.reload(ctx);
        panel
    }

    pub fn busy(&self) -> bool {
        self.load == Load::Loading || self.submitting
    }

    fn reload(&mut self, ctx: &Ctx) {
        self.load = Load::Loading;
        self.error = None;
        let api = ctx.api.clone();
        spawn_request(
            ctx,
            async move { api.list_cron_tasks().await.map_err(|e| error_text(&e)) },
            |result| PanelMsg::Schedules(Msg::Loaded(result)),
        );
    }

    fn reset_form(&mut self) {
        self.editing = None;
        self.fields = Default::default();
        self.focused = 0;
        self.submitting = false;
    }

    fn start_edit(&mut self, task: CronTask) {
        self.fields = [
            TextInput::new(&task.name),
            TextInput::new(&task.schedule),
            TextInput::new(task.instruction.as_deref().unwrap_or("")),
        ];
        self.editing = Some(task);
        self.focused = 0;
        self.submitting = false;
        self.error = None;
        self.mode = Mode::Form;
    }

    fn focus(&mut self, field: usize) {
        self.focused = field;
        // The focused field starts with its cursor at the end.
        let value = self.fields[field].value.clone();
        self.fields[field].reset(&value);
    }

    pub fn on_msg(&mut self, msg: Msg, ctx: &Ctx) {
        match msg {
            Msg::Loaded(Ok(list)) => {
                self.selected = if list.is_empty() {
                    0
                } else {
                    self.selected.min(list.len() - 1)
                };
                self.tasks = list;
                self.load = Load::Ready;
            }
            Msg::Loaded(Err(message)) => {
                self.error = Some(message);
                self.load = Load::Error;
            }
            Msg::Saved(Ok(())) => {
                self.reset_form();
                self.mode = Mode::List;
                self.reload(ctx);
            }
            Msg::Saved(Err(message)) => {
                self.error = Some(message);
                self.submitting = false;
            }
            Msg::Deleted(Ok(())) => {
                self.mode = Mode::List;
                self.reload(ctx);
            }
            Msg::Deleted(Err(message)) => {
                self.error = Some(message);
                self.load = Load::Error;
                self.mode = Mode::List;
            }
        }
    }

    fn submit(&mut self, ctx: &Ctx) {
        let name = self.fields[0].value.trim().to_string();
        let schedule = self.fields[1].value.trim().to_string();
        let instruction = self.fields[2].value.trim().to_string();
        if name.is_empty() || schedule.is_empty() || instruction.is_empty() || self.submitting {
            return;
        }
        self.submitting = true;
        self.error = None;
        let editing = self.editing.clone();
        let api = ctx.api.clone();
        let request = async move {
            let result = match editing {
                Some(task) => {
                    // An edit sends only the fields that changed: a schedule that is sent is read again from now.
                    let mut changes = Map::new();
                    if name != task.name.trim() {
                        changes.insert("name".into(), json!(name));
                    }
                    if schedule != task.schedule.trim() {
                        changes.insert("schedule".into(), json!(schedule));
                    }
                    if instruction != task.instruction.as_deref().unwrap_or("").trim() {
                        changes.insert("instruction".into(), json!(instruction));
                    }
                    if changes.is_empty() {
                        Ok(())
                    } else {
                        api.update_cron_task(&task.id, Value::Object(changes)).await
                    }
                }
                None => api.create_cron_task(&name, &schedule, &instruction).await,
            };
            result.map_err(|e| error_text(&e))
        };
        spawn_request(ctx, request, |result| {
            PanelMsg::Schedules(Msg::Saved(result))
        });
    }

    fn confirm_delete(&mut self, ctx: &Ctx) {
        let Some(task) = self.tasks.get(self.selected).cloned() else {
            self.mode = Mode::List;
            return;
        };
        let api = ctx.api.clone();
        spawn_request(
            ctx,
            async move {
                api.delete_cron_task(&task.id)
                    .await
                    .map_err(|e| error_text(&e))
            },
            |result| PanelMsg::Schedules(Msg::Deleted(result)),
        );
    }

    pub fn handle_key(&mut self, ev: &KeyEvent, ctx: &Ctx) -> PanelAction {
        let k = &ev.key;
        if self.mode == Mode::Form && self.load == Load::Ready {
            self.fields[self.focused].handle(ev, true);
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
        match self.mode {
            Mode::List => {
                if k.escape {
                    return PanelAction::Close;
                }
                if k.up {
                    self.selected = self.selected.saturating_sub(1);
                } else if k.down {
                    self.selected = (self.selected + 1).min(self.tasks.len().saturating_sub(1));
                } else if ev.input == "n" {
                    self.reset_form();
                    self.error = None;
                    self.mode = Mode::Form;
                } else if ev.input == "e" {
                    if let Some(task) = self.tasks.get(self.selected).cloned() {
                        self.start_edit(task);
                    }
                } else if ev.input == "d" && !self.tasks.is_empty() {
                    self.mode = Mode::ConfirmDelete;
                }
            }
            Mode::Form => {
                if k.escape {
                    self.reset_form();
                    self.error = None;
                    self.mode = Mode::List;
                } else if k.ret {
                    self.submit(ctx);
                } else if k.tab && k.shift {
                    self.focus((self.focused + 2) % 3);
                } else if k.tab || k.down {
                    self.focus((self.focused + 1) % 3);
                } else if k.up {
                    self.focus((self.focused + 2) % 3);
                }
            }
            Mode::ConfirmDelete => {
                if ev.input == "y" {
                    self.confirm_delete(ctx);
                } else if ev.input == "n" || k.escape {
                    self.mode = Mode::List;
                }
            }
        }
        PanelAction::None
    }

    pub fn view(&self, input_active: bool, frame: usize) -> El {
        if self.load == Load::Loading {
            return loading_view("Loading schedules…", Style::new().dim(), frame);
        }
        if self.load == Load::Error {
            return load_error_view(self.error.as_deref(), "Failed to load schedules");
        }
        match self.mode {
            Mode::Form => self.form_view(input_active, frame),
            Mode::ConfirmDelete => {
                let name = self
                    .tasks
                    .get(self.selected)
                    .map(|t| t.name.clone())
                    .unwrap_or_default();
                col(vec![text(vec![
                    Span::plain("Delete "),
                    Span::new(format!("\"{name}\""), Style::new().bold()),
                    Span::plain("? (y/n)"),
                ])])
                .border(BorderKind::Round, Color::Red)
                .pad_x(1)
                .el()
            }
            Mode::List => self.list_view(),
        }
    }

    fn form_view(&self, input_active: bool, frame: usize) -> El {
        let labels = ["Name", "Schedule", "Instruction"];
        let mut children = vec![styled(
            if self.editing.is_some() {
                "Edit schedule"
            } else {
                "New schedule"
            },
            Style::new().bold().fg(Color::Cyan),
        )];
        for (i, label) in labels.iter().enumerate() {
            let focused = self.focused == i;
            let style = if focused {
                Style::new().fg(Color::Cyan).bold()
            } else {
                Style::default()
            };
            let mut r = row(vec![
                row(vec![styled(*label, style)]).width(14).el(),
                text_line(self.fields[i].line(input_active && focused, true, None)),
            ]);
            if i == 0 {
                r = r.margin_top(1);
            }
            children.push(r.el());
        }
        // An unchanged schedule is not sent, so a one-off task keeps its time.
        let runs_once_at = self.editing.as_ref().and_then(|t| {
            (!t.recurring && self.fields[1].value.trim() == t.schedule.trim())
                .then(|| t.next_run_at.clone())
                .flatten()
        });
        let mut notes = vec![styled("All three fields are required.", Style::new().dim())];
        if let Some(at) = runs_once_at {
            notes.push(styled(
                format!("Runs once, at {}.", next_run(Some(&at))),
                Style::new().dim(),
            ));
        }
        notes.push(styled(
            "Schedule accepts cron or natural language ('every day at 9am', 'in 2 minutes').",
            Style::new().dim(),
        ));
        children.push(col(notes).margin_top(1).el());
        if let Some(error) = &self.error {
            children.push(styled(error.clone(), Style::new().fg(Color::Red)));
        }
        let footer = if self.submitting {
            row(vec![
                spinner(frame),
                styled(
                    if self.editing.is_some() {
                        " saving…"
                    } else {
                        " creating…"
                    },
                    Style::new().dim(),
                ),
            ])
            .el()
        } else {
            styled(
                format!(
                    "tab/↑↓ move · enter {} · esc cancel",
                    if self.editing.is_some() {
                        "save"
                    } else {
                        "create"
                    }
                ),
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
            .tasks
            .iter()
            .map(|task| {
                let active = Style::new().fg(if task.is_active {
                    Color::Green
                } else {
                    Color::Red
                });
                vec![
                    (task.name.clone(), Style::default()),
                    (task.schedule.clone(), Style::default()),
                    (next_run(task.next_run_at.as_deref()), Style::default()),
                    ((if task.is_active { "✓" } else { "✗" }).to_string(), active),
                ]
            })
            .collect();
        ListPanel {
            title: "Schedules",
            columns: &COLUMNS,
            rows,
            selected: self.selected,
            empty: "No scheduled tasks. Press n to create one.",
            error: None,
            hint: "↑↓ select · n new · e edit · d delete · esc close",
        }
        .view()
    }
}
