//! The tools each conversation declares to the model.
//!
//! The tools block is the first element of the cached prompt prefix, so a
//! change to it invalidates the whole cache of the conversation. On a model that
//! takes mid-conversation tool changes, a conversation therefore declares one
//! list for its life: a tool joins the list the first time a turn offers it, and
//! stays. What changes between turns is which declared tools are available, and
//! each change is an announcement in the history that every later request
//! replays after the same row. A tool whose definition changes gets the new one:
//! one cache miss, as for a new tool.
//!
//! A tool that goes away keeps its definition, description included, so an
//! outage keeps the cache. Every call to it is refused. The definition goes when
//! the runtime restarts or the conversation leaves the list.
//!
//! In memory, one record per thread and model, since the cache is per model
//! too: a thread-bound cron task on its own model keeps a list of its own. A
//! restart or an eviction starts a new list: one cache miss.

use std::collections::HashSet;
use std::sync::LazyLock;

use indexmap::{IndexMap, IndexSet};
use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::ai::json::js_stringify;
use crate::ai::{
    StopCondition, SystemModelMessage, Tool, ToolChoice, ToolExecutionOptions, ToolSet, ToolType,
    execute_fn, step_count_is,
};
use crate::lib::llm_providers::llm_provider::{
    ToolChange, ToolChangeProtocol, ToolChangeType, is_deferred_tool, merge_provider_options,
};

/// A tool-change announcement and the history row it follows; `None` when it
/// counts from the start.
#[derive(Debug, Clone)]
pub struct AnchoredToolChange {
    pub after_row_id: Option<String>,
    pub message: SystemModelMessage,
}

/// What one request of a conversation sends.
pub struct DeclaredTools {
    /// The declared list, in declaration order. A tool not available now refuses
    /// every call.
    pub tools: ToolSet,
    /// Declared tools that load only when an addition names them.
    pub deferred: IndexSet<String>,
    /// Every announcement the request has, oldest first.
    pub tool_changes: Vec<AnchoredToolChange>,
}

/// One announcement whose row is still in the history.
#[derive(Debug, Clone)]
struct Announcement {
    after_row_id: Option<String>,
    changes: Vec<ToolChange>,
}

struct ConversationTools {
    /// The definition of each declared tool, in declaration order.
    definitions: IndexMap<String, Tool>,
    /// What the model sees of each definition, to tell a changed one (`wire_signature`).
    signatures: IndexMap<String, String>,
    /// The tools of the conversation's first request, which load without an addition.
    initial: HashSet<String>,
    /// The tools available where the replayed history starts: `initial` after the
    /// folded announcements.
    at_start: HashSet<String>,
    /// Announcements whose row is still in the history, oldest first.
    announcements: Vec<Announcement>,
}

/// Conversations kept. Only a thread that takes another turn reads its record,
/// so the least recently used one loses least: one cache miss on its next turn.
const MAX_CONVERSATIONS: usize = 100;

/// The parts of a tool the model sees. Everything else, `execute` included,
/// comes from the turn.
const WIRE_FIELDS: [&str; 6] = [
    "type",
    "description",
    "inputSchema",
    "inputExamples",
    "strict",
    "providerOptions",
];

/// The tool with only its `WIRE_FIELDS`.
fn wire_definition(tool: &Tool) -> Tool {
    Tool {
        tool_type: tool.tool_type.clone(),
        description: tool.description.clone(),
        input_schema: tool.input_schema.clone(),
        input_examples: tool.input_examples.clone(),
        strict: tool.strict,
        provider_options: tool.provider_options.clone(),
        ..Default::default()
    }
}

/// The turn's tool with a declared definition over it: every `WIRE_FIELDS` value
/// the definition sets wins, and the turn's tool gives the rest.
fn over_live(live: &Tool, definition: &Tool) -> Tool {
    Tool {
        // A function tool leaves `type` unset, so the turn's tool gives it.
        tool_type: if definition.tool_type == ToolType::Function {
            live.tool_type.clone()
        } else {
            definition.tool_type.clone()
        },
        description: definition
            .description
            .clone()
            .or_else(|| live.description.clone()),
        input_schema: definition.input_schema.clone(),
        input_examples: definition
            .input_examples
            .clone()
            .or_else(|| live.input_examples.clone()),
        strict: definition.strict.or(live.strict),
        provider_options: definition
            .provider_options
            .clone()
            .or_else(|| live.provider_options.clone()),
        ..live.clone()
    }
}

/// The definition as the model sees it, in one string: the JSON of
/// `[type, description, inputSchema as JSON Schema, inputExamples, strict, isDeferredTool]`.
async fn wire_signature(tool: &Tool) -> String {
    let examples = tool
        .input_examples
        .as_ref()
        .map(|examples| serde_json::to_value(examples).unwrap_or(Value::Null))
        .unwrap_or(Value::Null);
    js_stringify(&json!([
        tool.tool_type.as_str(),
        tool.description,
        tool.input_schema.json_schema(),
        examples,
        tool.strict,
        is_deferred_tool(tool),
    ]))
}

/// A tool's `execute` that fails with
/// `The <name> tool is not available in this conversation now.`
fn refusal(tool: Tool, name: &str) -> Tool {
    let message = format!("The {name} tool is not available in this conversation now.");
    Tool {
        execute: Some(execute_fn(
            move |_input: Value, _options: ToolExecutionOptions| {
                let message = message.clone();
                async move { Err(anyhow::anyhow!(message)) }
            },
        )),
        ..tool
    }
}

/// The tool options of a summary request (a compaction, the early-stop summary).
#[derive(Clone)]
pub struct SummaryToolOptions {
    pub tools: ToolSet,
    pub tool_choice: ToolChoice,
    pub allow_system_in_messages: bool,
    /// A model that calls a tool anyway gets the refusal and answers in the second step.
    pub stop_when: StopCondition,
}

/// The tool options of a summary request (a compaction, the early-stop summary)
/// in a conversation with a declared list. A summary request must run no tool,
/// but under tool choice `none` the provider SDK sends no tools block, so the
/// history's announcements would name tools the request does not declare, and
/// the request would miss the cached prefix that starts with them. The request
/// therefore declares the list under `auto`, and refuses every call.
pub fn summary_tool_options(tools: &ToolSet) -> SummaryToolOptions {
    SummaryToolOptions {
        tools: tools
            .iter()
            .map(|(name, tool)| (name.clone(), refusal(tool.clone(), name)))
            .collect(),
        tool_choice: ToolChoice::Auto,
        allow_system_in_messages: true,
        stop_when: step_count_is(2),
    }
}

/// Additions, then removals, each in declaration order, so the bytes do not
/// follow collection order.
fn changes_between<'a>(
    order: impl IntoIterator<Item = &'a String>,
    from: &HashSet<String>,
    to: &HashSet<String>,
) -> Vec<ToolChange> {
    let names: Vec<&String> = order.into_iter().collect();
    let additions = names
        .iter()
        .filter(|name| to.contains(name.as_str()) && !from.contains(name.as_str()))
        .map(|name| ToolChange {
            kind: ToolChangeType::ToolAddition,
            tool_name: (*name).clone(),
        });
    let removals = names
        .iter()
        .filter(|name| from.contains(name.as_str()) && !to.contains(name.as_str()))
        .map(|name| ToolChange {
            kind: ToolChangeType::ToolRemoval,
            tool_name: (*name).clone(),
        });
    additions.chain(removals).collect()
}

fn apply(available: &mut HashSet<String>, changes: &[ToolChange]) {
    for change in changes {
        match change.kind {
            ToolChangeType::ToolAddition => {
                available.insert(change.tool_name.clone());
            }
            ToolChangeType::ToolRemoval => {
                available.remove(&change.tool_name);
            }
        }
    }
}

/// What `declare` records for one turn of a conversation.
pub struct DeclareInput<'a> {
    pub thread_id: &'a str,
    pub model_id: &'a str,
    pub protocol: &'a ToolChangeProtocol,
    pub available: &'a ToolSet,
    /// The history rows the request replays, oldest first.
    pub row_ids: &'a [String],
}

pub struct ToolLedgerService {
    /// Keyed by `<model id> <thread id>`; iteration order is recency of use.
    conversations: Mutex<IndexMap<String, ConversationTools>>,
}

impl ToolLedgerService {
    pub fn new() -> Self {
        ToolLedgerService {
            conversations: Mutex::new(IndexMap::new()),
        }
    }

    /// Record which tools this turn of the conversation offers, and return what
    /// its request sends. `row_ids` are the history rows the request replays,
    /// oldest first; a change this turn is announced after the last of them.
    pub async fn declare(&self, input: DeclareInput<'_>) -> DeclaredTools {
        let DeclareInput {
            thread_id,
            model_id,
            protocol,
            available,
            row_ids,
        } = input;
        let names: Vec<&String> = available.keys().collect();
        let key = format!("{model_id} {thread_id}");
        // Computed before the record is read, so the update below runs under one lock.
        let mut signatures = Vec::with_capacity(names.len());
        for name in &names {
            signatures.push(wire_signature(&available[name.as_str()]).await);
        }

        let mut conversations = self.conversations.lock();
        let mut conversation =
            conversations
                .shift_remove(&key)
                .unwrap_or_else(|| ConversationTools {
                    definitions: IndexMap::new(),
                    signatures: IndexMap::new(),
                    initial: names.iter().map(|name| (*name).clone()).collect(),
                    at_start: names.iter().map(|name| (*name).clone()).collect(),
                    announcements: Vec::new(),
                });

        Self::fold(&mut conversation, row_ids);

        // A new tool joins at the end; a changed one keeps its place.
        for (index, name) in names.iter().enumerate() {
            if conversation.signatures.get(name.as_str()) == Some(&signatures[index]) {
                continue;
            }
            let definition = wire_definition(&available[name.as_str()]);
            conversation
                .signatures
                .insert((*name).clone(), signatures[index].clone());
            let definition = if conversation.initial.contains(name.as_str()) {
                definition
            } else {
                Tool {
                    provider_options: Some(merge_provider_options([
                        definition.provider_options.as_ref(),
                        Some(&protocol.deferred_tool),
                    ])),
                    ..definition
                }
            };
            conversation.definitions.insert((*name).clone(), definition);
        }

        let mut current = conversation.at_start.clone();
        for announcement in &conversation.announcements {
            apply(&mut current, &announcement.changes);
        }
        let offered: HashSet<String> = names.iter().map(|name| (*name).clone()).collect();
        let changes = changes_between(conversation.definitions.keys(), &current, &offered);
        if !changes.is_empty() {
            conversation.announcements.push(Announcement {
                after_row_id: row_ids.last().cloned(),
                changes,
            });
        }

        let view = Self::view(&conversation, protocol, available);
        conversations.insert(key, conversation);
        if conversations.len() > MAX_CONVERSATIONS {
            conversations.shift_remove_index(0);
        }
        view
    }

    /// What the conversation's next request would declare, with no tool
    /// available and nothing recorded; `None` when it has no list for `model_id`.
    pub fn peek(
        &self,
        thread_id: &str,
        model_id: &str,
        protocol: &ToolChangeProtocol,
    ) -> Option<DeclaredTools> {
        let conversations = self.conversations.lock();
        let conversation = conversations.get(&format!("{model_id} {thread_id}"))?;
        Some(Self::view(conversation, protocol, &ToolSet::new()))
    }

    /// Fold every announcement up to the last one whose row left the history
    /// (compaction) into `at_start`, so they become one announcement at the start.
    fn fold(conversation: &mut ConversationTools, row_ids: &[String]) {
        let present: HashSet<&str> = row_ids.iter().map(String::as_str).collect();
        let mut cut = 0;
        for (index, announcement) in conversation.announcements.iter().enumerate() {
            match announcement.after_row_id.as_deref() {
                Some(id) if present.contains(id) => {}
                _ => cut = index + 1,
            }
        }
        let folded: Vec<Announcement> = conversation.announcements.drain(..cut).collect();
        for announcement in folded {
            apply(&mut conversation.at_start, &announcement.changes);
        }
    }

    fn view(
        conversation: &ConversationTools,
        protocol: &ToolChangeProtocol,
        available: &ToolSet,
    ) -> DeclaredTools {
        let mut tools = ToolSet::new();
        let mut deferred = IndexSet::new();
        for (name, definition) in &conversation.definitions {
            if !conversation.initial.contains(name) {
                deferred.insert(name.clone());
            }
            let tool = match available.get(name) {
                Some(live) => over_live(live, definition),
                None => refusal(definition.clone(), name),
            };
            tools.insert(name.clone(), tool);
        }

        let at_start = changes_between(
            conversation.definitions.keys(),
            &conversation.initial,
            &conversation.at_start,
        );
        let mut tool_changes = Vec::new();
        if !at_start.is_empty() {
            tool_changes.push(AnchoredToolChange {
                after_row_id: None,
                message: (protocol.announce)(&at_start),
            });
        }
        tool_changes.extend(conversation.announcements.iter().map(|announcement| {
            AnchoredToolChange {
                after_row_id: announcement.after_row_id.clone(),
                message: (protocol.announce)(&announcement.changes),
            }
        }));
        DeclaredTools {
            tools,
            deferred,
            tool_changes,
        }
    }
}

impl Default for ToolLedgerService {
    fn default() -> Self {
        Self::new()
    }
}

pub static TOOL_LEDGER_SERVICE: LazyLock<ToolLedgerService> = LazyLock::new(ToolLedgerService::new);

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::{Value, json};

    use super::*;
    use crate::ai::json_schema;
    use crate::lib::llm_providers::llm_provider::{provider_options, provider_options_json};
    use crate::lib::llm_providers::tool_changes::ANTHROPIC_TOOL_CHANGES;

    const MODEL: &str = "global.anthropic.claude-opus-5-5";

    fn tool_with(description: &str, properties: Value, calls: Option<Arc<AtomicUsize>>) -> Tool {
        let answer = description.to_string();
        Tool {
            description: Some(description.to_string()),
            input_schema: json_schema(json!({ "type": "object", "properties": properties })),
            execute: Some(execute_fn(
                move |_input: Value, _options: ToolExecutionOptions| {
                    let answer = answer.clone();
                    let calls = calls.clone();
                    async move {
                        if let Some(calls) = calls {
                            calls.fetch_add(1, Ordering::SeqCst);
                        }
                        Ok(Value::String(answer))
                    }
                },
            )),
            ..Default::default()
        }
    }

    fn tool(description: &str) -> Tool {
        tool_with(description, json!({}), None)
    }

    fn set(tools: Vec<(&str, Tool)>) -> ToolSet {
        tools
            .into_iter()
            .map(|(name, tool)| (name.to_string(), tool))
            .collect()
    }

    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    async fn declare_on(
        ledger: &ToolLedgerService,
        available: ToolSet,
        row_ids: &[&str],
        thread_id: &str,
        model_id: &str,
    ) -> DeclaredTools {
        ledger
            .declare(DeclareInput {
                thread_id,
                model_id,
                protocol: &ANTHROPIC_TOOL_CHANGES,
                available: &available,
                row_ids: &ids(row_ids),
            })
            .await
    }

    async fn declare(
        ledger: &ToolLedgerService,
        available: ToolSet,
        row_ids: &[&str],
    ) -> DeclaredTools {
        declare_on(ledger, available, row_ids, "thread-1", MODEL).await
    }

    fn names(declared: &DeclaredTools) -> Vec<&str> {
        declared.tools.keys().map(String::as_str).collect()
    }

    /// The changes each announcement has, with its row.
    fn announced(declared: &DeclaredTools) -> Value {
        Value::Array(
            declared
                .tool_changes
                .iter()
                .map(|change| {
                    let options = change
                        .message
                        .provider_options
                        .as_ref()
                        .map(provider_options_json)
                        .unwrap_or(Value::Null);
                    json!({
                        "afterRowId": change.after_row_id,
                        "changes": options["anthropic"]["toolChanges"],
                    })
                })
                .collect(),
        )
    }

    async fn run(tool: &Tool) -> anyhow::Result<Value> {
        (tool.execute.as_ref().expect("execute"))(json!({}), ToolExecutionOptions::default()).await
    }

    fn options_of(tool: &Tool) -> Option<Value> {
        tool.provider_options.as_ref().map(provider_options_json)
    }

    #[tokio::test]
    async fn declares_the_first_turns_tools_as_loaded_with_nothing_to_announce() {
        let ledger = ToolLedgerService::new();
        let first = declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B"))]),
            &["u1"],
        )
        .await;
        assert_eq!(names(&first), ["a", "b"]);
        assert!(first.deferred.is_empty());
        assert!(first.tool_changes.is_empty());
    }

    #[tokio::test]
    async fn sends_the_same_list_and_announces_nothing_when_the_tools_do_not_change() {
        let ledger = ToolLedgerService::new();
        declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B"))]),
            &["u1"],
        )
        .await;
        let second = declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B"))]),
            &["u1", "r1", "u2"],
        )
        .await;
        assert_eq!(names(&second), ["a", "b"]);
        assert!(second.tool_changes.is_empty());
    }

    #[tokio::test]
    async fn keeps_a_removed_tool_declared_announces_the_removal_and_refuses_its_calls() {
        let ledger = ToolLedgerService::new();
        let removed_calls = Arc::new(AtomicUsize::new(0));
        declare(
            &ledger,
            set(vec![
                ("a", tool("A")),
                (
                    "b",
                    tool_with("B", json!({}), Some(Arc::clone(&removed_calls))),
                ),
            ]),
            &["u1"],
        )
        .await;

        let second = declare(&ledger, set(vec![("a", tool("A"))]), &["u1", "r1", "u2"]).await;

        assert_eq!(names(&second), ["a", "b"]);
        assert_eq!(second.tools["b"].description.as_deref(), Some("B"));
        assert_eq!(
            announced(&second),
            json!([{ "afterRowId": "u2", "changes": [{ "type": "tool_removal", "toolName": "b" }] }])
        );
        let err = run(&second.tools["b"]).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "The b tool is not available in this conversation now."
        );
        assert_eq!(removed_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn announces_a_tool_that_comes_back_as_an_addition_and_replays_the_earlier_removal() {
        let ledger = ToolLedgerService::new();
        declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B"))]),
            &["u1"],
        )
        .await;
        declare(&ledger, set(vec![("a", tool("A"))]), &["u1", "r1", "u2"]).await;
        let third = declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B"))]),
            &["u1", "r1", "u2", "r2", "u3"],
        )
        .await;
        assert_eq!(names(&third), ["a", "b"]);
        assert!(third.deferred.is_empty());
        assert_eq!(
            announced(&third),
            json!([
                { "afterRowId": "u2", "changes": [{ "type": "tool_removal", "toolName": "b" }] },
                { "afterRowId": "u3", "changes": [{ "type": "tool_addition", "toolName": "b" }] },
            ])
        );
    }

    #[tokio::test]
    async fn appends_a_tool_first_seen_mid_conversation_as_deferred_and_announces_it() {
        let ledger = ToolLedgerService::new();
        declare(&ledger, set(vec![("a", tool("A"))]), &["u1"]).await;
        let second = declare(
            &ledger,
            set(vec![("c", tool("C")), ("a", tool("A"))]),
            &["u1", "r1", "u2"],
        )
        .await;
        assert_eq!(names(&second), ["a", "c"]);
        assert_eq!(second.deferred.iter().collect::<Vec<_>>(), ["c"]);
        assert_eq!(
            options_of(&second.tools["c"]),
            Some(json!({ "anthropic": { "deferLoading": true } }))
        );
        assert_eq!(
            announced(&second),
            json!([{ "afterRowId": "u2", "changes": [{ "type": "tool_addition", "toolName": "c" }] }])
        );
    }

    #[tokio::test]
    async fn runs_the_turns_own_execute_under_the_declared_definition() {
        let ledger = ToolLedgerService::new();
        declare(&ledger, set(vec![("a", tool("A"))]), &["u1"]).await;
        let mut live = tool("A");
        live.execute = Some(execute_fn(|_: Value, _: ToolExecutionOptions| async {
            Ok(json!("live"))
        }));
        let second = declare(&ledger, set(vec![("a", live)]), &["u1", "r1", "u2"]).await;
        assert_eq!(run(&second.tools["a"]).await.unwrap(), json!("live"));
    }

    #[tokio::test]
    async fn replaces_a_definition_that_changes_in_its_place_and_with_its_loading() {
        // An MCP server that adds a required parameter: calls with the old schema would fail.
        let ledger = ToolLedgerService::new();
        declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B"))]),
            &["u1"],
        )
        .await;
        declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B")), ("c", tool("C"))]),
            &["u1", "r1", "u2"],
        )
        .await;
        let third = declare(
            &ledger,
            set(vec![
                (
                    "a",
                    tool_with("A", json!({ "region": { "type": "string" } }), None),
                ),
                ("b", tool("B")),
                ("c", tool("C, now with a region")),
            ]),
            &["u1", "r1", "u2", "r2", "u3"],
        )
        .await;
        assert_eq!(names(&third), ["a", "b", "c"]);
        assert_eq!(
            third.tools["a"].input_schema.json_schema(),
            &json!({ "type": "object", "properties": { "region": { "type": "string" } } })
        );
        assert_eq!(
            third.tools["c"].description.as_deref(),
            Some("C, now with a region")
        );
        assert_eq!(
            options_of(&third.tools["c"]),
            Some(json!({ "anthropic": { "deferLoading": true } }))
        );
        assert_eq!(third.tool_changes.len(), 1);
    }

    #[tokio::test]
    async fn replaces_a_definition_that_a_tool_search_stops_deferring() {
        let ledger = ToolLedgerService::new();
        let mut deferred = tool("B");
        deferred.provider_options = Some(provider_options(
            json!({ "anthropic": { "deferLoading": true } }),
        ));
        declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", deferred)]),
            &["u1"],
        )
        .await;
        let second = declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B"))]),
            &["u1", "r1", "u2"],
        )
        .await;
        assert_eq!(second.tools["b"].provider_options, None);
    }

    #[tokio::test]
    async fn folds_the_announcements_of_compacted_rows_into_their_net_change_at_the_start() {
        let ledger = ToolLedgerService::new();
        declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B")), ("c", tool("C"))]),
            &["u1"],
        )
        .await;
        declare(
            &ledger,
            set(vec![("a", tool("A")), ("c", tool("C"))]),
            &["u1", "r1", "u2"],
        )
        .await;
        declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B"))]),
            &["u1", "r1", "u2", "r2", "u3"],
        )
        .await;
        declare(
            &ledger,
            set(vec![("a", tool("A"))]),
            &["u1", "r1", "u2", "r2", "u3", "r3", "u4"],
        )
        .await;

        // Compaction kept the rows from r3 on.
        let after = declare(
            &ledger,
            set(vec![("a", tool("A"))]),
            &["r3", "u4", "r4", "u5"],
        )
        .await;

        assert_eq!(names(&after), ["a", "b", "c"]);
        assert_eq!(
            announced(&after),
            json!([
                // u2 removed b and u3 put it back and removed c: c's removal is what is left.
                { "afterRowId": null, "changes": [{ "type": "tool_removal", "toolName": "c" }] },
                { "afterRowId": "u4", "changes": [{ "type": "tool_removal", "toolName": "b" }] },
            ])
        );
    }

    #[tokio::test]
    async fn starts_a_new_list_after_a_restart_with_nothing_to_replay() {
        let before = ToolLedgerService::new();
        declare(
            &before,
            set(vec![("a", tool("A")), ("b", tool("B"))]),
            &["u1"],
        )
        .await;
        declare(&before, set(vec![("a", tool("A"))]), &["u1", "r1", "u2"]).await;

        let restarted = ToolLedgerService::new();
        let first = declare(
            &restarted,
            set(vec![("a", tool("A"))]),
            &["u1", "r1", "u2", "r2", "u3"],
        )
        .await;
        assert_eq!(names(&first), ["a"]);
        assert!(first.tool_changes.is_empty());
    }

    #[tokio::test]
    async fn keeps_a_list_of_its_own_for_each_model_the_conversation_runs_on() {
        let ledger = ToolLedgerService::new();
        declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B"))]),
            &["u1"],
        )
        .await;
        // A thread-bound cron task with a model of its own, then the chat model again.
        let other = declare_on(
            &ledger,
            set(vec![("a", tool("A"))]),
            &["u1", "r1"],
            "thread-1",
            "us.anthropic.claude-opus-4-8",
        )
        .await;
        let back = declare(
            &ledger,
            set(vec![("a", tool("A")), ("b", tool("B"))]),
            &["u1", "r1", "r2", "u3"],
        )
        .await;
        assert_eq!(names(&other), ["a"]);
        assert!(other.tool_changes.is_empty());
        assert_eq!(names(&back), ["a", "b"]);
        assert!(back.tool_changes.is_empty());
    }

    #[tokio::test]
    async fn shows_the_declared_list_without_recording_anything_every_tool_refusing() {
        let ledger = ToolLedgerService::new();
        let calls = Arc::new(AtomicUsize::new(0));
        declare(
            &ledger,
            set(vec![
                ("a", tool_with("A", json!({}), Some(Arc::clone(&calls)))),
                ("b", tool("B")),
            ]),
            &["u1"],
        )
        .await;
        declare(
            &ledger,
            set(vec![(
                "a",
                tool_with("A", json!({}), Some(Arc::clone(&calls))),
            )]),
            &["u1", "r1", "u2"],
        )
        .await;

        let peeked = ledger
            .peek("thread-1", MODEL, &ANTHROPIC_TOOL_CHANGES)
            .expect("a declared list");

        assert_eq!(names(&peeked), ["a", "b"]);
        assert_eq!(
            announced(&peeked),
            json!([{ "afterRowId": "u2", "changes": [{ "type": "tool_removal", "toolName": "b" }] }])
        );
        assert!(run(&peeked.tools["a"]).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(
            ledger
                .peek("thread-2", MODEL, &ANTHROPIC_TOOL_CHANGES)
                .is_none()
        );
        assert!(
            ledger
                .peek("thread-1", "other", &ANTHROPIC_TOOL_CHANGES)
                .is_none()
        );
    }

    #[tokio::test]
    async fn forgets_the_least_recently_used_conversation_past_its_bound() {
        let ledger = ToolLedgerService::new();
        for i in 0..=100 {
            declare_on(
                &ledger,
                set(vec![("a", tool("A"))]),
                &["u1"],
                &format!("thread-{i}"),
                MODEL,
            )
            .await;
        }
        assert!(
            ledger
                .peek("thread-0", MODEL, &ANTHROPIC_TOOL_CHANGES)
                .is_none()
        );
        assert!(
            ledger
                .peek("thread-1", MODEL, &ANTHROPIC_TOOL_CHANGES)
                .is_some()
        );
    }

    #[test]
    fn a_summary_request_declares_the_list_under_auto_and_refuses_every_call() {
        let options = summary_tool_options(&set(vec![("a", tool("A"))]));
        assert_eq!(options.tool_choice, ToolChoice::Auto);
        assert!(options.allow_system_in_messages);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let err = runtime.block_on(run(&options.tools["a"])).unwrap_err();
        assert_eq!(
            err.to_string(),
            "The a tool is not available in this conversation now."
        );
    }
}
