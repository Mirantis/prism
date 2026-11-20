//! Sign in with ChatGPT (OAuth 2.0 Authorization Code + PKCE) for `LLM_PROVIDER=chatgpt`.
//!
//! Uses OpenAI's dynamic agent client registration flow (`client_id=dynamic_agent_client`
//! on first sign-in with `agent_name_hint=Prism` and a persistent `ext_agent_host_id`),
//! then keeps the issued `oaiapp_...` client ID and tokens in `runtime_state`. Access
//! tokens are scoped for `https://api.openai.com/v1` with `chatgpt.tokens.use.direct`,
//! so Prism calls the public OpenAI Responses API under the user's ChatGPT plan.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::config::{CONFIG, LlmProviderName};
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::log_warn;
use crate::services::runtime_state_service::{
    CHATGPT_AUTH_CLIENT_ID, CHATGPT_AUTH_HOST_ID, CHATGPT_AUTH_TOKENS, RUNTIME_STATE_SERVICE,
};

pub const CHATGPT_AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
pub const CHATGPT_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
pub const CHATGPT_DYNAMIC_CLIENT_ID: &str = "dynamic_agent_client";
pub const CHATGPT_AGENT_NAME_HINT: &str = "Prism";
pub const CHATGPT_API_RESOURCE: &str = "https://api.openai.com/v1";
pub const CHATGPT_DIRECT_USAGE_SCOPE: &str = "chatgpt.tokens.use.direct";
pub const CHATGPT_OAUTH_SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

/// Refresh the access token this many milliseconds before it expires.
const EXPIRY_BUFFER_MS: i64 = 60_000;
/// Upper bound on token endpoint requests, so a stalled auth server cannot hang every turn.
const TOKEN_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Pending browser PKCE attempts expire after 15 minutes.
pub const CHATGPT_PENDING_TTL_MS: i64 = 15 * 60_000;
const MAX_PENDING_ATTEMPTS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredChatGptTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Epoch milliseconds.
    pub expires_at: i64,
    pub scope: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptAuthStatus {
    pub enabled: bool,
    pub signed_in: bool,
    pub email: Option<String>,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct ChatGptCallbackParams {
    pub code: Option<String>,
    pub state: Option<String>,
    pub client_id: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// A sign-in or token failure with the HTTP status the route answers it with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ChatGptAuthError {
    pub message: String,
    pub status_code: u16,
}

fn auth_error(message: impl Into<String>, status_code: u16) -> anyhow::Error {
    ChatGptAuthError {
        message: message.into(),
        status_code,
    }
    .into()
}

#[derive(Debug, Clone)]
struct PendingAttempt {
    code_verifier: String,
    redirect_uri: String,
    client_id: String,
    is_dynamic_registration: bool,
    generation: u64,
    created_at: i64,
}

#[derive(Debug, Default, Deserialize)]
struct TokenEndpointResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<f64>,
    scope: Option<String>,
    id_token: Option<String>,
    client_id: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Default)]
struct State {
    tokens: Option<Arc<StoredChatGptTokens>>,
    client_id: Option<String>,
    generation: u64,
    pending: IndexMap<String, PendingAttempt>,
}

pub struct ChatGptAuthService {
    state: Mutex<State>,
    /// Commits and clears run one at a time, in order.
    persist: tokio::sync::Mutex<()>,
    /// One refresh at a time; a caller that waited reads the token it produced.
    refresh: tokio::sync::Mutex<()>,
    token_url: String,
    http: reqwest::Client,
}

fn now_ms() -> i64 {
    crate::support::now_ms()
}

fn owner() -> String {
    CONFIG.owner_user_id()
}

fn track(name: &str, props: &[(&str, String)]) {
    let props = props
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect();
    track_event(name, Some(&owner()), Some(props));
}

fn random_bytes() -> [u8; 32] {
    rand::random()
}

fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// The display email in an OIDC ID token's payload. The raw JWT is never logged or stored.
fn email_from_id_token(id_token: Option<&str>) -> Option<String> {
    let payload = id_token?.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let payload: Value = serde_json::from_slice(&bytes).ok()?;
    let email = payload.get("email")?.as_str()?.trim();
    (!email.is_empty()).then(|| email.to_string())
}

fn parse_stored_tokens(raw: Option<&str>) -> Option<StoredChatGptTokens> {
    let parsed: Value = serde_json::from_str(raw?).ok()?;
    let access_token = parsed
        .get("accessToken")?
        .as_str()
        .filter(|t| !t.is_empty())?;
    let expires_at = parsed
        .get("expiresAt")?
        .as_f64()
        .filter(|n| n.is_finite())?;
    let text = |key: &str| parsed.get(key).and_then(Value::as_str).map(str::to_string);
    Some(StoredChatGptTokens {
        access_token: access_token.to_string(),
        refresh_token: text("refreshToken").filter(|t| !t.is_empty()),
        expires_at: expires_at as i64,
        scope: text("scope"),
        email: text("email"),
    })
}

fn expires_at_from(expires_in: Option<f64>) -> i64 {
    let seconds = expires_in.filter(|s| *s > 0.0).unwrap_or(3600.0);
    now_ms() + (seconds * 1000.0) as i64
}

impl ChatGptAuthService {
    pub fn new() -> Self {
        Self::with_token_url(CHATGPT_TOKEN_URL)
    }

    fn with_token_url(token_url: &str) -> Self {
        ChatGptAuthService {
            state: Mutex::new(State::default()),
            persist: tokio::sync::Mutex::new(()),
            refresh: tokio::sync::Mutex::new(()),
            token_url: token_url.to_string(),
            http: reqwest::Client::builder()
                .timeout(TOKEN_REQUEST_TIMEOUT)
                .build()
                .expect("the token HTTP client builds"),
        }
    }

    /// Read the stored sign-in into memory at boot, so `is_signed_in` answers synchronously.
    pub async fn load(&self) {
        let loaded = async {
            let tokens = RUNTIME_STATE_SERVICE.get(CHATGPT_AUTH_TOKENS).await?;
            let client_id = RUNTIME_STATE_SERVICE.get(CHATGPT_AUTH_CLIENT_ID).await?;
            anyhow::Ok((tokens, client_id))
        }
        .await;
        match loaded {
            Ok((tokens, client_id)) => {
                let mut state = self.state.lock();
                state.tokens = parse_stored_tokens(tokens.as_deref()).map(Arc::new);
                state.client_id = client_id.filter(|id| !id.is_empty());
            }
            Err(err) => log_warn!(
                json!({ "err": err_json(&err) }),
                "[ChatGptAuth] could not load persisted auth state"
            ),
        }
    }

    pub fn is_signed_in(&self) -> bool {
        let state = self.state.lock();
        let Some(tokens) = &state.tokens else {
            return false;
        };
        (tokens.refresh_token.is_some() && state.client_id.is_some())
            || tokens.expires_at > now_ms()
    }

    pub fn status(&self) -> ChatGptAuthStatus {
        let signed_in = self.is_signed_in();
        let tokens = self.state.lock().tokens.clone().filter(|_| signed_in);
        ChatGptAuthStatus {
            enabled: CONFIG.llm_provider == LlmProviderName::Chatgpt,
            signed_in,
            email: tokens.as_ref().and_then(|t| t.email.clone()),
            expires_at: tokens.map(|t| t.expires_at),
        }
    }

    async fn host_id(&self) -> anyhow::Result<String> {
        if let Some(existing) = RUNTIME_STATE_SERVICE.get(CHATGPT_AUTH_HOST_ID).await? {
            return Ok(existing);
        }
        let created = format!("urn:uuid:{}", uuid::Uuid::new_v4());
        RUNTIME_STATE_SERVICE
            .set(CHATGPT_AUTH_HOST_ID, &created)
            .await?;
        Ok(created)
    }

    async fn client_id(&self) -> anyhow::Result<Option<String>> {
        if let Some(id) = self.state.lock().client_id.clone() {
            return Ok(Some(id));
        }
        let stored = RUNTIME_STATE_SERVICE
            .get(CHATGPT_AUTH_CLIENT_ID)
            .await?
            .filter(|id| !id.is_empty());
        self.state.lock().client_id = stored.clone();
        Ok(stored)
    }

    fn prune_pending(state: &mut State, now: i64) {
        state
            .pending
            .retain(|_, attempt| now - attempt.created_at <= CHATGPT_PENDING_TTL_MS);
    }

    /// Start a PKCE flow and return the browser authorization URL.
    pub async fn start_sign_in(&self, redirect_uri: &str) -> anyhow::Result<String> {
        let host_id = self.host_id().await?;
        let saved_client_id = self.client_id().await?;
        let is_dynamic_registration = saved_client_id.is_none();
        let client_id = saved_client_id.unwrap_or_else(|| CHATGPT_DYNAMIC_CLIENT_ID.to_string());

        let state_param = hex::encode(random_bytes());
        let nonce = hex::encode(random_bytes());
        let code_verifier = URL_SAFE_NO_PAD.encode(random_bytes());
        let challenge = code_challenge(&code_verifier);
        {
            let mut state = self.state.lock();
            Self::prune_pending(&mut state, now_ms());
            if state.pending.len() >= MAX_PENDING_ATTEMPTS {
                state.pending.shift_remove_index(0);
            }
            let generation = state.generation;
            state.pending.insert(
                state_param.clone(),
                PendingAttempt {
                    code_verifier,
                    redirect_uri: redirect_uri.to_string(),
                    client_id: client_id.clone(),
                    is_dynamic_registration,
                    generation,
                    created_at: now_ms(),
                },
            );
        }

        let mut url = url::Url::parse(CHATGPT_AUTHORIZE_URL)?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("client_id", &client_id);
            if is_dynamic_registration {
                query.append_pair("agent_name_hint", CHATGPT_AGENT_NAME_HINT);
            }
            query
                .append_pair("ext_agent_host_id", &host_id)
                .append_pair("response_type", "code")
                .append_pair("redirect_uri", redirect_uri)
                .append_pair("scope", CHATGPT_OAUTH_SCOPES)
                .append_pair("resource", CHATGPT_API_RESOURCE)
                .append_pair("state", &state_param)
                .append_pair("nonce", &nonce)
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256");
        }
        track(
            "chatgpt auth started",
            &[(
                "auth.dynamic_registration",
                is_dynamic_registration.to_string(),
            )],
        );
        Ok(url.into())
    }

    async fn post_token(&self, form: &[(&str, &str)]) -> (u16, TokenEndpointResponse) {
        match self.http.post(&self.token_url).form(form).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.json().await.unwrap_or_default();
                (status, body)
            }
            Err(err) => (
                0,
                TokenEndpointResponse {
                    error: Some(err.to_string()),
                    ..TokenEndpointResponse::default()
                },
            ),
        }
    }

    fn detail(status: u16, payload: &TokenEndpointResponse) -> String {
        payload
            .error_description
            .clone()
            .or_else(|| payload.error.clone())
            .unwrap_or_else(|| format!("HTTP {status}"))
    }

    /// Complete the OAuth callback, storing the issued client ID and tokens.
    pub async fn handle_callback(
        &self,
        params: ChatGptCallbackParams,
    ) -> anyhow::Result<ChatGptAuthStatus> {
        let fail = |reason: &str| track("chatgpt auth failed", &[("auth.reason", reason.into())]);
        let state_param = params.state.as_deref().map(str::trim).unwrap_or("");
        let attempt = {
            let mut state = self.state.lock();
            Self::prune_pending(&mut state, now_ms());
            let attempt = state.pending.shift_remove(state_param);
            attempt.filter(|attempt| attempt.generation == state.generation)
        };
        let Some(attempt) = attempt.filter(|_| !state_param.is_empty()) else {
            fail("invalid_state");
            return Err(auth_error(
                "This sign-in link has expired or is invalid. Start sign-in again.",
                400,
            ));
        };
        if let Some(error) = &params.error {
            fail("provider_error");
            let detail = params.error_description.as_ref().unwrap_or(error);
            return Err(auth_error(
                format!("Sign in with ChatGPT was not completed: {detail}"),
                400,
            ));
        }
        let Some(code) = params
            .code
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        else {
            fail("missing_code");
            return Err(auth_error("Missing authorization code in callback.", 400));
        };

        // A query-string client_id never overrides a previously saved client.
        let callback_client_id = attempt
            .is_dynamic_registration
            .then(|| params.client_id.as_deref().map(str::trim))
            .flatten()
            .filter(|id| !id.is_empty());
        let exchange_client_id = callback_client_id.unwrap_or(&attempt.client_id);
        let (status, payload) = self
            .post_token(&[
                ("grant_type", "authorization_code"),
                ("client_id", exchange_client_id),
                ("code", code),
                ("redirect_uri", &attempt.redirect_uri),
                ("code_verifier", &attempt.code_verifier),
                ("resource", CHATGPT_API_RESOURCE),
            ])
            .await;
        let Some(access_token) = payload
            .access_token
            .clone()
            .filter(|_| (200..300).contains(&status))
        else {
            fail("token_exchange_failed");
            return Err(auth_error(
                format!(
                    "Could not complete ChatGPT sign-in ({}).",
                    Self::detail(status, &payload)
                ),
                502,
            ));
        };

        if let Some(scope) = &payload.scope
            && !scope
                .split_whitespace()
                .any(|s| s == CHATGPT_DIRECT_USAGE_SCOPE)
        {
            fail("missing_usage_scope");
            return Err(auth_error(
                "Your ChatGPT account did not grant direct plan usage access. Check your ChatGPT plan and settings.",
                403,
            ));
        }

        // The token endpoint's client_id first; the callback's only for a dynamic registration.
        let issued_client_id = payload
            .client_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .or(callback_client_id);
        let effective_client_id = match issued_client_id {
            Some(id) if id != CHATGPT_DYNAMIC_CLIENT_ID => Some(id.to_string()),
            _ if !attempt.is_dynamic_registration => Some(attempt.client_id.clone()),
            _ => None,
        };
        if attempt.is_dynamic_registration && effective_client_id.is_none() {
            fail("missing_client_id");
            return Err(auth_error(
                "OpenAI did not return a client ID for this installation. Start sign-in again.",
                502,
            ));
        }

        let tokens = StoredChatGptTokens {
            access_token,
            refresh_token: payload.refresh_token.clone(),
            expires_at: expires_at_from(payload.expires_in),
            scope: payload.scope.clone(),
            email: email_from_id_token(payload.id_token.as_deref()),
        };
        let has_refresh_token = tokens.refresh_token.is_some();
        let issued = effective_client_id.filter(|_| attempt.is_dynamic_registration);
        let committed = self
            .commit_tokens_if_current(attempt.generation, tokens, issued, None, true)
            .await?;
        if !committed {
            fail("superseded");
            return Err(auth_error(
                "Sign-in was cancelled before completion. Start sign-in again.",
                409,
            ));
        }
        track(
            "chatgpt auth succeeded",
            &[
                (
                    "auth.dynamic_registration",
                    attempt.is_dynamic_registration.to_string(),
                ),
                ("auth.has_refresh_token", has_refresh_token.to_string()),
            ],
        );
        Ok(self.status())
    }

    /// Store `tokens` (and an issued client ID) only while `generation` is current
    /// and, when given, the cached tokens are still `expected`. False when a newer
    /// sign-out or sign-in superseded them.
    async fn commit_tokens_if_current(
        &self,
        generation: u64,
        tokens: StoredChatGptTokens,
        issued_client_id: Option<String>,
        expected: Option<&Arc<StoredChatGptTokens>>,
        advance_generation: bool,
    ) -> anyhow::Result<bool> {
        let _persist = self.persist.lock().await;
        let current = |state: &State| {
            state.generation == generation
                && expected.is_none_or(|expected| {
                    state
                        .tokens
                        .as_ref()
                        .is_some_and(|tokens| Arc::ptr_eq(tokens, expected))
                })
        };
        if !current(&self.state.lock()) {
            return Ok(false);
        }
        if let Some(client_id) = issued_client_id {
            self.state.lock().client_id = Some(client_id.clone());
            RUNTIME_STATE_SERVICE
                .set(CHATGPT_AUTH_CLIENT_ID, &client_id)
                .await?;
        }
        let text = serde_json::to_string(&tokens)?;
        {
            let mut state = self.state.lock();
            if state.generation != generation {
                return Ok(false);
            }
            state.tokens = Some(Arc::new(tokens));
            if advance_generation {
                state.generation += 1;
            }
        }
        RUNTIME_STATE_SERVICE
            .set(CHATGPT_AUTH_TOKENS, &text)
            .await?;
        Ok(true)
    }

    /// Clear the stored tokens while `generation` and `expected` still hold.
    async fn clear_tokens_if_current(
        &self,
        generation: u64,
        expected: &Arc<StoredChatGptTokens>,
    ) -> anyhow::Result<()> {
        let _persist = self.persist.lock().await;
        {
            let mut state = self.state.lock();
            let same = state
                .tokens
                .as_ref()
                .is_some_and(|tokens| Arc::ptr_eq(tokens, expected));
            if state.generation != generation || !same {
                return Ok(());
            }
            state.tokens = None;
        }
        RUNTIME_STATE_SERVICE.delete(CHATGPT_AUTH_TOKENS).await
    }

    /// A valid access token, refreshed when near expiry or when `force_refresh`
    /// (after a 401 from OpenAI).
    pub async fn get_access_token(&self, force_refresh: bool) -> anyhow::Result<String> {
        let (generation, seen) = {
            let state = self.state.lock();
            (state.generation, state.tokens.clone())
        };
        let Some(seen) = seen else {
            return Err(auth_error(
                "Not signed in to ChatGPT. Sign in from Profile to use your ChatGPT plan.",
                401,
            ));
        };
        let needs_refresh = force_refresh || seen.expires_at - now_ms() <= EXPIRY_BUFFER_MS;
        if !needs_refresh {
            return Ok(seen.access_token.clone());
        }
        if seen.refresh_token.is_none() {
            if force_refresh || seen.expires_at <= now_ms() {
                self.clear_tokens_if_current(generation, &seen).await?;
                return Err(auth_error(
                    "ChatGPT session expired. Please sign in again.",
                    401,
                ));
            }
            return Ok(seen.access_token.clone());
        }

        let _refresh = self.refresh.lock().await;
        // Another caller refreshed while this one waited: its token is the new one.
        let current = self.state.lock().tokens.clone();
        if let Some(current) = current
            && !Arc::ptr_eq(&current, &seen)
            && current.expires_at - now_ms() > EXPIRY_BUFFER_MS
        {
            return Ok(current.access_token.clone());
        }
        self.refresh_access_token().await
    }

    async fn refresh_access_token(&self) -> anyhow::Result<String> {
        let (generation, current) = {
            let state = self.state.lock();
            (state.generation, state.tokens.clone())
        };
        let Some(current) = current else {
            return Err(auth_error(
                "ChatGPT session cannot be refreshed. Please sign in again.",
                401,
            ));
        };
        let client_id = self.client_id().await?;
        let (Some(refresh_token), Some(client_id)) = (current.refresh_token.clone(), client_id)
        else {
            self.clear_tokens_if_current(generation, &current).await?;
            return Err(auth_error(
                "ChatGPT session cannot be refreshed. Please sign in again.",
                401,
            ));
        };

        let (status, payload) = self
            .post_token(&[
                ("grant_type", "refresh_token"),
                ("client_id", &client_id),
                ("refresh_token", &refresh_token),
                ("resource", CHATGPT_API_RESOURCE),
            ])
            .await;
        let Some(access_token) = payload
            .access_token
            .clone()
            .filter(|_| (200..300).contains(&status))
        else {
            track(
                "chatgpt auth refresh failed",
                &[("auth.status_code", status.to_string())],
            );
            if status == 400 || status == 401 {
                self.clear_tokens_if_current(generation, &current).await?;
            }
            return Err(auth_error(
                format!(
                    "ChatGPT token refresh failed ({}). Please sign in again.",
                    Self::detail(status, &payload)
                ),
                401,
            ));
        };

        let updated = StoredChatGptTokens {
            access_token: access_token.clone(),
            refresh_token: payload.refresh_token.clone().or(Some(refresh_token)),
            expires_at: expires_at_from(payload.expires_in),
            scope: payload.scope.clone().or_else(|| current.scope.clone()),
            email: email_from_id_token(payload.id_token.as_deref())
                .or_else(|| current.email.clone()),
        };
        let committed = self
            .commit_tokens_if_current(generation, updated, None, Some(&current), false)
            .await?;
        if !committed {
            return Err(auth_error(
                "ChatGPT session changed while refreshing. Please sign in again.",
                401,
            ));
        }
        Ok(access_token)
    }

    /// Clear the stored tokens and invalidate in-flight attempts and refreshes. The
    /// host ID and client ID stay.
    pub async fn sign_out(&self) -> anyhow::Result<ChatGptAuthStatus> {
        {
            let mut state = self.state.lock();
            state.generation += 1;
            state.pending.clear();
            state.tokens = None;
        }
        {
            let _persist = self.persist.lock().await;
            RUNTIME_STATE_SERVICE.delete(CHATGPT_AUTH_TOKENS).await?;
        }
        track("chatgpt auth signed out", &[]);
        Ok(self.status())
    }
}

impl Default for ChatGptAuthService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CHATGPT_AUTH_SERVICE: LazyLock<ChatGptAuthService> =
    LazyLock::new(ChatGptAuthService::new);

#[cfg(test)]
#[path = "chatgpt_auth_service_tests.rs"]
mod tests;
