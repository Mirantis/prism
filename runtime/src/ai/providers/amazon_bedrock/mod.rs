//! The Amazon Bedrock provider (`@ai-sdk/amazon-bedrock`): Converse, the Anthropic
//! Messages branch (`anthropic`), and Titan embeddings.
//!
//! Every request is authorized one of two ways. A bearer API key (`api_key`, else
//! `AWS_BEARER_TOKEN_BEDROCK`) is sent as `Authorization: Bearer <key>` when it is
//! set and not blank. Otherwise the request is signed with AWS Signature Version 4,
//! from the credential provider, else the explicit keys, else the `AWS_*`
//! environment.

pub mod anthropic;
pub mod api;
pub mod auth;
pub mod converse;
pub mod convert_messages;
pub mod embedding;
pub mod prepare_tools;
pub mod sigv4;

use std::sync::Arc;

use futures::future::BoxFuture;
use indexmap::IndexMap;

use self::api::{EnvLookup, FetchFunction, default_fetch, process_env};
use self::auth::{SessionTokenFallback, authorized_fetch, resolve_auth};
use self::converse::{AmazonBedrockChatLanguageModel, ChatConfig};
use self::embedding::{AmazonBedrockEmbeddingModel, EmbeddingConfig};
use crate::ai::generate_text::with_user_agent_suffix;
use crate::ai::provider::Headers;
use crate::ai::{EmbeddingModel, LanguageModel};

/// The `@ai-sdk/amazon-bedrock` version the user agent names.
pub const VERSION: &str = "5.0.113";

/// Resolved AWS credentials for SigV4.
#[derive(Clone, Debug, Default)]
pub struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

/// Resolves credentials on each request, as the SDK's `credentialProvider`.
pub type CredentialProvider =
    Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<AwsCredentials>> + Send + Sync>;

/// `AmazonBedrockProviderSettings`.
#[derive(Clone, Default)]
pub struct AmazonBedrockProviderSettings {
    pub region: Option<String>,
    /// Replaces `https://bedrock-runtime.{region}.amazonaws.com`.
    pub base_url: Option<String>,
    /// Bearer API key; `AWS_BEARER_TOKEN_BEDROCK` when unset.
    pub api_key: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub session_token: Option<String>,
    pub credential_provider: Option<CredentialProvider>,
    pub headers: Option<IndexMap<String, String>>,
    /// Sends the requests in place of the global `fetch`.
    pub fetch: Option<FetchFunction>,
}

/// `isAnthropicModel` of `amazon-bedrock-anthropic-model-support`: a Claude model
/// by family, by id, or an application inference profile asked to think.
pub fn is_anthropic_model(
    model_id: &str,
    model_family: Option<&str>,
    reasoning_budget_tokens: Option<f64>,
) -> bool {
    model_family == Some("anthropic")
        || model_id.contains("anthropic")
        || (model_id.contains(":application-inference-profile/")
            && reasoning_budget_tokens.is_some())
}

/// Bedrock validates against its own copy of the Messages schema, which refuses
/// `output_config.format` and a tool's `strict` for the newest Claude models.
const MODELS_WITHOUT_STRICT_TOOL_SUPPORT: &[&str] = &[
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-haiku-5-5",
];

/// Native structured output is also unreliable on these, though their strict tools
/// work: Sonnet 4.6 can miss complex schemas, and Haiku 4.5 support varies between
/// Bedrock accounts.
const MODELS_WITHOUT_RELIABLE_NATIVE_STRUCTURED_OUTPUT: &[&str] =
    &["claude-sonnet-4-6", "claude-haiku-4-5"];

/// `supportsStrictTools`.
pub fn supports_strict_tools(model_id: &str) -> bool {
    !MODELS_WITHOUT_STRICT_TOOL_SUPPORT
        .iter()
        .any(|model| model_id.contains(model))
}

/// `supportsNativeStructuredOutput`.
pub fn supports_native_structured_output(model_id: &str) -> bool {
    supports_strict_tools(model_id)
        && !MODELS_WITHOUT_RELIABLE_NATIVE_STRUCTURED_OUTPUT
            .iter()
            .any(|model| model_id.contains(model))
}

/// `generateId`: 16 random letters and digits.
pub fn generate_id() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::rng();
    (0..16)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

/// The provider `createAmazonBedrock` returns.
pub struct AmazonBedrockProvider {
    pub settings: AmazonBedrockProviderSettings,
    fetch: FetchFunction,
    env: EnvLookup,
}

/// `createAmazonBedrock`: a bearer key when one is set, else SigV4.
pub fn create_amazon_bedrock(settings: AmazonBedrockProviderSettings) -> AmazonBedrockProvider {
    create_amazon_bedrock_in(settings, process_env())
}

/// `create_amazon_bedrock` reading `env` in place of the process environment.
pub fn create_amazon_bedrock_in(
    settings: AmazonBedrockProviderSettings,
    env: EnvLookup,
) -> AmazonBedrockProvider {
    let auth = resolve_auth(
        &settings,
        &env,
        SessionTokenFallback::WhenKeysFromEnvironment,
    );
    let fetch = authorized_fetch(auth, settings.fetch.clone().unwrap_or_else(default_fetch));
    AmazonBedrockProvider {
        settings,
        fetch,
        env,
    }
}

/// The settings' headers with the provider's user agent (`getHeaders`).
fn provider_headers(headers: Option<&IndexMap<String, String>>) -> Headers {
    with_user_agent_suffix(headers, &format!("ai-sdk-amazon-bedrock/{VERSION}"))
}

/// The bedrock-runtime base URL, resolved on each request.
fn base_url_fn(
    settings: &AmazonBedrockProviderSettings,
    env: &EnvLookup,
) -> Arc<dyn Fn() -> anyhow::Result<String> + Send + Sync> {
    let base_url = settings.base_url.clone();
    let region = settings.region.clone();
    let env = env.clone();
    Arc::new(move || {
        api::resolve_bedrock_runtime_base_url(base_url.as_deref(), region.as_deref(), &env)
    })
}

impl AmazonBedrockProvider {
    /// `provider(modelId)`: a Converse model.
    pub fn language_model(&self, model_id: &str) -> Arc<dyn LanguageModel> {
        let headers = self.settings.headers.clone();
        Arc::new(AmazonBedrockChatLanguageModel::new(
            model_id,
            Arc::new(ChatConfig {
                base_url: base_url_fn(&self.settings, &self.env),
                headers: Arc::new(move || provider_headers(headers.as_ref())),
                fetch: self.fetch.clone(),
                generate_id: Arc::new(generate_id),
                model_family: None,
            }),
        ))
    }

    /// `provider.embedding(modelId)`: Titan over InvokeModel.
    pub fn embedding(&self, model_id: &str) -> Arc<dyn EmbeddingModel> {
        let headers = self.settings.headers.clone();
        Arc::new(AmazonBedrockEmbeddingModel::new(
            model_id,
            Arc::new(EmbeddingConfig {
                base_url: base_url_fn(&self.settings, &self.env),
                headers: Arc::new(move || provider_headers(headers.as_ref())),
                fetch: self.fetch.clone(),
            }),
        ))
    }
}

#[cfg(test)]
mod tests;
