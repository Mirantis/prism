//! Thread title generation (channel-agnostic).
//!
//! The synchronous title (the conversation service's `add_message`) is just the
//! first 3 words of the user's message, truncated. This upgrades it to a proper
//! short title via the classification model — a direct LLM inference call, no
//! tools and no `invoke`, mirroring the heartbeat classification gate.
//!
//! `on_first_user_message` owns the placeholder → upgrade lifecycle and announces
//! each title on the `events` channel. It is triggered from the conversation
//! engine (the one path every channel goes through), so nothing here knows
//! about a transport; transports subscribe to `events` to push updates.
//! Fail-open: a generation failure just leaves the placeholder in place.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// The length of the title the model is asked for.
const TITLE_WORDS: usize = 3;

/// The longest title kept. The model often writes one word more than it is asked
/// for, and cutting that word leaves a fragment such as "Billing API Test".
const MAX_TITLE_WORDS: usize = TITLE_WORDS + 1;

const SYSTEM_PROMPT: &str = "You name chat conversations. You get the first message of a conversation and write a short title that names its topic. You do not answer or carry out the message. Write only the title on one line, with no quotes, label or formatting.";

/// A thread's title was (re)set — sent on the service's `events` channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTitleChange {
    pub user_id: String,
    pub thread_id: String,
    pub title: String,
}

/// Keep the first non-empty line, strip wrapping quotes and trailing punctuation,
/// and keep at most `MAX_TITLE_WORDS` words. A title is one line, so a second line
/// is the start of an answer and never part of the title.
fn clamp_title(raw: &str) -> Option<String> {
    let first_line = raw
        .split('\n')
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let cleaned = first_line
        .trim()
        .trim_start_matches(['"', '\'', '`'])
        .trim_end_matches(['"', '\'', '`', '.', '!', '?'])
        .trim();
    let title = cleaned
        .split_whitespace()
        .take(MAX_TITLE_WORDS)
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() { None } else { Some(title) }
}

/// Ask the classification model for a short title for `message`. Returns the
/// clamped title, or `None` when the message is empty, the model declined it
/// (finish reason `content-filter`), or the call fails.
///
/// The user message is `<message>\n{text}\n</message>\n\nWrite a title of at most
/// {TITLE_WORDS} words for this message, in the language the message is written
/// in.`, with `maxOutputTokens: 24`.
async fn generate_thread_title(thread_id: &str, message: &str) -> Option<String> {
    todo!()
}

pub struct ThreadTitleService {
    /// Sends a [`ThreadTitleChange`] whenever a thread title is (re)set — first
    /// the placeholder, then the LLM upgrade. Transports (e.g. the WS gateway)
    /// subscribe to push the update to clients; the generation here stays
    /// channel-agnostic.
    pub events: broadcast::Sender<ThreadTitleChange>,
}

impl ThreadTitleService {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(64);
        ThreadTitleService { events }
    }

    /// React to the first user message that named a thread: announce the
    /// placeholder title immediately, then asynchronously upgrade it to a proper
    /// short title and announce that too. Fire-and-forget — never blocks the
    /// turn; a generation failure just keeps the placeholder.
    pub fn on_first_user_message(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        message: &str,
        placeholder_title: &str,
    ) {
        todo!()
    }

    /// Generate a short title for the thread's first message and persist it.
    /// Returns the saved title, or `None` when nothing was generated. Fails only
    /// when the title cannot be saved.
    pub async fn generate_and_save(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        message: &str,
    ) -> anyhow::Result<Option<String>> {
        todo!()
    }
}

impl Default for ThreadTitleService {
    fn default() -> Self {
        Self::new()
    }
}

pub static THREAD_TITLE_SERVICE: LazyLock<ThreadTitleService> =
    LazyLock::new(ThreadTitleService::new);
