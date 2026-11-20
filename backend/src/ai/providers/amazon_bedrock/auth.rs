//! How a Bedrock request is authorized: a bearer API key (`apiKey` or
//! `AWS_BEARER_TOKEN_BEDROCK`) when one is set, else an AWS Signature Version 4
//! from a credential provider, explicit keys or the `AWS_*` environment.

use std::sync::Arc;

use futures::future::BoxFuture;

use super::api::{
    EnvLookup, FetchFunction, FetchRequest, load_optional_setting, load_setting, normalize_headers,
};
use super::sigv4::{SignInput, datetime_now, sign};
use super::{AmazonBedrockProviderSettings, VERSION};
use crate::ai::generate_text::with_user_agent_suffix;
use crate::ai::provider::Headers;

/// The credentials one signature uses (`AmazonBedrockCredentials`).
#[derive(Debug, Clone, PartialEq)]
pub struct SigningCredentials {
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

/// Resolves the signing credentials for each request.
pub type SigningCredentialsFn =
    Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<SigningCredentials>> + Send + Sync>;

/// How requests are authorized.
#[derive(Clone)]
pub enum Auth {
    /// `Authorization: Bearer <key>`.
    ApiKey(String),
    /// AWS Signature Version 4 for the `bedrock` service.
    SigV4(SigningCredentialsFn),
}

/// Where a SigV4 session token comes from when it is not passed. The Converse
/// provider reads `AWS_SESSION_TOKEN` only when either key came from the
/// environment; the Anthropic provider reads it whenever no token is passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionTokenFallback {
    WhenKeysFromEnvironment,
    Always,
}

/// The bearer key when one is set and not blank (trimmed), else SigV4.
pub fn resolve_auth(
    settings: &AmazonBedrockProviderSettings,
    env: &EnvLookup,
    session_token_fallback: SessionTokenFallback,
) -> Auth {
    let raw_api_key =
        load_optional_setting(settings.api_key.as_deref(), "AWS_BEARER_TOKEN_BEDROCK", env);
    let api_key = raw_api_key
        .map(|key| crate::support::js::trim(&key).to_string())
        .filter(|key| !key.is_empty());
    if let Some(key) = api_key {
        return Auth::ApiKey(key);
    }
    let settings = settings.clone();
    let env = env.clone();
    Auth::SigV4(Arc::new(move || {
        let settings = settings.clone();
        let env = env.clone();
        Box::pin(async move { signing_credentials(&settings, &env, session_token_fallback).await })
    }))
}

/// The SDK's credential loader for SigV4.
async fn signing_credentials(
    settings: &AmazonBedrockProviderSettings,
    env: &EnvLookup,
    session_token_fallback: SessionTokenFallback,
) -> anyhow::Result<SigningCredentials> {
    let region = load_setting(
        settings.region.as_deref(),
        "AWS_REGION",
        "region",
        "AWS region",
        env,
    )?;

    if let Some(provider) = &settings.credential_provider {
        return match provider().await {
            Ok(credentials) => Ok(SigningCredentials {
                region,
                access_key_id: credentials.access_key_id,
                secret_access_key: credentials.secret_access_key,
                session_token: credentials.session_token,
            }),
            Err(err) => Err(anyhow::anyhow!(
                "AWS credential provider failed: {}. Please ensure your credential provider returns valid AWS credentials with accessKeyId and secretAccessKey properties.",
                err
            )),
        };
    }

    let keys = load_setting(
        settings.access_key_id.as_deref(),
        "AWS_ACCESS_KEY_ID",
        "accessKeyId",
        "AWS access key ID",
        env,
    )
    .and_then(|access_key_id| {
        load_setting(
            settings.secret_access_key.as_deref(),
            "AWS_SECRET_ACCESS_KEY",
            "secretAccessKey",
            "AWS secret access key",
            env,
        )
        .map(|secret_access_key| (access_key_id, secret_access_key))
    });
    let (access_key_id, secret_access_key) = match keys {
        Ok(keys) => keys,
        Err(err) => {
            let message = err.message;
            if message.contains("AWS_ACCESS_KEY_ID") || message.contains("accessKeyId") {
                anyhow::bail!(
                    "AWS SigV4 authentication requires AWS credentials. Please provide either:\n1. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables\n2. Provide accessKeyId and secretAccessKey in options\n3. Use a credentialProvider function\n4. Use API key authentication with AWS_BEARER_TOKEN_BEDROCK or apiKey option\nOriginal error: {message}"
                );
            }
            anyhow::bail!(
                "AWS SigV4 authentication requires both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. Please ensure both credentials are provided.\nOriginal error: {message}"
            );
        }
    };
    let keys_passed = settings.access_key_id.is_some() && settings.secret_access_key.is_some();
    let session_token = match session_token_fallback {
        SessionTokenFallback::WhenKeysFromEnvironment if keys_passed => {
            settings.session_token.clone()
        }
        _ => load_optional_setting(settings.session_token.as_deref(), "AWS_SESSION_TOKEN", env),
    };
    Ok(SigningCredentials {
        region,
        access_key_id,
        secret_access_key,
        session_token,
    })
}

/// `isAscii`: no character past U+007F.
fn is_ascii(value: &str) -> bool {
    value.is_ascii()
}

/// The fetch `createApiKeyFetchFunction` or `createSigV4FetchFunction` makes:
/// `inner` with the user agent and the request's authorization added.
pub fn authorized_fetch(auth: Auth, inner: FetchFunction) -> FetchFunction {
    Arc::new(move |request: FetchRequest, abort_signal| {
        let auth = auth.clone();
        let inner = inner.clone();
        Box::pin(async move {
            let headers = with_user_agent_suffix(
                Some(&normalize_headers(&request.headers)),
                &format!("ai-sdk-amazon-bedrock/{VERSION}"),
            );
            match auth {
                Auth::ApiKey(key) => {
                    let mut headers = headers;
                    headers.insert("Authorization".to_string(), format!("Bearer {key}"));
                    inner(FetchRequest { headers, ..request }, abort_signal).await
                }
                Auth::SigV4(credentials) => {
                    if request.body.is_empty() {
                        return inner(FetchRequest { headers, ..request }, abort_signal).await;
                    }
                    let credentials = credentials().await?;
                    let signed = sign_request(&request.url, &headers, &request.body, &credentials)?;
                    let mut combined = headers;
                    for (name, value) in signed {
                        combined.insert(name, value);
                    }
                    inner(
                        FetchRequest {
                            headers: combined,
                            ..request
                        },
                        abort_signal,
                    )
                    .await
                }
            }
        })
    })
}

/// The headers a signature adds to `headers` (every header, signed or not, as the
/// signer's `Headers` holds them).
fn sign_request(
    url: &str,
    headers: &Headers,
    body: &str,
    credentials: &SigningCredentials,
) -> anyhow::Result<Vec<(String, String)>> {
    let signable: Vec<(String, String)> = headers
        .iter()
        .filter(|(_, value)| is_ascii(value))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let datetime = datetime_now();
    let signed = sign(&SignInput {
        url,
        method: "POST",
        headers: &signable,
        body,
        region: &credentials.region,
        service: "bedrock",
        access_key_id: &credentials.access_key_id,
        secret_access_key: &credentials.secret_access_key,
        session_token: credentials.session_token.as_deref(),
        datetime: &datetime,
    })?;
    Ok(signed.headers)
}

#[cfg(test)]
mod tests {
    use super::super::AwsCredentials;
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> EnvLookup {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Arc::new(move |name: &str| map.get(name).cloned())
    }

    async fn credentials(auth: Auth) -> anyhow::Result<SigningCredentials> {
        match auth {
            Auth::SigV4(f) => f().await,
            Auth::ApiKey(_) => panic!("expected SigV4"),
        }
    }

    #[test]
    fn prefers_a_bearer_key_from_the_environment() {
        let vars = env(&[
            ("AWS_BEARER_TOKEN_BEDROCK", "  token-1  "),
            ("AWS_ACCESS_KEY_ID", "AKID"),
        ]);
        match resolve_auth(&Default::default(), &vars, SessionTokenFallback::Always) {
            Auth::ApiKey(key) => assert_eq!(key, "token-1"),
            Auth::SigV4(_) => panic!("expected the bearer key"),
        }
    }

    #[test]
    fn prefers_the_api_key_setting_over_the_environment() {
        let vars = env(&[("AWS_BEARER_TOKEN_BEDROCK", "from-env")]);
        let settings = AmazonBedrockProviderSettings {
            api_key: Some("from-setting".into()),
            ..Default::default()
        };
        match resolve_auth(&settings, &vars, SessionTokenFallback::Always) {
            Auth::ApiKey(key) => assert_eq!(key, "from-setting"),
            Auth::SigV4(_) => panic!("expected the bearer key"),
        }
    }

    #[tokio::test]
    async fn falls_back_to_sigv4_when_the_key_is_blank() {
        let vars = env(&[
            ("AWS_BEARER_TOKEN_BEDROCK", "   "),
            ("AWS_REGION", "eu-west-1"),
            ("AWS_ACCESS_KEY_ID", "AKID"),
            ("AWS_SECRET_ACCESS_KEY", "SECRET"),
            ("AWS_SESSION_TOKEN", "TOKEN"),
        ]);
        let auth = resolve_auth(
            &Default::default(),
            &vars,
            SessionTokenFallback::WhenKeysFromEnvironment,
        );
        assert_eq!(
            credentials(auth).await.unwrap(),
            SigningCredentials {
                region: "eu-west-1".into(),
                access_key_id: "AKID".into(),
                secret_access_key: "SECRET".into(),
                session_token: Some("TOKEN".into()),
            }
        );
    }

    #[tokio::test]
    async fn reads_no_session_token_from_the_environment_for_passed_keys_on_converse() {
        let vars = env(&[("AWS_SESSION_TOKEN", "ENV-TOKEN")]);
        let settings = AmazonBedrockProviderSettings {
            region: Some("us-east-1".into()),
            access_key_id: Some("AKID".into()),
            secret_access_key: Some("SECRET".into()),
            ..Default::default()
        };
        let converse = resolve_auth(
            &settings,
            &vars,
            SessionTokenFallback::WhenKeysFromEnvironment,
        );
        assert_eq!(credentials(converse).await.unwrap().session_token, None);
        let anthropic = resolve_auth(&settings, &vars, SessionTokenFallback::Always);
        assert_eq!(
            credentials(anthropic).await.unwrap().session_token,
            Some("ENV-TOKEN".into())
        );
    }

    #[tokio::test]
    async fn uses_the_credential_provider_with_the_region() {
        let settings = AmazonBedrockProviderSettings {
            region: Some("us-east-2".into()),
            credential_provider: Some(Arc::new(|| {
                Box::pin(async {
                    Ok(AwsCredentials {
                        access_key_id: "chain-key".into(),
                        secret_access_key: "chain-secret".into(),
                        session_token: Some("chain-token".into()),
                    })
                })
            })),
            ..Default::default()
        };
        let auth = resolve_auth(&settings, &env(&[]), SessionTokenFallback::Always);
        assert_eq!(
            credentials(auth).await.unwrap(),
            SigningCredentials {
                region: "us-east-2".into(),
                access_key_id: "chain-key".into(),
                secret_access_key: "chain-secret".into(),
                session_token: Some("chain-token".into()),
            }
        );
    }

    #[tokio::test]
    async fn reports_a_failed_credential_provider() {
        let settings = AmazonBedrockProviderSettings {
            region: Some("us-east-2".into()),
            credential_provider: Some(Arc::new(|| {
                Box::pin(async { Err(anyhow::anyhow!("no IMDS")) })
            })),
            ..Default::default()
        };
        let auth = resolve_auth(&settings, &env(&[]), SessionTokenFallback::Always);
        assert_eq!(
            credentials(auth).await.unwrap_err().to_string(),
            "AWS credential provider failed: no IMDS. Please ensure your credential provider returns valid AWS credentials with accessKeyId and secretAccessKey properties."
        );
    }

    #[tokio::test]
    async fn explains_missing_keys() {
        let vars = env(&[("AWS_REGION", "us-east-1")]);
        let auth = resolve_auth(&Default::default(), &vars, SessionTokenFallback::Always);
        assert_eq!(
            credentials(auth).await.unwrap_err().to_string(),
            "AWS SigV4 authentication requires AWS credentials. Please provide either:\n1. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables\n2. Provide accessKeyId and secretAccessKey in options\n3. Use a credentialProvider function\n4. Use API key authentication with AWS_BEARER_TOKEN_BEDROCK or apiKey option\nOriginal error: AWS access key ID setting is missing. Pass it using the 'accessKeyId' parameter or the AWS_ACCESS_KEY_ID environment variable."
        );
        let vars = env(&[("AWS_REGION", "us-east-1"), ("AWS_ACCESS_KEY_ID", "AKID")]);
        let auth = resolve_auth(&Default::default(), &vars, SessionTokenFallback::Always);
        assert_eq!(
            credentials(auth).await.unwrap_err().to_string(),
            "AWS SigV4 authentication requires both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. Please ensure both credentials are provided.\nOriginal error: AWS secret access key setting is missing. Pass it using the 'secretAccessKey' parameter or the AWS_SECRET_ACCESS_KEY environment variable."
        );
    }

    fn recording_fetch(seen: Arc<parking_lot::Mutex<Vec<FetchRequest>>>) -> FetchFunction {
        Arc::new(move |request: FetchRequest, _| {
            seen.lock().push(request);
            Box::pin(async {
                Ok(super::super::api::FetchResponse {
                    status: 200,
                    status_text: "OK".into(),
                    headers: Headers::new(),
                    body: bytes::Bytes::from_static(b"{}"),
                })
            })
        })
    }

    #[tokio::test]
    async fn adds_the_bearer_header_and_user_agent() {
        let seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let fetch = authorized_fetch(Auth::ApiKey("k".into()), recording_fetch(seen.clone()));
        let mut headers = Headers::new();
        headers.insert("Content-Type".into(), "application/json".into());
        headers.insert("user-agent".into(), "ai/7.0.137".into());
        fetch(
            FetchRequest {
                url: "https://x".into(),
                headers,
                body: "{}".into(),
            },
            None,
        )
        .await
        .unwrap();
        let sent = seen.lock()[0].headers.clone();
        assert_eq!(sent.get("Authorization").unwrap(), "Bearer k");
        assert_eq!(sent.get("content-type").unwrap(), "application/json");
        assert_eq!(
            sent.get("user-agent").unwrap(),
            &format!("ai/7.0.137 ai-sdk-amazon-bedrock/{VERSION}")
        );
    }

    #[tokio::test]
    async fn signs_with_the_session_token() {
        let seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let credentials: SigningCredentialsFn = Arc::new(|| {
            Box::pin(async {
                Ok(SigningCredentials {
                    region: "us-east-1".into(),
                    access_key_id: "AKID".into(),
                    secret_access_key: "SECRET".into(),
                    session_token: Some("TOKEN".into()),
                })
            })
        });
        let fetch = authorized_fetch(Auth::SigV4(credentials), recording_fetch(seen.clone()));
        let mut headers = Headers::new();
        headers.insert("content-type".into(), "application/json".into());
        headers.insert("anthropic-beta".into(), "x".into());
        fetch(
            FetchRequest {
                url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke".into(),
                headers,
                body: "{}".into(),
            },
            None,
        )
        .await
        .unwrap();
        let sent = seen.lock()[0].headers.clone();
        assert_eq!(sent.get("x-amz-security-token").unwrap(), "TOKEN");
        assert!(sent.get("x-amz-date").is_some());
        let authorization = sent.get("authorization").unwrap();
        assert!(
            authorization.starts_with("AWS4-HMAC-SHA256 Credential=AKID/"),
            "{authorization}"
        );
        assert!(
            authorization.contains(
                "/us-east-1/bedrock/aws4_request, SignedHeaders=anthropic-beta;host;x-amz-date;x-amz-security-token, Signature="
            ),
            "{authorization}"
        );
    }
}
