//! HTTP client for the agent-runtime management API.
//!
//! Every endpoint resolves the single agent server-side, so no agent id or user
//! id appears in a URL. A non-2xx answer is an `ApiError` with the body's
//! `error` or `detail` text when it has one.

use std::path::Path;
use std::time::Duration;

use reqwest::Method;
use serde_json::{Value, json};

use crate::attachments::{MAX_ATTACHMENT_BYTES, format_file_size};
use crate::protocol::AttachmentMeta;

#[derive(Clone, Debug)]
pub struct ApiError {
    pub message: String,
    /// The HTTP status, or `None` when the request did not get an answer.
    pub status: Option<u16>,
    pub detail: Option<String>,
}

impl ApiError {
    fn local(message: impl Into<String>) -> ApiError {
        ApiError {
            message: message.into(),
            status: None,
            detail: None,
        }
    }
    /// `err.detail ?? err.message`.
    pub fn detail_or_message(&self) -> String {
        self.detail.clone().unwrap_or_else(|| self.message.clone())
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

fn s(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn opt_s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}
fn num(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}
fn boolean(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone, Debug, Default)]
pub struct AgentDetails {
    pub raw: Value,
    pub name: String,
    pub model: Option<String>,
    pub heartbeat_model: Option<String>,
    pub cron_model: Option<String>,
    pub timezone: String,
    pub heartbeat_interval_ms: f64,
    pub heartbeat_status: String,
}

impl AgentDetails {
    fn parse(v: Value) -> AgentDetails {
        AgentDetails {
            name: s(&v, "name"),
            model: opt_s(&v, "model"),
            heartbeat_model: opt_s(&v, "heartbeatModel"),
            cron_model: opt_s(&v, "cronModel"),
            timezone: s(&v, "timezone"),
            heartbeat_interval_ms: num(&v, "heartbeatIntervalMs"),
            heartbeat_status: s(&v, "heartbeatStatus"),
            raw: v,
        }
    }
    /// One of the seven workspace documents, by its field name.
    pub fn doc(&self, field: &str) -> String {
        match self.raw.get(field) {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct HeartbeatStatus {
    pub is_active: bool,
    pub last_run: Option<String>,
    pub is_running: bool,
    pub consecutive_errors: f64,
    pub interval_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CronTask {
    pub id: String,
    pub name: String,
    pub schedule: String,
    pub recurring: bool,
    pub instruction: Option<String>,
    pub is_active: bool,
    pub next_run_at: Option<String>,
}

impl CronTask {
    fn parse(v: &Value) -> CronTask {
        CronTask {
            id: s(v, "id"),
            name: s(v, "name"),
            schedule: s(v, "schedule"),
            recurring: boolean(v, "recurring"),
            instruction: opt_s(v, "instruction"),
            is_active: boolean(v, "isActive"),
            next_run_at: opt_s(v, "nextRunAt"),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WebhookSubscription {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub events: Option<String>,
    pub prompt: Option<String>,
    pub deliver_to: String,
    pub slack_channel_ids: Vec<String>,
    pub deliver_only: bool,
    pub is_active: bool,
}

impl WebhookSubscription {
    fn parse(v: &Value) -> WebhookSubscription {
        WebhookSubscription {
            id: s(v, "id"),
            name: s(v, "name"),
            description: opt_s(v, "description"),
            events: opt_s(v, "events"),
            prompt: opt_s(v, "prompt"),
            deliver_to: s(v, "deliverTo"),
            slack_channel_ids: strings(v, "slackChannelIds"),
            deliver_only: boolean(v, "deliverOnly"),
            is_active: boolean(v, "isActive"),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SlackChannel {
    pub channel_id: String,
    pub channel_name: Option<String>,
    pub is_main: bool,
}

#[derive(Clone, Debug)]
pub struct Goal {
    pub id: String,
    pub objective: String,
    pub status: String,
    pub token_budget: Option<f64>,
    pub tokens_used: f64,
    pub turn_count: f64,
    pub max_turns: f64,
    pub last_reason: Option<String>,
}

impl Goal {
    fn parse(v: &Value) -> Goal {
        Goal {
            id: s(v, "id"),
            objective: s(v, "objective"),
            status: s(v, "status"),
            token_budget: v.get("tokenBudget").and_then(Value::as_f64),
            tokens_used: num(v, "tokensUsed"),
            turn_count: num(v, "turnCount"),
            max_turns: num(v, "maxTurns"),
            last_reason: opt_s(v, "lastReason"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub source: String,
    pub plugin_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PluginSummary {
    pub id: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub skills: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct UpdateAttempt {
    pub version_to: String,
    pub outcome: String,
    pub error_code: Option<String>,
    pub started_at: String,
}

#[derive(Clone, Debug)]
pub struct UpdateStatus {
    pub enabled: bool,
    pub reason: Option<String>,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub applying: bool,
    pub last_attempt: Option<UpdateAttempt>,
}

#[derive(Clone, Debug)]
pub struct ModelSelection {
    pub effective_mode: String,
    /// `(tier, effective model)` for small, medium and large, in that order.
    pub tiers: Vec<(String, Option<String>)>,
}

#[derive(Clone, Debug)]
pub struct LlmProviderStatus {
    pub provider: String,
    pub missing_settings: Vec<String>,
}

/// A model setting as the runtime answers it: the stored value and the one in force.
#[derive(Clone, Debug)]
pub struct ModelSetting {
    pub model: Option<String>,
    pub effective: String,
}

pub struct ApiClient {
    base: String,
    http: reqwest::Client,
}

impl ApiClient {
    pub fn new(http_url: &str) -> ApiClient {
        ApiClient {
            base: crate::config::base_url(http_url),
            http: reqwest::Client::new(),
        }
    }

    async fn request(&self, method: Method, path: &str, body: Option<Value>) -> ApiResult<Value> {
        let mut req = self
            .http
            .request(method.clone(), format!("{}{}", self.base, path));
        if method != Method::GET
            && let Some(body) = body
        {
            req = req.json(&body);
        }
        let res = req
            .send()
            .await
            .map_err(|e| ApiError::local(network_message(&e)))?;
        handle(res).await
    }

    async fn get(&self, path: &str) -> ApiResult<Value> {
        self.request(Method::GET, path, None).await
    }

    async fn get_list<T>(&self, path: &str, parse: impl Fn(&Value) -> T) -> ApiResult<Vec<T>> {
        Ok(list_of(&self.get(path).await?, parse))
    }

    async fn delete(&self, path: &str) -> ApiResult<()> {
        self.request(Method::DELETE, path, None).await?;
        Ok(())
    }

    pub async fn get_details(&self) -> ApiResult<AgentDetails> {
        let body = self.get("/agents/details").await?;
        Ok(AgentDetails::parse(
            body.get("agent").cloned().unwrap_or(Value::Null),
        ))
    }

    pub async fn set_name(&self, name: &str) -> ApiResult<String> {
        let body = self
            .request(Method::PATCH, "/agents/name", Some(json!({ "name": name })))
            .await?;
        Ok(s(&body, "name"))
    }

    pub async fn set_agent_guide(&self, agent_md: &str) -> ApiResult<()> {
        self.request(
            Method::PATCH,
            "/agents/agent-guide",
            Some(json!({ "agentMd": agent_md })),
        )
        .await?;
        Ok(())
    }

    pub async fn set_model(&self, model: Option<&str>) -> ApiResult<Option<String>> {
        let body = self
            .request(
                Method::PATCH,
                "/agents/model",
                Some(json!({ "model": model })),
            )
            .await?;
        Ok(opt_s(&body, "model"))
    }

    pub async fn get_llm_provider(&self) -> ApiResult<LlmProviderStatus> {
        let body = self.get("/agents/llm-provider").await?;
        Ok(LlmProviderStatus {
            provider: s(&body, "provider"),
            missing_settings: strings(&body, "missingSettings"),
        })
    }

    /// Set the model of one kind of run at `path` (`/agents/heartbeat-model`, `/agents/cron-model`).
    pub async fn set_model_setting(
        &self,
        path: &str,
        model: Option<&str>,
    ) -> ApiResult<ModelSetting> {
        let body = self
            .request(Method::PATCH, path, Some(json!({ "model": model })))
            .await?;
        Ok(ModelSetting {
            model: opt_s(&body, "model"),
            effective: s(&body, "effective"),
        })
    }

    fn parse_selection(body: &Value) -> ModelSelection {
        let effective_mode = body
            .get("mode")
            .and_then(|m| m.get("effective"))
            .and_then(Value::as_str)
            .unwrap_or("fixed")
            .to_string();
        let tiers = ["small", "medium", "large"]
            .iter()
            .map(|t| {
                let effective = body
                    .get("tiers")
                    .and_then(|ts| ts.get(*t))
                    .and_then(|tier| tier.get("effective"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                (t.to_string(), effective)
            })
            .collect();
        ModelSelection {
            effective_mode,
            tiers,
        }
    }

    pub async fn get_model_selection(&self) -> ApiResult<ModelSelection> {
        Ok(Self::parse_selection(
            &self.get("/agents/model-selection").await?,
        ))
    }

    pub async fn set_model_mode(&self, mode: &str) -> ApiResult<ModelSelection> {
        let body = self
            .request(
                Method::PATCH,
                "/agents/model-selection",
                Some(json!({ "mode": mode })),
            )
            .await?;
        Ok(Self::parse_selection(&body))
    }

    pub async fn get_heartbeat_status(&self) -> ApiResult<HeartbeatStatus> {
        let b = self.get("/agents/heartbeat/status").await?;
        Ok(HeartbeatStatus {
            is_active: boolean(&b, "isActive"),
            last_run: opt_s(&b, "lastRun"),
            is_running: boolean(&b, "isRunning"),
            consecutive_errors: num(&b, "consecutiveErrors"),
            interval_ms: b.get("intervalMs").and_then(Value::as_f64),
        })
    }

    pub async fn start_heartbeat(&self, agent: &AgentDetails) -> ApiResult<String> {
        let body = self
            .request(
                Method::POST,
                "/agents/heartbeat/start",
                Some(json!({ "agent": agent.raw })),
            )
            .await?;
        Ok(s(&body, "message"))
    }

    pub async fn stop_heartbeat(&self) -> ApiResult<String> {
        let body = self
            .request(Method::POST, "/agents/heartbeat/stop", None)
            .await?;
        Ok(s(&body, "message"))
    }

    pub async fn trigger_heartbeat(&self) -> ApiResult<bool> {
        let body = self
            .request(Method::POST, "/agents/heartbeat/trigger", None)
            .await?;
        Ok(boolean(&body, "success"))
    }

    pub async fn set_heartbeat_interval(&self, interval_ms: f64) -> ApiResult<Option<f64>> {
        let body = self
            .request(
                Method::PATCH,
                "/agents/heartbeat/interval",
                Some(json!({ "intervalMs": interval_ms })),
            )
            .await?;
        Ok(body.get("intervalMs").and_then(Value::as_f64))
    }

    pub async fn list_cron_tasks(&self) -> ApiResult<Vec<CronTask>> {
        self.get_list("/agents/cron-tasks", CronTask::parse).await
    }

    pub async fn create_cron_task(
        &self,
        name: &str,
        schedule: &str,
        instruction: &str,
    ) -> ApiResult<()> {
        self.request(
            Method::POST,
            "/agents/cron-tasks",
            Some(json!({ "name": name, "schedule": schedule, "instruction": instruction })),
        )
        .await?;
        Ok(())
    }

    pub async fn update_cron_task(&self, id: &str, changes: Value) -> ApiResult<()> {
        self.request(
            Method::PATCH,
            &format!("/agents/cron-tasks/{id}"),
            Some(changes),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_cron_task(&self, id: &str) -> ApiResult<()> {
        self.delete(&format!("/agents/cron-tasks/{id}")).await
    }

    pub async fn list_webhook_subscriptions(&self) -> ApiResult<Vec<WebhookSubscription>> {
        self.get_list("/agents/webhook-subscriptions", WebhookSubscription::parse)
            .await
    }

    pub async fn update_webhook_subscription(
        &self,
        id: &str,
        update: Value,
    ) -> ApiResult<WebhookSubscription> {
        let path = format!("/agents/webhook-subscriptions/{}", encode_component(id));
        let body = self.request(Method::PATCH, &path, Some(update)).await?;
        Ok(WebhookSubscription::parse(&body))
    }

    pub async fn list_slack_channels(&self) -> ApiResult<Vec<SlackChannel>> {
        let body = self.get("/agents/slack-channel-mappings").await?;
        Ok(body
            .get("channels")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|c| SlackChannel {
                        channel_id: s(c, "channelId"),
                        channel_name: opt_s(c, "channelName"),
                        is_main: boolean(c, "isMain"),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn create_goal(&self, thread_id: &str, objective: &str) -> ApiResult<Goal> {
        let body = self
            .request(
                Method::POST,
                "/agents/goals",
                Some(json!({ "threadId": thread_id, "objective": objective, "originChannel": "websocket" })),
            )
            .await?;
        Ok(Goal::parse(&body))
    }

    pub async fn get_thread_goal(&self, thread_id: &str) -> ApiResult<Option<Goal>> {
        let body = self
            .get(&format!("/agents/threads/{thread_id}/goal"))
            .await?;
        Ok(if body.is_object() {
            Some(Goal::parse(&body))
        } else {
            None
        })
    }

    pub async fn list_goals(&self) -> ApiResult<Vec<Goal>> {
        self.get_list("/agents/goals", Goal::parse).await
    }

    async fn goal_action(&self, method: Method, path: String) -> ApiResult<Goal> {
        Ok(Goal::parse(&self.request(method, &path, None).await?))
    }

    pub async fn stop_goal(&self, id: &str) -> ApiResult<Goal> {
        self.goal_action(Method::DELETE, format!("/agents/goals/{id}"))
            .await
    }

    pub async fn pause_goal(&self, id: &str) -> ApiResult<Goal> {
        self.goal_action(Method::POST, format!("/agents/goals/{id}/pause"))
            .await
    }

    pub async fn resume_goal(&self, id: &str) -> ApiResult<Goal> {
        self.goal_action(Method::POST, format!("/agents/goals/{id}/resume"))
            .await
    }

    /// Upload a local file as a shared attachment, after the local checks.
    pub async fn upload_attachment(&self, file_path: &Path) -> ApiResult<AttachmentMeta> {
        let shown = file_path.display().to_string();
        let meta = std::fs::metadata(file_path)
            .map_err(|_| ApiError::local(format!("File not found: {shown}")))?;
        if meta.is_dir() {
            return Err(ApiError::local(format!(
                "{shown} is a directory — attach a single file."
            )));
        }
        let size = meta.len() as f64;
        if size > MAX_ATTACHMENT_BYTES {
            return Err(ApiError::local(format!(
                "File too large ({}) — max {}.",
                format_file_size(size),
                format_file_size(MAX_ATTACHMENT_BYTES)
            )));
        }
        if size == 0.0 {
            return Err(ApiError::local(format!("File is empty: {shown}")));
        }
        let data = tokio::fs::read(file_path)
            .await
            .map_err(|e| ApiError::local(e.to_string()))?;
        let filename = file_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let body = self.upload(data, &filename).await?;
        AttachmentMeta::parse(&body)
            .ok_or_else(|| ApiError::local("The runtime answered without the file's metadata."))
    }

    /// Store bytes as an attachment and return the runtime's answer.
    pub async fn upload(&self, data: Vec<u8>, filename: &str) -> ApiResult<Value> {
        let part = reqwest::multipart::Part::bytes(data).file_name(filename.to_string());
        let form = reqwest::multipart::Form::new().part("file", part);
        let res = self
            .http
            .post(format!("{}/agents/attachments", self.base))
            .multipart(form)
            .send()
            .await
            .map_err(|e| ApiError::local(network_message(&e)))?;
        handle(res).await
    }

    pub async fn delete_attachment(&self, id: &str) -> ApiResult<()> {
        self.delete(&format!("/agents/attachments/{id}")).await
    }

    /// A stored attachment's bytes.
    pub async fn download_attachment(&self, id: &str) -> ApiResult<Vec<u8>> {
        let res = self
            .http
            .get(format!("{}/agents/attachments/{id}", self.base))
            .send()
            .await
            .map_err(|e| ApiError::local(network_message(&e)))?;
        if !res.status().is_success() {
            return Err(error_of(res).await);
        }
        res.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| ApiError::local(e.to_string()))
    }

    pub async fn list_skills(&self, thread_id: Option<&str>) -> ApiResult<Vec<SkillSummary>> {
        let qs = thread_id
            .map(|t| format!("?threadId={}", encode_component(t)))
            .unwrap_or_default();
        let body = self.get(&format!("/agents/skills{qs}")).await?;
        Ok(list_of(&body, |v| SkillSummary {
            name: s(v, "name"),
            description: s(v, "description"),
            source: s(v, "source"),
            plugin_id: opt_s(v, "pluginId"),
        }))
    }

    pub async fn run_skill(&self, name: &str, thread_id: Option<&str>) -> ApiResult<String> {
        let body = match thread_id {
            Some(t) => json!({ "threadId": t }),
            None => json!({}),
        };
        let res = self
            .request(
                Method::POST,
                &format!("/agents/skills/{}/run", encode_component(name)),
                Some(body),
            )
            .await?;
        Ok(s(&res, "skill"))
    }

    pub async fn list_plugins(&self) -> ApiResult<Vec<PluginSummary>> {
        let body = self.get("/agents/plugins").await?;
        Ok(list_of(&body, |v| PluginSummary {
            id: s(v, "id"),
            version: opt_s(v, "version"),
            description: opt_s(v, "description"),
            skills: strings(v, "skills"),
            mcp_servers: strings(v, "mcpServers"),
            diagnostics: strings(v, "diagnostics"),
        }))
    }

    pub async fn compact_thread(&self, thread_id: &str) -> ApiResult<()> {
        self.request(
            Method::POST,
            &format!("/agents/threads/{}/compact", encode_component(thread_id)),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn sign_in_for_computer(
        &self,
        help_id: &str,
        username: &str,
        password: &str,
    ) -> ApiResult<()> {
        let path = format!(
            "/agents/computer/help/{}/credentials",
            encode_component(help_id)
        );
        self.request(
            Method::POST,
            &path,
            Some(json!({ "username": username, "password": password })),
        )
        .await?;
        Ok(())
    }

    pub async fn update_status(&self) -> ApiResult<UpdateStatus> {
        let b = self.get("/agents/update/status").await?;
        let last_attempt = b
            .get("lastAttempt")
            .filter(|a| a.is_object())
            .map(|a| UpdateAttempt {
                version_to: s(a, "versionTo"),
                outcome: s(a, "outcome"),
                error_code: opt_s(a, "errorCode"),
                started_at: s(a, "startedAt"),
            });
        Ok(UpdateStatus {
            enabled: boolean(&b, "enabled"),
            reason: opt_s(&b, "reason"),
            current_version: s(&b, "currentVersion"),
            latest_version: opt_s(&b, "latestVersion"),
            update_available: boolean(&b, "updateAvailable"),
            applying: boolean(&b, "applying"),
            last_attempt,
        })
    }

    pub async fn apply_update(&self) -> ApiResult<String> {
        let body = self.request(Method::POST, "/agents/update", None).await?;
        Ok(s(&body, "version"))
    }

    // ---- The chat session's own reads: a failure is `None`, never an error. ----

    /// `GET /agents/me`'s thread mode. `None` when the runtime did not answer.
    pub async fn thread_mode(&self) -> Option<crate::protocol::ThreadMode> {
        let res = self
            .http
            .get(format!("{}/agents/me", self.base))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        let body: Value = res.json().await.ok()?;
        Some(
            if body.get("threadMode").and_then(Value::as_str) == Some("single") {
                crate::protocol::ThreadMode::Single
            } else {
                crate::protocol::ThreadMode::Multi
            },
        )
    }

    /// Start a conversation rooted in `workspace_root`. `None` when the runtime could not.
    pub async fn create_thread(&self, workspace_root: &str) -> Option<String> {
        let res = self
            .http
            .post(format!("{}/threads", self.base))
            .json(&json!({ "workspaceRoot": workspace_root }))
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        let body: Value = res.json().await.ok()?;
        body.get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// The resumable conversations, newest first. Empty on any error.
    pub async fn list_threads(&self) -> Vec<crate::protocol::ThreadSummary> {
        let Ok(res) = self
            .http
            .get(format!("{}/threads", self.base))
            .timeout(Duration::from_secs(15))
            .send()
            .await
        else {
            return Vec::new();
        };
        if !res.status().is_success() {
            return Vec::new();
        }
        let Ok(body) = res.json::<Value>().await else {
            return Vec::new();
        };
        body.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(crate::protocol::coerce_thread_summary)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A thread's newest `limit` messages, oldest first. `None` when the runtime did not answer.
    pub async fn load_history(
        &self,
        thread_id: &str,
        limit: usize,
    ) -> Option<Vec<crate::protocol::TuiMessage>> {
        let res = self
            .http
            .get(format!("{}/messages", self.base))
            .query(&[
                ("limit", limit.to_string()),
                ("threadId", thread_id.to_string()),
            ])
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        let body: Value = res.json().await.ok()?;
        Some(
            body.as_array()?
                .iter()
                .filter_map(crate::protocol::coerce_message)
                .collect(),
        )
    }
}

/// Each element of a JSON array, read with `parse`. Anything but an array is empty.
fn list_of<T>(body: &Value, parse: impl Fn(&Value) -> T) -> Vec<T> {
    body.as_array()
        .map(|a| a.iter().map(parse).collect())
        .unwrap_or_default()
}

async fn handle(res: reqwest::Response) -> ApiResult<Value> {
    if !res.status().is_success() {
        return Err(error_of(res).await);
    }
    if res.status().as_u16() == 204 {
        return Ok(Value::Null);
    }
    let text = res
        .text()
        .await
        .map_err(|e| ApiError::local(e.to_string()))?;
    if text.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| ApiError::local(e.to_string()))
}

async fn error_of(res: reqwest::Response) -> ApiError {
    let status = res.status().as_u16();
    let detail = res.json::<Value>().await.ok().and_then(|body| {
        body.get("error")
            .and_then(Value::as_str)
            .or_else(|| body.get("detail").and_then(Value::as_str))
            .map(str::to_string)
    });
    ApiError {
        message: detail
            .clone()
            .unwrap_or_else(|| format!("Request failed with status {status}")),
        status: Some(status),
        detail,
    }
}

fn network_message(err: &reqwest::Error) -> String {
    if err.is_connect() || err.is_timeout() || err.is_request() {
        return "fetch failed".into();
    }
    err.to_string()
}

/// `encodeURIComponent`.
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b);
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
