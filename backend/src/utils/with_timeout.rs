//! A deadline for a future that has none of its own.
//!
//! Written for reads from a live browser page, which never time out, so a read
//! that does not settle stalls every later poll behind it. Nothing about it
//! belongs to meetings, or to a browser.
//!
//! Fails rather than resolving with a sentinel: a caller that can carry on without the
//! value catches and says so, and one that cannot has an error to report.

use std::future::Future;
use std::time::Duration;

/// Fail with `timed out after <ms>ms` if `future` hasn't settled within `ms`.
pub async fn with_timeout<T, F>(future: F, ms: i64) -> anyhow::Result<T>
where
    F: Future<Output = anyhow::Result<T>>,
{
    match tokio::time::timeout(Duration::from_millis(ms.max(0) as u64), future).await {
        Ok(result) => result,
        Err(_) => Err(anyhow::anyhow!("timed out after {ms}ms")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fails_a_future_that_does_not_settle_in_time() {
        let err = with_timeout(std::future::pending::<anyhow::Result<()>>(), 5)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "timed out after 5ms");
        assert_eq!(with_timeout(async { Ok(3) }, 1000).await.unwrap(), 3);
    }
}
