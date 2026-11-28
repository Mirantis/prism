//! The chat session: its state, the events that change it, and the loop that
//! draws it.
//!
//! Everything the session shows lives in `App` and changes only on this loop.
//! Network requests, commands and child processes run as tasks and report back
//! as `AppEvent`s, so the state is never touched from two places at once.

pub mod adapter;
mod keys;
mod view;

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};

use self::adapter::{Adapter, Out};
use crate::api::{ApiClient, LlmProviderStatus};
use crate::attachments::{PathSuggestion, list_path_suggestions};
use crate::commands::{ATTACH_COMMAND, SlashCommand, filter_by_prefix};
use crate::config::{PrismConfig, ws_url_from_http_url};
use crate::event::{AppEvent, AppTx, Ctx, Opened, PanelId};
use crate::images::graphics::TerminalGraphics;
use crate::panels::config::ConfigPanel;
use crate::panels::resume::ResumeList;
use crate::panels::schedules::SchedulesPanel;
use crate::panels::sign_in::SignInPanel;
use crate::panels::webhooks::WebhooksPanel;
use crate::panels::{PanelAction, PanelMsg};
use crate::protocol::{
    AttachmentMeta, ContextUsage, Role, SignInRequest, TURN_FAILED_TEXT, ThreadMode, ThreadSummary,
    TuiMessage, TurnEvent, TurnOutcome, TurnState, Viewer, now_iso,
};
use crate::status_report::{ProgramStatus, program_status_sequence};
use crate::term::input::InputParser;
use crate::term::renderer::Renderer;
use crate::term::terminal::{self, Reader, TermInput};
use crate::transcript::{ChatEntry, append_local, mark_failed, upsert_message, with_history};
use crate::ui::message_list::RowCache;
use crate::ui::render_cache::{ImageStore, MarkdownCache};
use crate::ui::spinner::INTERVAL_MS;
use crate::ui::text_input::TextInput;

/// How long to wait before asking the runtime again for this session's conversation.
const THREAD_RETRY: Duration = Duration::from_millis(2_000);
/// How long a lone Escape waits for the rest of a sequence.
const ESCAPE_FLUSH: Duration = Duration::from_millis(20);

pub enum Panel {
    Schedules(SchedulesPanel),
    Config(ConfigPanel),
    Webhooks(WebhooksPanel),
}

pub struct Options {
    pub cfg: PrismConfig,
    pub version: String,
    pub graphics: TerminalGraphics,
    pub resume: Option<(Vec<ThreadSummary>, String)>,
    /// Keys typed while the terminal answered the start-up probe.
    pub typed_early: String,
    pub interactive: bool,
}

pub struct App {
    cfg: PrismConfig,
    graphics: TerminalGraphics,
    ctx: Ctx,
    adapter: Adapter,
    reader: Option<Reader>,
    parser: InputParser,
    escape_deadline: Option<Instant>,

    entries: Vec<ChatEntry>,
    /// The `--resume` picker, until a conversation is picked.
    resume: Option<ResumeList>,
    /// A conversation was picked and its history is loading.
    resuming: bool,
    active_thread_id: Option<String>,
    status_error: Option<Option<String>>,
    last_turn: Option<TurnEvent>,
    me: Option<Viewer>,
    context_usage: Option<ContextUsage>,
    shutting_down: bool,
    composer: TextInput,
    command_index: usize,
    /// The `/attach` suggestions and the draft they were listed for, so a frame reads the
    /// directory only when the draft changes.
    path_cache: RefCell<Option<(String, Arc<Vec<PathSuggestion>>)>>,
    expanded_message_id: Option<String>,
    panel: Option<Panel>,
    sign_in: Option<SignInRequest>,
    closed_sign_in_id: Option<String>,
    sign_in_panel: Option<SignInPanel>,
    staged: Vec<AttachmentMeta>,
    history: Vec<String>,
    history_index: Option<usize>,
    compacting: bool,
    update_available: Option<String>,
    llm_provider: Option<LlmProviderStatus>,
    suspended: bool,
    spinner_frame: usize,

    images: ImageStore,
    markdown: MarkdownCache,
    rows_cache: RowCache,
    renderer: Renderer,
    program_status: String,
    columns: usize,
    rows: usize,
}

fn system_message(text: &str) -> TuiMessage {
    TuiMessage {
        id: format!("system-{}", uuid::Uuid::new_v4()),
        thread_id: String::new(),
        role: Role::System,
        content: text.to_string(),
        triggered_by: "USER_INPUT".into(),
        tool_calls: serde_json::Value::Null,
        blocks: serde_json::Value::Null,
        created_at: now_iso(),
        attachments: None,
        sender_id: None,
        sender_name: None,
        agent_message_kind: None,
    }
}

impl App {
    fn new(opts: Options, tx: AppTx, reader: Option<Reader>) -> App {
        let api = Arc::new(ApiClient::new(&opts.cfg.http_url));
        let ctx = Ctx {
            api: api.clone(),
            tx: tx.clone(),
            interactive: opts.interactive,
            open_panel: Arc::default(),
        };
        let (columns, rows) = terminal::size();
        let mut adapter = Adapter::new(api, tx);
        adapter.connect(ws_url_from_http_url(&opts.cfg.http_url), &opts.version);
        App {
            cfg: opts.cfg,
            graphics: opts.graphics,
            ctx,
            adapter,
            reader,
            parser: InputParser::new(),
            escape_deadline: None,
            entries: Vec::new(),
            resume: opts
                .resume
                .map(|(sessions, cwd)| ResumeList::new(sessions, cwd)),
            resuming: false,
            active_thread_id: None,
            status_error: None,
            last_turn: None,
            me: None,
            context_usage: None,
            shutting_down: false,
            composer: TextInput::default(),
            command_index: 0,
            path_cache: RefCell::default(),
            expanded_message_id: None,
            panel: None,
            sign_in: None,
            closed_sign_in_id: None,
            sign_in_panel: None,
            staged: Vec::new(),
            history: Vec::new(),
            history_index: None,
            compacting: false,
            update_available: None,
            llm_provider: None,
            suspended: false,
            spinner_frame: 0,
            images: ImageStore::new(),
            markdown: MarkdownCache::default(),
            rows_cache: RowCache::default(),
            renderer: Renderer::new(),
            program_status: String::new(),
            columns,
            rows,
        }
    }

    fn start(&mut self, typed_early: &str) {
        if self.resume.is_none() {
            self.open_conversation();
        }
        let ctx = self.ctx.clone();
        tokio::spawn(async move {
            // Unreachable or an older runtime: the `update` events remain the source.
            if let Ok(status) = ctx.api.update_status().await
                && status.enabled
                && status.update_available
                && let Some(version) = status.latest_version
            {
                ctx.send(AppEvent::UpdateHint(version));
            }
        });
        let ctx = self.ctx.clone();
        tokio::spawn(async move {
            // A runtime that cannot answer shows no warning; chat reports its own errors.
            if let Ok(status) = ctx.api.get_llm_provider().await {
                ctx.send(AppEvent::LlmProvider(status));
            }
        });
        if !typed_early.is_empty() {
            self.on_text(typed_early);
        }
    }

    /// Start a fresh conversation, or open the agent's one conversation in
    /// single-thread mode. A runtime that is not up yet is asked again until it answers.
    fn open_conversation(&self) {
        let ctx = self.ctx.clone();
        tokio::spawn(async move {
            let opened = async {
                match ctx.api.thread_mode().await? {
                    ThreadMode::Multi => {
                        let cwd = std::env::current_dir()
                            .unwrap_or_else(|_| PathBuf::from("."))
                            .display()
                            .to_string();
                        let thread_id = ctx.api.create_thread(&cwd).await?;
                        Some(Opened {
                            thread_id,
                            existing: false,
                            context_usage: None,
                        })
                    }
                    ThreadMode::Single => {
                        let conversation = ctx.api.list_threads().await.into_iter().next()?;
                        Some(Opened {
                            thread_id: conversation.id,
                            existing: true,
                            context_usage: conversation.context_usage,
                        })
                    }
                }
            }
            .await;
            ctx.send(AppEvent::Opened(opened));
        });
    }

    fn append_system(&mut self, text: &str) {
        append_local(&mut self.entries, system_message(text));
    }

    fn turn_state(&self) -> TurnState {
        self.last_turn
            .as_ref()
            .map(|t| t.state)
            .unwrap_or(TurnState::Idle)
    }

    fn sign_in_open(&self) -> bool {
        self.sign_in
            .as_ref()
            .is_some_and(|r| Some(&r.id) != self.closed_sign_in_id.as_ref())
    }

    fn show_sign_in(&self) -> bool {
        self.sign_in_open() && !self.suspended
    }

    // ---- the composer's popup ----

    fn slash_mode(&self) -> bool {
        let v = &self.composer.value;
        v.starts_with('/') && !v.contains(' ')
    }

    fn attach_prefix() -> String {
        format!("{ATTACH_COMMAND} ")
    }

    fn attach_mode(&self) -> bool {
        self.composer.value.starts_with(&Self::attach_prefix())
    }

    fn filtered_commands(&self) -> Vec<&'static SlashCommand> {
        if !self.slash_mode() {
            return Vec::new();
        }
        let v = &self.composer.value;
        filter_by_prefix(if v.len() == 1 { "/" } else { v })
    }

    fn path_suggestions(&self) -> Arc<Vec<PathSuggestion>> {
        if !self.attach_mode() {
            return Arc::default();
        }
        let draft = &self.composer.value;
        if let Some((value, list)) = &*self.path_cache.borrow()
            && value == draft
        {
            return list.clone();
        }
        let partial = &draft[Self::attach_prefix().len()..];
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let list = Arc::new(list_path_suggestions(partial, &cwd));
        *self.path_cache.borrow_mut() = Some((draft.clone(), list.clone()));
        list
    }

    fn popup_len(&self) -> usize {
        if self.slash_mode() {
            self.filtered_commands().len()
        } else {
            self.path_suggestions().len()
        }
    }

    fn safe_index(&self) -> usize {
        let len = self.popup_len();
        if len == 0 {
            0
        } else {
            self.command_index.min(len - 1)
        }
    }

    /// Keep the popup's selection inside the list as it shrinks.
    fn clamp_command_index(&mut self) {
        if self.command_index >= self.popup_len() {
            self.command_index = 0;
        }
    }

    // ---- events ----

    fn handle(&mut self, event: AppEvent) {
        match event {
            AppEvent::Term(TermInput::Text(text)) => self.on_text(&text),
            AppEvent::Term(TermInput::Resize) => self.on_resize(),
            AppEvent::FlushEscape => {
                self.escape_deadline = None;
                if let Some(pending) = self.parser.flush_pending_escape() {
                    self.on_input_event(&pending);
                }
            }
            AppEvent::Ws(e) => {
                let outs = self.adapter.on_ws(e);
                self.apply_outs(outs);
            }
            AppEvent::Opened(None) => {
                let tx = self.ctx.tx.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(THREAD_RETRY).await;
                    let _ = tx.send(AppEvent::RetryOpen);
                });
            }
            AppEvent::RetryOpen => self.open_conversation(),
            AppEvent::Opened(Some(opened)) => {
                if opened.existing {
                    if let Some(usage) = opened.context_usage {
                        self.context_usage = Some(usage);
                    }
                    let outs = self.adapter.resume_thread(&opened.thread_id);
                    self.apply_outs(outs);
                } else {
                    self.adapter.adopt(&opened.thread_id);
                }
                self.active_thread_id = Some(opened.thread_id);
            }
            AppEvent::History {
                generation,
                messages,
            } => {
                let outs = self.adapter.on_history(generation, messages);
                self.apply_outs(outs);
            }
            AppEvent::System(text) => {
                if !text.is_empty() {
                    self.append_system(&text);
                }
            }
            AppEvent::SendMessage(text) => self.send_message(text, Vec::new()),
            AppEvent::OpenPanel(id) => {
                self.ctx.open_panel.fetch_add(1, Ordering::Relaxed);
                self.panel = Some(match id {
                    PanelId::Schedules => Panel::Schedules(SchedulesPanel::open(&self.ctx)),
                    PanelId::Config => Panel::Config(ConfigPanel::open(&self.ctx)),
                    PanelId::Webhooks => Panel::Webhooks(WebhooksPanel::open(&self.ctx)),
                });
            }
            AppEvent::Stage(att) => self.staged.push(att),
            AppEvent::ClearStaged => self.staged.clear(),
            AppEvent::Shutdown => self.shutting_down = true,
            AppEvent::Panel(panel, msg) => self.on_panel_msg(panel, msg),
            AppEvent::Suspend(ack) => {
                self.suspended = true;
                self.sign_in_panel = None;
                let mut out = String::new();
                self.renderer.clear(&mut out);
                out.push_str(terminal::SHOW_CURSOR);
                terminal::write(&out);
                if let Some(r) = &self.reader {
                    r.pause();
                }
                terminal::disable_raw();
                let _ = ack.send(());
            }
            AppEvent::Resume(ack) => {
                terminal::enable_raw();
                if let Some(r) = &self.reader {
                    r.resume();
                }
                terminal::write(terminal::HIDE_CURSOR);
                self.suspended = false;
                let _ = ack.send(());
            }
            AppEvent::UpdateHint(version) => self.update_available = Some(version),
            AppEvent::LlmProvider(status) => self.llm_provider = Some(status),
            AppEvent::ImageLoaded { id, bitmap } => self.images.loaded(id, bitmap),
            AppEvent::SpinnerTick => self.spinner_frame = self.spinner_frame.wrapping_add(1),
        }
    }

    fn on_resize(&mut self) {
        let (columns, rows) = terminal::size();
        // A narrower terminal reflows what is on screen, so the frame is erased and drawn again.
        if columns < self.columns {
            let mut out = String::new();
            self.renderer.clear(&mut out);
            terminal::write(&out);
        }
        self.columns = columns;
        self.rows = rows;
    }

    fn on_text(&mut self, text: &str) {
        self.escape_deadline = None;
        for event in self.parser.push(text) {
            self.on_input_event(&event);
        }
        if self.parser.has_pending_escape() {
            self.escape_deadline = Some(Instant::now() + ESCAPE_FLUSH);
        }
    }

    fn on_panel_msg(&mut self, panel: u64, msg: PanelMsg) {
        let ctx = self.ctx.clone();
        // A result for a panel that has closed since its request started is dropped.
        let current = panel == ctx.open_panel.load(Ordering::Relaxed);
        match (msg, &mut self.panel) {
            (PanelMsg::Schedules(_) | PanelMsg::Config(_) | PanelMsg::Webhooks(_), _)
                if !current => {}
            (PanelMsg::Schedules(m), Some(Panel::Schedules(p))) => p.on_msg(m, &ctx),
            (PanelMsg::Config(m), Some(Panel::Config(p))) => p.on_msg(m),
            (PanelMsg::Webhooks(m), Some(Panel::Webhooks(p))) => p.on_msg(m),
            (PanelMsg::SignIn(m), _) => {
                if let Some(p) = &mut self.sign_in_panel
                    && p.on_msg(m) == PanelAction::Close
                {
                    self.close_sign_in();
                }
            }
            _ => {}
        }
    }

    fn close_sign_in(&mut self) {
        self.closed_sign_in_id = self.sign_in.as_ref().map(|r| r.id.clone());
        self.sign_in_panel = None;
    }

    fn close_panel(&mut self) {
        self.panel = None;
        let value = self.composer.value.clone();
        self.composer.reset(&value);
    }

    fn apply_outs(&mut self, outs: Vec<Out>) {
        for out in outs {
            match out {
                Out::Status(detail) => self.status_error = detail.map(Some),
                Out::Welcome(you) => self.me = Some(you),
                Out::History(messages) => self.entries = with_history(&self.entries, messages),
                Out::Message(msg) => upsert_message(&mut self.entries, msg),
                Out::Turn(turn) => self.on_turn(turn),
                Out::SendFailed {
                    message_id,
                    message,
                } => mark_failed(&mut self.entries, &message_id, &message),
                Out::ContextUsage(usage) => self.context_usage = Some(usage),
                Out::Compaction(event) => {
                    self.compacting = event.status == "started";
                    match event.status.as_str() {
                        "completed" => {
                            let n = event.messages_compacted.unwrap_or(0.0);
                            let when = if event.idle { " while idle" } else { "" };
                            let plural = if n == 1.0 { "" } else { "s" };
                            self.append_system(&format!(
                                "Conversation compacted{when} — {} older message{plural} summarized.",
                                crate::util::js_number(n)
                            ));
                        }
                        "skipped" if event.trigger == "manual" => {
                            let text = event
                                .detail
                                .unwrap_or_else(|| "Nothing to compact yet.".into());
                            self.append_system(&text);
                        }
                        "failed" if event.trigger == "manual" => {
                            let text = format!(
                                "Compaction failed: {}",
                                event.error.unwrap_or_else(|| "unknown error".into())
                            );
                            self.append_system(&text);
                        }
                        _ => {}
                    }
                }
                Out::Update(u) => match u.status.as_str() {
                    "available" => self.update_available = Some(u.version),
                    "updating" => {
                        self.update_available = None;
                        self.append_system(&format!(
                            "Backend updating to {} — reconnecting when it's back…",
                            u.version
                        ));
                    }
                    "failed" => {
                        let code = u.error_code.unwrap_or_else(|| "unknown error".into());
                        self.append_system(&format!("Update to {} failed ({code}).", u.version));
                    }
                    _ => {}
                },
                Out::SignIn(request) => self.sign_in = Some(request),
                Out::SignInEnded(id) => {
                    if self.sign_in.as_ref().is_some_and(|r| r.id == id) {
                        self.sign_in = None;
                        self.sign_in_panel = None;
                    }
                }
                Out::Unsupported(notice) => self.append_system(&notice),
                Out::Resynced => {
                    if self.resuming {
                        self.resuming = false;
                        self.resume = None;
                    }
                }
            }
        }
    }

    fn on_turn(&mut self, turn: TurnEvent) {
        // Each reconnect restates an idle conversation without an outcome, which keeps
        // how its last turn ended.
        let keep = turn.state == TurnState::Idle
            && turn.outcome.is_none()
            && self
                .last_turn
                .as_ref()
                .is_some_and(|t| t.state == TurnState::Idle);
        let outcome = turn.outcome;
        let error = turn.error.clone();
        if !keep {
            self.last_turn = Some(turn);
        }
        match outcome {
            Some(TurnOutcome::Cancelled) => self.append_system("⏹ Response stopped"),
            Some(TurnOutcome::Failed) => {
                let text = format!("⚠ {}", error.unwrap_or_else(|| TURN_FAILED_TEXT.into()));
                self.append_system(&text);
            }
            _ => {}
        }
    }

    /// Drawn at once under the id it is sent with. The runtime's copy arrives with
    /// the same id and takes this row's place.
    fn send_message(&mut self, text: String, attachments: Vec<AttachmentMeta>) {
        let id = uuid::Uuid::new_v4().to_string();
        let ids: Vec<String> = attachments.iter().map(|a| a.id.clone()).collect();
        let mut msg = system_message(&text);
        msg.id = id.clone();
        msg.thread_id = self.active_thread_id.clone().unwrap_or_default();
        msg.role = Role::User;
        msg.attachments = if attachments.is_empty() {
            None
        } else {
            Some(attachments)
        };
        append_local(&mut self.entries, msg);
        self.adapter.submit(id, text, ids);
    }

    fn program_status(&self) -> ProgramStatus {
        if let Some(request) = &self.sign_in {
            return ProgramStatus::BlockedAuth(request.reason.clone());
        }
        let turn = self.last_turn.as_ref();
        match turn.map(|t| t.state) {
            Some(TurnState::Running) => return ProgramStatus::Working("Thinking".into()),
            Some(TurnState::Queued) => {
                return ProgramStatus::Working("Waiting for another conversation to finish".into());
            }
            _ => {}
        }
        if self.compacting {
            return ProgramStatus::Working("Compacting the conversation".into());
        }
        match turn.and_then(|t| t.outcome) {
            Some(TurnOutcome::Completed) => ProgramStatus::Done("Reply ready".into()),
            Some(TurnOutcome::Failed) => ProgramStatus::Error(
                turn.and_then(|t| t.error.clone())
                    .unwrap_or_else(|| TURN_FAILED_TEXT.into()),
            ),
            _ => ProgramStatus::Idle,
        }
    }

    /// A spinner is on screen.
    fn spinning(&self) -> bool {
        if self.shutting_down || self.suspended || self.resume.is_some() {
            return false;
        }
        if let Some(panel) = &self.panel {
            if self.show_sign_in() {
                return false;
            }
            return match panel {
                Panel::Schedules(p) => p.busy(),
                Panel::Config(p) => p.busy(),
                Panel::Webhooks(p) => p.busy(),
            };
        }
        !self.show_sign_in() && (self.turn_state() != TurnState::Idle || self.compacting)
    }

    fn render(&mut self) {
        if self.show_sign_in()
            && self.sign_in_panel.is_none()
            && let Some(request) = &self.sign_in
        {
            self.sign_in_panel = Some(SignInPanel::new(request));
        }
        if !self.show_sign_in() {
            self.sign_in_panel = None;
        }
        let mut out = String::new();
        if terminal::stdout_is_tty() {
            let sequence = program_status_sequence(&self.program_status());
            if sequence != self.program_status {
                out.push_str(&sequence);
                self.program_status = sequence;
            }
        }
        let lines = self.frame();
        for attachment in self.images.take_wanted() {
            let ctx = self.ctx.clone();
            tokio::spawn(async move {
                let bitmap = match ctx.api.download_attachment(&attachment.id).await {
                    Ok(bytes) => {
                        let media_type = attachment.media_type.clone();
                        tokio::task::spawn_blocking(move || {
                            crate::images::decode::decode_image(&bytes, &media_type).ok()
                        })
                        .await
                        .ok()
                        .flatten()
                        .map(Arc::new)
                    }
                    Err(_) => None,
                };
                ctx.send(AppEvent::ImageLoaded {
                    id: attachment.id,
                    bitmap,
                });
            });
        }
        if !self.suspended {
            out.push_str(&self.images.take_transmissions());
            self.renderer.render(&lines, self.rows, &mut out);
        }
        terminal::write(&out);
    }

    fn finish(&mut self) {
        let mut out = String::new();
        self.renderer.release(&mut out);
        out.push_str(terminal::SHOW_CURSOR);
        if terminal::stdout_is_tty() {
            out.push_str(&program_status_sequence(&ProgramStatus::Clear));
        }
        terminal::write(&out);
        self.adapter.disconnect();
    }
}

/// Run the chat session until it shuts down. Returns the exit code.
pub async fn run(
    opts: Options,
    reader: Option<Reader>,
    mut term_rx: mpsc::UnboundedReceiver<TermInput>,
) -> i32 {
    let (tx, mut rx) = mpsc::unbounded_channel::<AppEvent>();
    let typed_early = opts.typed_early.clone();
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            while let Some(input) = term_rx.recv().await {
                if tx.send(AppEvent::Term(input)).is_err() {
                    return;
                }
            }
        });
    }
    #[cfg(unix)]
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let Ok(mut winch) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())
            else {
                return;
            };
            while winch.recv().await.is_some() {
                let _ = tx.send(AppEvent::Term(TermInput::Resize));
            }
        });
    }
    let mut app = App::new(opts, tx.clone(), reader);
    terminal::write(terminal::HIDE_CURSOR);
    app.start(&typed_early);
    app.render();
    let mut next_tick = Instant::now() + Duration::from_millis(INTERVAL_MS);
    loop {
        let spinning = app.spinning();
        let escape_at = app.escape_deadline;
        let event = tokio::select! {
            ev = rx.recv() => match ev {
                Some(ev) => ev,
                None => break,
            },
            _ = sleep_until(next_tick), if spinning => {
                next_tick = Instant::now() + Duration::from_millis(INTERVAL_MS);
                AppEvent::SpinnerTick
            }
            _ = sleep_until(escape_at.unwrap_or_else(Instant::now)), if escape_at.is_some() => AppEvent::FlushEscape,
        };
        if !spinning {
            next_tick = Instant::now() + Duration::from_millis(INTERVAL_MS);
        }
        app.handle(event);
        while let Ok(ev) = rx.try_recv() {
            app.handle(ev);
        }
        app.render();
        if app.shutting_down {
            break;
        }
    }
    app.finish();
    0
}
