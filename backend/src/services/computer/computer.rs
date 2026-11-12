//! What a computer offers the tools, the viewers and the help requests, wherever it is.
//!
//! `AgentComputer` is the runtime's own desktop and `RemoteComputer` is one that links in
//! over `/api/computer-link`. A computer answers for its own screen and input; who may use
//! it and when is `ComputerSession`'s.

use std::any::Any;
use std::future::Future;
use std::sync::Arc;

use async_trait::async_trait;
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};

use super::agent_computer::ModelChannel;
use super::computer_session::SignInOutcome;
use super::computer_tools::{ComputerBrowser, ComputerDesktop, ComputerUserScreen};
use super::picture_stream::FrameSink;
use super::sign_in_form::SignInCredentials;

/// What a sign-in asks for: both fields, or the password alone (the second step of a
/// sign-in that asks in two).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialFields {
    Both,
    Password,
}

impl CredentialFields {
    pub fn as_str(self) -> &'static str {
        match self {
            CredentialFields::Both => "both",
            CredentialFields::Password => "password",
        }
    }
}

/// The sign-in on a tab: where it goes, what the box for it asks for, and the tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInFormInfo {
    pub origin: String,
    pub fields: CredentialFields,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
}

#[async_trait]
pub trait Computer: ComputerBrowser + ComputerDesktop + ComputerUserScreen + Send + Sync {
    /// Run `action` with pictures and narration going to `channel`. `with_model_channel`
    /// below is the form that hands back the action's value.
    async fn with_model_channel(&self, channel: Arc<dyn ModelChannel>, action: BoxFuture<'_, ()>);
    /// Send the screen to `on_frame`, starting over when a stream already runs.
    fn start_screen_stream(&self, on_frame: FrameSink);
    fn stop_screen_stream(&self);
    /// A text frame from a viewer: its pointer and keyboard while it holds the computer.
    fn handle_input(&self, text: &str);
    /// Let go of whatever a viewer's hand left pressed.
    fn release_input(&self);
    /// Forget what a person typed during a secure takeover.
    async fn clear_after_secure_window(&self) -> anyhow::Result<()>;
    async fn tab_target(&self, tab: Option<i64>) -> anyhow::Result<Option<String>>;
    async fn focus_target(&self, target_id: &str) -> anyhow::Result<()>;
    async fn sign_in_form(&self, tab: Option<i64>) -> anyhow::Result<Option<SignInFormInfo>>;
    /// Answers `Filled`, `NoForm`, `NoPasswordStep`, `TabGone` or `SiteChanged`.
    async fn sign_in(
        &self,
        target_id: &str,
        site: &str,
        credentials: &SignInCredentials,
    ) -> anyhow::Result<SignInOutcome>;
    /// Release what the computer holds. Safe to call more than once.
    async fn stop(&self) -> anyhow::Result<()>;
    /// This computer as `Any`, so the owner of the runtime's own desktop can have it back
    /// as an `AgentComputer`.
    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync>;
}

/// Run `action` on `computer` with pictures and narration going to `channel`, and hand
/// back its value.
pub async fn with_model_channel<C, F>(
    computer: &C,
    channel: Arc<dyn ModelChannel>,
    action: F,
) -> F::Output
where
    C: Computer + ?Sized,
    F: Future + Send,
    F::Output: Send,
{
    let mut output = None;
    computer
        .with_model_channel(
            channel,
            Box::pin(async {
                output = Some(action.await);
            }),
        )
        .await;
    output.expect("a computer runs the action it is handed")
}
