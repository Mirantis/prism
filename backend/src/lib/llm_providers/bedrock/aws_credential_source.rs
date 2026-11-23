//! Whether the AWS default credential chain has a source to read.

use std::sync::atomic::{AtomicBool, Ordering};

use aws_config::default_provider::credentials::DefaultCredentialsChain;
use aws_credential_types::provider::ProvideCredentials;
use aws_credential_types::provider::error::CredentialsError;

static SOURCE_FOUND: AtomicBool = AtomicBool::new(false);

/// The variables the AWS default chain reads its sources from.
const CHAIN_VARIABLES: [&str; 12] = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
];

/// Removes each chain variable whose value is blank. The JavaScript SDK reads an
/// empty value as unset, but Rust's chain reads an empty
/// `AWS_WEB_IDENTITY_TOKEN_FILE` as a web identity set up without its role, a
/// source that fails. A start that blanks its credentials so `.env` cannot bring
/// them back (the `@no-llm-provider` E2E run) then has no source, as it should.
/// Call it after `.env` is loaded and before any thread starts.
pub fn drop_blank_chain_variables() {
    for name in CHAIN_VARIABLES {
        if std::env::var_os(name).is_some_and(|value| value.to_string_lossy().trim().is_empty()) {
            // SAFETY: called from `main` before the async runtime or any other
            // thread starts, so nothing reads the environment concurrently.
            unsafe { std::env::remove_var(name) };
        }
    }
}

/// True when the chain finds a source. A source that is set up but fails, such as
/// an expired SSO session, also answers true, so the model request reports the
/// SDK's own error. Once a source is found, later calls answer true without a
/// lookup; until then each call looks again, so a source added while the runtime
/// runs is found.
pub async fn has_aws_credential_source() -> bool {
    if SOURCE_FOUND.load(Ordering::Relaxed) {
        return true;
    }
    let chain = DefaultCredentialsChain::builder().build().await;
    if !has_source(&chain.provide_credentials().await) {
        return false;
    }
    SOURCE_FOUND.store(true, Ordering::Relaxed);
    true
}

/// `CredentialsNotLoaded` is what the chain answers when no link has a source; any
/// other answer, a failure included, means a source is set up.
fn has_source<T>(answer: &Result<T, CredentialsError>) -> bool {
    !matches!(answer, Err(CredentialsError::CredentialsNotLoaded(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_link_with_a_source_is_no_source() {
        assert!(!has_source::<()>(&Err(CredentialsError::not_loaded(
            "no providers in chain"
        ))));
    }

    #[test]
    fn a_source_that_fails_still_counts_as_set_up() {
        assert!(has_source::<()>(&Err(CredentialsError::provider_error(
            "the SSO session has expired"
        ))));
        assert!(has_source(&Ok(())));
    }
}
