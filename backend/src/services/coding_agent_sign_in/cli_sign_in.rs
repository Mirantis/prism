//! One run of a coding agent's own sign-in command, `claude auth login` or
//! `codex login --device-auth`, read for the link it prints.
//!
//! The person signs in on Anthropic's or OpenAI's page. Claude then shows a
//! code, which goes to the waiting command's stdin and nowhere else; Codex asks
//! the person to type the code it printed on OpenAI's page, and its command
//! ends when they have.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

use crate::config::CodingAgentName;
use crate::lib::coding_agents::claude_code::authenticated_home::subscription_environment as claude_subscription_environment;
use crate::lib::coding_agents::codex::credentials::subscription_environment as codex_subscription_environment;
use crate::lib::execution_environments::execution_environment::{
    ExecOutput, ExecProcess, ExecStdin, ExecutionEnvironment, ProcessEnv, RunOptions, Signal,
    StdinMode,
};
use crate::support::js::len16;

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
    let set = |mut env: ProcessEnv, pairs: &[(&str, &str)]| {
        for (key, value) in pairs {
            env.insert(key.to_string(), value.to_string());
        }
        env
    };
    match agent {
        CodingAgentName::ClaudeCode => SignInCommand {
            command: "claude".to_string(),
            args: ["auth", "login", "--claudeai"].map(str::to_string).to_vec(),
            // No browser to open here: the person opens the link on their own device.
            env: set(
                claude_subscription_environment(base_env),
                &[
                    ("CLAUDE_CONFIG_DIR", home),
                    ("BROWSER", "false"),
                    ("DISABLE_AUTOUPDATER", "1"),
                ],
            ),
        },
        CodingAgentName::Codex => SignInCommand {
            command: "codex".to_string(),
            args: [
                "login",
                "--device-auth",
                "-c",
                "cli_auth_credentials_store=\"file\"",
            ]
            .map(str::to_string)
            .to_vec(),
            env: set(
                codex_subscription_environment(base_env),
                &[("CODEX_HOME", home)],
            ),
        },
    }
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
    let SignInCommand { command, args, env } =
        sign_in_command(agent, &environment.base_env(), home);
    let child = environment.run_program(
        &command,
        &args,
        RunOptions {
            cwd: environment.workspace_root(),
            env,
            stdin: StdinMode::Pipe,
        },
    );
    let sign_in = Arc::new(RunningSignIn {
        agent,
        stdin: Arc::new(tokio::sync::Mutex::new(child.take_stdin())),
        output: Mutex::new(Reading::default()),
        prompt: watch::channel(None).0,
        ended: watch::channel(None).0,
        child: child.clone(),
    });
    for stream in [child.take_stdout(), child.take_stderr()]
        .into_iter()
        .flatten()
    {
        let reader = sign_in.clone();
        tokio::spawn(async move { reader.read(stream).await });
    }
    let waiter = sign_in.clone();
    tokio::spawn(async move {
        let end = waiter.child.ended().await;
        waiter.settle_prompt(Err(format!(
            "{command} sign-in ended before it showed a link"
        )));
        waiter.settle_end(if end.error.is_none() && end.exit_code == Some(0) {
            SignInEnd::Exited
        } else {
            SignInEnd::Failed
        });
    });
    sign_in
}

/// What the command printed so far, and whether a code went in.
#[derive(Default)]
struct Reading {
    output: String,
    code_sent: bool,
}

struct RunningSignIn {
    agent: CodingAgentName,
    child: Arc<dyn ExecProcess>,
    /// The command's stdin; a pipe the command's end closed is not the sign-in's error.
    stdin: Arc<tokio::sync::Mutex<Option<ExecStdin>>>,
    output: Mutex<Reading>,
    prompt: watch::Sender<Option<Result<SignInPrompt, String>>>,
    ended: watch::Sender<Option<SignInEnd>>,
}

impl RunningSignIn {
    async fn read(&self, mut stream: ExecOutput) {
        let mut chunk = vec![0u8; 8192];
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(n) => self.take(&String::from_utf8_lossy(&chunk[..n])),
            }
        }
    }

    /// One piece of output, as it arrives.
    fn take(&self, piece: &str) {
        let (found, refused) = {
            let mut reading = self.output.lock();
            if len16(&reading.output) < OUTPUT_LIMIT {
                reading.output.push_str(piece);
            }
            (
                read_prompt(self.agent, &reading.output),
                reading.code_sent && INVALID_CODE_PATTERN.is_match(&reading.output),
            )
        };
        if let Some(found) = found {
            self.settle_prompt(Ok(found));
        }
        if refused {
            self.settle_end(SignInEnd::InvalidCode);
            self.child.kill(Signal::SIGTERM);
        }
    }

    fn settle_prompt(&self, outcome: Result<SignInPrompt, String>) {
        self.prompt.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(outcome);
            true
        });
    }

    fn settle_end(&self, end: SignInEnd) {
        self.ended.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(end);
            true
        });
    }
}

#[async_trait]
impl CliSignIn for RunningSignIn {
    async fn prompt(&self) -> anyhow::Result<SignInPrompt> {
        let mut prompt = self.prompt.subscribe();
        let settled = prompt
            .wait_for(Option::is_some)
            .await
            .map_err(|_| anyhow::anyhow!("the sign-in ended"))?
            .clone();
        match settled {
            Some(Ok(prompt)) => Ok(prompt),
            Some(Err(message)) => Err(anyhow::anyhow!(message)),
            None => unreachable!("wait_for returns a settled prompt"),
        }
    }

    async fn ended(&self) -> SignInEnd {
        let mut ended = self.ended.subscribe();
        match ended.wait_for(Option::is_some).await {
            Ok(end) => end.unwrap_or(SignInEnd::Failed),
            Err(_) => SignInEnd::Failed,
        }
    }

    fn submit_code(&self, code: &str) {
        // Only what comes after the code is read for a refusal.
        {
            let mut reading = self.output.lock();
            reading.output.clear();
            reading.code_sent = true;
        }
        let stdin = self.stdin.clone();
        let line = format!("{code}\n");
        tokio::spawn(async move {
            if let Some(stdin) = stdin.lock().await.as_mut() {
                let _ = stdin.write_all(line.as_bytes()).await;
                let _ = stdin.flush().await;
            }
        });
    }

    fn kill(&self) {
        self.child.kill(Signal::SIGTERM);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::coding_agents::testing::{FakeChild, FakeEnvironment, env_of, wait_for};

    // What Claude Code 2.1 prints with stdin piped: the link wrapped in an OSC 8 hyperlink.
    const CLAUDE_OUTPUT: &str = "If the browser didn't open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=test\x07https://claude.com/cai/oauth/authorize?code=true&client_id=test\x1b]8;;\x07\nPaste code here if prompted > ";
    // What Codex 0.156 prints for a device sign-in, coloured.
    const CODEX_OUTPUT: &str = "Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mTEST-CODE1\x1b[0m\n";

    fn prompt(url: &str, user_code: Option<&str>) -> SignInPrompt {
        SignInPrompt {
            url: url.to_string(),
            user_code: user_code.map(str::to_string),
        }
    }

    #[test]
    fn reads_claudes_link_out_of_its_hyperlink() {
        assert_eq!(
            read_prompt(CodingAgentName::ClaudeCode, CLAUDE_OUTPUT),
            Some(prompt(
                "https://claude.com/cai/oauth/authorize?code=true&client_id=test",
                None
            ))
        );
    }

    #[test]
    fn reads_codexs_link_and_one_time_code() {
        assert_eq!(
            read_prompt(CodingAgentName::Codex, CODEX_OUTPUT),
            Some(prompt(
                "https://auth.openai.com/codex/device",
                Some("TEST-CODE1")
            ))
        );
    }

    #[test]
    fn waits_for_the_code_codex_prints_after_its_link() {
        let cut = &CODEX_OUTPUT[..CODEX_OUTPUT.find("2.").unwrap()];
        assert_eq!(read_prompt(CodingAgentName::Codex, cut), None);
    }

    #[test]
    fn skips_a_link_the_cli_prints_before_its_sign_in_link() {
        let notice = "A new version is out: https://github.com/example/releases\n";
        assert_eq!(
            read_prompt(
                CodingAgentName::ClaudeCode,
                &format!("{notice}{CLAUDE_OUTPUT}")
            )
            .map(|p| p.url),
            Some("https://claude.com/cai/oauth/authorize?code=true&client_id=test".to_string())
        );
        assert_eq!(
            read_prompt(CodingAgentName::Codex, &format!("{notice}{CODEX_OUTPUT}")).map(|p| p.url),
            Some("https://auth.openai.com/codex/device".to_string())
        );
    }

    #[test]
    fn signs_claude_in_to_the_task_home_without_the_variables_that_outrank_its_login() {
        let SignInCommand { command, args, env } = sign_in_command(
            CodingAgentName::ClaudeCode,
            &env_of(&[
                ("CLAUDE_CODE_USE_BEDROCK", "1"),
                ("ANTHROPIC_API_KEY", "k"),
                ("PATH", "/bin"),
            ]),
            "/data/.claude",
        );
        assert_eq!(command, "claude");
        assert_eq!(args, ["auth", "login", "--claudeai"]);
        assert_eq!(
            env,
            env_of(&[
                ("PATH", "/bin"),
                ("CLAUDE_CONFIG_DIR", "/data/.claude"),
                ("BROWSER", "false"),
                ("DISABLE_AUTOUPDATER", "1"),
            ])
        );
    }

    #[test]
    fn signs_codex_in_to_the_task_home_in_the_credential_store_tasks_read() {
        let SignInCommand { command, args, env } = sign_in_command(
            CodingAgentName::Codex,
            &env_of(&[("OPENAI_API_KEY", "k"), ("PATH", "/bin")]),
            "/data/.codex",
        );
        assert_eq!(command, "codex");
        assert_eq!(
            args,
            [
                "login",
                "--device-auth",
                "-c",
                "cli_auth_credentials_store=\"file\""
            ]
        );
        assert_eq!(
            env,
            env_of(&[("PATH", "/bin"), ("CODEX_HOME", "/data/.codex")])
        );
    }

    fn start(agent: CodingAgentName) -> (Arc<FakeChild>, Arc<dyn CliSignIn>) {
        let child = FakeChild::new();
        let process = child.process();
        let environment = FakeEnvironment::with_run_program(move |_, _, _| process.clone());
        (child, start_cli_sign_in(&environment, agent, "/home"))
    }

    #[tokio::test]
    async fn types_claudes_code_into_the_waiting_command_and_ends_when_it_exits() {
        let (child, sign) = start(CodingAgentName::ClaudeCode);
        child.write_stdout(CLAUDE_OUTPUT);
        assert_eq!(sign.prompt().await.unwrap().user_code, None);
        sign.submit_code("test-code#state");
        let typed = child.stdin.clone();
        wait_for(move || typed.text() == "test-code#state\n").await;
        child.finish(Some(0));
        assert_eq!(sign.ended().await, SignInEnd::Exited);
    }

    #[tokio::test]
    async fn ends_at_once_on_a_refused_code_since_the_cli_keeps_waiting_for_another() {
        let (child, sign) = start(CodingAgentName::ClaudeCode);
        child.write_stdout(CLAUDE_OUTPUT);
        sign.prompt().await.unwrap();
        sign.submit_code("wrong");
        child.write_stderr("Invalid code. Please make sure the full code was copied.\n");
        assert_eq!(sign.ended().await, SignInEnd::InvalidCode);
        assert_eq!(child.signals(), [Signal::SIGTERM]);
    }

    #[tokio::test]
    async fn reads_the_prompt_whole_when_the_output_arrives_cut() {
        for (agent, output, cut) in [
            (CodingAgentName::ClaudeCode, CLAUDE_OUTPUT, "&client_id"),
            (CodingAgentName::Codex, CODEX_OUTPUT, "/device"),
            (CodingAgentName::Codex, CODEX_OUTPUT, "CODE1"),
        ] {
            let (child, sign) = start(agent);
            let at = output.rfind(cut).unwrap();
            child.write_stdout(&output[..at]);
            let early =
                tokio::time::timeout(std::time::Duration::from_millis(50), sign.prompt()).await;
            assert!(early.is_err(), "{cut}");
            child.write_stdout(&output[at..]);
            assert_eq!(sign.prompt().await.ok(), read_prompt(agent, output));
        }
    }

    #[tokio::test]
    async fn rejects_the_prompt_when_the_command_ends_before_its_link() {
        let (child, sign) = start(CodingAgentName::Codex);
        child.finish(Some(1));
        let err = sign.prompt().await.unwrap_err();
        assert!(err.to_string().contains("ended before it showed a link"));
        assert_eq!(sign.ended().await, SignInEnd::Failed);
    }
}
