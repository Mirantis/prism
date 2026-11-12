//! Retries with exponential backoff that honors a provider's `retry-after-ms` and
//! `retry-after` headers (`retryWithExponentialBackoffRespectingRetryHeaders`).

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::errors::{
    AbortError, ApiCallError, InvalidArgumentError, RetryError, RetryErrorReason,
    get_error_message, is_abort_error,
};

/// The SDK's default retry count.
pub const DEFAULT_MAX_RETRIES: u32 = 2;
const INITIAL_DELAY_MS: f64 = 2000.0;
const BACKOFF_FACTOR: f64 = 2.0;

/// A prepared retry policy.
#[derive(Debug, Clone)]
pub struct Retry {
    pub max_retries: u32,
    initial_delay_ms: f64,
    backoff_factor: f64,
    abort_signal: Option<CancellationToken>,
}

/// `prepareRetries`: the retry count (2 unless given) and the policy. A count that
/// is negative is refused.
pub fn prepare_retries(
    max_retries: Option<i64>,
    abort_signal: Option<CancellationToken>,
) -> Result<Retry, InvalidArgumentError> {
    if let Some(n) = max_retries
        && n < 0
    {
        return Err(InvalidArgumentError::new(
            "maxRetries",
            json!(n),
            "maxRetries must be >= 0",
        ));
    }
    Ok(Retry {
        max_retries: max_retries.map(|n| n as u32).unwrap_or(DEFAULT_MAX_RETRIES),
        initial_delay_ms: INITIAL_DELAY_MS,
        backoff_factor: BACKOFF_FACTOR,
        abort_signal,
    })
}

/// `parseFloat`: the longest number at the start of the text, or `None` for NaN.
fn parse_float(text: &str) -> Option<f64> {
    let trimmed = text.trim_start();
    let bytes = trimmed.as_bytes();
    let mut end = 0;
    if end < bytes.len() && (bytes[end] == b'+' || bytes[end] == b'-') {
        end += 1;
    }
    if trimmed[end..].starts_with("Infinity") {
        let sign = if trimmed.starts_with('-') { -1.0 } else { 1.0 };
        return Some(sign * f64::INFINITY);
    }
    let digits_start = end;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'.' {
        end += 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
    }
    let mantissa = &trimmed[digits_start..end];
    if mantissa.is_empty() || mantissa == "." {
        return None;
    }
    if end < bytes.len() && (bytes[end] == b'e' || bytes[end] == b'E') {
        let mut exp_end = end + 1;
        if exp_end < bytes.len() && (bytes[exp_end] == b'+' || bytes[exp_end] == b'-') {
            exp_end += 1;
        }
        let exp_digits = exp_end;
        while exp_end < bytes.len() && bytes[exp_end].is_ascii_digit() {
            exp_end += 1;
        }
        if exp_end > exp_digits {
            end = exp_end;
        }
    }
    trimmed[..end].parse::<f64>().ok()
}

/// How long to wait before the next attempt: the provider's own figure when it is
/// sane (under a minute, or under the backoff), else the backoff.
fn retry_delay_ms(error: &anyhow::Error, exponential_backoff_delay: f64) -> f64 {
    let Some(headers) = error
        .downcast_ref::<ApiCallError>()
        .and_then(|e| e.response_headers.as_ref())
    else {
        return exponential_backoff_delay;
    };
    let mut ms: Option<f64> = None;
    if let Some(value) = headers.get("retry-after-ms").filter(|v| !v.is_empty())
        && let Some(parsed) = parse_float(value)
    {
        ms = Some(parsed);
    }
    if let Some(value) = headers.get("retry-after").filter(|v| !v.is_empty())
        && ms.is_none()
    {
        ms = match parse_float(value) {
            Some(seconds) => Some(seconds * 1000.0),
            None => chrono::DateTime::parse_from_rfc2822(value)
                .ok()
                .map(|date| (date.timestamp_millis() - crate::support::now_ms()) as f64),
        };
    }
    match ms {
        Some(ms)
            if !ms.is_nan() && ms >= 0.0 && (ms < 60_000.0 || ms < exponential_backoff_delay) =>
        {
            ms
        }
        _ => exponential_backoff_delay,
    }
}

fn should_retry(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<ApiCallError>()
        .is_some_and(|e| e.is_retryable)
}

/// `delay(ms, { abortSignal })`.
async fn delay(ms: f64, abort: Option<&CancellationToken>) -> anyhow::Result<()> {
    if abort.is_some_and(|t| t.is_cancelled()) {
        return Err(AbortError::delay().into());
    }
    let duration = Duration::from_micros((ms.max(0.0) * 1000.0) as u64);
    match abort {
        Some(token) => tokio::select! {
            _ = tokio::time::sleep(duration) => Ok(()),
            _ = token.cancelled() => Err(AbortError::delay().into()),
        },
        None => {
            tokio::time::sleep(duration).await;
            Ok(())
        }
    }
}

impl Retry {
    /// Runs `f` until it succeeds, retrying a retryable `ApiCallError`. An abort is
    /// returned as it is; with retries disabled, or a non-retryable first error,
    /// the error is returned unwrapped; otherwise a `RetryError` holds every error.
    pub async fn run<T, F, Fut>(&self, mut f: F) -> anyhow::Result<T>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = anyhow::Result<T>>,
    {
        let mut errors: Vec<Arc<anyhow::Error>> = Vec::new();
        let mut delay_ms = self.initial_delay_ms;
        loop {
            let error = match f().await {
                Ok(value) => return Ok(value),
                Err(error) => error,
            };
            if is_abort_error(&error) || self.max_retries == 0 {
                return Err(error);
            }
            let message = get_error_message(&error);
            let retryable = should_retry(&error);
            let wait = retry_delay_ms(&error, delay_ms);
            errors.push(Arc::new(error));
            let try_number = errors.len();
            if try_number > self.max_retries as usize {
                return Err(RetryError::new(
                    format!("Failed after {try_number} attempts. Last error: {message}"),
                    RetryErrorReason::MaxRetriesExceeded,
                    errors,
                )
                .into());
            }
            if retryable {
                delay(wait, self.abort_signal.as_ref()).await?;
                delay_ms *= self.backoff_factor;
                continue;
            }
            if try_number == 1 {
                let only = errors.pop().expect("one error");
                return Err(Arc::try_unwrap(only)
                    .unwrap_or_else(|shared| anyhow::anyhow!(shared.to_string())));
            }
            return Err(RetryError::new(
                format!("Failed after {try_number} attempts with non-retryable error: '{message}'"),
                RetryErrorReason::ErrorNotRetryable,
                errors,
            )
            .into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::time::Instant;

    fn api_error(status: u16, headers: &[(&str, &str)]) -> anyhow::Error {
        let mut error = ApiCallError::new(
            "Overloaded",
            "https://example.com",
            json!({}),
            Some(status),
            None,
            None,
        );
        if !headers.is_empty() {
            error.response_headers = Some(
                headers
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect::<IndexMap<_, _>>(),
            );
        }
        error.into()
    }

    #[tokio::test(start_paused = true)]
    async fn backs_off_two_then_four_seconds_and_wraps_the_errors() {
        let retry = prepare_retries(None, None).unwrap();
        let attempts = AtomicUsize::new(0);
        let started = Instant::now();
        let err = retry
            .run(|| {
                attempts.fetch_add(1, Ordering::SeqCst);
                async { Err::<(), _>(api_error(529, &[])) }
            })
            .await
            .unwrap_err();
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert_eq!(started.elapsed(), Duration::from_millis(6000));
        let retry_error = err.downcast_ref::<RetryError>().unwrap();
        assert_eq!(retry_error.reason, RetryErrorReason::MaxRetriesExceeded);
        assert_eq!(retry_error.errors.len(), 3);
        assert_eq!(
            err.to_string(),
            "Failed after 3 attempts. Last error: AI_APICallError: Overloaded"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn honors_retry_after_headers() {
        let retry = prepare_retries(Some(1), None).unwrap();
        let attempts = AtomicUsize::new(0);
        let started = Instant::now();
        let value = retry
            .run(|| {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        Err(api_error(429, &[("retry-after-ms", "150")]))
                    } else {
                        Ok(7)
                    }
                }
            })
            .await
            .unwrap();
        assert_eq!(value, 7);
        assert_eq!(started.elapsed(), Duration::from_millis(150));

        let started = Instant::now();
        let attempts = AtomicUsize::new(0);
        retry
            .run(|| {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        Err(api_error(503, &[("retry-after", "3")]))
                    } else {
                        Ok(())
                    }
                }
            })
            .await
            .unwrap();
        assert_eq!(started.elapsed(), Duration::from_millis(3000));
    }

    #[tokio::test(start_paused = true)]
    async fn ignores_a_retry_after_past_a_minute() {
        let retry = prepare_retries(Some(1), None).unwrap();
        let attempts = AtomicUsize::new(0);
        let started = Instant::now();
        retry
            .run(|| {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        Err(api_error(429, &[("retry-after", "120")]))
                    } else {
                        Ok(())
                    }
                }
            })
            .await
            .unwrap();
        assert_eq!(started.elapsed(), Duration::from_millis(2000));
    }

    #[tokio::test]
    async fn returns_a_non_retryable_first_error_unwrapped() {
        let retry = prepare_retries(None, None).unwrap();
        let err = retry
            .run(|| async { Err::<(), _>(api_error(400, &[])) })
            .await
            .unwrap_err();
        assert!(err.downcast_ref::<ApiCallError>().is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn wraps_a_non_retryable_error_after_a_retry() {
        let retry = prepare_retries(None, None).unwrap();
        let attempts = AtomicUsize::new(0);
        let err = retry
            .run(|| {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    Err::<(), _>(if n == 0 {
                        api_error(500, &[])
                    } else {
                        api_error(400, &[])
                    })
                }
            })
            .await
            .unwrap_err();
        let retry_error = err.downcast_ref::<RetryError>().unwrap();
        assert_eq!(retry_error.reason, RetryErrorReason::ErrorNotRetryable);
        assert_eq!(
            err.to_string(),
            "Failed after 2 attempts with non-retryable error: 'AI_APICallError: Overloaded'"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stops_waiting_when_aborted() {
        let token = CancellationToken::new();
        let retry = prepare_retries(None, Some(token.clone())).unwrap();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            cancel.cancel();
        });
        let err = retry
            .run(|| async { Err::<(), _>(api_error(500, &[])) })
            .await
            .unwrap_err();
        assert_eq!(
            err.downcast_ref::<AbortError>().unwrap().message,
            "Delay was aborted"
        );
    }

    #[test]
    fn parses_floats_as_javascript_does() {
        assert_eq!(parse_float("1.5s"), Some(1.5));
        assert_eq!(parse_float(" 20"), Some(20.0));
        assert_eq!(parse_float("abc"), None);
        assert_eq!(parse_float("2e3"), Some(2000.0));
    }
}
