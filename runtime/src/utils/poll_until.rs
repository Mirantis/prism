//! Poll an async predicate until it succeeds, with exponential backoff.
//!
//! Runs `predicate` immediately, then keeps retrying, doubling the delay
//! between attempts (capped at `max_delay_ms`), until it returns `true` or the
//! total elapsed time reaches `timeout_ms`. Returns whether it succeeded within
//! the budget (a timeout is not an error; the caller decides how to proceed). A
//! predicate that fails ends the poll with its error.
//!
//! Timing is injectable (`sleep`/`now`) so callers' tests don't wait on real
//! timers.

use std::future::Future;
use std::sync::Arc;

use futures::future::BoxFuture;

/// Waits the given number of milliseconds.
pub type SleepFn = Arc<dyn Fn(i64) -> BoxFuture<'static, ()> + Send + Sync>;
/// The current time in epoch milliseconds.
pub type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;

#[derive(Clone, Default)]
pub struct PollUntilOptions {
    /// Total time budget across all attempts. Default 30s.
    pub timeout_ms: Option<i64>,
    /// Delay before the 2nd attempt; doubles each retry. Default 300ms.
    pub base_delay_ms: Option<i64>,
    /// Upper bound on any single backoff delay. Default 4s.
    pub max_delay_ms: Option<i64>,
    pub sleep: Option<SleepFn>,
    pub now: Option<NowFn>,
}

impl std::fmt::Debug for PollUntilOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PollUntilOptions")
            .field("timeout_ms", &self.timeout_ms)
            .field("base_delay_ms", &self.base_delay_ms)
            .field("max_delay_ms", &self.max_delay_ms)
            .finish_non_exhaustive()
    }
}

pub async fn poll_until<F, Fut>(mut predicate: F, options: PollUntilOptions) -> anyhow::Result<bool>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<bool>>,
{
    let timeout_ms = options.timeout_ms.unwrap_or(30_000);
    let base_delay_ms = options.base_delay_ms.unwrap_or(300);
    let max_delay_ms = options.max_delay_ms.unwrap_or(4_000);
    let now = options
        .now
        .unwrap_or_else(|| Arc::new(crate::support::now_ms));
    let sleep = options.sleep.unwrap_or_else(|| {
        Arc::new(|ms: i64| -> BoxFuture<'static, ()> {
            Box::pin(tokio::time::sleep(std::time::Duration::from_millis(
                ms.max(0) as u64,
            )))
        })
    });

    let start = now();
    let mut delay = base_delay_ms;

    loop {
        if predicate().await? {
            return Ok(true);
        }
        if now() - start >= timeout_ms {
            return Ok(false);
        }
        sleep(delay.min(max_delay_ms)).await;
        delay = delay.saturating_mul(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    #[tokio::test]
    async fn backs_off_until_the_predicate_holds_or_the_budget_runs_out() {
        let clock = Arc::new(Mutex::new(0i64));
        let slept = Arc::new(Mutex::new(Vec::new()));
        let options = |clock: Arc<Mutex<i64>>, slept: Arc<Mutex<Vec<i64>>>| PollUntilOptions {
            timeout_ms: Some(1_000),
            base_delay_ms: Some(300),
            max_delay_ms: Some(500),
            now: Some({
                let clock = clock.clone();
                Arc::new(move || *clock.lock())
            }),
            sleep: Some(Arc::new(move |ms| {
                *clock.lock() += ms;
                slept.lock().push(ms);
                Box::pin(async {})
            })),
        };

        let found = poll_until(
            || async { Ok(false) },
            options(clock.clone(), slept.clone()),
        )
        .await
        .unwrap();
        assert!(!found);
        assert_eq!(*slept.lock(), vec![300, 500, 500]);

        let mut calls = 0;
        let found = poll_until(
            || {
                calls += 1;
                let done = calls == 2;
                async move { Ok(done) }
            },
            PollUntilOptions::default(),
        )
        .await;
        assert!(found.is_ok());
    }
}
