//! Tool assembly for model invocations.
//!
//! Kept in one place so every request that sends the agent's tool set builds a
//! byte-identical tools block — the provider's prompt-cache prefix hash covers it,
//! and any divergence misses the cache. The subagent Task invoker is injected (the
//! same pattern `create_task_tool` itself uses) so this module never imports
//! `invoke.rs`.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::ai::{ModelMessage, Tool, ToolSet};
use crate::lib::llm_providers::llm_provider::{
    CachePointFragment, is_deferred_tool, merge_provider_options,
};
use crate::lib::pending_file_writes::PendingFileWrites;
use crate::lib::task_tool::Invoker;
use crate::services::agent_workspace_service::SubagentInfo;
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::computer::computer_access::ComputerUse;
use crate::services::delivery_target_service::PostingCeiling;
use crate::services::outbound_message_service::SEND_MESSAGE_TOOL_NAME;
use crate::tools::meeting::{
    MEETING_MEMBERSHIP_TOOL_NAMES, MEETING_READ_TOOL_NAME, MEETING_SCREEN_TOOL_NAMES,
};
use crate::tools::share_file::SHARE_FILE_TOOL_NAME;

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
/// Called from the startup sequence. Never fails: a failed probe logs `[Tools]
/// Meeting toolchain probe failed: ${err}` and means "no voice meetings here",
/// which is the correct outcome for every host without the container's browser
/// and audio packages.
pub async fn init_meeting_tool_availability() -> bool {
    todo!()
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
/// tools, no MCP round trip) filtered by mode, every tool the Lens Agents MCP
/// endpoint exposes, and the Task tool when subagents are configured.
///
/// In order:
/// 1. Awaits the coding-agent detection (the shell tools name the available coding
///    agents in their descriptions) and, in chat mode, the installed sign-in CLIs.
/// 2. Builds the built-ins in this key order: memory, computer (when the mode has a
///    computer), cron, goals, coding-agent sign-in, agent config, shell, share
///    file, send message (left out when the posting ceiling reaches nowhere:
///    neither web chat nor any target), attachments, web fetch, conversation
///    history (when the thread is stored in the database), skills, meeting (when
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
    todo!()
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
        .last();
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
