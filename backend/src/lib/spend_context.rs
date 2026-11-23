//! The request and thread the model calls of a piece of work belong to, and what
//! started that work.
//!
//! A chat turn and an autonomous run set it once at their entry, and
//! `LLM_CALL_SERVICE.record` reads it, so a gate or a compaction deep inside the
//! work is attributed without passing an id through every call site. A task the
//! work spawns keeps it when the spawn goes through [`carried`].

use std::future::Future;

use serde::{Deserialize, Serialize};

use crate::types::InvokeMode;

/// What starts a request: a person's message, or one of the agent's own triggers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpendSourceKind {
    Chat,
    Heartbeat,
    Cron,
    Webhook,
    Goal,
    VoiceChat,
    Meeting,
    Dictation,
}

pub const SPEND_SOURCE_KINDS: [SpendSourceKind; 8] = [
    SpendSourceKind::Chat,
    SpendSourceKind::Heartbeat,
    SpendSourceKind::Cron,
    SpendSourceKind::Webhook,
    SpendSourceKind::Goal,
    SpendSourceKind::VoiceChat,
    SpendSourceKind::Meeting,
    SpendSourceKind::Dictation,
];

impl SpendSourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Heartbeat => "heartbeat",
            Self::Cron => "cron",
            Self::Webhook => "webhook",
            Self::Goal => "goal",
            Self::VoiceChat => "voice-chat",
            Self::Meeting => "meeting",
            Self::Dictation => "dictation",
        }
    }

    /// The kind a stored text names, or `None` for any other text.
    pub fn parse(value: &str) -> Option<SpendSourceKind> {
        SPEND_SOURCE_KINDS
            .into_iter()
            .find(|kind| kind.as_str() == value)
    }

    /// The kind an `invoke()` run of `mode` is started by. A subagent run has no kind
    /// of its own: it runs inside its parent's request.
    pub fn of_mode(mode: InvokeMode) -> Option<SpendSourceKind> {
        match mode {
            InvokeMode::Chat => Some(Self::Chat),
            InvokeMode::Heartbeat => Some(Self::Heartbeat),
            InvokeMode::Cron => Some(Self::Cron),
            InvokeMode::Goal => Some(Self::Goal),
            InvokeMode::Webhook => Some(Self::Webhook),
            InvokeMode::Subagent => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpendSource {
    pub kind: SpendSourceKind,
    /// The scheduled task, webhook or goal, where the kind has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

impl SpendSource {
    pub fn of(kind: SpendSourceKind) -> SpendSource {
        SpendSource { kind, id: None }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendContext {
    /// The id the work's calls are grouped by: the user message a chat turn answers, or the run's own id.
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SpendSource>,
}

tokio::task_local! {
    static SPEND: SpendContext;
}

/// Run `work` with `context` as its spend context.
pub async fn with_spend_context<F: Future>(context: SpendContext, work: F) -> F::Output {
    SPEND.scope(context, work).await
}

/// The spend context the current task runs in, if any.
pub fn current_spend_context() -> Option<SpendContext> {
    SPEND.try_with(Clone::clone).ok()
}

/// `work`, run in the spend context current where this is called, so a task spawned
/// for it is spent where its caller was.
pub fn carried<F: Future>(work: F) -> impl Future<Output = F::Output> {
    let context = current_spend_context();
    async move {
        match context {
            Some(context) => SPEND.scope(context, work).await,
            None => work.await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context() -> SpendContext {
        SpendContext {
            request_id: "message-1".into(),
            thread_id: Some("thread-1".into()),
            source: Some(SpendSource {
                kind: SpendSourceKind::Cron,
                id: Some("task-1".into()),
            }),
        }
    }

    #[tokio::test]
    async fn work_sees_the_context_it_runs_in_and_a_carried_spawn_keeps_it() {
        assert_eq!(current_spend_context(), None);
        let (inside, spawned) = with_spend_context(context(), async {
            let spawned = tokio::spawn(carried(async { current_spend_context() }));
            let bare = tokio::spawn(async { current_spend_context() });
            assert_eq!(bare.await.unwrap(), None);
            (current_spend_context(), spawned.await.unwrap())
        })
        .await;
        assert_eq!(inside, Some(context()));
        assert_eq!(spawned, Some(context()));
        assert_eq!(current_spend_context(), None);
    }

    #[test]
    fn serializes_as_the_pending_work_row_stores_it() {
        assert_eq!(
            serde_json::to_value(context()).unwrap(),
            json!({ "requestId": "message-1", "threadId": "thread-1", "source": { "kind": "cron", "id": "task-1" } })
        );
        let bare = SpendContext {
            request_id: "run-1".into(),
            thread_id: None,
            source: Some(SpendSource::of(SpendSourceKind::VoiceChat)),
        };
        assert_eq!(
            serde_json::to_value(&bare).unwrap(),
            json!({ "requestId": "run-1", "source": { "kind": "voice-chat" } })
        );
        for kind in SPEND_SOURCE_KINDS {
            assert_eq!(SpendSourceKind::parse(kind.as_str()), Some(kind));
        }
    }
}
