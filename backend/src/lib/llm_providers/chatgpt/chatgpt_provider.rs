//! ChatGPT subscription provider (`LLM_PROVIDER=chatgpt`).
//!
//! Speaks the public OpenAI Responses API at `https://api.openai.com/v1` with the
//! OAuth tokens of the Sign in with ChatGPT flow (`chatgpt_auth_service`). It is
//! the `openai` provider's SDK surface with a `fetch` that sets the current bearer
//! token, so prompt caching, deferred tools and the GPT-5.x gate rules stay the
//! same as `openai`.

use std::sync::Arc;

use serde_json::json;

use crate::ai::providers::openai::api::{FetchFunction, FetchRequest, default_fetch};
use crate::lib::llm_providers::deferred_tools::{
    OPENAI_DEFERRED_TOOLS, deferred_tools_when, supports_open_ai_deferred_tools,
};
use crate::lib::llm_providers::llm_provider::LlmProvider;
use crate::lib::llm_providers::openai::openai_provider::{
    open_ai_cache_request, open_ai_cache_ttl_ms,
};
use crate::lib::llm_providers::openai_compatible::{
    OpenAiCompatibleOptions, create_open_ai_compatible_provider,
};
use crate::log_info;
use crate::services::chatgpt_auth_service::CHATGPT_AUTH_SERVICE;

fn with_bearer(mut request: FetchRequest, token: &str) -> FetchRequest {
    request
        .headers
        .retain(|name, _| !name.eq_ignore_ascii_case("authorization"));
    request
        .headers
        .insert("Authorization".to_string(), format!("Bearer {token}"));
    request
}

/// Sends each request with the current Sign in with ChatGPT token, and once more
/// with a refreshed token after a 401.
fn chatgpt_fetch() -> FetchFunction {
    let inner = default_fetch();
    Arc::new(move |request: FetchRequest| {
        let inner = inner.clone();
        Box::pin(async move {
            let token = CHATGPT_AUTH_SERVICE.get_access_token(false).await?;
            let first = inner(with_bearer(request.clone(), &token)).await?;
            if first.status != 401 {
                return Ok(first);
            }
            let refreshed = CHATGPT_AUTH_SERVICE.get_access_token(true).await?;
            inner(with_bearer(request, &refreshed)).await
        })
    })
}

pub fn create_chatgpt_provider(base_url: &str) -> LlmProvider {
    log_info!(
        json!({ "routing": "direct" }),
        "Creating ChatGPT subscription provider"
    );
    let mut provider = create_open_ai_compatible_provider(OpenAiCompatibleOptions {
        // `chatgpt_fetch` replaces this with the real bearer token on every request.
        api_key: Some("chatgpt-oauth".to_string()),
        base_url: Some(base_url.to_string()),
        fetch: Some(chatgpt_fetch()),
    });
    provider.deferred_tools = Some(deferred_tools_when(
        supports_open_ai_deferred_tools,
        &OPENAI_DEFERRED_TOOLS,
    ));
    provider.cache_request = Some(Arc::new(open_ai_cache_request));
    provider.cache_ttl_ms = Some(Arc::new(open_ai_cache_ttl_ms));
    provider
}

/// Empty when the user has signed in with ChatGPT; otherwise names what is missing.
pub fn missing_chatgpt_settings() -> Vec<String> {
    if CHATGPT_AUTH_SERVICE.is_signed_in() {
        Vec::new()
    } else {
        vec!["ChatGPT sign-in".to_string()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_placeholder_key_with_the_token() {
        let request = FetchRequest {
            url: "https://api.openai.com/v1/responses".into(),
            headers: [(
                "Authorization".to_string(),
                "Bearer chatgpt-oauth".to_string(),
            )]
            .into_iter()
            .collect(),
            body: "{}".into(),
        };
        let sent = with_bearer(request, "at-1");
        assert_eq!(sent.headers.len(), 1);
        assert_eq!(sent.headers["Authorization"], "Bearer at-1");
    }

    #[test]
    fn dispatches_to_the_responses_api_with_the_openai_cache_rules() {
        let provider = create_chatgpt_provider("https://api.openai.com/v1");
        let model = provider.model("gpt-5.6-sol").unwrap();
        assert_eq!(model.provider(), "openai.responses");
        assert!(provider.cache_request.is_some());
        assert!(provider.deferred_tools("gpt-5.6-sol").is_some());
    }
}
