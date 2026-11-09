//! Agent Runtime Entry Point
//!
//! On startup:
//! 1. Start the HTTP server
//! 2. Resolve (or bootstrap) the single AgentWorkspace row
//! 3. Start heartbeat timers and schedule cron tasks
//!
//! On shutdown:
//! - Stop all heartbeats, cron jobs, sessions, queues
//!
//! Pending `.prism` imports are applied by `scripts::apply_pending_import` before
//! this process opens the database.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use diesel::prelude::*;
use futures::FutureExt;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

use crate::config::{CONFIG, ThreadMode, ToolSearchMode};
use crate::db::models::{AgentStatus, AgentWorkspaceChangeset, ConversationMessage, ThreadSource};
use crate::db::schema::agent_workspaces;
use crate::lib::attachment_boot::reconcile_attachment_storage;
use crate::lib::coding_agents::availability::ensure_coding_agents_detected;
use crate::lib::coding_agents::get_coding_agent::get_coding_agent;
use crate::lib::coding_agents::subscription_switch::load_subscription_switches;
use crate::lib::data_dir::ensure_data_dirs;
use crate::lib::environment::DOTENV_LOAD_INFO;
use crate::lib::execution_environments::get_execution_environment::{
    ensure_execution_environment_detected, get_execution_environment,
};
use crate::lib::execution_environments::storage_migration::migrate_storage_if_environment_changed;
use crate::lib::file_janitor::start_file_janitor;
use crate::lib::langfuse::{init_langfuse, shutdown_langfuse};
use crate::lib::llm_providers::create_provider::{create_provider, missing_provider_settings};
use crate::lib::log_redaction::err_json;
use crate::lib::mcp_client::close_mcp_clients;
use crate::lib::model_catalog::{cancel_model_catalog_refresh, refresh_model_catalog};
use crate::lib::single_agent_bootstrap::resolve_or_bootstrap_single_agent;
use crate::lib::startup_telemetry::{TrackAgentStartedOptions, track_agent_started};
use crate::lib::telemetry::{init_telemetry, shutdown_telemetry};
use crate::lib::tool_collection::init_meeting_tool_availability;
use crate::queues::slack_heartbeat_throttle_queue::get_slack_heartbeat_throttle_queue;
use crate::scripts::backfill_embeddings::run_backfill;
use crate::server::{
    ServerHandle, create_agent_messages_server, create_app, listen_for_agent_messages, listen_on,
    spawn_server,
};
use crate::services::channel_adapter_interface::{
    ChannelAdapter, ChannelContext, ChannelDestination, ChannelName, DefaultDestination,
    DeliverableMessage, LinkedTarget, PostedMessage,
};
use crate::services::compaction_service::COMPACTION_SERVICE;
use crate::services::computer::computer_endpoint::COMPUTER_ENDPOINT;
use crate::services::computer::computer_service::COMPUTER_SERVICE;
use crate::services::computer::remote::computer_link_endpoint::COMPUTER_LINK_ENDPOINT;
use crate::services::computer::remote::remote_computer_service::REMOTE_COMPUTER_SERVICE;
use crate::services::computer::supported::init_computer_availability;
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::cron_scheduler_service::{
    CRON_SCHEDULER_SERVICE, ScheduleSource, ScheduleTaskOptions,
};
use crate::services::goal_service::GOAL_SERVICE;
use crate::services::heartbeat_service::{HEARTBEAT_SERVICE, HeartbeatSchedule};
use crate::services::inbound_message_service::INBOUND_MESSAGE_SERVICE;
use crate::services::meeting::meeting_bot_service::MEETING_BOT_SERVICE;
use crate::services::message_delivery_service::MESSAGE_DELIVERY_SERVICE;
use crate::services::pending_work_service::{
    PENDING_WORK_SERVICE, PendingWorkKind, PendingWorkResumer,
};
use crate::services::plugin_catalog_service::PLUGIN_CATALOG_SERVICE;
use crate::services::plugin_mcp_service::PLUGIN_MCP_SERVICE;
use crate::services::program_status_service::PROGRAM_STATUS_SERVICE;
use crate::services::providers::slack_thread_provider::SlackThreadProvider;
use crate::services::resume_replies::resume_replies;
use crate::services::session_manager_service::SESSION_MANAGER_SERVICE;
use crate::services::slack_adapter_service::SLACK_ADAPTER_SERVICE;
use crate::services::slack_message_queue_service::SLACK_MESSAGE_QUEUE_SERVICE;
use crate::services::teams::teams_adapter_service::TEAMS_ADAPTER_SERVICE;
use crate::services::update::update_service::UPDATE_SERVICE;
use crate::services::voice::voice_chat_service::VOICE_CHAT_SERVICE;
use crate::services::webhook_receiver_service::WEBHOOK_RECEIVER_SERVICE;
use crate::services::webhook_service::WEBHOOK_SERVICE;
use crate::services::websocket_adapter_service::WEB_SOCKET_ADAPTER_SERVICE;
use crate::services::websocket_gateway_service::WEB_SOCKET_GATEWAY_SERVICE;
use crate::support::js;
use crate::tools::shell::agent_task_manager::get_agent_task_manager;
use crate::tools::shell::process_manager::get_process_manager;
use crate::types::ResumedReply;
use crate::{log_error, log_info, log_warn};

/// The file janitor's hourly sweep, stopped by the shutdown.
static FILE_JANITOR: LazyLock<Mutex<Option<JoinHandle<()>>>> = LazyLock::new(|| Mutex::new(None));

/// The process entry. Loads `.env` before any thread starts (it writes the
/// environment), builds the configuration, applies the database migrations the
/// file does not have yet, and runs the runtime on a multi-threaded async runtime
/// until it shuts down.
pub fn main() {
    LazyLock::force(&DOTENV_LOAD_INFO);
    LazyLock::force(&CONFIG);
    log_dotenv_load();

    // Before anything reads the database.
    match crate::db::run_sync(|conn| crate::db::migrate(conn)) {
        Ok(applied) if !applied.is_empty() => {
            eprintln!("[prism-server] applied {} migration(s)", applied.len());
        }
        Ok(_) => {}
        Err(err) => {
            eprintln!("[prism-server] fatal startup error {err:#}");
            std::process::exit(1);
        }
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("Error: {err}");
            std::process::exit(1);
        }
    };
    let code = runtime.block_on(start());
    std::process::exit(code);
}

/// The `.env` load summary, as the first log line of a boot.
fn log_dotenv_load() {
    let info = &*DOTENV_LOAD_INFO;
    match &info.error {
        Some(err) => log_warn!(
            json!({ "err": err_json(err), "path": info.path }),
            "[dotenv] failed to load .env"
        ),
        None => log_info!(
            "[dotenv] injected {} env var(s) from {}",
            info.loaded_count,
            info.path
        ),
    }
}

/// A channel adapter that lives in a static, registered by reference.
struct StaticAdapter(&'static dyn ChannelAdapter);

#[async_trait]
impl ChannelAdapter for StaticAdapter {
    fn name(&self) -> ChannelName {
        self.0.name()
    }

    fn shows_whole_conversation(&self) -> bool {
        self.0.shows_whole_conversation()
    }

    fn opens_web_ui_links(&self) -> bool {
        self.0.opens_web_ui_links()
    }

    async fn thread_destination(
        &self,
        thread_id: &str,
        origin_channel_id: Option<&str>,
    ) -> Option<anyhow::Result<ChannelDestination>> {
        self.0
            .thread_destination(thread_id, origin_channel_id)
            .await
    }

    async fn default_destination(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> Option<anyhow::Result<Option<DefaultDestination>>> {
        self.0.default_destination(agent_id, user_id).await
    }

    fn continue_reply(&self, message: &ConversationMessage, resumed: &ResumedReply) -> Option<()> {
        self.0.continue_reply(message, resumed)
    }

    async fn linked_channel_ids(&self, agent_id: &str) -> Option<anyhow::Result<Vec<String>>> {
        self.0.linked_channel_ids(agent_id).await
    }

    async fn deliver(
        &self,
        user_id: &str,
        message: &DeliverableMessage,
        channel_context: Option<&ChannelContext>,
    ) -> anyhow::Result<()> {
        self.0.deliver(user_id, message, channel_context).await
    }

    async fn is_user_connected(&self, user_id: &str) -> anyhow::Result<bool> {
        self.0.is_user_connected(user_id).await
    }

    fn display_name(&self) -> Option<&str> {
        self.0.display_name()
    }

    async fn list_linked_targets(
        &self,
        agent_id: &str,
    ) -> Option<anyhow::Result<Vec<LinkedTarget>>> {
        self.0.list_linked_targets(agent_id).await
    }

    async fn post_to_target(
        &self,
        target: &LinkedTarget,
        text: &str,
        thread: Option<&str>,
    ) -> Option<anyhow::Result<PostedMessage>> {
        self.0.post_to_target(target, text, thread).await
    }

    async fn initialize(&self) -> anyhow::Result<()> {
        self.0.initialize().await
    }

    async fn shutdown(&self) -> anyhow::Result<()> {
        self.0.shutdown().await
    }
}

/// The listeners the shutdown closes.
struct Servers {
    api: ServerHandle,
    agent_messages: Option<ServerHandle>,
}

/// Everything the TypeScript entry did at module load, in order, then the boot,
/// the listeners and the signal handlers.
async fn start() -> i32 {
    // Initialize Langfuse tracing before any LLM calls
    init_langfuse();

    // Initialize product telemetry (OTEL Logs → Collector → S3)
    init_telemetry();

    // Refresh the model-window catalog in the background; lookups use the bundle until it lands.
    tokio::spawn(refresh_model_catalog());

    let app = create_app();
    // Other agents' messages, on a port of their own (`AGENT_MESSAGES_PORT`), and
    // only when `AGENT_MESSAGES_TOKEN_ID` says who may deliver them.
    let agent_messages_app = create_agent_messages_server();

    // Register channel adapters for unified message delivery.
    // Must be registered BEFORE the server starts accepting connections.
    MESSAGE_DELIVERY_SERVICE.register(Arc::new(StaticAdapter(&*WEB_SOCKET_ADAPTER_SERVICE)));
    MESSAGE_DELIVERY_SERVICE.register(Arc::new(StaticAdapter(&*SLACK_ADAPTER_SERVICE)));
    MESSAGE_DELIVERY_SERVICE.register(Arc::new(StaticAdapter(&*TEAMS_ADAPTER_SERVICE)));
    CONVERSATION_SERVICE
        .register_thread_provider(ThreadSource::Slack, Arc::new(SlackThreadProvider::new()));
    HEARTBEAT_SERVICE.register_trigger_source(SLACK_MESSAGE_QUEUE_SERVICE.clone());
    // Its subscriptions are made at construction, before the first turn.
    LazyLock::force(&INBOUND_MESSAGE_SERVICE);

    // Initialize the WebSocket endpoints before listening.
    WEB_SOCKET_GATEWAY_SERVICE.initialize();
    COMPUTER_ENDPOINT.initialize();
    COMPUTER_LINK_ENDPOINT.initialize();

    let servers = match get_server(app, agent_messages_app).await {
        Ok(servers) => Arc::new(Mutex::new(Some(servers))),
        Err(err) => {
            log_error!("Failed to start server: {}", err);
            return 1;
        }
    };

    wait_for_signals(servers).await;
    0
}

/// Boot, then open the listeners.
async fn get_server(
    app: axum::Router,
    agent_messages_app: Option<axum::Router>,
) -> anyhow::Result<Servers> {
    if let Err(err) = initialize().await {
        log_error!("Failed to initialize services: {}", err);
        // Fail loudly — there's nothing to fall back to and lazy init would mask
        // config errors (missing AGENT_ID, invalid SLACK_BOT_TOKEN, etc.).
        std::process::exit(1);
    }

    WEBHOOK_RECEIVER_SERVICE.initialize().await?;
    let listener = listen_on().await?;
    let api = spawn_server(listener, app);
    let agent_messages = match agent_messages_app {
        Some(app) => listen_for_agent_messages(app).await,
        None => {
            log_info!(
                "[AgentMessages] AGENT_MESSAGES_TOKEN_ID is not set, so the agent-messages port stays closed"
            );
            None
        }
    };
    Ok(Servers {
        api,
        agent_messages,
    })
}

/// SIGTERM, SIGINT and SIGHUP each start the shutdown. A closed terminal on a host
/// install sends SIGHUP: without a handler the process ends at once, and the exit
/// hooks that stop the agent's own processes never run. Off Unix, Ctrl+C is the
/// one signal.
async fn wait_for_signals(servers: Arc<Mutex<Option<Servers>>>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let kinds = [
            (SignalKind::terminate(), "SIGTERM"),
            (SignalKind::interrupt(), "SIGINT"),
            (SignalKind::hangup(), "SIGHUP"),
        ];
        let mut streams = Vec::new();
        for (kind, name) in kinds {
            match signal(kind) {
                Ok(stream) => streams.push((stream, name)),
                Err(err) => log_warn!("Cannot listen for {}: {}", name, err),
            }
        }
        loop {
            let received =
                futures::future::select_all(streams.iter_mut().map(|(stream, name)| {
                    async move { stream.recv().await.map(|_| *name) }.boxed()
                }))
                .await
                .0;
            let Some(name) = received else {
                return;
            };
            tokio::spawn(shutdown(name, Arc::clone(&servers)));
        }
    }
    #[cfg(not(unix))]
    {
        loop {
            if tokio::signal::ctrl_c().await.is_err() {
                return;
            }
            tokio::spawn(shutdown("SIGINT", Arc::clone(&servers)));
        }
    }
}

/// The resume step of each kind of pending work.
fn resumers() -> HashMap<PendingWorkKind, PendingWorkResumer> {
    let mut resumers: HashMap<PendingWorkKind, PendingWorkResumer> = HashMap::new();
    resumers.insert(
        PendingWorkKind::Chat,
        Arc::new(|items, _given_up| resume_replies(items).boxed()),
    );
    resumers.insert(
        PendingWorkKind::Webhook,
        Arc::new(|items, _given_up| WEBHOOK_SERVICE.resume(items).boxed()),
    );
    resumers.insert(
        PendingWorkKind::CodingTask,
        Arc::new(|items, given_up| {
            async move {
                get_agent_task_manager().resume(items, given_up).await;
                Ok(())
            }
            .boxed()
        }),
    );
    resumers.insert(
        PendingWorkKind::Cron,
        Arc::new(|items, given_up| CRON_SCHEDULER_SERVICE.resume(items, given_up).boxed()),
    );
    resumers.insert(
        PendingWorkKind::Heartbeat,
        Arc::new(|items, given_up| HEARTBEAT_SERVICE.resume(items, given_up).boxed()),
    );
    resumers
}

/// The boot: data dirs, the shell workspace, the execution environment and its
/// storage, the coding agents, the plugins, attachment storage, the provider line
/// and the startup warnings, the single agent, the interrupted work, the channel
/// adapters, the resumed work, heartbeat, cron, goals, idle compaction, sessions,
/// the updater, the throttle queue, the file janitor and the embedding backfill.
async fn initialize() -> anyhow::Result<()> {
    // The data dirs come first: an execution environment that isolates the agent
    // has to mount them, and a mount whose host path does not exist yet is one the
    // engine invents as a root-owned directory.
    let dirs = ensure_data_dirs()?;
    if let Some(fell_back_from) = &dirs.fell_back_from {
        log_warn!(
            "[Startup] data dir {} is not usable; falling back to {}. Set PRISM_DATA_DIR to choose another.",
            fell_back_from,
            dirs.data_dir
        );
    }
    log_info!("[Startup] skills dir: {}", dirs.skills_dir);

    // Ensure the shell tools' workspace dir exists before any invocation can spawn
    // a command there — a missing cwd surfaces as a spawn ENOENT, which masquerades
    // as a missing shell. It is a host directory in either environment, so it is
    // made before one is chosen.
    let ws = get_execution_environment().prepare_workspace();
    match &ws.fell_back_from {
        Some(fell_back_from) => log_warn!(
            "[Startup] shell workspace {} is not usable; falling back to {}. Set SHELL_WORKSPACE_ROOT to choose another.",
            fell_back_from,
            ws.root
        ),
        None => log_info!("[Startup] shell workspace: {}", ws.root),
    }

    // Where the agent's commands run. Derived, not configured — and it reports
    // itself, including when it wanted a container and could not have one.
    ensure_execution_environment_detected().await?;

    // Before anything reads the agent's directories: the two environments keep them
    // in different places, so a deployment that has moved between them finds empty
    // storage until its files are brought across.
    migrate_storage_if_environment_changed().await;

    // Which agents have credentials is a question for the execution environment, so
    // it is asked here — after the line above, so it is asked of the environment
    // that won.
    ensure_coding_agents_detected().await;
    load_subscription_switches().await;
    for name in CONFIG.available_coding_agents() {
        let coding_agent = get_coding_agent(Some(name))?;
        let home = coding_agent.prepare_home().await?;
        let mut fields = Map::new();
        fields.insert(
            "agent".to_string(),
            Value::String(name.as_str().to_string()),
        );
        if let Value::Object(home) = serde_json::to_value(&home)? {
            fields.extend(home);
        }
        log_info!(Value::Object(fields), "[Startup] coding agent");
    }
    // Scanning here also surfaces any malformed plugin's warning at boot rather than
    // on whichever turn first happens to build a system prompt.
    let plugins_dir = get_execution_environment().paths().plugins_dir;
    let installed = PLUGIN_CATALOG_SERVICE.get_plugins().await.len();
    log_info!(
        "[Startup] plugins dir: {} ({} installed)",
        plugins_dir,
        installed
    );

    // Bring the attachment rows and the media dir back into agreement (missing
    // files, over-TTL content, legacy BLOBs) before anything can serve them.
    reconcile_attachment_storage(&dirs.media_dir).await;

    // The provider answers for prompt caching, and only a vendor whose answer varies
    // by model declares the member at all — so the field is absent for a vendor that
    // has nothing to say, and no vendor is named here.
    let provider = create_provider();
    log_provider(&provider);
    let missing_settings = missing_provider_settings();
    if !missing_settings.is_empty() {
        log_warn!(
            json!({ "provider": CONFIG.llm_provider.as_str(), "missingSettings": missing_settings }),
            "[Startup] the LLM provider is missing settings; chat answers with a notice until they are set"
        );
    }
    // Not awaited: a check that waits on the network must not hold up boot.
    if let Some(check) = provider.startup_check.clone() {
        tokio::spawn(check());
    }

    log_config_warnings();

    // AGENT_ID is optional — when unset, the bootstrap either picks up the existing
    // row or creates a fresh one with a generated UUID. Auth is handled by Lens
    // Agents inbound routing in front of the runtime; the container itself trusts
    // every incoming connection.
    log_info!(
        json!({ "agentId": CONFIG.agent_id().unwrap_or_else(|| "<unset, will resolve>".to_string()) }),
        "[Startup] resolving agent workspace"
    );
    let agent = resolve_or_bootstrap_single_agent().await?;
    // Chosen, and created if need be, before any work or request can name a thread,
    // so two first requests never make two.
    if CONFIG.thread_mode == ThreadMode::Single {
        let thread = CONVERSATION_SERVICE
            .get_or_create_latest_thread(&agent.id, &agent.user_id)
            .await?;
        log_info!(
            json!({ "threadId": thread.id }),
            "[Startup] single-thread mode"
        );
    } else {
        CONVERSATION_SERVICE.forget_single_thread().await?;
    }
    // Before any turn, since the tools a turn gets depend on whether remote computers exist.
    REMOTE_COMPUTER_SERVICE.load(&agent.id).await?;

    // Clear stale RUNNING status from previous process crashes.
    let agent_id = agent.id.clone();
    crate::db::run(move |conn| {
        let changes = AgentWorkspaceChangeset {
            status: Some(AgentStatus::Idle),
            ..AgentWorkspaceChangeset::default()
        };
        diesel::update(
            agent_workspaces::table
                .filter(agent_workspaces::id.eq(&agent_id))
                .filter(agent_workspaces::status.eq(AgentStatus::Running)),
        )
        .set(&changes)
        .execute(conn)?;
        Ok(())
    })
    .await?;

    // Before any work starts, resumed work included, so its first turns are reported.
    PROGRAM_STATUS_SERVICE.start(&agent.id, &agent.user_id);

    // Probe for the voice-meeting toolchain once, here rather than per turn, and
    // before any work can start: the tools block must stay byte-identical across
    // requests for the provider's prompt cache to hit, a resumed turn's included.
    if let Some(reason) = &CONFIG.realtime_unavailable_reason {
        log_info!(json!({ "reason": reason }), "Voice is not configured");
    }
    if init_meeting_tool_availability().await {
        log_info!(
            "Voice meetings available (browser + audio toolchain and Realtime credential present)"
        );
    } else {
        log_info!("Voice meetings unavailable — meeting tools not registered");
    }

    // The same question for the agent's own computer, which needs a desktop on top
    // of that toolchain. The Web UI reads the answer and leaves its Computer page out
    // where it is no.
    if init_computer_availability().await {
        log_info!("The agent's computer is available (desktop packages present)");
    } else {
        log_info!("The agent's computer is unavailable — the Computer page is not offered");
    }

    // Read before the channels connect, so a message that arrives during the boot is
    // new work and never also resumed.
    let interrupted = PENDING_WORK_SERVICE.interrupted().await?;

    // The channels connect before any work starts, so work that delivers at once — a
    // resumed reply, an overdue check — finds them ready.
    MESSAGE_DELIVERY_SERVICE.initialize_all().await;

    // Continue the work a restart interrupted. Each kind's owner gets its rows back
    // and schedules the work; none of it holds up the boot.
    PENDING_WORK_SERVICE
        .resume_all(interrupted, resumers())
        .await;

    // Boot keeps the schedule the last run set, so a restart cannot defer a check,
    // and an overdue one runs promptly.
    HEARTBEAT_SERVICE.start_heartbeat(&agent, HeartbeatSchedule::KeepSchedule);
    log_info!("Heartbeat started");
    HEARTBEAT_SERVICE.answer_pending_triggers().await?;

    // Recurring schedules are read in the agent's time zone.
    CRON_SCHEDULER_SERVICE.use_timezone(&agent.timezone);
    let cron_tasks = CRON_SCHEDULER_SERVICE
        .list_active_cron_tasks(Some(&agent.id))
        .await?;
    let cron_count = cron_tasks.len();
    for task in cron_tasks {
        // Boot re-registration of existing tasks — not a new schedule, so no
        // 'cron task scheduled' telemetry.
        CRON_SCHEDULER_SERVICE.schedule_task(
            task,
            ScheduleTaskOptions {
                source: Some(ScheduleSource::Boot),
                ..ScheduleTaskOptions::default()
            },
        );
    }
    log_info!("Cron tasks scheduled: {}", cron_count);

    // Product telemetry: the boot census. Best-effort; never fails.
    track_agent_started(
        &agent,
        TrackAgentStartedOptions {
            cron_tasks: cron_count,
        },
    )
    .await;

    // Resume any goal that was still active when the process last stopped.
    GOAL_SERVICE.restore_active_goals(&agent.id).await?;

    // Re-arm the idle compactions the restart dropped; best effort, a failure only
    // leaves a conversation to its next turn.
    tokio::spawn(async {
        if let Err(err) = COMPACTION_SERVICE.restore_idle().await {
            log_warn!(
                json!({ "err": err_json(&err) }),
                "[Compaction] could not restore idle compactions"
            );
        }
    });

    SESSION_MANAGER_SERVICE.initialize().await;
    log_info!("Session manager initialized");

    // Resolve any update attempt left pending by a previous process (the restart
    // sentinel), then start the check loop where the install allows self-update.
    UPDATE_SERVICE.start().await?;

    get_slack_heartbeat_throttle_queue().start().await;

    // Sweep abandoned uploads, scratch dirs, expired content, stray media files and
    // expired saved tool outputs now, then hourly.
    *FILE_JANITOR.lock() = Some(start_file_janitor().await);

    // Embed the memory entries that have no vector yet. In-process and best-effort:
    // it never blocks startup, and a failure costs a log line.
    tokio::spawn(async {
        if let Err(err) = run_backfill().await {
            log_warn!(
                json!({ "err": err_json(&err) }),
                "[Startup] embedding backfill failed"
            );
        }
    });
    Ok(())
}

/// The active LLM provider and routing, so the deployed vendor is observable in the
/// logs. `routing` is `nexus` when the gateway serves the chat endpoint, else
/// `direct`; `endpoint` names that endpoint (origin and path only, so a credential
/// in a URL cannot reach the log) and `endpointSource` says whether an explicit
/// `*_BASE_URL` replaced a derived mount. `embeddings` names the embedding vendor:
/// it can be off, and without this line the only signal is a per-call warning once
/// a memory write happens.
fn log_provider(provider: &crate::lib::llm_providers::llm_provider::LlmProvider) {
    let model = CONFIG.chat_model_id.as_str();
    let mut fields = Map::new();
    fields.insert("provider".into(), json!(CONFIG.llm_provider.as_str()));
    fields.insert("routing".into(), json!(CONFIG.chat_routing.as_str()));
    fields.insert("endpoint".into(), json!(CONFIG.chat_endpoint_for_log));
    fields.insert(
        "endpointSource".into(),
        json!(CONFIG.chat_endpoint_source.as_str()),
    );
    fields.insert("chatModel".into(), json!(model));
    fields.insert(
        "embeddings".into(),
        json!(if CONFIG.embedding_model_id.is_empty() {
            "disabled".to_string()
        } else {
            format!(
                "{}:{}",
                CONFIG.embedding_provider.as_str(),
                CONFIG.embedding_model_id
            )
        }),
    );
    if let Some(state) = provider.prompt_cache_state(model) {
        fields.insert("promptCache".into(), json!(state.as_str()));
    }
    fields.insert(
        "toolChanges".into(),
        json!(if provider.tool_changes(model).is_some() {
            "on"
        } else {
            "off"
        }),
    );
    fields.insert(
        "toolSearch".into(),
        json!(if CONFIG.tool_search == ToolSearchMode::Auto
            && provider.deferred_tools(model).is_some()
        {
            format!(
                "auto ({}%)",
                js::number_text(CONFIG.tool_search_threshold_percent)
            )
        } else {
            "off".to_string()
        }),
    );
    log_info!(Value::Object(fields), "[Startup] LLM provider");
}

/// The startup warning of each configuration value that was refused for a default.
fn log_config_warnings() {
    if let Some(configured) = &CONFIG.invalid_llm_provider {
        log_warn!(
            json!({ "configuredProvider": configured, "effectiveProvider": CONFIG.llm_provider.as_str() }),
            "[Startup] invalid LLM_PROVIDER; using bedrock"
        );
    }

    // A typo'd EMBEDDING_PROVIDER keeps the derived default running, so nothing ever
    // looks broken without this line.
    if let Some(configured) = &CONFIG.invalid_embedding_provider {
        log_warn!(
            json!({ "configuredProvider": configured, "effectiveProvider": CONFIG.embedding_provider.as_str() }),
            "[Startup] invalid EMBEDDING_PROVIDER; using the chat vendor default"
        );
    }

    if let Some(configured) = &CONFIG.invalid_thread_mode {
        log_warn!(
            json!({ "configuredMode": configured, "effectiveMode": CONFIG.thread_mode.as_str() }),
            "[Startup] invalid THREAD_MODE; using multi"
        );
    }

    if let Some(configured) = &CONFIG.invalid_tool_search {
        log_warn!(
            json!({ "configured": configured, "effective": CONFIG.tool_search.as_str() }),
            "[Startup] invalid TOOL_SEARCH; using auto"
        );
    }
    if let Some(configured) = &CONFIG.invalid_tool_search_threshold {
        log_warn!(
            json!({ "configured": configured, "effective": js::number(CONFIG.tool_search_threshold_percent) }),
            "[Startup] invalid TOOL_SEARCH_THRESHOLD_PERCENT; using the default"
        );
    }

    match &CONFIG.invalid_tool_risk_gate_mode {
        Some(configured) => log_warn!(
            json!({ "configuredMode": configured, "effectiveMode": CONFIG.tool_risk_gate_mode.as_str() }),
            "[Startup] invalid TOOL_RISK_GATE_MODE; risk gate is disabled"
        ),
        None => log_info!(
            json!({ "mode": CONFIG.tool_risk_gate_mode.as_str() }),
            "[Startup] tool risk gate"
        ),
    }
}

/// `String(err)` of a JavaScript `Error`.
fn error_text(err: &anyhow::Error) -> String {
    let name = err_json(err)
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Error")
        .to_string();
    format!("{name}: {err}")
}

/// Graceful shutdown: stops the work in flight first, so it stays pending, then
/// every service and the listeners, and exits.
async fn shutdown(signal: &'static str, servers: Arc<Mutex<Option<Servers>>>) {
    log_info!("{} received, shutting down...", signal);

    // Armed first, before anything that can block. The 5 s timer below is only
    // reached once the awaited teardowns have resolved, so a wedged plugin MCP child
    // or an unreachable telemetry endpoint would leave no backstop at all. That
    // matters most to the self-updater: it signals this shutdown after swapping the
    // install, so a shutdown that never exits leaves the old process serving new
    // files with no supervisor restart coming.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(30));
        log_warn!("[Shutdown] teardown did not finish in 30s — exiting anyway");
        std::process::exit(0);
    });

    // First: the work in flight stops and stays pending, so the teardown below
    // cannot end it half done, and the next boot continues it.
    PENDING_WORK_SERVICE.shutdown();
    HEARTBEAT_SERVICE.stop_all();
    CRON_SCHEDULER_SERVICE.stop_all();
    GOAL_SERVICE.stop_all();
    SESSION_MANAGER_SERVICE.stop_all();
    UPDATE_SERVICE.stop();
    // A delivery starts an agent run, so deliveries stop with the timers. A failure
    // here ends the process, as an unhandled rejection does.
    if let Err(err) = WEBHOOK_RECEIVER_SERVICE.shutdown().await {
        eprintln!("{err:?}");
        std::process::exit(1);
    }
    // So does another agent's message, which starts a turn too.
    let (api, agent_messages) = match servers.lock().take() {
        Some(servers) => (Some(servers.api), servers.agent_messages),
        None => (None, None),
    };
    if let Some(agent_messages) = agent_messages {
        agent_messages.shutdown.cancel();
        agent_messages.task.abort();
    }
    if let Some(janitor) = FILE_JANITOR.lock().take() {
        janitor.abort();
    }
    // A signal early in boot would otherwise leave the catalog fetch holding a
    // socket, so the server close waits and the 5 s force exit below fires.
    cancel_model_catalog_refresh();

    // The agent's own work goes early, ahead of the slower teardowns below. Locally
    // these die with us because they are our children; in a container they do not,
    // and a shutdown that is cut short after this point would leave both them and
    // the container behind.
    get_process_manager().kill_all(None);
    get_agent_task_manager().kill_all();
    get_execution_environment().shutdown().await;

    WEB_SOCKET_GATEWAY_SERVICE.close_all();
    COMPUTER_ENDPOINT.close();
    COMPUTER_SERVICE.close().await;
    COMPUTER_LINK_ENDPOINT.close();
    // Leave any live call before the process goes: otherwise the browser and audio
    // daemon die with us and the bot lingers in the meeting as a frozen participant.
    if let Err(err) = MEETING_BOT_SERVICE.shutdown().await {
        log_warn!("[Meeting] Shutdown teardown failed: {}", error_text(&err));
    }
    // Same for a browser voice chat: the peer dies with the process, so end the
    // session while there is still a socket to say so on.
    if let Err(err) = VOICE_CHAT_SERVICE.shutdown().await {
        log_warn!("[VoiceChat] Shutdown teardown failed: {}", error_text(&err));
    }
    MESSAGE_DELIVERY_SERVICE.shutdown_all().await;
    // Plugin MCP servers are child processes we spawned; close them explicitly so a
    // bare SIGTERM to the runtime doesn't orphan them.
    PLUGIN_MCP_SERVICE.shutdown_all().await;
    // Close the Lens Agents MCP client. On the legacy protocol this ends its gateway session.
    close_mcp_clients().await;
    get_slack_heartbeat_throttle_queue().stop().await;
    // Work whose result was delivered during the teardown records that before the exit.
    PENDING_WORK_SERVICE.flush().await;
    shutdown_langfuse().await;
    shutdown_telemetry().await;

    // Force exit after 5 seconds.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(5));
        log_info!("Force exit");
        std::process::exit(0);
    });

    let Some(api) = api else {
        return;
    };
    api.shutdown.cancel();
    let _ = api.task.await;
    log_info!("Server closed");
    std::process::exit(0);
}
