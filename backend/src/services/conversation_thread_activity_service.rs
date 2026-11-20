//! Conversation Thread Activity Service
//!
//! Owns which conversation threads are working. A thread is working while at least
//! one invocation runs on it. A bound scheduled task can run on a thread while a
//! chat turn runs there, so each thread holds a count.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use indexmap::IndexMap;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

use serde_json::json;

use crate::lib::log_redaction::err_json;
use crate::log_warn;
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::types::{InvokeMode, InvokeRequest};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadActivityChange {
    pub thread_id: String,
    pub working: bool,
    /// Whose conversation it is. A channel turn runs as the Lens user who wrote it.
    pub user_id: String,
}

/// Receives each `change`.
pub type ThreadActivityListener = Arc<dyn Fn(&ThreadActivityChange) + Send + Sync>;

/// The `change` events: a thread started or stopped working.
#[derive(Default)]
pub struct ThreadActivityEvents {
    change: RwLock<Vec<ThreadActivityListener>>,
}

impl ThreadActivityEvents {
    /// Call `listener` with every change from now on, in the order they happen.
    pub fn on_change(&self, listener: impl Fn(&ThreadActivityChange) + Send + Sync + 'static) {
        self.change.write().push(Arc::new(listener));
    }

    /// Hand `change` to every listener, synchronously and in subscription order.
    pub fn emit_change(&self, change: &ThreadActivityChange) {
        let listeners = self.change.read().clone();
        for listener in listeners {
            listener(change);
        }
    }
}

/// One mark on a known thread. `end` lifts it, once.
pub struct ThreadMark {
    thread_id: String,
    user_id: String,
    ended: AtomicBool,
}

impl ThreadMark {
    /// Lift the mark. Calling it again does nothing.
    pub fn end(&self) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        CONVERSATION_THREAD_ACTIVITY_SERVICE.add(&self.thread_id, &self.user_id, -1);
    }
}

/// An invocation's mark on its thread.
pub struct ThreadActivity {
    /// The thread and user marked; `None` for an invocation that marks no thread.
    thread: Option<(String, String)>,
    mark: Mutex<Option<ThreadMark>>,
    ended: AtomicBool,
}

impl ThreadActivity {
    /// An activity that marks no thread.
    fn unmarked() -> Self {
        Self {
            thread: None,
            mark: Mutex::new(None),
            ended: AtomicBool::new(false),
        }
    }

    /// Ends the mark, once.
    pub fn end(&self) {
        self.ended.store(true, Ordering::SeqCst);
        if let Some(mark) = self.mark.lock().as_ref() {
            mark.end();
        }
    }

    /// Runs `wait` with the mark lifted, since an invocation waiting for the user
    /// is not working. The mark comes back after it, unless `end` ran meanwhile.
    pub async fn idle<T>(&self, wait: impl Future<Output = T>) -> T {
        let Some((thread_id, user_id)) = &self.thread else {
            return wait.await;
        };
        if let Some(mark) = self.mark.lock().as_ref() {
            mark.end();
        }
        let result = wait.await;
        if !self.ended.load(Ordering::SeqCst) {
            *self.mark.lock() =
                Some(CONVERSATION_THREAD_ACTIVITY_SERVICE.begin_thread(thread_id, user_id));
        }
        result
    }
}

pub struct ConversationThreadActivityService {
    pub events: ThreadActivityEvents,
    /// Per working thread, how many invocations run on it, in the order the
    /// threads started working.
    running: Mutex<IndexMap<String, i64>>,
}

impl ConversationThreadActivityService {
    pub fn new() -> Self {
        Self {
            events: ThreadActivityEvents::default(),
            running: Mutex::new(IndexMap::new()),
        }
    }

    /// Mark the request's thread as working.
    ///
    /// A request without a thread works on the user's latest web thread, where its
    /// result is published. A subagent runs inside a parent invocation, which already
    /// marks its thread. A failed lookup of the latest thread is logged
    /// (`[ThreadActivity] latest-thread lookup failed; no thread shows as working`)
    /// and marks nothing.
    pub async fn begin(&self, request: &InvokeRequest) -> ThreadActivity {
        let Some(thread_id) = self.thread_for(request).await else {
            return ThreadActivity::unmarked();
        };
        let mark = self.begin_thread(&thread_id, &request.user_id);
        ThreadActivity {
            thread: Some((thread_id, request.user_id.clone())),
            mark: Mutex::new(Some(mark)),
            ended: AtomicBool::new(false),
        }
    }

    /// Mark a known thread as working. The returned mark ends that, once.
    pub fn begin_thread(&self, thread_id: &str, user_id: &str) -> ThreadMark {
        self.add(thread_id, user_id, 1);
        ThreadMark {
            thread_id: thread_id.to_string(),
            user_id: user_id.to_string(),
            ended: AtomicBool::new(false),
        }
    }

    /// The threads that are working now.
    pub fn working_thread_ids(&self) -> Vec<String> {
        self.running.lock().keys().cloned().collect()
    }

    /// The thread a request marks: its own, else the user's latest web thread;
    /// none for a subagent.
    async fn thread_for(&self, request: &InvokeRequest) -> Option<String> {
        if request.mode == InvokeMode::Subagent {
            return None;
        }
        if let Some(thread_id) = request.thread_id.as_ref().filter(|id| !id.is_empty()) {
            return Some(thread_id.clone());
        }
        match CONVERSATION_SERVICE
            .find_latest_web_thread(&request.agent_id, &request.user_id)
            .await
        {
            Ok(latest) => latest.map(|thread| thread.id),
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[ThreadActivity] latest-thread lookup failed; no thread shows as working"
                );
                None
            }
        }
    }

    fn add(&self, thread_id: &str, user_id: &str, delta: i64) {
        let count = {
            let mut running = self.running.lock();
            let count = running.get(thread_id).copied().unwrap_or(0) + delta;
            if count > 0 {
                running.insert(thread_id.to_string(), count);
            } else {
                running.shift_remove(thread_id);
            }
            count
        };

        if count == 1 && delta == 1 {
            self.emit(ThreadActivityChange {
                thread_id: thread_id.to_string(),
                working: true,
                user_id: user_id.to_string(),
            });
        }
        if count == 0 {
            self.emit(ThreadActivityChange {
                thread_id: thread_id.to_string(),
                working: false,
                user_id: user_id.to_string(),
            });
        }
    }

    fn emit(&self, change: ThreadActivityChange) {
        self.events.emit_change(&change);
    }
}

impl Default for ConversationThreadActivityService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CONVERSATION_THREAD_ACTIVITY_SERVICE: LazyLock<ConversationThreadActivityService> =
    LazyLock::new(ConversationThreadActivityService::new);
