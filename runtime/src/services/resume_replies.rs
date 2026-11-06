//! Continue the replies a restart interrupted: one exchange per thread, which
//! answers every message the thread was owed. A channel with a queue of its own
//! (`ChannelAdapter::continue_reply`) takes the reply into that queue. Every other
//! thread's turn starts at once.

use crate::services::conversation_engine_service::ChatWork;
use crate::services::pending_work_service::PendingWorkItem;

/// The `chat` owner's boot step: one resumed exchange per thread that was owed a
/// reply.
pub async fn resume_replies(items: Vec<PendingWorkItem>) -> anyhow::Result<()> {
    todo!()
}

/// Link the uploads of a stored message, which a restart between its insert and
/// the link leaves unlinked. The link claims only uploads that no message holds.
async fn link_uploads(id: &str, work: &ChatWork) {
    todo!()
}

/// Store a message a restart stopped before its insert, from its row. False when
/// it cannot be stored.
async fn store_message(id: &str, work: &ChatWork) -> bool {
    todo!()
}
