//! Retires a Slack Socket Mode app for good, so its client opens no socket again.
//!
//! `disconnect()` closes the client's socket. A reconnect that already started
//! keeps retrying `apps.connections.open`, and it opens a socket when Slack
//! answers. The client's requests go through `retirable_fetch`, so a retired
//! client gets no answer and its reconnect waits for ever. A request resolves
//! when the headers arrive, and the client reads the body later, so the gate
//! reads the body first and answers with a copy of the response.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use bytes::Bytes;
use http::{HeaderMap, StatusCode};

/// A response whose body was read before the retire gate let it through.
#[derive(Debug, Clone)]
pub struct FetchedResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

/// A fetch for one Socket Mode client, and the switch that retires it.
#[derive(Clone)]
pub struct RetirableFetch {
    client: reqwest::Client,
    retired: Arc<AtomicBool>,
}

impl RetirableFetch {
    /// Sends `request`. Once retired, the call never resolves, whether the
    /// retire came before the request, before its body arrived, or before its
    /// error was reported.
    pub async fn fetch(&self, request: reqwest::Request) -> reqwest::Result<FetchedResponse> {
        if self.is_retired() {
            return std::future::pending().await;
        }
        let result = async {
            let response = self.client.execute(request).await?;
            let status = response.status();
            let headers = response.headers().clone();
            let body = response.bytes().await?;
            Ok(FetchedResponse {
                status,
                headers,
                body,
            })
        }
        .await;
        if self.is_retired() {
            return std::future::pending().await;
        }
        result
    }

    /// Retires the client: every request in flight or to come gets no answer.
    pub fn retire(&self) {
        self.retired.store(true, Ordering::SeqCst);
    }

    pub fn is_retired(&self) -> bool {
        self.retired.load(Ordering::SeqCst)
    }

    /// The HTTP client requests are built with.
    pub fn client(&self) -> reqwest::Client {
        self.client.clone()
    }
}

pub fn retirable_fetch(client: reqwest::Client) -> RetirableFetch {
    RetirableFetch {
        client,
        retired: Arc::new(AtomicBool::new(false)),
    }
}

/// The part of a Socket Mode app that retiring it stops.
#[async_trait]
pub trait StoppableApp: Send + Sync {
    async fn stop(&self) -> anyhow::Result<()>;
}

/// The part of a Socket Mode client that retiring it touches.
pub trait RetiringClient: Send + Sync {
    fn remove_all_listeners(&self, event: &str);
}

/// Retires the client's requests, then stops `app`. A reconnect of the client
/// runs `start()`, which waits for Slack's hello and fails, with no handler, when
/// the client reports `disconnected`. That failure ends the process, and a
/// stopped client reports `disconnected`, so the listener goes before the stop.
pub async fn retire_socket_app(
    app: &dyn StoppableApp,
    client: &dyn RetiringClient,
    retire: impl FnOnce(),
) -> anyhow::Result<()> {
    retire();
    client.remove_all_listeners("disconnected");
    app.stop().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    struct Recorder(Arc<Mutex<Vec<String>>>);

    #[async_trait]
    impl StoppableApp for Recorder {
        async fn stop(&self) -> anyhow::Result<()> {
            self.0.lock().push("stop".into());
            Ok(())
        }
    }

    impl RetiringClient for Recorder {
        fn remove_all_listeners(&self, event: &str) {
            self.0.lock().push(format!("remove {event}"));
        }
    }

    #[tokio::test]
    async fn retires_then_drops_the_disconnected_listeners_then_stops() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let app = Recorder(log.clone());
        let retired = log.clone();
        retire_socket_app(&app, &app, move || retired.lock().push("retire".into()))
            .await
            .unwrap();
        assert_eq!(*log.lock(), vec!["retire", "remove disconnected", "stop"]);
    }

    #[tokio::test]
    async fn a_retired_fetch_never_answers() {
        let fetch = retirable_fetch(reqwest::Client::new());
        fetch.retire();
        let request = fetch.client().get("http://127.0.0.1:9/").build().unwrap();
        let answered =
            tokio::time::timeout(std::time::Duration::from_millis(50), fetch.fetch(request)).await;
        assert!(answered.is_err());
    }
}
