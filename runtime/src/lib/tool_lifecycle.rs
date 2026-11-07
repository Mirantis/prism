//! Tool Lifecycle Events
//!
//! Wraps each tool's `execute` to report when it starts and finishes, for live
//! progress UI, such as a channel's working indicator.
//! Purely observational: listener panics are swallowed, and the wrapper never
//! changes a tool's arguments, result, or returned error.

use crate::ai::{Tool, ToolExecuteFunction, ToolSet};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Which edge of a tool's execution an event reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolLifecycleEventType {
    Started,
    Completed,
}

impl ToolLifecycleEventType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Completed => "completed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLifecycleEvent {
    #[serde(rename = "type")]
    pub kind: ToolLifecycleEventType,
    pub tool_name: String,
}

/// Called around every tool execution.
pub type ToolLifecycleListener = Arc<dyn Fn(ToolLifecycleEvent) + Send + Sync>;

/// Wrap every executable tool so `on_tool_event` fires around its execution.
/// `completed` fires however the call ends — a tool that fails still reports, so a
/// progress UI never sticks on a failed tool. Without a listener the tools
/// are returned untouched.
pub fn with_tool_lifecycle_events(
    tools: ToolSet,
    on_tool_event: Option<ToolLifecycleListener>,
) -> ToolSet {
    let Some(on_tool_event) = on_tool_event else {
        return tools;
    };
    tools
        .into_iter()
        .map(|(name, tool)| {
            let Some(execute) = tool.execute.clone() else {
                return (name, tool);
            };
            let listener = on_tool_event.clone();
            let tool_name = name.clone();
            let wrapped: ToolExecuteFunction = Arc::new(move |args, options| {
                let execute = execute.clone();
                let listener = listener.clone();
                let tool_name = tool_name.clone();
                Box::pin(async move {
                    notify(
                        &listener,
                        ToolLifecycleEvent {
                            kind: ToolLifecycleEventType::Started,
                            tool_name: tool_name.clone(),
                        },
                    );
                    // `completed` on every path, a cancelled future included.
                    let _completed = CompletedGuard {
                        listener,
                        tool_name,
                    };
                    execute(args, options).await
                })
            });
            (
                name,
                Tool {
                    execute: Some(wrapped),
                    ..tool
                },
            )
        })
        .collect()
}

/// Reports `completed` when dropped, which is when the wrapped call ends however
/// it ends.
struct CompletedGuard {
    listener: ToolLifecycleListener,
    tool_name: String,
}

impl Drop for CompletedGuard {
    fn drop(&mut self) {
        notify(
            &self.listener,
            ToolLifecycleEvent {
                kind: ToolLifecycleEventType::Completed,
                tool_name: std::mem::take(&mut self.tool_name),
            },
        );
    }
}

/// Progress UI only — a listener bug must not fail the tool call.
fn notify(listener: &ToolLifecycleListener, event: ToolLifecycleEvent) {
    let listener = listener.clone();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || listener(event)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{ToolExecutionOptions, execute_fn};
    use parking_lot::Mutex;
    use serde_json::{Value, json};

    fn make_tool(result: anyhow::Result<Value>, order: Arc<Mutex<Vec<String>>>) -> Tool {
        let result = Arc::new(Mutex::new(Some(result)));
        Tool {
            description: Some("a tool".into()),
            execute: Some(execute_fn(move |_input, _options| {
                let result = result.clone();
                let order = order.clone();
                async move {
                    order.lock().push("execute".into());
                    result.lock().take().expect("one call")
                }
            })),
            ..Default::default()
        }
    }

    fn recorder(
        order: Arc<Mutex<Vec<String>>>,
    ) -> (ToolLifecycleListener, Arc<Mutex<Vec<ToolLifecycleEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let listener: ToolLifecycleListener = Arc::new(move |event: ToolLifecycleEvent| {
            order.lock().push(event.kind.as_str().to_string());
            seen.lock().push(event);
        });
        (listener, events)
    }

    #[test]
    fn returns_the_tools_untouched_without_a_listener() {
        let mut tools = ToolSet::new();
        tools.insert(
            "kubectl".into(),
            make_tool(Ok(json!("ok")), Default::default()),
        );
        let execute = tools["kubectl"].execute.clone().unwrap();
        let wrapped = with_tool_lifecycle_events(tools, None);
        assert!(Arc::ptr_eq(
            &execute,
            wrapped["kubectl"].execute.as_ref().unwrap()
        ));
    }

    #[tokio::test]
    async fn reports_started_before_and_completed_after_keeping_the_result() {
        let order: Arc<Mutex<Vec<String>>> = Default::default();
        let mut tools = ToolSet::new();
        tools.insert(
            "kubectl".into(),
            make_tool(Ok(json!("result")), order.clone()),
        );
        let (listener, events) = recorder(order.clone());
        let wrapped = with_tool_lifecycle_events(tools, Some(listener));

        let execute = wrapped["kubectl"].execute.clone().unwrap();
        let result = execute(json!({ "ns": "default" }), ToolExecutionOptions::default())
            .await
            .unwrap();

        assert_eq!(result, json!("result"));
        assert_eq!(*order.lock(), ["started", "execute", "completed"]);
        assert_eq!(
            serde_json::to_value(&*events.lock()).unwrap(),
            json!([
                { "type": "started", "toolName": "kubectl" },
                { "type": "completed", "toolName": "kubectl" },
            ])
        );
    }

    #[tokio::test]
    async fn reports_completed_when_the_tool_fails_and_returns_its_error() {
        let order: Arc<Mutex<Vec<String>>> = Default::default();
        let mut tools = ToolSet::new();
        tools.insert(
            "broken".into(),
            make_tool(Err(anyhow::anyhow!("tool exploded")), order.clone()),
        );
        let (listener, events) = recorder(order);
        let wrapped = with_tool_lifecycle_events(tools, Some(listener));

        let execute = wrapped["broken"].execute.clone().unwrap();
        let error = execute(json!({}), ToolExecutionOptions::default())
            .await
            .unwrap_err();

        assert_eq!(error.to_string(), "tool exploded");
        let kinds: Vec<_> = events.lock().iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            [
                ToolLifecycleEventType::Started,
                ToolLifecycleEventType::Completed
            ]
        );
    }

    #[tokio::test]
    async fn swallows_a_failing_listener() {
        let mut tools = ToolSet::new();
        tools.insert(
            "kubectl".into(),
            make_tool(Ok(json!("ok")), Default::default()),
        );
        let listener: ToolLifecycleListener = Arc::new(|_| panic!("listener bug"));
        let wrapped = with_tool_lifecycle_events(tools, Some(listener));

        let execute = wrapped["kubectl"].execute.clone().unwrap();
        let result = execute(json!({}), ToolExecutionOptions::default())
            .await
            .unwrap();
        assert_eq!(result, json!("ok"));
    }

    #[test]
    fn leaves_a_tool_without_execute_untouched() {
        let mut tools = ToolSet::new();
        tools.insert(
            "passive".into(),
            Tool {
                description: Some("a tool".into()),
                ..Default::default()
            },
        );
        let (listener, _) = recorder(Default::default());
        let wrapped = with_tool_lifecycle_events(tools, Some(listener));
        assert!(wrapped["passive"].execute.is_none());
        assert_eq!(wrapped["passive"].description.as_deref(), Some("a tool"));
    }
}
