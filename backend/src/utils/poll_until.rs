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

    /// A virtual clock: `sleep` advances it by the requested delay, so backoff and
    /// the timeout budget are exercised deterministically without real timers.
    struct VirtualClock {
        now: Arc<Mutex<i64>>,
        sleeps: Arc<Mutex<Vec<i64>>>,
    }

    impl VirtualClock {
        fn new() -> Self {
            VirtualClock {
                now: Arc::new(Mutex::new(0)),
                sleeps: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn options(&self) -> PollUntilOptions {
            let now = self.now.clone();
            let clock = self.now.clone();
            let sleeps = self.sleeps.clone();
            PollUntilOptions {
                now: Some(Arc::new(move || *now.lock())),
                sleep: Some(Arc::new(move |ms| {
                    sleeps.lock().push(ms);
                    *clock.lock() += ms;
                    Box::pin(async {})
                })),
                ..PollUntilOptions::default()
            }
        }

        fn sleeps(&self) -> Vec<i64> {
            self.sleeps.lock().clone()
        }
    }

    /// A predicate that answers `answers` in turn, then the last one, and counts its calls.
    fn predicate(
        answers: Vec<bool>,
        calls: Arc<Mutex<usize>>,
    ) -> impl FnMut() -> futures::future::Ready<anyhow::Result<bool>> {
        move || {
            let mut count = calls.lock();
            let answer = answers
                .get(*count)
                .or(answers.last())
                .copied()
                .unwrap_or(false);
            *count += 1;
            futures::future::ready(Ok(answer))
        }
    }

    #[tokio::test]
    async fn returns_true_immediately_when_the_predicate_succeeds_on_the_first_attempt() {
        let clock = VirtualClock::new();
        let calls = Arc::new(Mutex::new(0));
        let result = poll_until(predicate(vec![true], calls.clone()), clock.options())
            .await
            .unwrap();
        assert!(result);
        assert_eq!(*calls.lock(), 1);
        assert!(clock.sleeps().is_empty());
    }

    #[tokio::test]
    async fn retries_with_backoff_until_the_predicate_succeeds() {
        let clock = VirtualClock::new();
        let calls = Arc::new(Mutex::new(0));
        let result = poll_until(
            predicate(vec![false, false, true], calls.clone()),
            PollUntilOptions {
                base_delay_ms: Some(100),
                max_delay_ms: Some(4000),
                timeout_ms: Some(30_000),
                ..clock.options()
            },
        )
        .await
        .unwrap();
        assert!(result);
        assert_eq!(*calls.lock(), 3);
        assert_eq!(clock.sleeps(), vec![100, 200]);
    }

    #[tokio::test]
    async fn returns_false_once_the_time_budget_is_exhausted() {
        let clock = VirtualClock::new();
        let calls = Arc::new(Mutex::new(0));
        let result = poll_until(
            predicate(vec![false], calls.clone()),
            PollUntilOptions {
                base_delay_ms: Some(100),
                max_delay_ms: Some(400),
                timeout_ms: Some(1000),
                ..clock.options()
            },
        )
        .await
        .unwrap();
        assert!(!result);
        // 0 → s100 →100 → s200 →300 → s400 →700 → s400 →1100 (>=1000, stop)
        assert_eq!(clock.sleeps(), vec![100, 200, 400, 400]);
        assert_eq!(*calls.lock(), 5);
    }

    #[tokio::test]
    async fn caps_the_backoff_delay_at_max_delay_ms() {
        let clock = VirtualClock::new();
        let calls = Arc::new(Mutex::new(0));
        poll_until(
            predicate(vec![false], calls),
            PollUntilOptions {
                base_delay_ms: Some(1000),
                max_delay_ms: Some(2000),
                timeout_ms: Some(10_000),
                ..clock.options()
            },
        )
        .await
        .unwrap();
        let sleeps = clock.sleeps();
        assert!(sleeps.iter().all(|delay| *delay <= 2000));
        assert!(sleeps.contains(&2000));
    }

    #[tokio::test]
    async fn always_attempts_at_least_once_even_with_a_zero_budget() {
        let clock = VirtualClock::new();
        let calls = Arc::new(Mutex::new(0));
        let result = poll_until(
            predicate(vec![false], calls.clone()),
            PollUntilOptions {
                timeout_ms: Some(0),
                ..clock.options()
            },
        )
        .await
        .unwrap();
        assert!(!result);
        assert_eq!(*calls.lock(), 1);
        assert!(clock.sleeps().is_empty());
    }
}
