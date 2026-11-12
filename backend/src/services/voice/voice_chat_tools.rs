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
            if computer_names.contains(&name)
                && let Some(computer) = computer.clone()
            {
                return async move { computer.execute(&name, &arguments_json).await }.boxed();
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A prepared set that records which of its tools were run.
    fn set(names: &[&str]) -> (PreparedTools, Arc<Mutex<Vec<String>>>) {
        let declarations: Arc<Vec<RealtimeFunctionTool>> = Arc::new(
            names
                .iter()
                .map(|name| RealtimeFunctionTool {
                    name: name.to_string(),
                    description: name.to_string(),
                    parameters: json!({}),
                })
                .collect(),
        );
        let ran = Arc::new(Mutex::new(Vec::new()));
        let record = ran.clone();
        let prepared = PreparedTools {
            declarations: Arc::new(move || declarations.clone()),
            count: names.len(),
            execute: Arc::new(move |name: String, _arguments: String| {
                record.lock().push(name.clone());
                async move { name }.boxed()
            }),
            catalog: None,
        };
        (prepared, ran)
    }

    fn names(tools: &PreparedTools) -> Vec<String> {
        tools
            .declarations()
            .iter()
            .map(|d| d.name.clone())
            .collect()
    }

    const COMPUTER_NAMES: [&str; 4] = [
        "computer_browse",
        "computer_screen",
        "computer_click",
        "computer_instruct",
    ];

    fn with_meeting_tools(first: &str) -> Vec<&str> {
        std::iter::once(first)
            .chain(MEETING_TOOL_NAMES.iter().copied())
            .collect()
    }

    #[tokio::test]
    async fn omits_call_specific_tools_and_refuses_to_execute_them() {
        let (base, ran) = set(&with_meeting_tools("memory_search"));
        let tools = prepare_voice_chat_tools(base, None);
        assert_eq!(names(&tools), vec!["memory_search"]);
        assert_eq!(tools.count, 1);
        let refused = tools.execute(MEETING_TOOL_NAMES[0], "{}").await;
        assert!(refused.contains("Unknown tool"), "{refused}");
        assert!(ran.lock().is_empty());
    }

    #[tokio::test]
    async fn follows_the_base_declarations_when_a_load_adds_to_them() {
        let current = Arc::new(Mutex::new(Arc::new(vec![RealtimeFunctionTool {
            name: "memory_search".into(),
            description: String::new(),
            parameters: json!({}),
        }])));
        let source = current.clone();
        let base = PreparedTools {
            declarations: Arc::new(move || source.lock().clone()),
            count: 2,
            execute: Arc::new(|_name: String, _arguments: String| async { String::new() }.boxed()),
            catalog: None,
        };
        let (computer, _) = set(&["computer_screen"]);
        let tools = prepare_voice_chat_tools(base, Some(computer));
        let before = tools.declarations();
        assert!(Arc::ptr_eq(&tools.declarations(), &before));
        // The base counts its deferred tool, as the meeting path does.
        assert_eq!(tools.count, 3);

        {
            let mut declarations = current.lock();
            let mut next = declarations.as_ref().clone();
            next.push(RealtimeFunctionTool {
                name: "gh__create_issue".into(),
                description: String::new(),
                parameters: json!({}),
            });
            *declarations = Arc::new(next);
        }

        assert!(!Arc::ptr_eq(&tools.declarations(), &before));
        assert_eq!(
            names(&tools),
            vec!["memory_search", "gh__create_issue", "computer_screen"]
        );
    }

    #[tokio::test]
    async fn adds_the_computer_declarations_after_the_agents_own() {
        let (base, _) = set(&with_meeting_tools("memory_search"));
        let (computer, _) = set(&COMPUTER_NAMES);
        let tools = prepare_voice_chat_tools(base, Some(computer));
        let mut expected = vec!["memory_search".to_string()];
        expected.extend(COMPUTER_NAMES.iter().map(|n| n.to_string()));
        assert_eq!(names(&tools), expected);
    }

    #[tokio::test]
    async fn routes_each_computer_declaration_to_the_computer_executor() {
        let (base, base_ran) = set(&with_meeting_tools("memory_search"));
        let (computer, computer_ran) = set(&COMPUTER_NAMES);
        let tools = prepare_voice_chat_tools(base, Some(computer));
        tools.execute("memory_search", "{}").await;
        for name in COMPUTER_NAMES {
            tools.execute(name, "{}").await;
        }
        assert_eq!(*base_ran.lock(), vec!["memory_search"]);
        assert_eq!(*computer_ran.lock(), COMPUTER_NAMES.to_vec());
    }

    #[tokio::test]
    async fn keeps_unrelated_tools_whose_names_start_with_computer() {
        let (base, ran) = set(&["computer_inventory"]);
        let tools = prepare_voice_chat_tools(base, None);
        assert_eq!(names(&tools), vec!["computer_inventory"]);
        tools.execute("computer_inventory", "{}").await;
        assert_eq!(*ran.lock(), vec!["computer_inventory"]);
    }

    #[tokio::test]
    async fn declares_a_duplicate_name_once_and_uses_its_replacement_executor() {
        let (base, base_ran) = set(&["computer_browse"]);
        let (computer, computer_ran) = set(&["computer_browse"]);
        let tools = prepare_voice_chat_tools(base, Some(computer));
        assert_eq!(names(&tools), vec!["computer_browse"]);
        tools.execute("computer_browse", "{}").await;
        assert!(base_ran.lock().is_empty());
        assert_eq!(*computer_ran.lock(), vec!["computer_browse"]);
    }
}
