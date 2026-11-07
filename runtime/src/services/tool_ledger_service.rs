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
