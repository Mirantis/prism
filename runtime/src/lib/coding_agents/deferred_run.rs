//! A coding agent's run whose process starts once some work before it is done.

use std::sync::Arc;

use async_trait::async_trait;
use futures::future::BoxFuture;
use tokio_util::sync::CancellationToken;

use super::coding_agent::{CodingAgentEvents, CodingAgentRun};
use crate::lib::execution_environments::execution_environment::ProcessMark;

/// The work before the process, given the token a stop cancels.
pub type DeferredStart = Box<
    dyn FnOnce(CancellationToken) -> BoxFuture<'static, anyhow::Result<Arc<dyn CodingAgentRun>>>
        + Send,
>;

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
    todo!()
}

/// The run while its process has yet to start, and after.
pub struct DeferredRun {
    pub(crate) abort: CancellationToken,
    pub(crate) run: parking_lot::Mutex<Option<Arc<dyn CodingAgentRun>>>,
    pub(crate) ended: std::sync::atomic::AtomicBool,
    pub(crate) started: tokio::sync::watch::Receiver<bool>,
    pub(crate) events: parking_lot::Mutex<Option<CodingAgentEvents>>,
}

#[async_trait]
impl CodingAgentRun for DeferredRun {
    fn take_events(&self) -> Option<CodingAgentEvents> {
        self.events.lock().take()
    }

    fn exited(&self) -> bool {
        todo!()
    }

    fn mark(&self) -> Option<ProcessMark> {
        self.run.lock().as_ref().and_then(|run| run.mark())
    }

    async fn started(&self) {
        todo!()
    }

    fn stop(&self) {
        todo!()
    }
}
