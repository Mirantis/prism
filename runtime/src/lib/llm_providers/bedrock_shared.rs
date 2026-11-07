//! Shared bedrock-runtime plumbing for the two AWS vendors.
//!
//! `bedrock` and `bedrock-mantle` are separate providers — they speak different
//! protocols to different hosts — but they overlap on two things that are
//! properties of AWS Bedrock itself rather than of either provider:
//!
//!  - **Credential resolution.** Explicit keys, or the AWS default chain (ECS task
//!    role → container metadata). A bearer token in `AWS_BEARER_TOKEN_BEDROCK`
//!    short-circuits both; the SDK reads it from the environment itself.
//!  - **What an Anthropic model id looks like** on Bedrock.
//!
//! It lives here, beside the shared contract and the selector, rather than in
//! either vendor's folder: a peer importing a sibling vendor would make one of them
//! incidentally load the other's SDKs and read as the more fundamental of the two,
//! which neither is.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use aws_credential_types::Credentials;
use aws_credential_types::provider::ProvideCredentials;
use chrono::{DateTime, Local};

use crate::ai::providers::amazon_bedrock::{
    AmazonBedrockProviderSettings, AwsCredentials, CredentialProvider,
};
use crate::config::CONFIG;
use crate::log_info;

/// Credential/region options for any bedrock-runtime SDK client: explicit keys
/// when set, otherwise the AWS default provider chain.
pub fn create_shared_bedrock_options() -> AmazonBedrockProviderSettings {
    shared_bedrock_options(
        &CONFIG.aws_region,
        CONFIG.aws_access_key_id.as_deref(),
        CONFIG.aws_secret_access_key.as_deref(),
        CONFIG.aws_session_token.as_deref(),
        default_provider,
    )
}

/// `create_shared_bedrock_options` on the given configuration, with
/// `default_provider` making the default chain.
fn shared_bedrock_options(
    region: &str,
    access_key_id: Option<&str>,
    secret_access_key: Option<&str>,
    session_token: Option<&str>,
    default_provider: fn() -> ChainProvider,
) -> AmazonBedrockProviderSettings {
    if let (Some(access_key_id), Some(secret_access_key)) = (
        access_key_id.filter(|k| !k.is_empty()),
        secret_access_key.filter(|k| !k.is_empty()),
    ) {
        log_info!("Using explicit AWS credentials for Bedrock authentication");
        return AmazonBedrockProviderSettings {
            region: Some(region.to_string()),
            access_key_id: Some(access_key_id.to_string()),
            secret_access_key: Some(secret_access_key.to_string()),
            session_token: session_token.filter(|t| !t.is_empty()).map(str::to_string),
            ..Default::default()
        };
    }

    log_info!(
        "Using default AWS credential provider chain for Bedrock authentication (no explicit keys set)"
    );

    // In ECS, use the default credential provider chain (task role -> container metadata)
    let provider = default_provider();

    let credential_provider: CredentialProvider = Arc::new(move || {
        let provider = provider.clone();
        Box::pin(async move {
            log_info!("Using default AWS credential provider chain for Bedrock authentication");
            let creds = provider().await?;

            log_info!(
                "Credentials expire at {} with scope {}",
                creds
                    .expiry()
                    .map(js_date_string)
                    .unwrap_or_else(|| "undefined".to_string()),
                "undefined"
            );

            Ok(AwsCredentials {
                access_key_id: creds.access_key_id().to_string(),
                secret_access_key: creds.secret_access_key().to_string(),
                session_token: creds.session_token().map(str::to_string),
            })
        })
    });

    AmazonBedrockProviderSettings {
        region: Some(region.to_string()),
        credential_provider: Some(credential_provider),
        ..Default::default()
    }
}

/// The default chain: a call resolves credentials, as `defaultProvider()`'s
/// function does.
type ChainProvider =
    Arc<dyn Fn() -> futures::future::BoxFuture<'static, anyhow::Result<Credentials>> + Send + Sync>;

/// Credentials within this long of their expiry are resolved again, as the AWS
/// SDK's memoized default provider treats them as expired.
const EXPIRY_WINDOW: Duration = Duration::from_secs(300);

/// `defaultProvider()` of `@aws-sdk/credential-provider-node`: environment,
/// profile (SSO, process, assumed role), web identity, ECS container, then EC2
/// instance metadata. The chain is built on first use, and its credentials are
/// kept until they come within five minutes of their expiry.
fn default_provider() -> ChainProvider {
    let state: Arc<
        tokio::sync::Mutex<(
            Option<aws_config::default_provider::credentials::DefaultCredentialsChain>,
            Option<Credentials>,
        )>,
    > = Arc::new(tokio::sync::Mutex::new((None, None)));
    Arc::new(move || {
        let state = state.clone();
        Box::pin(async move {
            let mut guard = state.lock().await;
            if let Some(credentials) = &guard.1 {
                let fresh = credentials.expiry().is_none_or(|expiry| {
                    expiry
                        .duration_since(SystemTime::now())
                        .is_ok_and(|left| left >= EXPIRY_WINDOW)
                });
                if fresh {
                    return Ok(credentials.clone());
                }
            }
            if guard.0.is_none() {
                guard.0 = Some(
                    aws_config::default_provider::credentials::DefaultCredentialsChain::builder()
                        .build()
                        .await,
                );
            }
            let chain = guard.0.as_ref().expect("the chain was built above");
            let credentials = chain
                .provide_credentials()
                .await
                .map_err(anyhow::Error::new)?;
            guard.1 = Some(credentials.clone());
            Ok(credentials)
        })
    })
}

/// `String(date)`: `Date.prototype.toString()` in the local time zone.
fn js_date_string(time: SystemTime) -> String {
    let local: DateTime<Local> = time.into();
    let offset = local.format("%z").to_string();
    let zone = if offset == "+0000" {
        " (Coordinated Universal Time)"
    } else {
        ""
    };
    format!("{} GMT{offset}{zone}", local.format("%a %b %d %Y %H:%M:%S"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain() -> ChainProvider {
        Arc::new(|| {
            Box::pin(async {
                Ok(Credentials::new(
                    "chain-key",
                    "chain-secret",
                    Some("chain-token".into()),
                    None,
                    "test",
                ))
            })
        })
    }

    #[test]
    fn uses_explicit_keys_when_both_are_set() {
        let options = shared_bedrock_options(
            "us-west-2",
            Some("explicit-key"),
            Some("explicit-secret"),
            Some("session-token-123"),
            chain,
        );
        assert_eq!(options.region.as_deref(), Some("us-west-2"));
        assert_eq!(options.access_key_id.as_deref(), Some("explicit-key"));
        assert_eq!(
            options.secret_access_key.as_deref(),
            Some("explicit-secret")
        );
        assert_eq!(options.session_token.as_deref(), Some("session-token-123"));
        assert!(options.credential_provider.is_none());
    }

    #[test]
    fn normalizes_an_empty_session_token_to_unset() {
        let options = shared_bedrock_options(
            "us-west-2",
            Some("explicit-key"),
            Some("explicit-secret"),
            Some(""),
            chain,
        );
        assert_eq!(options.session_token, None);
    }

    #[tokio::test]
    async fn falls_back_to_the_default_credential_chain_when_keys_are_missing() {
        let options = shared_bedrock_options("us-west-2", None, Some("secret"), None, chain);
        assert_eq!(options.region.as_deref(), Some("us-west-2"));
        assert!(options.access_key_id.is_none());
        let provider = options.credential_provider.expect("a credential provider");
        let credentials = provider().await.unwrap();
        assert_eq!(credentials.access_key_id, "chain-key");
        assert_eq!(credentials.secret_access_key, "chain-secret");
        assert_eq!(credentials.session_token.as_deref(), Some("chain-token"));
    }

    #[test]
    fn writes_a_date_as_javascript_prints_one() {
        let time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_793_995_200);
        let text = js_date_string(time);
        assert!(text.contains(" 2026 "), "{text}");
        assert!(text.contains(" GMT"), "{text}");
    }
}
