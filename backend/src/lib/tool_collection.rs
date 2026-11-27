//! Tool assembly for model invocations.
//!
//! Kept in one place so every request that sends the agent's tool set builds a
//! byte-identical tools block — the provider's prompt-cache prefix hash covers it,
//! and any divergence misses the cache. The subagent Task invoker is injected (the
//! same pattern `create_task_tool` itself uses) so this module never imports
//! `invoke.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::ai::{ModelMessage, ToolSet};
use crate::config::CONFIG;
use crate::lib::coding_agents::availability::ensure_coding_agents_detected;
use crate::lib::execution_environments::get_execution_environment::get_execution_environment;
use crate::lib::llm_providers::llm_provider::{
    CachePointFragment, is_deferred_tool, merge_provider_options,
};
use crate::lib::mcp_client::{MCPConnectionConfig, get_mcp_tools};
use crate::lib::pending_file_writes::PendingFileWrites;
use crate::lib::task_tool::Invoker;
use crate::lib::task_tool::create_task_tool;
use crate::lib::tool_names::{cap_tool_names, to_model_tool_name};
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::services::agent_workspace_service::SubagentInfo;
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::coding_agent_sign_in::coding_agent_account::installed_clis;
use crate::services::computer::computer_access::ComputerUse;
use crate::services::computer::supported::has_computer_for_mode;
use crate::services::conversation_search_service::{CONVERSATION_SEARCH_SERVICE, SearchScope};
use crate::services::delivery_target_service::PostingCeiling;
use crate::services::outbound_message_service::SEND_MESSAGE_TOOL_NAME;
use crate::services::plugin_mcp_service::PLUGIN_MCP_SERVICE;
use crate::services::task_notification_service::TaskNotificationTarget;
use crate::tools::agent_config::get_agent_config_tools;
use crate::tools::ask_questions::get_ask_questions_tools;
use crate::tools::attachments::get_attachment_tools;
use crate::tools::coding_agent_sign_in::get_coding_agent_sign_in_tools;
use crate::tools::computer::get_computer_tools;
use crate::tools::conversation_search::{
    ConversationSearchToolsInput, get_conversation_search_tools,
};
use crate::tools::cron::get_cron_tools;
use crate::tools::goals::get_goal_tools;
use crate::tools::meeting::{
    MEETING_MEMBERSHIP_TOOL_NAMES, MEETING_READ_TOOL_NAME, MEETING_SCREEN_TOOL_NAMES,
};
use crate::tools::meeting::{MeetingToolsInput, get_meeting_tools, is_meeting_supported};
use crate::tools::memory::get_memory_tools;
use crate::tools::send_message::get_send_message_tools;
use crate::tools::share_file::SHARE_FILE_TOOL_NAME;
use crate::tools::share_file::get_share_file_tools;
use crate::tools::shell::get_shell_tools;
use crate::tools::show_ui::get_show_ui_tools;
use crate::tools::skills::get_skill_tools;
use crate::tools::web::web_fetch::get_web_fetch_tools;
use crate::{log_info, log_warn};

/// The tools that post a message, and list where it may go.
const MESSAGE_TOOL_NAMES: [&str; 2] = [SEND_MESSAGE_TOOL_NAME, "list_message_targets"];

/// Queues a message for injection into the running invocation at the next step
/// boundary.
pub type AttachmentInjection = Arc<dyn Fn(ModelMessage) + Send + Sync>;

pub struct CollectToolsInput {
    pub computer_use: Option<Arc<ComputerUse>>,
    pub user_id: String,
    pub agent_id: String,
    pub thread_id: Option<String>,
    pub mode: String,
    /// The channel the turn came from; `websocket` when `None`.
    pub origin_channel: Option<ChannelName>,
    pub origin_channel_id: Option<String>,
    pub posting_ceiling: Option<PostingCeiling>,
    pub workspace_root: Option<String>,
    /// Runs a subagent Task; injected so this module never imports `invoke.rs`.
    pub task_invoker: Invoker,
    /// Queues a message for injection into the running invocation at the next step
    /// boundary (`invoke.rs` prepare_step). `view_attachment` uses it to attach a
    /// PDF as a user-message document — the only placement Bedrock's Converse
    /// converter accepts for file content.
    pub register_attachment_injection: Option<AttachmentInjection>,
    /// The current step's announced file writes, so `share_file` can wait for a
    /// write to the file it is about to read instead of racing it. Optional: a
    /// caller that passes none keeps the unsequenced behaviour, which is what the
    /// meeting tool bridge (no invoke loop, no steps) and unit tests want.
    pub pending_file_writes: Option<Arc<dyn PendingFileWrites>>,
    /// Locked-in mode, taken from the caller's context. Withholds the
    /// workspace-markdown writers and the long-term memory writers (`memory_write`,
    /// `memory_delete`); `memory_search` stays. Not re-read here: two requests built
    /// from the same context must produce a byte-identical tools block, or they
    /// miss the shared prompt-cache prefix.
    ///
    /// Required, not optional: a caller that omits the flag would leave the writers
    /// in its schema and lean on the runtime refusal alone.
    pub locked_in: bool,
}

/// Whether this host can host a voice meeting, resolved once at startup.
///
/// Probed once rather than per turn because the answer involves filesystem checks
/// and, more importantly, because the tools block must be byte-identical across
/// requests for the provider's prompt cache to hit. Defaults to false so a runtime
/// that never calls `init_meeting_tool_availability()` (tests, an embedder) simply
/// doesn't offer the tools.
static MEETING_TOOLS_AVAILABLE: AtomicBool = AtomicBool::new(false);

/// Probe for the meeting toolchain and remember the answer.
///
/// Called from the startup sequence. Never fails: a host without the container's
/// browser and audio packages answers "no voice meetings here".
pub async fn init_meeting_tool_availability() -> bool {
    let available = is_meeting_supported().await;
    MEETING_TOOLS_AVAILABLE.store(available, Ordering::Relaxed);
    available
}

/// Whether `init_meeting_tool_availability` found the meeting toolchain.
pub fn meeting_tools_available() -> bool {
    MEETING_TOOLS_AVAILABLE.load(Ordering::Relaxed)
}

pub struct CollectedTools {
    pub tools: ToolSet,
    /// Returned so callers can also render the task-tool system instructions.
    pub subagents: Vec<SubagentInfo>,
    /// The MCP tools, which a request may send deferred. A built-in never is.
    pub deferrable: Vec<String>,
}

/// Collect the tools an invocation of `mode` sends: built-ins (direct AI SDK
/// tools, no MCP round trip) filtered by mode, every tool the Mirantis Agent Platform MCP
/// endpoint exposes, and the Task tool when subagents are configured.
///
/// In order:
/// 1. Awaits the coding-agent detection (the shell tools name the available coding
///    agents in their descriptions) and, in chat mode, the installed sign-in CLIs.
/// 2. Builds the built-ins in this key order: memory, computer (when the mode has a
///    computer), cron, goals, coding-agent sign-in, ask questions (chat only),
///    agent config, shell, share file, send message (left out when the posting
///    ceiling reaches nowhere: neither web chat nor any target), attachments, web fetch, conversation
///    search (scoped by `conversation_search_scope`), skills, meeting (when
///    available; `in_meeting_session` is `mode == "meeting"`).
/// 3. Fetches the platform MCP tools (`CONFIG.nexus_mcp_url`) and the plugin tools,
///    and merges each after the built-ins without overriding a taken name, logging
///    `[${source}] dropping tool "${name}" — that name is already taken` for
///    `Nexus` and `Plugins`.
/// 4. Filters by mode, drops `share_file` under a posting ceiling, and drops the
///    locked tools in locked-in mode.
/// 5. Adds `Task` when the agent has subagents (never in subagent mode), logging
///    `Adding Task tool for ${n} subagent(s)`.
/// 6. Caps the names (`cap_tool_names(tools, "collect", built-in names + "Task")`)
///    and reports as deferrable the tools that came from MCP, matched by tool
///    identity since capping can rename one.
/// 7. Logs `Collected ${builtIn} built-in + ${nexus} platform MCP + ${plugin}
///    plugin MCP tool(s); ${subagents} subagent(s)`.
pub async fn collect_tools(input: CollectToolsInput) -> anyhow::Result<CollectedTools> {
    let origin_channel = input.origin_channel.unwrap_or(ChannelName::Websocket);
    let mode = input.mode.as_str();
    let thread_id = input.thread_id.as_deref();
    let workspace_root = input.workspace_root.as_deref();
    let origin_channel_id = input.origin_channel_id.as_deref();
    // The shell tools name the available coding agents in their descriptions, and
    // the tools block has to be byte-identical from turn to turn for the prompt
    // cache. Memoized, so only a turn that beats boot to it pays anything.
    ensure_coding_agents_detected().await;
    // Asked once per process, so the sign-in's agent list stays the same too.
    let sign_in_agents = if mode == "chat" {
        installed_clis(get_execution_environment().as_ref()).await
    } else {
        Vec::new()
    };

    let mut built_in_tools = ToolSet::new();
    built_in_tools.extend(get_memory_tools(&input.user_id, &input.agent_id));
    if has_computer_for_mode(mode) {
        built_in_tools.extend(get_computer_tools(
            input.computer_use.clone(),
            None,
            Some(mode),
        ));
    }
    built_in_tools.extend(get_cron_tools(
        &input.user_id,
        &input.agent_id,
        mode,
        thread_id,
        Some(origin_channel),
        origin_channel_id,
    ));
    built_in_tools.extend(get_goal_tools(
        &input.user_id,
        &input.agent_id,
        thread_id,
        origin_channel,
        origin_channel_id,
    ));
    // A person is there to sign in only in chat.
    built_in_tools.extend(get_coding_agent_sign_in_tools(
        &input.user_id,
        &input.agent_id,
        thread_id,
        origin_channel,
        origin_channel_id,
        &sign_in_agents,
    ));
    // A person is there to answer, and to see a UI, only in chat.
    if mode == "chat" {
        built_in_tools.extend(get_ask_questions_tools(
            &input.user_id,
            &input.agent_id,
            thread_id,
            origin_channel,
            origin_channel_id,
        ));
        built_in_tools.extend(get_show_ui_tools(
            &input.user_id,
            &input.agent_id,
            thread_id,
            origin_channel,
        ));
    }
    built_in_tools.extend(get_agent_config_tools()?);
    // A task started in a chat conversation reports its end there, and the agent ends
    // its turn meanwhile. Every other run polls for the result.
    let task_notifications = match thread_id {
        Some(thread_id) if mode == "chat" => Some(TaskNotificationTarget {
            thread_id: thread_id.to_string(),
            agent_id: input.agent_id.clone(),
            user_id: input.user_id.clone(),
            origin_channel: Some(origin_channel.as_str().to_string()),
            origin_channel_id: origin_channel_id.map(str::to_string),
        }),
        _ => None,
    };
    built_in_tools.extend(get_shell_tools(
        workspace_root,
        input.pending_file_writes.clone(),
        task_notifications,
    ));
    // Same workspace root as the shell tools: write-then-share has to agree on what
    // a relative path means, and the write/read sequencing compares resolved paths.
    built_in_tools.extend(get_share_file_tools(
        workspace_root,
        input.pending_file_writes.clone(),
    ));
    // A run whose delivery setting reaches nowhere gets no tool to post with.
    let reaches_nowhere = input
        .posting_ceiling
        .as_ref()
        .is_some_and(|ceiling| !ceiling.web_chat && ceiling.targets.is_empty());
    if !reaches_nowhere {
        built_in_tools.extend(get_send_message_tools(
            &input.user_id,
            &input.agent_id,
            mode,
            thread_id,
            Some(origin_channel),
            origin_channel_id,
            input.posting_ceiling.clone(),
        ));
    }
    built_in_tools.extend(get_attachment_tools(
        &input.user_id,
        &input.agent_id,
        thread_id,
        workspace_root,
        input.register_attachment_injection.clone(),
    ));
    built_in_tools.extend(get_web_fetch_tools(&input.user_id, &input.agent_id));
    built_in_tools.extend(get_conversation_search_tools(
        ConversationSearchToolsInput {
            agent_id: input.agent_id.clone(),
            user_id: input.user_id.clone(),
            thread_id: thread_id.map(str::to_string),
            workspace_root: workspace_root.map(str::to_string),
            scope: conversation_search_scope(mode, thread_id, origin_channel, origin_channel_id)
                .await?,
        },
    ));
    // Progressive disclosure: the `skill` tool loads a skill's full SKILL.md body on
    // demand. The workspace root merges the repo's skills with the global ones.
    // Empty (and omitted) when no skills are available.
    built_in_tools.extend(get_skill_tools(workspace_root).await);
    // Live voice meetings. Empty unless the host has the browser/audio toolchain
    // and an OpenAI key; see `MEETING_TOOLS_AVAILABLE`.
    if meeting_tools_available() {
        built_in_tools.extend(get_meeting_tools(MeetingToolsInput {
            user_id: input.user_id.clone(),
            agent_id: input.agent_id.clone(),
            thread_id: input.thread_id.clone(),
            // `see_screen` delivers its picture into the meeting's Realtime session,
            // so it has to know whether the model asking for it is the one in the call.
            in_meeting_session: Some(mode == "meeting"),
        }));
    }

    // Register every tool the Mirantis Agent Platform MCP endpoint exposes. In the sandbox this
    // is the project-scoped endpoint, which already excludes first-party shell tools
    // by design (those are local built-ins above), so no tool allowlist is sent.
    let nexus_tools = match CONFIG
        .nexus_mcp_url
        .as_deref()
        .filter(|url| !url.is_empty())
    {
        Some(url) => {
            get_mcp_tools(MCPConnectionConfig {
                url: url.to_string(),
            })
            .await
        }
        None => ToolSet::new(),
    };

    // Tools contributed by installed Agent Plugins, already namespaced by plugin and
    // server and in a stable order.
    let plugin_tools = PLUGIN_MCP_SERVICE.get_tools().await;

    // Merged with an explicit guard, so "nothing replaces a built-in" is a property
    // of this code and not of a naming convention that a future rename could
    // quietly invalidate. Platform tool names are un-namespaced, so one answering
    // to `memory_write` would otherwise inherit that name's exemption from the risk
    // gate, whose list matches bare names.
    let mut merged = built_in_tools.clone();
    let mut mcp_names: HashSet<String> = HashSet::new();
    for (source, tools) in [("Nexus", &nexus_tools), ("Plugins", &plugin_tools)] {
        for (name, tool) in tools {
            if merged.contains_key(name) {
                log_warn!(
                    "[{}] dropping tool \"{}\" — that name is already taken",
                    source,
                    name
                );
                continue;
            }
            merged.insert(name.clone(), tool.clone());
            mcp_names.insert(name.clone());
        }
    }

    // Applied to everything, not just the built-ins: an MCP tool that shares a name
    // with a built-in the current mode removed must not survive either.
    let mut mode_filtered_tools = filter_tools_by_mode(merged, mode);
    // A run with a posting ceiling reaches people only through `send_message`,
    // which has no file, so a file it shared would reach nobody.
    if input.posting_ceiling.is_some() {
        mode_filtered_tools.shift_remove(SHARE_FILE_TOOL_NAME);
    }

    // Locked-in mode: withhold the workspace-markdown writers and the long-term
    // memory writers. Applied after the mode filter so it holds for every mode, and
    // over the merged map so a platform MCP tool cannot answer to a withheld name.
    // The refusals in agent_config.rs and memory.rs are what enforce the lock.
    let mut filtered_tools = if input.locked_in {
        omit_locked_tools(mode_filtered_tools)
    } else {
        mode_filtered_tools
    };

    // Fetch subagents (skip for subagent invocations to prevent recursion).
    let subagents: Vec<SubagentInfo> = if mode == "subagent" {
        Vec::new()
    } else {
        AGENT_WORKSPACE_SERVICE
            .get_subagents(&input.agent_id)
            .await?
            .into_iter()
            .map(|subagent| SubagentInfo {
                id: subagent.agent.id,
                name: subagent.agent.name,
                description: subagent.description,
            })
            .collect()
    };

    // Add the Task tool when subagents are configured.
    if !subagents.is_empty() && mode != "subagent" {
        log_info!("Adding Task tool for {} subagent(s)", subagents.len());
        filtered_tools.insert(
            "Task".to_string(),
            create_task_tool(
                subagents.clone(),
                input.user_id.clone(),
                input.task_invoker.clone(),
            ),
        );
        mcp_names.remove("Task");
    }

    // Last word on what a tool may be called, and deliberately the last step here:
    // this is the only assembly point every request goes through (chat, compaction,
    // and the voice-meeting bridge, which re-declares these same keys to the
    // Realtime API under the same limit).
    //
    // Every built-in name is reserved, `Task` included, and the set is taken before
    // the filters rather than after: a mode that withheld `share_file` leaves its
    // name unclaimed, and a remote `share.file` sanitizing into that slot would hand
    // the model a tool the mode had just taken away.
    let mut reserved_names: HashSet<String> = built_in_tools.keys().cloned().collect();
    reserved_names.insert("Task".to_string());
    let origins = capped_origins(filtered_tools.keys(), &reserved_names);
    let tools = cap_tool_names(filtered_tools, "collect", &reserved_names);
    // Matched on where each kept tool came from, since capping can rename a tool.
    let deferrable: Vec<String> = tools
        .keys()
        .filter(|name| {
            origins
                .get(name.as_str())
                .is_some_and(|original| mcp_names.contains(original))
        })
        .cloned()
        .collect();

    log_info!(
        "Collected {} built-in + {} platform MCP + {} plugin MCP tool(s); {} subagent(s)",
        built_in_tools.len(),
        nexus_tools.len(),
        plugin_tools.len(),
        subagents.len()
    );

    Ok(CollectedTools {
        tools,
        subagents,
        deferrable,
    })
}

/// The original name behind each name `cap_tool_names` keeps, by the same rule:
/// a rename onto a reserved name is dropped, and a collision keeps the first.
fn capped_origins<'a>(
    names: impl Iterator<Item = &'a String>,
    reserved: &HashSet<String>,
) -> HashMap<String, String> {
    let mut origins: HashMap<String, String> = HashMap::new();
    for name in names {
        let capped = to_model_tool_name(name);
        if &capped != name && reserved.contains(&capped) {
            continue;
        }
        origins.entry(capped).or_insert_with(|| name.clone());
    }
    origins
}

/// Mark the last tool with the provider's cache breakpoint. Tools are stable per
/// agent, so a checkpoint here is the cheapest one to keep warm.
///
/// A deferred tool is skipped, whether the set names it or its `providerOptions`
/// defer it: the API refuses a breakpoint on a tool that is not loaded. The
/// breakpoint merges into the tool's own `providerOptions`.
///
/// It reaches the wire on the Anthropic Messages path only. Bedrock's Converse
/// conversion builds each `toolSpec` from the tool's name, description and schema
/// and never reads its `providerOptions`, so on that path this is a no-op and the
/// tools block has no checkpoint of its own. AWS documents the checkpoint order as
/// tools → system → messages with the minimum measured across all three, which
/// implies a later `system` checkpoint still covers the tools ahead of it — the
/// loss is a separate cache segment for tools, not the tokens going uncached.
pub fn with_tools_cache_control(
    tools: ToolSet,
    cache_point: CachePointFragment,
    deferred: &HashSet<String>,
) -> ToolSet {
    let last_key = tools
        .iter()
        .filter(|(name, tool)| !deferred.contains(name.as_str()) && !is_deferred_tool(tool))
        .map(|(name, _)| name.clone())
        .next_back();
    let Some(last_key) = last_key else {
        return tools;
    };

    let fragment = cache_point.to_provider_options();
    tools
        .into_iter()
        .map(|(name, mut tool)| {
            if name == last_key {
                tool.provider_options = Some(merge_provider_options([
                    tool.provider_options.as_ref(),
                    Some(&fragment),
                ]));
            }
            (name, tool)
        })
        .collect()
}

/// Tools that write the locked workspace markdown fields or long-term memory.
/// Withheld from the tool set while locked-in mode is on. `memory_search` is not in
/// the set: a locked agent still reads its memories, it just cannot add or remove
/// them. `rename_self` and `update_settings` are not in the set either: renames and
/// behavioural settings (heartbeat interval, timezone, verbose) stay editable while
/// locked, and `update_settings` cannot reach `lockedIn`.
pub const LOCKED_TOOL_NAMES: [&str; 8] = [
    "update_soul",
    "update_memory",
    "update_user_profile",
    "update_vision",
    "update_heartbeat_config",
    "clear_bootstrap",
    "memory_write",
    "memory_delete",
];

/// Drop the workspace-markdown and memory writers while locked-in mode is on.
fn omit_locked_tools(tools: ToolSet) -> ToolSet {
    tools
        .into_iter()
        .filter(|(name, _)| !LOCKED_TOOL_NAMES.contains(&name.as_str()))
        .collect()
}

fn omit(tools: ToolSet, names: &HashSet<&str>) -> ToolSet {
    tools
        .into_iter()
        .filter(|(name, _)| !names.contains(name.as_str()))
        .collect()
}

/// The conversations a run may search: the audience of the run sees what it finds.
/// A voice meeting, where anyone with the link can speak, and a webhook run, whose
/// payload anyone can write, reach only their own conversation. A run in a channel's
/// conversation, or one a channel started, reaches that channel's conversations and
/// its own. A run on the owner's own surfaces reaches every conversation.
async fn conversation_search_scope(
    mode: &str,
    thread_id: Option<&str>,
    origin_channel: ChannelName,
    origin_channel_id: Option<&str>,
) -> anyhow::Result<SearchScope> {
    if mode == "meeting" || mode == "webhook" {
        return Ok(SearchScope::Current);
    }
    let held_in = match thread_id {
        Some(thread_id) => {
            CONVERSATION_SEARCH_SERVICE
                .conversation_channel(thread_id)
                .await?
        }
        None => None,
    };
    let origin = origin_channel_id
        .filter(|_| origin_channel != ChannelName::Websocket)
        .map(str::to_string);
    Ok(held_in
        .or(origin)
        .map_or(SearchScope::All, SearchScope::Channel))
}

/// Filter the assembled tool set by invocation mode.
///
/// Named for built-ins because that is what it omits, but it runs over every tool —
/// including MCP ones — so a remote tool cannot answer to a name the mode has just
/// taken away.
///
/// Joining a voice meeting and leaving one are chat-only acts: every other mode
/// drops those two tools, because an autonomous run (a heartbeat, a cron tick, a
/// subagent) dialling into a live call with people in it — or hanging up on one —
/// is never what the operator asked for. Asking about a call and posting one line
/// into it are available in every mode, so a scheduled run started during a call
/// can report back into the room. Reading the call's chat goes the other way: only
/// the model in the call gets it.
///
/// - chat: All tools except `read_meeting_chat`
/// - heartbeat, cron, webhook: minus the goal tools; the schedule tools stay. A run
///   with a posting ceiling also loses share_file (see `collect_tools`)
/// - subagent: minus share_file (no user channel), goal tools and the message tools
///   (no user thread)
/// - goal: minus create_goal (no nested goals) and the schedule tools; get_goal
///   stays
/// - meeting: chat's set minus share_file and the message tools, plus
///   read_meeting_chat (see the function body)
/// - any other mode: everything except the two tools that join or leave a call, and
///   the chat read
pub fn filter_tools_by_mode(tools: ToolSet, mode: &str) -> ToolSet {
    // Goal-management tools are chat-only entry points; a goal turn keeps only
    // get_goal so it can introspect its own progress.
    let goal_tool_names = ["create_goal", "get_goal"];
    let cron_tool_names = [
        "schedule_task",
        "list_scheduled_tasks",
        "update_scheduled_task",
        "delete_scheduled_task",
    ];

    // Chat gets everything but the chat read. A chat turn persists its tool results
    // as conversation history and replays them into every later turn, so reading a
    // call's chat there would file words typed by unauthenticated third parties into
    // the database for good. The model in the call holds the reading for the length
    // of the call instead.
    if mode == "chat" {
        return omit(tools, &HashSet::from([MEETING_READ_TOOL_NAME]));
    }

    // A live voice meeting gets chat's surface except `share_file` and the message
    // tools, and the chat read on top.
    //
    // `share_file` is dropped for the same reason `subagent` drops it: the tool only
    // stores the file and hands back an id, and it is the *invoke loop* that puts
    // that id on the step and the conversation engine that links it to a delivered
    // message. A meeting runs neither, so a shared file would be stored and then
    // reach nobody — while the tool's own description promises the user a download.
    // The message tools go for a like reason: a sent message has to be stored in the
    // history of the run that sent it, and nothing about a call is stored.
    //
    // Nothing else is withheld. Meeting audio is unauthenticated: anyone with the
    // link can speak, and their words drive a model holding real tools. The one
    // guard is `prompts/meeting_prompt.rs`'s confirmation rule, which covers
    // self-configuration by name; it is guidance, not enforcement, so a sentence
    // agreed in a call can change the agent for every future turn on every channel.
    // Treat a meeting link as conferring the agent's authority over itself and keep
    // it private. `docs/voice-meetings.md` says so plainly.
    if mode == "meeting" {
        let mut names: HashSet<&str> = HashSet::from([SHARE_FILE_TOOL_NAME]);
        names.extend(MESSAGE_TOOL_NAMES);
        return omit(tools, &names);
    }

    // Only a person in a conversation asks the agent into a call or out of one, so
    // every mode below drops those two tools. Folded in here rather than repeated per
    // mode so a new mode can't accidentally inherit the ability to join a meeting.
    let mut membership_tool_names: HashSet<&str> = HashSet::new();
    membership_tool_names.extend(MEETING_MEMBERSHIP_TOOL_NAMES.iter().copied());
    // The screen tools go with them: an autonomous run must not move what a room is
    // watching, or open a browser in front of one.
    membership_tool_names.extend(MEETING_SCREEN_TOOL_NAMES.iter().copied());
    // And the chat read, for the reason the chat branch above drops it: every mode
    // below stores its tool results.
    membership_tool_names.insert(MEETING_READ_TOOL_NAME);

    // Subagents return their result as text to the parent invocation (via the Task
    // tool) — they have no direct channel to the user, so a file they "shared" would
    // never be delivered. Drop share_file. They also don't own a user thread, so
    // drop goal tools and attachment tools, and the message tools, whose sends have
    // to be stored in the history of the run that sent them.
    if mode == "subagent" {
        let mut names: HashSet<&str> = HashSet::from([
            SHARE_FILE_TOOL_NAME,
            "hydrate_attachment",
            "view_attachment",
        ]);
        names.extend(MESSAGE_TOOL_NAMES);
        names.extend(goal_tool_names);
        names.extend(membership_tool_names);
        return omit(tools, &names);
    }

    // An autonomous run reads, adds to and removes from the schedule as a chat turn
    // does, so it can retract a follow-up it scheduled itself. A webhook payload or a
    // Slack trigger message can therefore ask it to delete any of the owner's tasks;
    // `shell_exec`, which these modes hold, can already call the same REST route.
    // Goals stay chat-only.
    if mode == "heartbeat" || mode == "cron" || mode == "webhook" {
        let mut names: HashSet<&str> = HashSet::from(goal_tool_names);
        names.extend(membership_tool_names);
        return omit(tools, &names);
    }

    // A goal turn does real work but must not create/nest a goal or reshape the
    // schedule.
    if mode == "goal" {
        let mut names: HashSet<&str> = HashSet::from(["create_goal"]);
        names.extend(cron_tool_names);
        names.extend(membership_tool_names);
        return omit(tools, &names);
    }

    // A mode nothing above enumerates keeps every other tool, and none of the ones
    // that change which call the agent is in, move what a room is watching, or read
    // the call's chat. The permissive fallback is deliberate for the rest — a caller
    // passing a mode this function has not heard of should not silently lose the
    // shell — but `join_meeting` dials into a live call with people in it,
    // `leave_meeting` hangs up on one, and the chat read would be stored, which is
    // why every enumerated mode above drops them.
    omit(tools, &membership_tool_names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_meeting_and_a_webhook_search_only_their_own_conversation() {
        for mode in ["meeting", "webhook"] {
            assert_eq!(
                conversation_search_scope(mode, None, ChannelName::Slack, Some("C1"))
                    .await
                    .unwrap(),
                SearchScope::Current
            );
        }
        assert_eq!(
            conversation_search_scope("chat", None, ChannelName::Slack, Some("C1"))
                .await
                .unwrap(),
            SearchScope::Channel("C1".into())
        );
        assert_eq!(
            conversation_search_scope("chat", None, ChannelName::Websocket, Some("C1"))
                .await
                .unwrap(),
            SearchScope::All
        );
    }
    use crate::ai::Tool;
    use crate::lib::llm_providers::llm_provider::{
        ANTHROPIC_CACHE_POINT, provider_options, provider_options_json,
    };
    use serde_json::{Value, json};

    fn named(names: &[&str]) -> ToolSet {
        names
            .iter()
            .map(|name| {
                (
                    name.to_string(),
                    Tool {
                        description: Some(name.to_string()),
                        ..Default::default()
                    },
                )
            })
            .collect()
    }

    fn options_of(tools: &ToolSet, name: &str) -> Option<Value> {
        tools[name]
            .provider_options
            .as_ref()
            .map(provider_options_json)
    }

    fn cache_point() -> Value {
        json!({ "anthropic": { "cacheControl": { "type": "ephemeral" } } })
    }

    #[test]
    fn returns_no_tools_for_no_tools() {
        let result =
            with_tools_cache_control(ToolSet::new(), ANTHROPIC_CACHE_POINT, &HashSet::new());
        assert!(result.is_empty());
    }

    #[test]
    fn marks_only_the_last_tool() {
        let result = with_tools_cache_control(
            named(&["alpha", "beta", "gamma"]),
            ANTHROPIC_CACHE_POINT,
            &HashSet::new(),
        );
        assert_eq!(options_of(&result, "alpha"), None);
        assert_eq!(options_of(&result, "beta"), None);
        assert_eq!(options_of(&result, "gamma"), Some(cache_point()));
        assert_eq!(
            result.keys().collect::<Vec<_>>(),
            ["alpha", "beta", "gamma"]
        );
    }

    #[test]
    fn merges_the_breakpoint_into_the_tools_own_options() {
        let mut tools = named(&["a"]);
        tools["a"].provider_options = Some(provider_options(
            json!({ "anthropic": { "eagerInputStreaming": true } }),
        ));
        let result = with_tools_cache_control(tools, ANTHROPIC_CACHE_POINT, &HashSet::new());
        assert_eq!(
            options_of(&result, "a"),
            Some(
                json!({ "anthropic": { "eagerInputStreaming": true, "cacheControl": { "type": "ephemeral" } } })
            )
        );
    }

    #[test]
    fn puts_the_breakpoint_on_the_last_tool_that_is_not_deferred() {
        // The API refuses a breakpoint on a tool that loads only when a change names it.
        let deferred: HashSet<String> = ["c".to_string()].into_iter().collect();
        let result =
            with_tools_cache_control(named(&["a", "b", "c"]), ANTHROPIC_CACHE_POINT, &deferred);
        assert_eq!(options_of(&result, "b"), Some(cache_point()));
        assert_eq!(options_of(&result, "c"), None);
    }

    #[test]
    fn puts_the_breakpoint_on_the_last_tool_a_load_has_not_deferred() {
        let deferred = json!({ "anthropic": { "deferLoading": true } });
        let mut tools = named(&["a", "b"]);
        tools["b"].provider_options = Some(provider_options(deferred.clone()));
        let result = with_tools_cache_control(tools, ANTHROPIC_CACHE_POINT, &HashSet::new());
        assert_eq!(options_of(&result, "a"), Some(cache_point()));
        assert_eq!(options_of(&result, "b"), Some(deferred));
    }

    const ALL: [&str; 16] = [
        "memory_search",
        "memory_write",
        "memory_delete",
        "schedule_task",
        "list_scheduled_tasks",
        "update_scheduled_task",
        "delete_scheduled_task",
        "update_soul",
        "shell_exec",
        "share_file",
        "create_goal",
        "get_goal",
        "hydrate_attachment",
        "view_attachment",
        "send_message",
        "list_message_targets",
    ];

    fn kept(mode: &str, extra: &[&str]) -> Vec<String> {
        let mut names: Vec<&str> = ALL.to_vec();
        names.extend_from_slice(extra);
        filter_tools_by_mode(named(&names), mode)
            .into_keys()
            .collect()
    }

    #[test]
    fn chat_keeps_every_tool_but_the_meeting_chat_read() {
        let tools = kept("chat", &["join_meeting", MEETING_READ_TOOL_NAME]);
        assert!(tools.iter().any(|n| n == "share_file"));
        assert!(tools.iter().any(|n| n == "join_meeting"));
        assert!(!tools.iter().any(|n| n == MEETING_READ_TOOL_NAME));
        assert_eq!(tools.len(), ALL.len() + 1);
    }

    #[test]
    fn a_subagent_has_no_user_channel() {
        let tools = kept("subagent", &["join_meeting"]);
        for gone in [
            "share_file",
            "create_goal",
            "get_goal",
            "hydrate_attachment",
            "view_attachment",
            "send_message",
            "list_message_targets",
            "join_meeting",
        ] {
            assert!(!tools.iter().any(|n| n == gone), "{gone} stays");
        }
        assert!(tools.iter().any(|n| n == "shell_exec"));
    }

    #[test]
    fn an_autonomous_run_keeps_the_schedule_and_drops_the_goal_tools() {
        for mode in ["heartbeat", "cron", "webhook"] {
            let tools = kept(mode, &["leave_meeting"]);
            for stays in [
                "schedule_task",
                "list_scheduled_tasks",
                "update_scheduled_task",
                "delete_scheduled_task",
                "memory_search",
                "update_soul",
                "shell_exec",
            ] {
                assert!(tools.iter().any(|n| n == stays), "{mode} loses {stays}");
            }
            for gone in ["create_goal", "get_goal", "leave_meeting"] {
                assert!(!tools.iter().any(|n| n == gone), "{mode} keeps {gone}");
            }
        }
    }

    #[test]
    fn a_goal_turn_keeps_get_goal_and_drops_the_schedule() {
        let tools = kept("goal", &[]);
        assert!(!tools.iter().any(|n| n == "create_goal"));
        assert!(tools.iter().any(|n| n == "get_goal"));
        assert!(tools.iter().any(|n| n == "shell_exec"));
        for gone in [
            "schedule_task",
            "list_scheduled_tasks",
            "update_scheduled_task",
            "delete_scheduled_task",
        ] {
            assert!(!tools.iter().any(|n| n == gone));
        }
    }

    #[test]
    fn a_meeting_drops_share_file_and_the_message_tools_and_reads_the_chat() {
        let tools = kept("meeting", &[MEETING_READ_TOOL_NAME, "join_meeting"]);
        for gone in ["share_file", "send_message", "list_message_targets"] {
            assert!(!tools.iter().any(|n| n == gone));
        }
        assert!(tools.iter().any(|n| n == MEETING_READ_TOOL_NAME));
        assert!(tools.iter().any(|n| n == "join_meeting"));
    }

    #[test]
    fn an_unknown_mode_keeps_the_shell_but_never_joins_a_call() {
        let tools = kept("something-new", &["join_meeting", "leave_meeting"]);
        assert!(tools.iter().any(|n| n == "shell_exec"));
        assert!(!tools.iter().any(|n| n == "join_meeting"));
        assert!(!tools.iter().any(|n| n == "leave_meeting"));
    }

    #[test]
    fn locked_in_withholds_the_writers_and_keeps_the_search() {
        let tools: Vec<String> = omit_locked_tools(named(&ALL)).into_keys().collect();
        for gone in ["memory_write", "memory_delete", "update_soul"] {
            assert!(!tools.iter().any(|n| n == gone));
        }
        assert!(tools.iter().any(|n| n == "memory_search"));
    }

    #[test]
    fn traces_a_capped_name_back_to_its_original() {
        let long = format!("{}__connector__tool", "0123456789abcdef".repeat(4));
        let names = [
            long.clone(),
            "kubectl_get".to_string(),
            "share.file".to_string(),
        ];
        let reserved: HashSet<String> = ["share_file".to_string()].into_iter().collect();
        let origins = capped_origins(names.iter(), &reserved);
        assert_eq!(origins[&to_model_tool_name(&long)], long);
        assert_eq!(origins["kubectl_get"], "kubectl_get");
        // A rename onto a reserved name is dropped, as cap_tool_names drops it.
        assert!(!origins.contains_key("share_file"));
    }
}
