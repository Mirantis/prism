//! A coding agent's run whose process starts once some work before it is done.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use futures::StreamExt;
use futures::future::BoxFuture;
use serde_json::json;
use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_util::sync::CancellationToken;

use super::coding_agent::{
    CodingAgentEvent, CodingAgentEvents, CodingAgentRun, CodingAgentStopReason,
};
use crate::lib::execution_environments::execution_environment::ProcessMark;
use crate::lib::log_redaction::err_json;
use crate::log_error;

/// The work before the process, given the token a stop cancels.
pub type DeferredStart = Box<
    dyn FnOnce(CancellationToken) -> BoxFuture<'static, anyhow::Result<Arc<dyn CodingAgentRun>>>
        + Send,
>;

/// The error a start returns when a stop cancelled it before the process.
pub fn aborted() -> anyhow::Error {
    anyhow::anyhow!("This operation was aborted")
}

/// The run that `start` returns, as one `CodingAgentRun` from the moment it is
/// asked for. A stop before `start` settles cancels its token. A failure is the
/// run's closing `result`, as a launch failure is: `<name> was stopped before it
/// started` after a stop, else `<name> failed to start: <reason>` (logged as
/// `[AgentTask] coding task failed to start`).
pub fn deferred_run(
    task_id: &str,
    display_name: &str,
    start: DeferredStart,
) -> Arc<dyn CodingAgentRun> {
    let (tx, rx) = mpsc::unbounded_channel();
    let (started_tx, started_rx) = watch::channel(false);
    let run = Arc::new(DeferredRun {
        abort: CancellationToken::new(),
        run: parking_lot::Mutex::new(None),
        ended: AtomicBool::new(false),
        started: started_rx,
        events: parking_lot::Mutex::new(Some(UnboundedReceiverStream::new(rx).boxed())),
    });

    let this = run.clone();
    let task_id = task_id.to_string();
    let display_name = display_name.to_string();
    tokio::spawn(async move {
        let abort = this.abort.clone();
        let pumped: anyhow::Result<()> = async {
            let inner = start(abort.clone()).await?;
            *this.run.lock() = Some(inner.clone());
            let watched = inner.clone();
            tokio::spawn(async move {
                watched.started().await;
                let _ = started_tx.send(true);
            });
            if abort.is_cancelled() {
                inner.stop();
            }
            if let Some(mut events) = inner.take_events() {
                while let Some(event) = events.next().await {
                    let _ = tx.send(event);
                }
            }
            Ok(())
        }
        .await;
        if let Err(err) = pumped {
            let message = if abort.is_cancelled() {
                format!("{display_name} was stopped before it started")
            } else {
                log_error!(
                    json!({ "err": err_json(&err), "taskId": task_id }),
                    "[AgentTask] coding task failed to start"
                );
                format!("{display_name} failed to start: {err}")
            };
            let _ = tx.send(CodingAgentEvent::Result {
                stop_reason: CodingAgentStopReason::Error,
                turns: 0,
                message,
                refusals: None,
            });
        }
        this.ended.store(true, Ordering::SeqCst);
        drop(tx);
    });
    run
}

/// The run while its process has yet to start, and after.
pub struct DeferredRun {
    pub(crate) abort: CancellationToken,
    pub(crate) run: parking_lot::Mutex<Option<Arc<dyn CodingAgentRun>>>,
    pub(crate) ended: AtomicBool,
    pub(crate) started: watch::Receiver<bool>,
    pub(crate) events: parking_lot::Mutex<Option<CodingAgentEvents>>,
}

#[async_trait]
impl CodingAgentRun for DeferredRun {
    fn take_events(&self) -> Option<CodingAgentEvents> {
        self.events.lock().take()
    }

    fn exited(&self) -> bool {
        match self.run.lock().as_ref() {
            Some(run) => run.exited(),
            None => self.ended.load(Ordering::SeqCst),
        }
    }

    fn mark(&self) -> Option<ProcessMark> {
        self.run.lock().as_ref().and_then(|run| run.mark())
    }

    /// Pending for a run that starts no process.
    async fn started(&self) {
        let mut started = self.started.clone();
        if started.wait_for(|started| *started).await.is_err() {
            std::future::pending::<()>().await;
        }
    }

    fn stop(&self) {
        self.abort.cancel();
        let run = self.run.lock().clone();
        if let Some(run) = run {
            run.stop();
        }
    }
}
