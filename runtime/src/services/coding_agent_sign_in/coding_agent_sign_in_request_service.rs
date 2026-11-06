//! The agent asking the person, in chat, to sign a coding agent in to their
//! own subscription: a card in the conversation that opens the sign-in, and,
//! once a sign-in succeeds, the next turn of that conversation.
//!
//! The code a sign-in needs is typed where the card opens it, never into chat,
//! so nothing here reads or carries one.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::config::{CONFIG, CodingAgentName};
use crate::lib::telemetry::track_event;
use crate::log_error;
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::conversation_engine_service::ChatInput;

/// Whether a sign-in card still waits for the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodingAgentSignInRequestStatus {
    Waiting,
    SignedIn,
}

impl CodingAgentSignInRequestStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CodingAgentSignInRequestStatus::Waiting => "waiting",
            CodingAgentSignInRequestStatus::SignedIn => "signed_in",
        }
    }
}

/// The sign-in card, stored as the message's only UI block
/// (`{"type":"coding_agent_sign_in",…}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename = "coding_agent_sign_in",
    rename_all = "camelCase"
)]
pub struct CodingAgentSignInRequest {
    pub id: String,
    pub agent: CodingAgentName,
    pub status: CodingAgentSignInRequestStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_channel: Option<ChannelName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_channel_id: Option<String>,
}

/// A text for each coding agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PerAgent {
    pub claude_code: &'static str,
    pub codex: &'static str,
}

impl PerAgent {
    pub const fn get(&self, agent: CodingAgentName) -> &'static str {
        match agent {
            CodingAgentName::ClaudeCode => self.claude_code,
            CodingAgentName::Codex => self.codex,
        }
    }
}

/// Whose subscription the person signs in to.
pub const PROVIDERS: PerAgent = PerAgent {
    claude_code: "Claude",
    codex: "ChatGPT",
};

/// The name each coding agent is shown with.
pub const NAMES: PerAgent = PerAgent {
    claude_code: "Claude Code",
    codex: "Codex",
};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SignInCaller {
    pub agent_id: String,
    pub user_id: String,
    pub thread_id: String,
    pub origin_channel: Option<ChannelName>,
    pub origin_channel_id: Option<String>,
}

/// What `request` posted, or the card that already waited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestedSignIn {
    pub request: CodingAgentSignInRequest,
    /// True when a card for the same coding agent already waited in the
    /// conversation, and nothing was posted.
    pub repeated: bool,
}

/// The web UI's sign-in for `agent`: `<public url>/coding-agents?agent=<agent>`,
/// or the path alone without a public URL.
pub fn sign_in_link(agent: CodingAgentName) -> String {
    todo!()
}

/// A waiting card, with the thread and the message that hold it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct WaitingRequest {
    request: CodingAgentSignInRequest,
    thread_id: String,
    message_id: String,
}

pub struct CodingAgentSignInRequestService {}

impl CodingAgentSignInRequestService {
    pub fn new() -> Self {
        CodingAgentSignInRequestService {}
    }

    /// Posts the card, unless one for the same coding agent already waits in the
    /// conversation.
    pub async fn request(
        &self,
        caller: &SignInCaller,
        agent: CodingAgentName,
    ) -> anyhow::Result<RequestedSignIn> {
        todo!()
    }

    /// The cards still waiting in the agent's conversations with the user (in
    /// `thread_id` alone when given), oldest first.
    async fn waiting(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: Option<&str>,
    ) -> anyhow::Result<Vec<WaitingRequest>> {
        todo!()
    }

    /// Marks every request waiting for `agent` signed in and continues each
    /// conversation that asked, once. Each continuation is stored, owed an
    /// answer, before its card is marked, so a restart in between continues it
    /// at boot, and a later confirmation stores it no more.
    pub async fn signed_in(
        &self,
        agent_id: &str,
        user_id: &str,
        agent: CodingAgentName,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Stores the person's word that they signed in, owed an answer, under the
    /// request's id, and returns the turn that answers it. `None` when an earlier
    /// confirmation stored it: that one, or the boot after it, answers it.
    async fn accept_continuation(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        request: &CodingAgentSignInRequest,
    ) -> anyhow::Result<Option<ChatInput>> {
        todo!()
    }
}

impl Default for CodingAgentSignInRequestService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CODING_AGENT_SIGN_IN_REQUEST_SERVICE: LazyLock<CodingAgentSignInRequestService> =
    LazyLock::new(CodingAgentSignInRequestService::new);
