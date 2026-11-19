//! LLM Provider Route
//!
//! GET /agents/llm-provider — `{ provider, missingSettings }`: the selected LLM
//! provider and the settings it still needs before it can send a request, by
//! variable name. The clients warn while the list is not empty.

use axum::Router;
use axum::response::Response;
use axum::routing::get;
use serde::Serialize;

use crate::config::CONFIG;
use crate::lib::llm_providers::create_provider::missing_provider_settings;
use crate::support::http::json;

pub fn router() -> Router {
    Router::new().route("/agents/llm-provider", get(get_llm_provider))
}

/// The body of `GET /agents/llm-provider`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderBody {
    pub provider: &'static str,
    pub missing_settings: Vec<String>,
}

/// GET /agents/llm-provider
async fn get_llm_provider() -> Response {
    json(
        200,
        LlmProviderBody {
            provider: CONFIG.llm_provider.as_str(),
            missing_settings: missing_provider_settings().await,
        },
    )
}
