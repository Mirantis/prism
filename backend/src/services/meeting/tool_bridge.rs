//! Exposes the agent's real tools to the Realtime model, and runs them.
//!
//! This is what makes the voice in the meeting the agent rather than a narrator:
//! the tools an ordinary chat turn gets — memory, cron, goals, shell, skills, plus
//! everything the Mirantis Agent Platform MCP endpoint serves — are offered to the Realtime session as
//! function tools and executed in this process when called. `filter_tools_by_mode` makes two
//! changes for `meeting`: it drops `share_file` and the message tools, because a meeting
//! runs neither the invoke loop nor the conversation engine that deliver and store what
//! they produce, and it adds `read_meeting_chat`, which reads what people have typed in the
//! call and which no other mode gets, since every other mode stores its tool results.
//!
//! Executing them here (rather than via OpenAI's remote-MCP feature) is not a
//! choice: the tools are in-process closures over service singletons and a
//! single-writer SQLite handle, and OpenAI's servers could not dial into the
//! container anyway.
//!
//! Because the bridge runs tools on behalf of whoever is talking, everything a
//! meeting participant says is untrusted input with the agent's full tool authority
//! behind it — nothing destructive is withheld in `meeting` mode. The only guards
//! left in code are that one dropped tool and the size cap on results, and the cap
//! exists for a different reason (a model that has to *say* the answer should not be
//! handed a 100 kB dump). Behaviour around destructive requests is prompt-level; see
//! `prompts/meeting_prompt.rs`.

use std::sync::Arc;

use crate::ai::ToolSet;
use crate::config::CONFIG;
use crate::lib::llm_providers::deferred_tools::REALTIME_DEFERRED_TOOLS;
use crate::lib::tool_collection::{CollectToolsInput, collect_tools};
use crate::lib::tool_search::plan::{PlanToolSearchInput, ToolSearchTelemetry, plan_tool_search};
use crate::log_info;
use crate::services::voice::realtime_tools::{
    PreparedTools, RealtimeToolsOptions, prepare_realtime_tools,
};

/// The one part of the truncation notice that belongs to this channel: the call's chat
/// takes one short line, not a result of this size, so the model must speak a useful
/// subset instead of handing the rest over.
const VOICE_TRUNCATION_GUIDANCE: &str = concat!(
    "You cannot send the rest anywhere — the call chat takes one short line, not a result ",
    "this size, so say the part that answers the question and offer to go into more of it ",
    "out loud. If the answer needs something from the omitted middle, search the saved ",
    "output with a pattern — never read it through, because everything you pull back stays ",
    "in this call's context for the rest of it, and this session's context is small."
);

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MeetingToolBridgeInput {
    pub user_id: String,
    pub agent_id: String,
    pub thread_id: Option<String>,
    /// Locked-in mode, read from the same context the instructions were built
    /// from. Declarations go out once in `session.update`, so the set is fixed for
    /// the call. A lock turned on mid-call is still enforced by the refusal in the
    /// tools; a lock turned off does not hand the writers back until the next call.
    pub locked_in: bool,
}

/// Collect the agent's tools in `meeting` mode and adapt them for the Realtime API.
///
/// Everything executable is offered, Task included. Be aware of what that means for
/// pacing: `shell_spawn` and `coding_agent` do hand back a handle immediately, but
/// `Task` awaits the whole subagent run, so its result can take minutes. The session
/// stays alive and interruptible throughout — but the model is waiting on that
/// result, so the prompt's instruction to say something before a tool call is what
/// keeps the room from sitting in silence.
///
/// A meeting has no workspace: it is not launched from a repo checkout, so only global
/// skills apply — the same position autonomous runs are in. The task invoker calls
/// `invoke`. The session context is small, so the MCP tools wait for a `load_tools` call
/// on the same terms as a chat turn's: the plan uses `REALTIME_DEFERRED_TOOLS` and
/// `OPENAI_REALTIME_MODEL`, and the tools are labelled `Meeting` with
/// `VOICE_TRUNCATION_GUIDANCE`. Logs
/// `[Meeting] Collected {count} tool(s) for a live session`, with `, {n} deferred` when
/// the plan deferred any.
pub async fn prepare_meeting_tools(input: MeetingToolBridgeInput) -> anyhow::Result<PreparedTools> {
    let collected = collect_tools(CollectToolsInput {
        computer_use: None,
        user_id: input.user_id.clone(),
        agent_id: input.agent_id.clone(),
        thread_id: input.thread_id.clone(),
        mode: "meeting".to_string(),
        origin_channel: None,
        origin_channel_id: None,
        posting_ceiling: None,
        heartbeat_triggered: false,
        // A meeting has no workspace: it is not launched from a repo checkout, so only
        // global skills apply — the same position autonomous runs are in.
        workspace_root: None,
        task_invoker: Arc::new(|request| Box::pin(crate::invoke::invoke(request))),
        register_attachment_injection: None,
        pending_file_writes: None,
        locked_in: input.locked_in,
    })
    .await?;
    Ok(prepare_collected_tools(collected.tools, collected.deferrable, &input).await)
}

/// Plan the collected tools' deferral and adapt them for the Realtime API.
async fn prepare_collected_tools(
    tools: ToolSet,
    deferrable: Vec<String>,
    input: &MeetingToolBridgeInput,
) -> PreparedTools {
    // The session context is small, so the MCP tools wait for a `load_tools` call on the
    // same terms as a chat turn's.
    let tool_search = plan_tool_search(PlanToolSearchInput {
        tools,
        deferrable,
        protocol: Some(&*REALTIME_DEFERRED_TOOLS),
        model_id: CONFIG.openai_realtime_model.clone(),
        telemetry: ToolSearchTelemetry {
            user_id: input.user_id.clone(),
            agent_id: input.agent_id.clone(),
            mode: "meeting".to_string(),
        },
    })
    .await;
    let prepared = prepare_realtime_tools(
        &tool_search.tools,
        RealtimeToolsOptions {
            label: "Meeting".to_string(),
            truncation_guidance: VOICE_TRUNCATION_GUIDANCE.to_string(),
            deferred: Some(tool_search.deferred.iter().cloned().collect()),
            catalog: tool_search.catalog.clone(),
        },
    );
    log_info!(
        "[Meeting] Collected {} tool(s) for a live session{}",
        prepared.count,
        if tool_search.active {
            format!(", {} deferred", tool_search.deferred.len())
        } else {
            String::new()
        }
    );
    prepared
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::ai::{Tool, execute_fn, json_schema, zod_schema};

    fn tool_returning(description: &str, schema: Value, result: Value) -> Tool {
        Tool {
            description: Some(description.to_string()),
            input_schema: zod_schema(schema),
            execute: Some(execute_fn(move |_input, _options| {
                let result = result.clone();
                async move { Ok(result) }
            })),
            ..Default::default()
        }
    }

    fn input() -> MeetingToolBridgeInput {
        MeetingToolBridgeInput {
            user_id: "u1".into(),
            agent_id: "a1".into(),
            thread_id: None,
            locked_in: false,
        }
    }

    async fn prepare(tools: ToolSet) -> PreparedTools {
        prepare_collected_tools(tools, Vec::new(), &input()).await
    }

    #[tokio::test]
    async fn offers_every_executable_tool_task_included() {
        let mut tools = ToolSet::new();
        tools.insert(
            "Task".into(),
            tool_returning("Delegate", json!({ "type": "object" }), json!("x")),
        );
        tools.insert(
            "memory_search".into(),
            tool_returning("Search", json!({ "type": "object" }), json!("y")),
        );
        let prepared = prepare(tools).await;
        let mut names: Vec<String> = prepared
            .declarations()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        names.sort();
        assert_eq!(names, vec!["Task", "memory_search"]);
    }

    #[tokio::test]
    async fn passes_through_a_pre_wrapped_json_schema_tool() {
        let mut tools = ToolSet::new();
        tools.insert(
            "kubectl_get".into(),
            Tool {
                description: Some("Run kubectl get".into()),
                input_schema: json_schema(
                    json!({ "type": "object", "properties": { "resource": { "type": "string" } } }),
                ),
                execute: Some(execute_fn(|_input, _options| async { Ok(json!("ok")) })),
                ..Default::default()
            },
        );
        let prepared = prepare(tools).await;
        assert_eq!(
            prepared.declarations()[0].parameters,
            json!({ "type": "object", "properties": { "resource": { "type": "string" } } })
        );
    }

    #[tokio::test]
    async fn truncates_a_huge_result_with_the_meeting_guidance() {
        let mut tools = ToolSet::new();
        // Head and tail differ, so the cut can be shown to keep both ends.
        tools.insert(
            "dump".into(),
            tool_returning(
                "Dumps",
                json!({ "type": "object" }),
                json!(format!("{}TAIL", "x".repeat(40_000))),
            ),
        );
        let prepared = prepare(tools).await;
        let output = prepared.execute("dump", "{}").await;
        assert!(output.len() < 40_000);
        assert!(output.starts_with(&"x".repeat(1000)));
        assert!(output.ends_with("TAIL"));
        assert!(output.contains("INCOMPLETE OUTPUT"));
        assert!(output.contains("Do not state a count"));
        assert!(output.contains("the call chat takes one short line"));
    }

    #[tokio::test]
    async fn hands_over_a_result_that_fits_the_meeting_budget_whole() {
        let mut tools = ToolSet::new();
        tools.insert(
            "issue".into(),
            tool_returning(
                "Reads",
                json!({ "type": "object" }),
                json!("y".repeat(8_000)),
            ),
        );
        let prepared = prepare(tools).await;
        assert_eq!(prepared.execute("issue", "{}").await, "y".repeat(8_000));
    }

    #[tokio::test]
    async fn does_not_cut_a_result_that_only_just_passes_the_budget() {
        let mut tools = ToolSet::new();
        tools.insert(
            "listing".into(),
            tool_returning(
                "Lists",
                json!({ "type": "object" }),
                json!("w".repeat(12_200)),
            ),
        );
        let prepared = prepare(tools).await;
        assert_eq!(prepared.execute("listing", "{}").await, "w".repeat(12_200));
    }
}
