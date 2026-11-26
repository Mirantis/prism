//! Wraps a `CodingAgentRun` to emit a finished telemetry event once the stream
//! closes or is dropped.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use futures::StreamExt;
use indexmap::IndexMap;

use crate::lib::coding_agents::coding_agent::{
    CodingAgentEvent, CodingAgentEvents, CodingAgentRun,
};
use crate::lib::execution_environments::execution_environment::ProcessMark;
use crate::lib::telemetry::track_event;

/// Wraps `run` so `finished_event` is emitted once when the stream ends or is
/// dropped, with `status` (`end_turn`, `max_turns`, `error`, or `stopped`) and
/// `elapsed_ms`.
pub fn track_run(
    run: Arc<dyn CodingAgentRun>,
    finished_event: &'static str,
    owner: String,
    props: IndexMap<String, String>,
    started_at: i64,
) -> Arc<dyn CodingAgentRun> {
    let stopped = Arc::new(AtomicBool::new(false));
    let events = run.take_events().map(|events| {
        finished_after(
            events,
            Finish {
                event: finished_event,
                owner,
                props,
                started_at,
                stopped: stopped.clone(),
                status: "error",
                done: false,
            },
        )
    });
    Arc::new(TrackedRun {
        run,
        stopped,
        events: parking_lot::Mutex::new(events),
    })
}

struct Finish {
    event: &'static str,
    owner: String,
    props: IndexMap<String, String>,
    started_at: i64,
    stopped: Arc<AtomicBool>,
    status: &'static str,
    done: bool,
}

impl Finish {
    fn emit(&mut self) {
        if self.done {
            return;
        }
        self.done = true;
        let mut props = self.props.clone();
        let status = if self.stopped.load(Ordering::SeqCst) {
            "stopped"
        } else {
            self.status
        };
        props.insert("status".to_string(), status.to_string());
        props.insert(
            "elapsed_ms".to_string(),
            (crate::support::now_ms() - self.started_at).to_string(),
        );
        track_event(self.event, Some(&self.owner), Some(props));
    }
}

impl Drop for Finish {
    fn drop(&mut self) {
        self.emit();
    }
}

fn finished_after(events: CodingAgentEvents, finish: Finish) -> CodingAgentEvents {
    futures::stream::unfold((Some(events), finish), |(events, mut finish)| async move {
        let mut events = events?;
        match events.next().await {
            Some(event) => {
                if let CodingAgentEvent::Result { stop_reason, .. } = &event {
                    finish.status = stop_reason.as_str();
                }
                Some((event, (Some(events), finish)))
            }
            None => {
                finish.emit();
                None
            }
        }
    })
    .boxed()
}

struct TrackedRun {
    run: Arc<dyn CodingAgentRun>,
    stopped: Arc<AtomicBool>,
    events: parking_lot::Mutex<Option<CodingAgentEvents>>,
}

#[async_trait]
impl CodingAgentRun for TrackedRun {
    fn take_events(&self) -> Option<CodingAgentEvents> {
        self.events.lock().take()
    }

    fn exited(&self) -> bool {
        self.run.exited()
    }

    fn mark(&self) -> Option<ProcessMark> {
        self.run.mark()
    }

    async fn started(&self) {
        self.run.started().await
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.run.stop();
    }
}
