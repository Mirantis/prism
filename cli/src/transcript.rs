//! The conversation on screen, as a list the chat surface renders.
//!
//! A conversation is ordered by `createdAt`, then by `id`, the order the runtime
//! keeps. Lines only this client has, its notices and the messages the runtime
//! has not confirmed yet, are `local`. A stored message is ordered against the
//! stored messages only, so a local clock that differs from the runtime's
//! cannot reorder what the person already saw.

use std::collections::HashSet;

use crate::protocol::TuiMessage;

#[derive(Clone, Debug, PartialEq)]
pub struct ChatEntry {
    pub message: TuiMessage,
    /// Drawn by this client and not (yet) stored by the runtime.
    pub local: bool,
    /// Why the runtime refused this message. It is not sent again.
    pub failed: Option<String>,
}

fn before(a: &TuiMessage, b: &TuiMessage) -> bool {
    if a.created_at != b.created_at {
        return a.created_at < b.created_at;
    }
    a.id < b.id
}

fn insert_in_order(entries: &mut Vec<ChatEntry>, entry: ChatEntry) {
    let mut at = entries.len();
    for i in (0..entries.len()).rev() {
        let other = &entries[i];
        if other.local {
            continue;
        }
        if !before(&entry.message, &other.message) {
            break;
        }
        at = i;
    }
    entries.insert(at, entry);
}

/// Add a message, or replace the one with its id. The stored copy of a message
/// drawn locally takes its ordered place.
pub fn upsert_message(entries: &mut Vec<ChatEntry>, message: TuiMessage) {
    let entry = ChatEntry {
        message,
        local: false,
        failed: None,
    };
    match entries
        .iter()
        .position(|e| e.message.id == entry.message.id)
    {
        None => insert_in_order(entries, entry),
        Some(at) if entries[at].local => {
            entries.remove(at);
            insert_in_order(entries, entry);
        }
        Some(at) => entries[at] = entry,
    }
}

/// Draw a line only this client has: a notice, or a message not yet confirmed.
pub fn append_local(entries: &mut Vec<ChatEntry>, message: TuiMessage) {
    entries.push(ChatEntry {
        message,
        local: true,
        failed: None,
    });
}

/// The stored history in place of the stored messages on screen, keeping the local lines it does not contain.
pub fn with_history(entries: &[ChatEntry], history: Vec<TuiMessage>) -> Vec<ChatEntry> {
    let stored: HashSet<String> = history.iter().map(|m| m.id.clone()).collect();
    let mut sorted = history;
    sorted.sort_by(|a, b| {
        if before(a, b) {
            std::cmp::Ordering::Less
        } else if before(b, a) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let mut next: Vec<ChatEntry> = sorted
        .into_iter()
        .map(|message| ChatEntry {
            message,
            local: false,
            failed: None,
        })
        .collect();
    for entry in entries {
        if entry.local && !stored.contains(&entry.message.id) {
            insert_in_order(&mut next, entry.clone());
        }
    }
    next
}

/// Mark a message the runtime refused.
pub fn mark_failed(entries: &mut [ChatEntry], message_id: &str, reason: &str) {
    for e in entries.iter_mut() {
        if e.message.id == message_id {
            e.failed = Some(reason.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(id: &str, at: &str) -> TuiMessage {
        crate::protocol::coerce_message(&json!({"id":id,"content":id,"createdAt":at})).unwrap()
    }

    #[test]
    fn the_stored_copy_replaces_the_local_line() {
        let mut entries = Vec::new();
        append_local(&mut entries, msg("a", "2026-01-01T00:00:05Z"));
        upsert_message(&mut entries, msg("a", "2026-01-01T00:00:01Z"));
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].local);
    }

    #[test]
    fn orders_stored_messages_by_time() {
        let mut entries = Vec::new();
        upsert_message(&mut entries, msg("b", "2026-01-01T00:00:02Z"));
        upsert_message(&mut entries, msg("a", "2026-01-01T00:00:01Z"));
        let ids: Vec<_> = entries.iter().map(|e| e.message.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn history_keeps_local_notices() {
        let mut entries = Vec::new();
        append_local(&mut entries, msg("system-1", "2026-01-01T00:00:09Z"));
        let next = with_history(&entries, vec![msg("x", "2026-01-01T00:00:01Z")]);
        assert_eq!(next.len(), 2);
        assert_eq!(next[1].message.id, "system-1");
    }
}
