//! A token bucket: `burst` requests at once, refilled at `per_second`.
//!
//! Used to hold one chat connection to a sane request rate. A client over the
//! rate is told when to try again rather than being disconnected, because a
//! disconnect makes a well-behaved client reconnect and resend, which is more
//! load, not less.

use std::fmt;
use std::sync::Arc;

/// The clock a bucket reads, in epoch milliseconds (`Date.now` by default).
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub struct TokenBucket {
    per_second: f64,
    burst: f64,
    now: Clock,
    tokens: f64,
    last: i64,
}

impl fmt::Debug for TokenBucket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenBucket")
            .field("per_second", &self.per_second)
            .field("burst", &self.burst)
            .field("tokens", &self.tokens)
            .field("last", &self.last)
            .finish()
    }
}

impl TokenBucket {
    /// A full bucket on the wall clock.
    pub fn new(per_second: f64, burst: f64) -> Self {
        Self::with_clock(per_second, burst, Arc::new(crate::support::now_ms))
    }

    /// A full bucket on the given clock.
    pub fn with_clock(per_second: f64, burst: f64, now: Clock) -> Self {
        let last = now();
        Self {
            per_second,
            burst,
            now,
            tokens: burst,
            last,
        }
    }

    /// Take one token. Answers 0 when taken, else the milliseconds until one is free.
    pub fn take(&mut self) -> i64 {
        let now = (self.now)();
        self.tokens = self
            .burst
            .min(self.tokens + ((now - self.last) as f64 / 1000.0) * self.per_second);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            return 0;
        }
        (((1.0 - self.tokens) / self.per_second) * 1000.0).ceil() as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    #[test]
    fn allows_a_burst_then_names_the_wait() {
        let clock = Arc::new(AtomicI64::new(0));
        let reader = clock.clone();
        let mut bucket =
            TokenBucket::with_clock(2.0, 2.0, Arc::new(move || reader.load(Ordering::SeqCst)));
        assert_eq!(bucket.take(), 0);
        assert_eq!(bucket.take(), 0);
        assert_eq!(bucket.take(), 500);
        clock.store(500, Ordering::SeqCst);
        assert_eq!(bucket.take(), 0);
    }
}
