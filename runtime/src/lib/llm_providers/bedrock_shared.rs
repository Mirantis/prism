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

use crate::ai::providers::amazon_bedrock::AmazonBedrockProviderSettings;
use crate::config::CONFIG;
use crate::log_info;

/// Credential/region options for any bedrock-runtime SDK client: explicit keys
/// when set, otherwise the AWS default provider chain.
///
/// With explicit keys it logs `Using explicit AWS credentials for Bedrock
/// authentication` and returns `{ region, accessKeyId, secretAccessKey,
/// sessionToken }` (an empty session token is unset). Otherwise it logs `Using
/// default AWS credential provider chain for Bedrock authentication (no explicit
/// keys set)` and returns `{ region, credentialProvider }`, whose provider logs
/// `Using default AWS credential provider chain for Bedrock authentication` and
/// `Credentials expire at ${expiration} with scope ${credentialScope}` on each
/// resolution.
pub fn create_shared_bedrock_options() -> AmazonBedrockProviderSettings {
    todo!()
}
