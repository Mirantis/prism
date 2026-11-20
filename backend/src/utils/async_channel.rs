//! AsyncChannel: a bridge between push-based callbacks and pull-based async iteration.
//!
//! The producer calls `push(value)` / `close()` / `error()`. The consumer reads with
//! `next()` or `stream()`. Single-consumer only: concurrent readers interfere
//! with each other.

use std::collections::VecDeque;
use std::sync::Arc;

use futures::Stream;
use parking_lot::Mutex;
use tokio::sync::Notify;

struct State<T> {
    queue: VecDeque<T>,
    done: bool,
    err: Option<anyhow::Error>,
}

pub struct AsyncChannel<T> {
    state: Mutex<State<T>>,
    wake: Notify,
}

impl<T> Default for AsyncChannel<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> AsyncChannel<T> {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                queue: VecDeque::new(),
                done: false,
                err: None,
            }),
            wake: Notify::new(),
        }
    }

    /// Queues a value; ignored once the channel is closed.
    pub fn push(&self, value: T) {
        {
            let mut state = self.state.lock();
            if state.done {
                return;
            }
            state.queue.push_back(value);
        }
        self.wake.notify_one();
    }

    /// Ends the stream once the queued values are read.
    pub fn close(&self) {
        self.state.lock().done = true;
        self.wake.notify_one();
    }

    /// Ends the stream with `err` once the queued values are read.
    pub fn error(&self, err: anyhow::Error) {
        {
            let mut state = self.state.lock();
            state.err = Some(err);
            state.done = true;
        }
        self.wake.notify_one();
    }

    /// The next value, the error the channel ended with, or `None` once it ended.
    pub async fn next(&self) -> Option<anyhow::Result<T>> {
        loop {
            let notified = self.wake.notified();
            {
                let mut state = self.state.lock();
                if let Some(value) = state.queue.pop_front() {
                    return Some(Ok(value));
                }
                if state.done {
                    return state.err.take().map(Err);
                }
            }
            notified.await;
        }
    }
}

impl<T: Send + 'static> AsyncChannel<T> {
    /// The values as a stream, ending after the error the channel ended with.
    pub fn stream(self: Arc<Self>) -> impl Stream<Item = anyhow::Result<T>> + Send + 'static {
        futures::stream::unfold(self, |channel| async move {
            let item = channel.next().await?;
            Some((item, channel))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    #[tokio::test]
    async fn yields_queued_values_then_the_error() {
        let channel = Arc::new(AsyncChannel::new());
        let producer = channel.clone();
        tokio::spawn(async move {
            producer.push(1);
            producer.push(2);
            producer.error(anyhow::anyhow!("boom"));
            producer.push(3);
        });
        let items: Vec<String> = channel
            .stream()
            .map(|item| match item {
                Ok(v) => v.to_string(),
                Err(e) => e.to_string(),
            })
            .collect()
            .await;
        assert_eq!(items, ["1", "2", "boom"]);
    }

    async fn drain(channel: Arc<AsyncChannel<i32>>) -> (Vec<i32>, Option<String>) {
        let mut values = Vec::new();
        while let Some(item) = channel.next().await {
            match item {
                Ok(value) => values.push(value),
                Err(err) => return (values, Some(err.to_string())),
            }
        }
        (values, None)
    }

    #[tokio::test]
    async fn yields_values_pushed_before_iteration() {
        let channel = Arc::new(AsyncChannel::new());
        channel.push(1);
        channel.push(2);
        channel.close();
        assert_eq!(drain(channel).await, (vec![1, 2], None));
    }

    #[tokio::test]
    async fn yields_values_pushed_during_iteration() {
        let channel = Arc::new(AsyncChannel::new());
        let consumer = tokio::spawn(drain(channel.clone()));
        channel.push(1);
        channel.push(2);
        tokio::task::yield_now().await;
        channel.push(3);
        channel.close();
        assert_eq!(consumer.await.unwrap(), (vec![1, 2, 3], None));
    }

    #[tokio::test]
    async fn ends_at_once_when_closed_with_no_values() {
        let channel: Arc<AsyncChannel<i32>> = Arc::new(AsyncChannel::new());
        channel.close();
        assert_eq!(drain(channel).await, (vec![], None));
    }

    #[tokio::test]
    async fn ends_with_the_error_after_the_values_before_it() {
        let channel = Arc::new(AsyncChannel::new());
        channel.push(1);
        channel.error(anyhow::anyhow!("boom"));
        assert_eq!(drain(channel).await, (vec![1], Some("boom".to_string())));
    }

    #[tokio::test]
    async fn ends_with_an_error_set_while_the_consumer_waits() {
        let channel: Arc<AsyncChannel<i32>> = Arc::new(AsyncChannel::new());
        let consumer = tokio::spawn(drain(channel.clone()));
        tokio::task::yield_now().await;
        channel.error(anyhow::anyhow!("failed"));
        assert_eq!(
            consumer.await.unwrap(),
            (vec![], Some("failed".to_string()))
        );
    }

    #[tokio::test]
    async fn ignores_pushes_after_close() {
        let channel = Arc::new(AsyncChannel::new());
        channel.push(1);
        channel.close();
        channel.push(2);
        assert_eq!(drain(channel).await, (vec![1], None));
    }

    #[tokio::test]
    async fn ignores_pushes_after_an_error() {
        let channel = Arc::new(AsyncChannel::new());
        channel.push(1);
        channel.error(anyhow::anyhow!("err"));
        channel.push(2);
        assert_eq!(drain(channel).await, (vec![1], Some("err".to_string())));
    }
}
