//! How the web chat appears in the agent's system prompt, for the channel
//! participation instructions it gets once a second person writes there.

pub const WEB_CHAT_LABEL: &str = "this agent's web chat, which every person who opens the agent sees, and where you address people by name, because the chat shows a token as text";

/// The label for a web conversation that two or more people wrote in. Read from
/// the thread's rows, so every turn on it agrees and the system prompt changes once.
/// A thread that a channel keeps its own id for is that channel's, and gets none.
pub async fn web_chat_label(thread_id: &str) -> anyhow::Result<Option<String>> {
    todo!()
}
