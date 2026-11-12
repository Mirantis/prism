//! The environment a Claude Code process runs in, for a task and for `claude`
//! in the desktop's terminal alike. Reads nothing of the configuration, so the
//! terminal's `coding-agent-exec` uses it without starting the runtime.

use super::authenticated_home::subscription_environment;
use crate::lib::coding_agents::bedrock_credentials::{bedrock_region, has_bedrock_credentials};
use crate::lib::execution_environments::execution_environment::ProcessEnv;

/// The variable when it is set and not empty.
fn value<'a>(env: &'a ProcessEnv, key: &str) -> Option<&'a str> {
    env.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

/// `env` with the provider the deployment's credentials select: Foundry when
/// switched on (with the Azure key and resource filled in), Bedrock when switched
/// on or when AWS credentials are the only ones (with its region), the env as it
/// is for Vertex or an Anthropic key or token, else Foundry when its key and
/// resource are there.
pub fn claude_code_environment(env: &ProcessEnv) -> ProcessEnv {
    // `a || b`: the first when it is set and not empty, else the second as it is.
    let foundry_key = value(env, "ANTHROPIC_FOUNDRY_API_KEY")
        .or_else(|| env.get("AZURE_API_KEY").map(String::as_str));
    let foundry_resource = value(env, "ANTHROPIC_FOUNDRY_RESOURCE")
        .or_else(|| env.get("AZURE_RESOURCE_NAME").map(String::as_str));
    // `{ ...env, ...foundry }`: a key whose value is undefined is set to nothing.
    let with_foundry = |mut out: ProcessEnv| -> ProcessEnv {
        match foundry_key {
            Some(key) => {
                out.insert("ANTHROPIC_FOUNDRY_API_KEY".to_string(), key.to_string());
            }
            None => {
                out.shift_remove("ANTHROPIC_FOUNDRY_API_KEY");
            }
        }
        match foundry_resource {
            Some(resource) => {
                out.insert(
                    "ANTHROPIC_FOUNDRY_RESOURCE".to_string(),
                    resource.to_string(),
                );
            }
            None => {
                out.shift_remove("ANTHROPIC_FOUNDRY_RESOURCE");
            }
        }
        out
    };
    let flag = |key: &str| env.get(key).map(String::as_str);

    if flag("CLAUDE_CODE_USE_FOUNDRY") == Some("1") {
        return with_foundry(env.clone());
    }
    let uses_other_credentials = flag("CLAUDE_CODE_USE_VERTEX") == Some("1")
        || value(env, "ANTHROPIC_API_KEY").is_some()
        || value(env, "ANTHROPIC_AUTH_TOKEN").is_some()
        || value(env, "CLAUDE_CODE_OAUTH_TOKEN").is_some();
    if flag("CLAUDE_CODE_USE_BEDROCK") == Some("1")
        || (!uses_other_credentials
            && has_bedrock_credentials(env)
            && flag("CLAUDE_CODE_USE_BEDROCK") != Some("0"))
    {
        let mut out = env.clone();
        out.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());
        out.insert("AWS_REGION".to_string(), bedrock_region(env));
        return out;
    }
    if uses_other_credentials {
        return env.clone();
    }
    let truthy = |v: Option<&str>| v.is_some_and(|v| !v.is_empty());
    if (truthy(foundry_key) || value(env, "ANTHROPIC_FOUNDRY_AUTH_TOKEN").is_some())
        && (truthy(foundry_resource) || value(env, "ANTHROPIC_FOUNDRY_BASE_URL").is_some())
        && flag("CLAUDE_CODE_USE_FOUNDRY") != Some("0")
    {
        let mut out = with_foundry(env.clone());
        out.insert("CLAUDE_CODE_USE_FOUNDRY".to_string(), "1".to_string());
        return out;
    }
    env.clone()
}

/// On the subscription, `env` without what outranks the saved login; otherwise
/// the deployment's provider, as `claude_code_environment` resolves it.
pub fn claude_code_launch_environment(env: &ProcessEnv, subscription: bool) -> ProcessEnv {
    if subscription {
        subscription_environment(env)
    } else {
        claude_code_environment(env)
    }
}
