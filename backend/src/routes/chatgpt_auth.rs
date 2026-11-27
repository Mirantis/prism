//! Sign in with ChatGPT routes:
//!
//!   GET  /agents/chatgpt-auth/status   — `{ enabled, signedIn, email, expiresAt }`
//!   POST /agents/chatgpt-auth/start    — `{ authorizeUrl }`
//!   GET  /agents/chatgpt-auth/callback — the OAuth 2.0 PKCE browser callback
//!   POST /agents/chatgpt-auth/sign-out — clears the stored tokens

use axum::Router;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, HOST};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::json;

use crate::config::CONFIG;
use crate::lib::log_redaction::err_json;
use crate::services::chatgpt_auth_service::{
    CHATGPT_AUTH_SERVICE, ChatGptAuthError, ChatGptCallbackParams,
};
use crate::support::http::{QueryParams, error_json};
use crate::{log_error, log_warn};

const CALLBACK_PATH: &str = "/agents/chatgpt-auth/callback";

pub fn router() -> Router {
    Router::new()
        .route("/agents/chatgpt-auth/status", get(status))
        .route("/agents/chatgpt-auth/start", post(start))
        .route(CALLBACK_PATH, get(callback))
        .route("/agents/chatgpt-auth/sign-out", post(sign_out))
}

fn first_header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let value = headers.get(name)?.to_str().ok()?;
    let first = value.split(',').next()?.trim();
    (!first.is_empty()).then(|| first.to_string())
}

/// The callback URL the browser returns to: `PRISM_PUBLIC_URL`, else the host the
/// request came in on.
fn callback_url_for(headers: &HeaderMap) -> String {
    callback_url_from(CONFIG.public_url.as_deref(), CONFIG.port, headers)
}

fn callback_url_from(public_url: Option<&str>, port: u16, headers: &HeaderMap) -> String {
    if let Some(public_url) = public_url {
        return format!("{public_url}{CALLBACK_PATH}");
    }
    let host = first_header_value(headers, "x-forwarded-host")
        .or_else(|| {
            headers
                .get(HOST)
                .and_then(|h| h.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("127.0.0.1:{port}"));
    let proto = first_header_value(headers, "x-forwarded-proto")
        .map(|p| p.to_lowercase())
        .filter(|p| p == "https" || p == "http")
        .unwrap_or_else(|| "http".to_string());
    format!("{proto}://{host}{CALLBACK_PATH}")
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn callback_page(status: StatusCode, title: &str, message: &str, ok: bool) -> Response {
    let accent = if ok { "#15803d" } else { "#b91c1c" };
    let title = escape_html(title);
    let message = escape_html(message);
    let page = format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1.25rem; color: #111827; line-height: 1.5; }}
    h1 {{ font-size: 1.25rem; color: {accent}; margin-bottom: 0.5rem; }}
    p {{ color: #374151; }}
  </style>
</head>
<body>
  <h1>{title}</h1>
  <p>{message}</p>
</body>
</html>"#
    );
    let mut response = (status, page).into_response();
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
}

async fn status() -> Response {
    crate::support::http::json(200, CHATGPT_AUTH_SERVICE.status())
}

async fn start(headers: HeaderMap) -> Response {
    match CHATGPT_AUTH_SERVICE
        .start_sign_in(&callback_url_for(&headers))
        .await
    {
        Ok(authorize_url) => {
            crate::support::http::json(201, json!({ "authorizeUrl": authorize_url }))
        }
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[ChatGptAuth] Failed to start sign-in"
            );
            error_json(500, "Could not start Sign in with ChatGPT.")
        }
    }
}

async fn callback(query: QueryParams) -> Response {
    let text = |key: &str| query.str(key).map(str::to_string);
    let result = CHATGPT_AUTH_SERVICE
        .handle_callback(ChatGptCallbackParams {
            code: text("code"),
            state: text("state"),
            client_id: text("client_id"),
            error: text("error"),
            error_description: text("error_description"),
        })
        .await;
    match result {
        Ok(status) => {
            let who = status
                .email
                .map(|email| format!(" as {email}"))
                .unwrap_or_default();
            callback_page(
                StatusCode::OK,
                "Signed in to ChatGPT",
                &format!("Prism is now connected{who}. You can close this tab."),
                true,
            )
        }
        Err(err) => {
            let (code, message) = match err.downcast_ref::<ChatGptAuthError>() {
                Some(auth) => (auth.status_code, auth.message.clone()),
                None => (500, "Sign in with ChatGPT failed. Try again.".to_string()),
            };
            log_warn!(
                json!({ "err": err_json(&err), "statusCode": code }),
                "[ChatGptAuth] Callback failed"
            );
            let status = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            callback_page(status, "ChatGPT sign-in failed", &message, false)
        }
    }
}

async fn sign_out() -> Response {
    match CHATGPT_AUTH_SERVICE.sign_out().await {
        Ok(status) => crate::support::http::json(200, status),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[ChatGptAuth] Sign-out failed"
            );
            error_json(500, "Sign-out failed. Try again.")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_callback_from_the_public_url_or_the_request_host() {
        let mut headers = HeaderMap::new();
        assert_eq!(
            callback_url_from(None, 3003, &headers),
            "http://127.0.0.1:3003/agents/chatgpt-auth/callback"
        );
        headers.insert(HOST, HeaderValue::from_static("localhost:5173"));
        assert_eq!(
            callback_url_from(None, 3003, &headers),
            "http://localhost:5173/agents/chatgpt-auth/callback"
        );
        headers.insert(
            "x-forwarded-host",
            HeaderValue::from_static("prism.example.com, other"),
        );
        headers.insert("x-forwarded-proto", HeaderValue::from_static("HTTPS"));
        assert_eq!(
            callback_url_from(None, 3003, &headers),
            "https://prism.example.com/agents/chatgpt-auth/callback"
        );
        assert_eq!(
            callback_url_from(Some("https://prism.example.org"), 3003, &headers),
            "https://prism.example.org/agents/chatgpt-auth/callback"
        );
    }

    #[test]
    fn escapes_the_page_text() {
        assert_eq!(
            escape_html(r#"<a href="x">&'"#),
            "&lt;a href=&quot;x&quot;&gt;&amp;&#39;"
        );
    }
}
