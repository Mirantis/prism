//! A conversation started in the web UI or the terminal. A channel's threads all hold an
//! external id and are read in the channel, so a client never opens one.

use diesel::dsl::{And, Eq, IsNull};
use diesel::prelude::*;

use crate::db::models::ThreadSource;
use crate::db::schema::conversation_threads::dsl as t;

/// The filter that keeps the web threads.
pub type WebThread = And<Eq<t::thread_source, ThreadSource>, IsNull<t::external_thread_id>>;

/// The filter that keeps the web threads.
pub fn web_thread() -> WebThread {
    t::thread_source
        .eq(ThreadSource::Database)
        .and(t::external_thread_id.is_null())
}

/// Whether a thread read from the database is a web thread, by the rule of [`web_thread`].
pub fn is_web_thread(thread_source: ThreadSource, external_thread_id: Option<&str>) -> bool {
    thread_source == ThreadSource::Database && external_thread_id.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_web_thread_has_the_database_source_and_no_external_id() {
        assert!(is_web_thread(ThreadSource::Database, None));
        assert!(!is_web_thread(ThreadSource::Database, Some("D123")));
        assert!(!is_web_thread(ThreadSource::Slack, Some("C1:1.0")));
    }
}
