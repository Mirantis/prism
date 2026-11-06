//! The file writes the model asked for in the current step, so that a tool
//! reading a file can wait for the writes to that same file first.
//!
//! Why this exists. `share_file` reads the file when it runs. The model routinely
//! issues the write and the share in one assistant message, and the model-call
//! loop executes a step's tool calls concurrently, so the read can win the race
//! and capture the file as it was *before* the edit. The attachment then holds
//! stale bytes while the reply describes the new ones — indistinguishable to the
//! reader, and the bytes are copied eagerly into the media store, so nothing
//! downstream can repair it.
//!
//! Why it can work. The `generate_text` step loop announces **every** tool
//! call in the step — awaiting each tool's `on_input_available` in turn — and only
//! then executes the tools. So by the time any tool in a step begins executing,
//! every write in that step has already registered here. That ordering is the
//! whole mechanism; it is a property of the `generate_text` path specifically (on
//! a streaming path announce and execute interleave per call, which would
//! break it — `invoke.rs` uses `generate_text` only).
//!
//! A write whose target is unknown registers with no path and holds every reader
//! in the step: `shell_exec` can change any file, and nothing can tell which.
//!
//! Waiting is free. The step already joins on every tool future before the next
//! model call, so a reader finishing last within its own step delays nothing.
//!
//! Scope is one step: `invoke.rs` clears the registry at each step boundary
//! (`prepare_step`), which runs after the previous step's tools have all settled
//! and before the next step's calls exist. No timestamps, no cross-step leakage.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::log_warn;

/// What a wait for pending writes ended with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum PendingWaitOutcome {
    None,
    Settled {
        tool_names: Vec<String>,
        elapsed_ms: i64,
    },
    Timeout {
        tool_names: Vec<String>,
        elapsed_ms: i64,
    },
    Aborted {
        tool_names: Vec<String>,
        elapsed_ms: i64,
    },
    Cleared {
        tool_names: Vec<String>,
        elapsed_ms: i64,
    },
}

/// The options of [`PendingFileWrites::wait_for`].
#[derive(Debug, Clone, Default)]
pub struct WaitForOptions {
    pub timeout_ms: u64,
    pub abort_signal: Option<CancellationToken>,
}

#[async_trait]
pub trait PendingFileWrites: Send + Sync {
    /// Record a write the model has asked for, to `full_path` or, without one, to any
    /// file. Called from a write tool's `on_input_available`, which the model-call
    /// loop runs for every call in the step before any of them executes — registering
    /// from `execute` instead would defeat the point, since concurrent siblings have
    /// no ordering between them.
    fn register(&self, tool_call_id: Option<&str>, tool_name: &str, full_path: Option<&str>);
    /// Release a registered write. Called when the write tool's `execute` finishes.
    fn settle(&self, tool_call_id: Option<&str>);
    /// Record a non-write call, so `was_announced` can answer for it. This is the
    /// canary: a reader that finds its own id unannounced knows the hook did not run
    /// and must not read an empty registry as "no pending writes".
    fn announce(&self, tool_call_id: Option<&str>, tool_name: &str);
    /// Whether this call id passed through `on_input_available`.
    fn was_announced(&self, tool_call_id: Option<&str>) -> bool;
    /// Wait for the unsettled writes that can change `full_path`: the ones to that
    /// exact string, and the ones with no path.
    async fn wait_for(&self, full_path: &str, options: WaitForOptions) -> PendingWaitOutcome;
    /// Drop everything. Releases outstanding waiters first so none of them hang —
    /// as `Cleared` rather than `Settled`, because a write abandoned at a step
    /// boundary is precisely the case where nobody knows what is on disk.
    fn clear(&self);
}

/// How a registered write was released.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Release {
    Settled,
    Cleared,
}

struct PendingWrite {
    tool_name: String,
    /// `None` when the write can change any file.
    full_path: Option<String>,
    /// `None` until the write is released.
    done: watch::Sender<Option<Release>>,
}

/// The registry of one invocation.
struct PendingFileWritesRegistry {
    writes: Mutex<IndexMap<String, PendingWrite>>,
    announced: Mutex<HashSet<String>>,
}

pub fn create_pending_file_writes() -> Arc<dyn PendingFileWrites> {
    Arc::new(PendingFileWritesRegistry {
        writes: Mutex::new(IndexMap::new()),
        announced: Mutex::new(HashSet::new()),
    })
}

#[async_trait]
impl PendingFileWrites for PendingFileWritesRegistry {
    fn register(&self, tool_call_id: Option<&str>, tool_name: &str, full_path: Option<&str>) {
        let Some(id) = tool_call_id.filter(|id| !id.is_empty()) else {
            return;
        };
        self.announced.lock().insert(id.to_string());
        let mut writes = self.writes.lock();
        // A duplicate id would mean the loop announced one call twice; keep the
        // first entry so an existing waiter still has something to await.
        if writes.contains_key(id) {
            return;
        }
        let (done, _) = watch::channel(None);
        writes.insert(
            id.to_string(),
            PendingWrite {
                tool_name: tool_name.to_string(),
                full_path: full_path.map(str::to_string),
                done,
            },
        );
    }

    fn settle(&self, tool_call_id: Option<&str>) {
        let Some(id) = tool_call_id.filter(|id| !id.is_empty()) else {
            return;
        };
        let Some(entry) = self.writes.lock().shift_remove(id) else {
            return;
        };
        entry.done.send_replace(Some(Release::Settled));
    }

    fn announce(&self, tool_call_id: Option<&str>, _tool_name: &str) {
        let Some(id) = tool_call_id.filter(|id| !id.is_empty()) else {
            return;
        };
        self.announced.lock().insert(id.to_string());
    }

    fn was_announced(&self, tool_call_id: Option<&str>) -> bool {
        match tool_call_id.filter(|id| !id.is_empty()) {
            Some(id) => self.announced.lock().contains(id),
            None => false,
        }
    }

    /// Races, in one wait: every matching write released (`Cleared` when any of
    /// them was released by `clear()`, since one abandoned write is enough to make
    /// the file's contents unknown, else `Settled`), the timeout (`Timeout`), and
    /// the abort signal (`Aborted`, at once when it is already cancelled).
    /// `elapsed_ms` counts from the start of the wait.
    async fn wait_for(&self, full_path: &str, options: WaitForOptions) -> PendingWaitOutcome {
        todo!()
    }

    fn clear(&self) {
        let mut writes = self.writes.lock();
        if !writes.is_empty() {
            // A write still registered at a step boundary never reached its own
            // release — it failed somewhere above the handler, or the loop's
            // contract changed. Release it so nothing awaits a release no one
            // will send.
            let names: Vec<&str> = writes.values().map(|w| w.tool_name.as_str()).collect();
            log_warn!(
                json!({ "pendingWrites": names }),
                "pending file writes left unsettled at step boundary"
            );
            for entry in writes.values() {
                entry.done.send_replace(Some(Release::Cleared));
            }
        }
        writes.clear();
        drop(writes);
        self.announced.lock().clear();
    }
}
