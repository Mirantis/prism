//! Tool assembly for voice chat, including optional desktop control.

use std::collections::HashSet;
use std::sync::Arc;

use futures::FutureExt;
use parking_lot::Mutex;

use crate::services::meeting::realtime_session::RealtimeFunctionTool;
use crate::services::voice::realtime_tools::PreparedTools;
use crate::tools::meeting::MEETING_TOOL_NAMES;

/// What a truncated result tells the model in a voice chat. Speech is the only thing that
/// leaves this call, so there is nowhere to hand the rest of a large result.
pub const VOICE_CHAT_TRUNCATION_GUIDANCE: &str = concat!(
    "You cannot hand the rest over — speech is what leaves this call, not a result of this ",
    "size — so say the part that answers the question and offer to go into more of it out ",
    "loud. If the answer needs something from the omitted middle, search the saved output ",
    "with a pattern — never read it through, because everything you pull back stays in ",
    "this call's context for the rest of it, and this session's context is small."
);

/// The base declarations without the call-specific tools and those the computer declares.
fn base_names(
    base: &[RealtimeFunctionTool],
    meeting_names: &HashSet<String>,
    computer_names: &HashSet<String>,
) -> Vec<RealtimeFunctionTool> {
    base.iter()
        .filter(|d| !meeting_names.contains(&d.name) && !computer_names.contains(&d.name))
        .cloned()
        .collect()
}

/// Remove call-specific tools and route each declaration to its session's executor.
pub fn prepare_voice_chat_tools(
    base: PreparedTools,
    computer: Option<PreparedTools>,
) -> PreparedTools {
    let meeting_names: HashSet<String> = MEETING_TOOL_NAMES
        .iter()
        .map(|name| name.to_string())
        .collect();
    let computer_declarations: Arc<Vec<RealtimeFunctionTool>> = computer
        .as_ref()
        .map(|c| c.declarations())
        .unwrap_or_default();
    let computer_names: HashSet<String> = computer_declarations
        .iter()
        .map(|d| d.name.clone())
        .collect();

    let combine = {
        let meeting_names = meeting_names.clone();
        let computer_names = computer_names.clone();
        let computer = computer.clone();
        move |base: &[RealtimeFunctionTool]| -> Arc<Vec<RealtimeFunctionTool>> {
            let mut declarations = base_names(base, &meeting_names, &computer_names);
            if let Some(computer) = &computer {
                declarations.extend(computer.declarations().iter().cloned());
            }
            Arc::new(declarations)
        }
    };

    // Rebuilt only when a load changes the base set, so an unchanged set keeps its identity.
    let source = base.declarations();
    let initial = combine(&source);
    let cache = Arc::new(Mutex::new((source.clone(), initial)));

    // The base's count includes its deferred tools; the meeting and computer tools are never deferred.
    let kept = base_names(&source, &meeting_names, &computer_names).len();
    let count =
        base.count - (source.len() - kept) + computer.as_ref().map(|c| c.count).unwrap_or(0);

    let declarations = {
        let base = base.clone();
        let cache = cache.clone();
        Arc::new(move || {
            let current = base.declarations();
            let mut cached = cache.lock();
            if !Arc::ptr_eq(&current, &cached.0) {
                let rebuilt = combine(&current);
                *cached = (current, rebuilt);
            }
            cached.1.clone()
        })
    };

    let execute = {
        let base = base.clone();
        let computer = computer.clone();
        Arc::new(move |name: String, arguments_json: String| {
            if computer_names.contains(&name) {
                if let Some(computer) = computer.clone() {
                    return async move { computer.execute(&name, &arguments_json).await }.boxed();
                }
            }
            if meeting_names.contains(&name) {
                let error =
                    serde_json::json!({ "error": format!("Unknown tool: {name}") }).to_string();
                return async move { error }.boxed();
            }
            let base = base.clone();
            async move { base.execute(&name, &arguments_json).await }.boxed()
        })
    };

    PreparedTools {
        declarations,
        count,
        execute,
        catalog: base.catalog.clone().filter(|catalog| !catalog.is_empty()),
    }
}
