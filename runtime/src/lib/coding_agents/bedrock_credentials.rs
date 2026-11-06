//! AWS credentials and region as a coding agent's CLI will find them.

use crate::lib::execution_environments::execution_environment::ProcessEnv;

/// A variable that is set and not empty, as JavaScript's truthiness reads it.
fn set(env: &ProcessEnv, key: &str) -> bool {
    env.get(key).is_some_and(|v| !v.is_empty())
}

/// Explicit AWS credentials or a configured AWS credential chain.
pub fn has_bedrock_credentials(env: &ProcessEnv) -> bool {
    set(env, "AWS_BEARER_TOKEN_BEDROCK")
        || (set(env, "AWS_ACCESS_KEY_ID") && set(env, "AWS_SECRET_ACCESS_KEY"))
        || set(env, "AWS_PROFILE")
        || (set(env, "AWS_WEB_IDENTITY_TOKEN_FILE") && set(env, "AWS_ROLE_ARN"))
        || set(env, "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
        || set(env, "AWS_CONTAINER_CREDENTIALS_FULL_URI")
}

/// `AWS_REGION`, else `AWS_DEFAULT_REGION`, else the region of the selected
/// profile (`AWS_PROFILE`, default `default`) in the config file, then in the
/// shared credentials file, else `us-east-1`.
pub fn bedrock_region(env: &ProcessEnv) -> String {
    todo!()
}

/// Read a profile's top-level region without loading its credentials. Lines
/// lose a `;` or `#` comment; `[profile "x"]` reads as `profile x`; a key with
/// an empty value opens a subsection, whose `region` is not the profile's.
fn profile_region(file: &str, section: &str) -> Option<String> {
    todo!()
}
