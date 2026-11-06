//! One run of a coding agent's own sign-in command, `claude auth login` or
//! `codex login --device-auth`, read for the link it prints.
//!
//! The person signs in on Anthropic's or OpenAI's page. Claude then shows a
//! code, which goes to the waiting command's stdin and nowhere else; Codex asks
//! the person to type the code it printed on OpenAI's page, and its command
//! ends when they have.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::config::CodingAgentName;
use crate::lib::coding_agents::claude_code::authenticated_home::subscription_environment as claude_subscription_environment;
use crate::lib::coding_agents::codex::credentials::subscription_environment as codex_subscription_environment;
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};

/// What the person is shown: the page to open, and for Codex the code to enter there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInPrompt {
    pub url: String,
    pub user_code: Option<String>,
}

/// How the command ended: on its own with success, by refusing the code it was
/// given, or otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInEnd {
    Exited,
    InvalidCode,
    Failed,
}

impl SignInEnd {
    pub fn as_str(self) -> &'static str {
        match self {
            SignInEnd::Exited => "exited",
            SignInEnd::InvalidCode => "invalid_code",
            SignInEnd::Failed => "failed",
        }
    }
}

/// A running sign-in command. `prompt` and `ended` can be awaited any number of
/// times and from several tasks, and each answers with the one outcome.
#[async_trait]
pub trait CliSignIn: Send + Sync {
    /// Settles once the command has printed what the person needs; fails when it
    /// ends first ("<command> sign-in ended before it showed a link").
    async fn prompt(&self) -> anyhow::Result<SignInPrompt>;
    /// Settles when the command ends, or as soon as it refuses a code.
    async fn ended(&self) -> SignInEnd;
    /// Claude's code, typed into the waiting command.
    fn submit_code(&self, code: &str);
    fn kill(&self);
}

/// More than either CLI prints before the link; the rest is not read.
const OUTPUT_LIMIT: usize = 64 * 1024;

/// The CLIs colour their output and wrap a link in an OSC 8 hyperlink.
static ESCAPES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]").expect("valid regex")
});

/// A link the CLI has finished printing: output arrives in pieces, and only the
/// whitespace after a link shows that it is whole. The link is group 1.
static URL_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(https://[^\s"'<>]+)\s"#).expect("valid regex"));

/// Where each CLI's sign-in link goes. A link to anywhere else, such as a
/// notice's, is not it.
fn sign_in_hosts(agent: CodingAgentName) -> &'static [&'static str] {
    match agent {
        CodingAgentName::ClaudeCode => &["claude.com", "claude.ai"],
        CodingAgentName::Codex => &["auth.openai.com"],
    }
}

/// The one-time code `codex login --device-auth` prints after its link, e.g.
/// `ABCD-EFGHI`, once whole. The code is group 1.
static USER_CODE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)([A-Z0-9]{4}-[A-Z0-9]{4,6})\s").expect("valid regex"));

/// What `claude auth login` prints for a code it refuses. It then keeps waiting
/// for another.
static INVALID_CODE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)Invalid code").expect("valid regex"));

/// The command, its arguments and its environment, run where the home is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInCommand {
    pub command: String,
    pub args: Vec<String>,
    pub env: ProcessEnv,
}

/// The command, its arguments and its environment, run where the home is.
pub fn sign_in_command(agent: CodingAgentName, base_env: &ProcessEnv, home: &str) -> SignInCommand {
    todo!()
}

/// The link, and for Codex the code, in what the command printed so far; `None`
/// until all are there.
pub fn read_prompt(agent: CodingAgentName, output: &str) -> Option<SignInPrompt> {
    let text = ESCAPES.replace_all(output, "");
    let (url, end) = URL_PATTERN.captures_iter(&text).find_map(|caps| {
        let link = caps.get(1)?;
        let host = url::Url::parse(link.as_str())
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_string))
            .unwrap_or_default();
        sign_in_hosts(agent)
            .contains(&host.as_str())
            .then(|| (link.as_str().to_string(), link.end()))
    })?;
    if agent == CodingAgentName::ClaudeCode {
        return Some(SignInPrompt {
            url,
            user_code: None,
        });
    }
    let user_code = USER_CODE_PATTERN
        .captures(&text[end..])?
        .get(1)?
        .as_str()
        .to_string();
    Some(SignInPrompt {
        url,
        user_code: Some(user_code),
    })
}

/// Starts the sign-in command in `environment`, with stdin piped for Claude's
/// code. Output is read up to `OUTPUT_LIMIT` for the prompt and, after a code
/// was submitted, for a refusal, which ends the command with `InvalidCode`.
pub fn start_cli_sign_in(
    environment: &dyn ExecutionEnvironment,
    agent: CodingAgentName,
    home: &str,
) -> Arc<dyn CliSignIn> {
    todo!()
}
