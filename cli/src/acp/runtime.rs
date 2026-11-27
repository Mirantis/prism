//! The Prism runtime as the ACP bridge uses it: the chat socket for sending and
//! for the event stream, and REST for conversations, history and uploads.

use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::rpc::RpcError;
use crate::config::{base_url, ws_url_from_http_url};
use crate::protocol::{
    OutgoingMessage, ThreadSummary, TuiMessage, coerce_message, coerce_thread_summary,
};
use crate::ws_client::{WsClient, WsEvent};

/// The most messages one `GET /messages` page holds.
pub const HISTORY_PAGE: usize = 200;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

pub struct Runtime {
    http_url: String,
    http: reqwest::Client,
    socket: WsClient,
}

impl Runtime {
    pub fn connect(
        http_url: &str,
        version: &str,
        events: mpsc::UnboundedSender<WsEvent>,
    ) -> Runtime {
        let http_url = base_url(http_url);
        let socket = WsClient::connect(
            ws_url_from_http_url(&http_url),
            "prism-acp",
            version,
            events,
        );
        Runtime {
            http_url,
            http: reqwest::Client::new(),
            socket,
        }
    }

    /// A response with a 2xx status, or with `allowed`. Anything else is the request's error.
    async fn request(
        &self,
        req: reqwest::RequestBuilder,
        allowed: Option<u16>,
    ) -> Result<reqwest::Response, RpcError> {
        let res = req.timeout(REQUEST_TIMEOUT).send().await.map_err(|_| {
            RpcError::internal(&format!(
                "the Prism server at {} did not answer",
                self.http_url
            ))
        })?;
        let status = res.status().as_u16();
        if res.status().is_success() || Some(status) == allowed {
            return Ok(res);
        }
        let body: Option<Value> = res.json().await.ok();
        let reason = body
            .as_ref()
            .and_then(|b| b.get("error"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("status {status}"));
        Err(RpcError::internal(&format!(
            "the Prism server refused the request: {reason}"
        )))
    }

    async fn json(res: reqwest::Response) -> Result<Value, RpcError> {
        res.json()
            .await
            .map_err(|e| RpcError::internal(&e.to_string()))
    }

    /// The string `key` of the answer to `req`.
    async fn string_field(
        &self,
        req: reqwest::RequestBuilder,
        key: &str,
    ) -> Result<String, RpcError> {
        let body = Self::json(self.request(req, None).await?).await?;
        Ok(body
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    }

    /// Start a conversation whose shell and file tools work in `cwd`.
    pub async fn create_thread(&self, cwd: &str) -> Result<String, RpcError> {
        let req = self
            .http
            .post(format!("{}/threads", self.http_url))
            .json(&json!({ "workspaceRoot": cwd }));
        self.string_field(req, "threadId").await
    }

    /// The newest conversations, or with `workspace_root` the newest of those rooted in that folder.
    pub async fn list_threads(
        &self,
        workspace_root: Option<&str>,
    ) -> Result<Vec<ThreadSummary>, RpcError> {
        let mut req = self.http.get(format!("{}/threads", self.http_url));
        if let Some(root) = workspace_root {
            req = req.query(&[("workspaceRoot", root)]);
        }
        let body = Self::json(self.request(req, None).await?).await?;
        Ok(body
            .as_array()
            .map(|a| a.iter().filter_map(coerce_thread_summary).collect())
            .unwrap_or_default())
    }

    /// One page of a conversation, oldest first: its newest messages, or the ones
    /// before `before`. `None` when the runtime has no such conversation.
    pub async fn messages(
        &self,
        thread_id: &str,
        before: Option<&str>,
    ) -> Result<Option<Vec<TuiMessage>>, RpcError> {
        let mut query = vec![
            ("threadId", thread_id.to_string()),
            ("limit", HISTORY_PAGE.to_string()),
        ];
        if let Some(b) = before {
            query.push(("before", b.to_string()));
        }
        let req = self
            .http
            .get(format!("{}/messages", self.http_url))
            .query(&query);
        let res = self.request(req, Some(404)).await?;
        if res.status().as_u16() == 404 {
            return Ok(None);
        }
        let body = Self::json(res).await?;
        Ok(Some(
            body.as_array()
                .map(|a| a.iter().filter_map(coerce_message).collect())
                .unwrap_or_default(),
        ))
    }

    /// Store a file for a message to name, and return its attachment id.
    pub async fn upload(&self, data: Vec<u8>, filename: &str) -> Result<String, RpcError> {
        let part = reqwest::multipart::Part::bytes(data).file_name(filename.to_string());
        let req = self
            .http
            .post(format!("{}/agents/attachments", self.http_url))
            .multipart(reqwest::multipart::Form::new().part("file", part));
        self.string_field(req, "id").await
    }

    /// Where a client downloads a stored attachment.
    pub fn attachment_url(&self, attachment_id: &str) -> String {
        format!("{}/agents/attachments/{attachment_id}", self.http_url)
    }

    pub fn send(&self, message: OutgoingMessage) {
        self.socket.send(message);
    }

    /// Stop a conversation's work. False when the socket is down, so nothing was asked.
    pub fn cancel(&self, thread_id: &str) -> bool {
        self.socket.cancel(thread_id)
    }

    pub fn close(&self) {
        self.socket.close();
    }
}
