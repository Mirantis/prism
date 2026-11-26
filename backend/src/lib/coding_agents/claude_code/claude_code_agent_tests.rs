//! The Claude Code adapter against a fake `claude`: the argv it builds for each
//! mode, the events it reads out of the stream-json output, and the home it
//! prepares at boot.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::StreamExt;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};

use super::*;
use crate::lib::coding_agents::claude_code::mcp_config::claude_mcp_config;
use crate::lib::coding_agents::coding_agent::{CodingAgentMcpServer, Effort, ModelTier};
use crate::lib::coding_agents::shared_skills_home::prepare_shared_skills_home;
use crate::lib::coding_agents::subscription_switch::set_subscription_in_memory_for_tests;
use crate::lib::coding_agents::testing::{
    DIR_STAT, FakeChild, FakeEnvironment, FakeFiles, env_of, fake_paths, wait_for,
};
use crate::lib::execution_environments::execution_environment::{ProcessMark, RunOptions};
use crate::lib::execution_environments::get_execution_environment::set_execution_environment_for_tests;

fn base_task() -> CodingAgentTask {
    CodingAgentTask {
        task_id: "t1".to_string(),
        prompt: "do X".to_string(),
        workdir: None,
        env: env_of(&[("PATH", "/bin")]),
        mode: CodingAgentMode::Edit,
        model_tier: None,
        effort: None,
        max_turns: 100,
        append_system_prompt: None,
        session_id: None,
        debug: None,
        mcp_servers: vec![],
    }
}

/// `claude auth status --json` from Claude Code 2.1.304 signed in to a
/// subscription, account fields replaced.
const SUBSCRIPTION_STATUS: &str = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"user@example.com","orgId":"org-1","orgName":"Example","subscriptionType":"max"}"#;
const SIGNED_OUT: &str = r#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#;
const NO_SUBSCRIPTION: &str = "Claude Code failed to start: Claude Code is set to use your Claude subscription, and nobody is signed in to it: sign in again from Coding agents";

#[derive(Clone)]
struct Launch {
    command: String,
    args: Vec<String>,
    options: RunOptions,
    child: Arc<FakeChild>,
}

struct Started {
    run: Arc<dyn CodingAgentRun>,
    launches: Arc<Mutex<Vec<Launch>>>,
    asked: Arc<AtomicUsize>,
}

impl Started {
    /// The task's own launch, once the work before it is done.
    async fn launched(&self) -> Launch {
        let launches = self.launches.clone();
        wait_for(move || launches.lock().len() == 1).await;
        self.launches.lock()[0].clone()
    }
}

/// An environment that records each launch instead of running anything.
/// `status` is what `claude auth status` prints; without it the home is
/// missing, so the CLI is never asked.
fn recording(
    status: Option<&'static str>,
) -> (FakeEnvironment, Arc<Mutex<Vec<Launch>>>, Arc<AtomicUsize>) {
    let launches: Arc<Mutex<Vec<Launch>>> = Arc::default();
    let asked = Arc::new(AtomicUsize::new(0));
    let (sink, count) = (launches.clone(), asked.clone());
    let environment = FakeEnvironment {
        files: FakeFiles {
            stat: Some(Arc::new(move |_| match status {
                Some(_) => Ok(DIR_STAT),
                None => anyhow::bail!("ENOENT"),
            })),
            ..Default::default()
        },
        ..FakeEnvironment::with_run_program(move |command, args, options| {
            let child = FakeChild::new();
            if args.first().map(String::as_str) == Some("auth")
                && let Some(status) = status
            {
                count.fetch_add(1, Ordering::SeqCst);
                child.emit_line(status);
                child.finish(Some(0));
            } else {
                sink.lock().push(Launch {
                    command: command.to_string(),
                    args: args.to_vec(),
                    options,
                    child: child.clone(),
                });
            }
            child.process()
        })
    };
    (environment, launches, asked)
}

fn start(task: CodingAgentTask, status: Option<&'static str>) -> Started {
    let (environment, launches, asked) = recording(status);
    let run = create_claude_code_agent(Some(environment.arc())).run(task);
    Started {
        run,
        launches,
        asked,
    }
}

/// The launch of a task, which the test never finishes.
async fn capture(task: CodingAgentTask, status: Option<&'static str>) -> Launch {
    start(task, status).launched().await
}

/// The value carried by a flag, or `None` when the flag is absent.
fn value_of<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let i = args.iter().position(|arg| arg == flag)?;
    args.get(i + 1).map(String::as_str)
}

fn count(args: &[String], flag: &str) -> usize {
    args.iter().filter(|arg| *arg == flag).count()
}

async fn collect(run: &Arc<dyn CodingAgentRun>) -> Vec<CodingAgentEvent> {
    run.take_events().unwrap().collect().await
}

/// Feed stream-json lines to a fake `claude` and collect what the adapter reads.
async fn events_for(lines: &[Value], task: CodingAgentTask) -> Vec<CodingAgentEvent> {
    let started = start(task, None);
    let Launch { child, .. } = started.launched().await;
    for line in lines {
        child.emit_line(&line.to_string());
    }
    child.finish(Some(0));
    collect(&started.run).await
}

fn result(stop_reason: CodingAgentStopReason, turns: i64, message: &str) -> CodingAgentEvent {
    CodingAgentEvent::Result {
        stop_reason,
        turns,
        message: message.to_string(),
        refusals: None,
    }
}

fn deployment() -> Settings {
    Settings::of_deployment()
}

fn skipping_permissions() -> Settings {
    Settings {
        skip_permissions: true,
        ..Settings::of_deployment()
    }
}

#[test]
fn identifies_itself() {
    let agent = create_claude_code_agent(None);
    assert_eq!(agent.id(), CodingAgentName::ClaudeCode);
    assert_eq!(agent.display_name(), "Claude Code");
}

// ---------------------------------------------------------------- the spawn

#[tokio::test]
#[serial_test::serial]
async fn runs_the_claude_binary_in_print_mode_with_stream_json_output_and_the_turn_budget() {
    let Launch { command, args, .. } = capture(
        CodingAgentTask {
            max_turns: 42,
            ..base_task()
        },
        None,
    )
    .await;
    assert_eq!(command, "claude");
    assert_eq!(
        args[..7],
        [
            "-p",
            "do X",
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-turns",
            "42"
        ]
    );
    assert_eq!(
        value_of(&args, "--disallowed-tools"),
        Some("AskUserQuestion")
    );
}

#[tokio::test]
#[serial_test::serial]
async fn hands_the_tasks_cwd_and_env_to_the_child() {
    let Launch { options, .. } = capture(
        CodingAgentTask {
            workdir: Some("/work".to_string()),
            ..base_task()
        },
        None,
    )
    .await;
    assert_eq!(options.cwd, "/work");
    // The home comes from the execution environment, since that is the
    // filesystem it is on — a path this process resolved could name nothing
    // there.
    assert_eq!(
        options.env,
        env_of(&[
            ("PATH", "/bin"),
            ("CLAUDE_CONFIG_DIR", "/workspace/.claude")
        ])
    );
}

#[tokio::test]
#[serial_test::serial]
async fn takes_the_home_from_the_environment_not_from_the_task_env() {
    let Launch { options, .. } = capture(
        CodingAgentTask {
            env: env_of(&[("PATH", "/bin"), ("CLAUDE_CONFIG_DIR", "/theirs")]),
            ..base_task()
        },
        None,
    )
    .await;
    assert_eq!(options.env["CLAUDE_CONFIG_DIR"], "/workspace/.claude");
}

#[tokio::test]
#[serial_test::serial]
async fn resumes_a_session_and_turns_on_debug_when_asked() {
    let Launch { args, .. } = capture(
        CodingAgentTask {
            session_id: Some("sess-1".to_string()),
            debug: Some(true),
            ..base_task()
        },
        None,
    )
    .await;
    assert_eq!(value_of(&args, "--resume"), Some("sess-1"));
    assert!(args.contains(&"--debug".to_string()));
}

#[tokio::test]
#[serial_test::serial]
async fn passes_neither_by_default() {
    let Launch { args, .. } = capture(base_task(), None).await;
    assert!(!args.contains(&"--resume".to_string()));
    assert!(!args.contains(&"--debug".to_string()));
}

#[tokio::test]
#[serial_test::serial]
async fn runs_each_mode_in_its_permission_mode_never_with_the_bypass() {
    for (mode, permission_mode) in [
        (CodingAgentMode::Edit, "auto"),
        (CodingAgentMode::Plan, "plan"),
    ] {
        let Launch { args, .. } = capture(
            CodingAgentTask {
                mode,
                ..base_task()
            },
            None,
        )
        .await;
        assert_eq!(value_of(&args, "--permission-mode"), Some(permission_mode));
        assert_eq!(count(&args, "--permission-mode"), 1);
        assert!(!args.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(!args.contains(&"--allow-dangerously-skip-permissions".to_string()));
    }
}

#[test]
fn with_skip_permissions_on_runs_an_edit_task_with_the_permission_checks_skipped() {
    let args = build_args(&base_task(), false, false, None, &skipping_permissions());
    assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
    assert!(!args.contains(&"--permission-mode".to_string()));
}

#[test]
fn with_skip_permissions_on_keeps_a_plan_task_in_plan_mode() {
    let task = CodingAgentTask {
        mode: CodingAgentMode::Plan,
        ..base_task()
    };
    let args = build_args(&task, false, false, None, &skipping_permissions());
    assert_eq!(value_of(&args, "--permission-mode"), Some("plan"));
    assert!(!args.contains(&"--dangerously-skip-permissions".to_string()));
}

// ---------------------------------------------------------- the subscription

fn credential_env() -> ProcessEnv {
    env_of(&[
        ("PATH", "/bin"),
        ("ANTHROPIC_API_KEY", "test-key"),
        ("AWS_BEARER_TOKEN_BEDROCK", "test-token"),
        ("CLAUDE_CODE_USE_BEDROCK", "1"),
        ("HOME", "/nonexistent"),
    ])
}

/// Runs `check` with the Claude subscription switch on, then turns it off.
struct SubscriptionOn;

impl SubscriptionOn {
    fn new() -> SubscriptionOn {
        set_subscription_in_memory_for_tests(CodingAgentName::ClaudeCode, true);
        SubscriptionOn
    }
}

impl Drop for SubscriptionOn {
    fn drop(&mut self) {
        set_subscription_in_memory_for_tests(CodingAgentName::ClaudeCode, false);
    }
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_the_deployments_credentials_and_asks_nothing_while_the_subscription_is_off() {
    let started = start(
        CodingAgentTask {
            env: credential_env(),
            ..base_task()
        },
        Some(SUBSCRIPTION_STATUS),
    );
    let Launch { args, options, .. } = started.launched().await;
    assert_eq!(started.asked.load(Ordering::SeqCst), 0);
    assert_eq!(options.env["ANTHROPIC_API_KEY"], "test-key");
    assert_eq!(options.env["CLAUDE_CODE_USE_BEDROCK"], "1");
    assert!(!args.contains(&"--settings".to_string()));
    started.run.stop();
}

#[tokio::test]
#[serial_test::serial]
async fn runs_a_task_on_the_signed_in_subscription_with_nothing_that_outranks_it() {
    let _on = SubscriptionOn::new();
    let Launch { args, options, .. } = capture(
        CodingAgentTask {
            env: credential_env(),
            ..base_task()
        },
        Some(SUBSCRIPTION_STATUS),
    )
    .await;
    assert_eq!(
        options.env,
        env_of(&[
            ("PATH", "/bin"),
            ("AWS_BEARER_TOKEN_BEDROCK", "test-token"),
            ("HOME", "/nonexistent"),
            ("CLAUDE_CONFIG_DIR", "/workspace/.claude"),
        ])
    );
    // A repository's .claude/settings.json can name another provider or key;
    // these outrank it.
    let settings: Value = serde_json::from_str(value_of(&args, "--settings").unwrap()).unwrap();
    assert_eq!(settings["forceLoginMethod"], "claudeai");
    assert_eq!(settings["apiKeyHelper"], "");
    assert_eq!(settings["env"]["CLAUDE_CODE_USE_BEDROCK"], "");
    assert_eq!(settings["env"]["CLAUDE_CODE_USE_VERTEX"], "");
    assert_eq!(settings["env"]["ANTHROPIC_API_KEY"], "");
    assert_eq!(
        settings["env"]["ANTHROPIC_BASE_URL"],
        "https://api.anthropic.com"
    );
}

#[tokio::test]
#[serial_test::serial]
async fn fails_the_task_and_starts_nothing_without_a_subscription_in_the_home() {
    let _on = SubscriptionOn::new();
    for (status, message) in [
        (SIGNED_OUT, NO_SUBSCRIPTION.to_string()),
        (
            r#"{"loggedIn":true,"authMethod":"api_key"}"#,
            NO_SUBSCRIPTION.to_string(),
        ),
        // What Claude Code 2.1.20, from before `auth status --json`, prints on
        // stdout: nothing.
        (
            "",
            "Claude Code failed to start: claude auth status exited with 0 and no status"
                .to_string(),
        ),
    ] {
        let started = start(
            CodingAgentTask {
                env: credential_env(),
                ..base_task()
            },
            Some(status),
        );
        assert_eq!(
            collect(&started.run).await,
            [result(CodingAgentStopReason::Error, 0, &message)]
        );
        assert!(started.launches.lock().is_empty());
    }
}

/// An environment whose Claude home is `/host/...` and whose `claude` prints
/// `status` for `auth` and a finished result for a task, recording each home.
fn host_environment(
    claude_home: &str,
    status: &'static str,
    homes: Arc<Mutex<Vec<String>>>,
) -> FakeEnvironment {
    let mut paths = fake_paths("/workspace");
    paths.claude_home = claude_home.to_string();
    FakeEnvironment {
        paths,
        files: FakeFiles {
            stat: Some(Arc::new(|_| Ok(DIR_STAT))),
            ..Default::default()
        },
        ..FakeEnvironment::with_run_program(move |_, args, options| {
            homes.lock().push(
                options
                    .env
                    .get("CLAUDE_CONFIG_DIR")
                    .cloned()
                    .unwrap_or_default(),
            );
            let child = FakeChild::new();
            if args.first().map(String::as_str) == Some("auth") {
                child.emit_line(status);
            } else {
                child.emit_line(
                    r#"{"type":"result","subtype":"success","result":"ok","num_turns":1}"#,
                );
            }
            child.finish(Some(0));
            child.process()
        })
    }
}

#[tokio::test]
#[serial_test::serial]
async fn reads_the_login_and_runs_a_task_on_the_host_from_the_hosts_home() {
    let _on = SubscriptionOn::new();
    let homes: Arc<Mutex<Vec<String>>> = Arc::default();
    let host = host_environment("/host/.claude", SUBSCRIPTION_STATUS, homes.clone());
    let run = create_claude_code_agent(Some(host.arc())).run(CodingAgentTask {
        workdir: Some("/repo".to_string()),
        env: credential_env(),
        ..base_task()
    });
    let events = collect(&run).await;
    assert!(matches!(
        events.last(),
        Some(CodingAgentEvent::Result {
            stop_reason: CodingAgentStopReason::EndTurn,
            ..
        })
    ));
    assert_eq!(*homes.lock(), ["/host/.claude", "/host/.claude"]);
}

#[tokio::test]
#[serial_test::serial]
async fn names_the_command_that_signs_in_the_hosts_home_when_a_task_on_the_host_finds_nobody_signed_in()
 {
    let _on = SubscriptionOn::new();
    let host = host_environment("/host/o'neil/.claude", SIGNED_OUT, Arc::default());
    set_execution_environment_for_tests(Some(
        FakeEnvironment {
            serves_path: Arc::new(|_| false),
            ..Default::default()
        }
        .arc(),
    ));
    let run = create_claude_code_agent(Some(host.arc())).run(CodingAgentTask {
        workdir: Some("/repo".to_string()),
        env: credential_env(),
        ..base_task()
    });
    let events = collect(&run).await;
    set_execution_environment_for_tests(None);
    let Some(CodingAgentEvent::Result {
        stop_reason,
        message,
        ..
    }) = events.last()
    else {
        panic!("no result");
    };
    assert_eq!(*stop_reason, CodingAgentStopReason::Error);
    assert!(message.contains(
        "nobody is signed in to it on this computer, where this conversation's folder is. Coding agents signs in elsewhere: sign in by running `CLAUDE_CONFIG_DIR='/host/o'\\''neil/.claude' claude auth login --claudeai`"
    ));
}

#[tokio::test]
#[serial_test::serial]
async fn asks_again_for_every_task_so_a_sign_in_applies_to_the_next_one() {
    let _on = SubscriptionOn::new();
    let status = Arc::new(Mutex::new(SIGNED_OUT));
    let launches: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let (now, sink) = (status.clone(), launches.clone());
    let agent = create_claude_code_agent(Some(
        FakeEnvironment {
            files: FakeFiles {
                stat: Some(Arc::new(|_| Ok(DIR_STAT))),
                ..Default::default()
            },
            ..FakeEnvironment::with_run_program(move |_, args, _| {
                let child = FakeChild::new();
                if args.first().map(String::as_str) == Some("auth") {
                    child.emit_line(*now.lock());
                } else {
                    sink.lock().push(args.to_vec());
                }
                child.finish(Some(0));
                child.process()
            })
        }
        .arc(),
    ));

    let first = collect(&agent.run(CodingAgentTask {
        env: credential_env(),
        ..base_task()
    }))
    .await;
    *status.lock() = SUBSCRIPTION_STATUS;
    collect(&agent.run(CodingAgentTask {
        env: credential_env(),
        ..base_task()
    }))
    .await;

    assert_eq!(
        first,
        [result(CodingAgentStopReason::Error, 0, NO_SUBSCRIPTION)]
    );
    assert_eq!(launches.lock().len(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn starts_nothing_when_the_task_is_stopped_while_the_login_is_read() {
    let _on = SubscriptionOn::new();
    for printed in [None, Some(SUBSCRIPTION_STATUS)] {
        let launches: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        let sink = launches.clone();
        let run = create_claude_code_agent(Some(
            FakeEnvironment {
                files: FakeFiles {
                    stat: Some(Arc::new(|_| Ok(DIR_STAT))),
                    ..Default::default()
                },
                ..FakeEnvironment::with_run_program(move |_, args, _| {
                    sink.lock().push(args.to_vec());
                    let child = FakeChild::new();
                    if let Some(printed) = printed {
                        child.emit_line(printed);
                    }
                    child.process()
                })
            }
            .arc(),
        ))
        .run(base_task());
        let seen = launches.clone();
        wait_for(move || seen.lock().len() == 1).await;
        assert_eq!(launches.lock()[0], ["auth", "status", "--json"]);

        run.stop();

        assert_eq!(
            collect(&run).await,
            [result(
                CodingAgentStopReason::Error,
                0,
                "Claude Code was stopped before it started"
            )]
        );
        assert_eq!(launches.lock().len(), 1);
    }
}

// --------------------------------------------------------------- MCP servers

/// The runtime's servers as a task gets them: the platform endpoint and two
/// from a plugin.
fn servers() -> Vec<CodingAgentMcpServer> {
    vec![
        CodingAgentMcpServer::Http {
            name: "nexus".into(),
            url: "https://nexus.example.test/mcp".into(),
            headers: IndexMap::new(),
        },
        CodingAgentMcpServer::Stdio {
            name: "demo__probe".into(),
            command: "node".into(),
            args: vec!["server.js".into()],
            env: [("PROBE_TOKEN".to_string(), "stdio-secret-value".to_string())]
                .into_iter()
                .collect(),
            cwd: "/plugins/demo".into(),
        },
        CodingAgentMcpServer::Http {
            name: "demo__remote".into(),
            url: "https://remote.example.test/mcp".into(),
            headers: [("X-Api-Key".to_string(), "header-secret-value".to_string())]
                .into_iter()
                .collect(),
        },
    ]
}

struct McpHarness {
    environment: FakeEnvironment,
    launches: Arc<Mutex<Vec<Launch>>>,
}

/// An environment over the real filesystem that records each launch and each
/// temp dir, so a test can read the config file and see it go.
fn mcp_harness(child: fn() -> Arc<FakeChild>, files: FakeFiles) -> McpHarness {
    let launches: Arc<Mutex<Vec<Launch>>> = Arc::default();
    let sink = launches.clone();
    let environment = FakeEnvironment {
        files: FakeFiles {
            // No home, so the CLI is launched for the task alone.
            stat: Some(Arc::new(|_| anyhow::bail!("ENOENT"))),
            ..files
        },
        ..FakeEnvironment::with_run_program(move |command, args, options| {
            let child = child();
            sink.lock().push(Launch {
                command: command.to_string(),
                args: args.to_vec(),
                options,
                child: child.clone(),
            });
            child.process()
        })
    };
    McpHarness {
        environment,
        launches,
    }
}

impl McpHarness {
    fn start(&self) -> Arc<dyn CodingAgentRun> {
        self.start_with(base_task())
    }

    fn start_with(&self, task: CodingAgentTask) -> Arc<dyn CodingAgentRun> {
        create_claude_code_agent(Some(self.environment.clone().arc())).run(CodingAgentTask {
            mcp_servers: servers(),
            ..task
        })
    }

    async fn launched(&self) -> Launch {
        let launches = self.launches.clone();
        wait_for(move || launches.lock().len() == 1).await;
        self.launches.lock()[0].clone()
    }

    fn dirs(&self) -> Vec<String> {
        self.environment.files.temp_dirs.lock().clone()
    }
}

#[tokio::test]
#[serial_test::serial]
async fn passes_no_mcp_config_when_the_runtime_connects_none() {
    let Launch { args, .. } = capture(base_task(), None).await;
    assert!(!args.contains(&"--mcp-config".to_string()));
    // Strict would drop the CLI's own servers, the person's claude.ai connectors among them.
    assert!(!args.contains(&"--strict-mcp-config".to_string()));
}

#[cfg(unix)]
#[tokio::test]
#[serial_test::serial]
async fn points_the_cli_at_a_private_config_file() {
    use std::os::unix::fs::PermissionsExt;

    let harness = mcp_harness(FakeChild::new, FakeFiles::local());
    let run = harness.start();
    let Launch { args, child, .. } = harness.launched().await;

    let config_path = value_of(&args, "--mcp-config").unwrap().to_string();
    // Last, so the variadic `--mcp-config` takes the one path only.
    let at = args.iter().position(|a| a == "--mcp-config").unwrap();
    assert_eq!(at + 2, args.len());
    assert_eq!(
        std::fs::read_to_string(&config_path).unwrap(),
        claude_mcp_config(&servers(), true).document
    );
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(std::path::Path::new(&config_path)), 0o600);
    assert_eq!(
        mode(std::path::Path::new(&config_path).parent().unwrap()),
        0o700
    );

    child.finish(Some(0));
    collect(&run).await;
}

#[tokio::test]
#[serial_test::serial]
async fn ends_the_config_path_before_the_debug_flag() {
    let harness = mcp_harness(FakeChild::new, FakeFiles::local());
    let run = harness.start_with(CodingAgentTask {
        debug: Some(true),
        ..base_task()
    });
    let Launch { args, child, .. } = harness.launched().await;

    let at = args.iter().position(|a| a == "--mcp-config").unwrap();
    assert_eq!(args[at + 2], "--debug");

    child.finish(Some(0));
    collect(&run).await;
}

#[tokio::test]
#[serial_test::serial]
async fn names_the_cli_it_starts_to_the_next_boot() {
    let harness = mcp_harness(
        || {
            let child = FakeChild::new();
            *child.mark.lock() = Some(ProcessMark {
                pid: 4343,
                started_at: 2_000,
            });
            child
        },
        FakeFiles::local(),
    );
    let run = harness.start();
    // The config is written first, so there is no process to name yet.
    assert_eq!(run.mark(), None);
    let Launch { child, .. } = harness.launched().await;
    let named = run.clone();
    wait_for(move || named.mark().is_some()).await;

    assert_eq!(
        run.mark(),
        Some(ProcessMark {
            pid: 4343,
            started_at: 2_000
        })
    );
    child.finish(Some(0));
    collect(&run).await;
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_every_env_value_and_header_out_of_the_process_arguments() {
    let harness = mcp_harness(FakeChild::new, FakeFiles::local());
    let run = harness.start();
    let Launch { args, child, .. } = harness.launched().await;

    let argv = args.join("\n");
    assert!(!argv.contains("stdio-secret-value"));
    assert!(!argv.contains("header-secret-value"));

    child.finish(Some(0));
    collect(&run).await;
}

#[tokio::test]
#[serial_test::serial]
async fn removes_the_config_however_the_cli_ends() {
    for ending in ["reports its result", "exits without a result", "is stopped"] {
        let harness = mcp_harness(FakeChild::new, FakeFiles::local());
        let run = harness.start();
        let Launch { child, .. } = harness.launched().await;

        match ending {
            "reports its result" => {
                child.emit_line(
                    r#"{"type":"result","subtype":"success","result":"ok","num_turns":1}"#,
                );
                child.finish(Some(0));
            }
            "exits without a result" => child.finish(Some(1)),
            // A stop before the start hands the CLI over reaches it once it does.
            _ => run.stop(),
        }
        let events = collect(&run).await;

        assert!(
            matches!(events.last(), Some(CodingAgentEvent::Result { .. })),
            "{ending}"
        );
        let dirs = harness.dirs();
        assert_eq!(dirs.len(), 1, "{ending}");
        assert!(!std::path::Path::new(&dirs[0]).exists(), "{ending}");
        assert!(run.exited(), "{ending}");
    }
}

#[tokio::test]
#[serial_test::serial]
async fn removes_the_config_when_the_cli_fails_to_launch() {
    let harness = mcp_harness(FakeChild::new, FakeFiles::local());
    let run = harness.start();
    let Launch { child, .. } = harness.launched().await;

    child.fail("spawn claude ENOENT");
    let events = collect(&run).await;

    assert_eq!(
        events,
        [result(
            CodingAgentStopReason::Error,
            0,
            "Claude Code failed to start: spawn claude ENOENT"
        )]
    );
    assert!(!std::path::Path::new(&harness.dirs()[0]).exists());
}

#[tokio::test]
#[serial_test::serial]
async fn starts_nothing_and_removes_the_config_when_stopped_before_the_cli_starts() {
    let harness = mcp_harness(FakeChild::new, FakeFiles::local());
    let run = harness.start();
    assert!(!run.exited());

    run.stop();
    let events = collect(&run).await;

    assert_eq!(
        events,
        [result(
            CodingAgentStopReason::Error,
            0,
            "Claude Code was stopped before it started"
        )]
    );
    assert!(harness.launches.lock().is_empty());
    // The stop can come before the config is written; either way none is left.
    assert!(
        harness
            .dirs()
            .iter()
            .all(|dir| !std::path::Path::new(dir).exists())
    );
    assert!(run.exited());
}

#[tokio::test]
#[serial_test::serial]
async fn reports_a_config_that_cannot_be_written_as_a_failed_start_and_removes_its_directory() {
    let harness = mcp_harness(
        FakeChild::new,
        FakeFiles {
            write_text: Some(Arc::new(|_, _| anyhow::bail!("No space left on device"))),
            ..FakeFiles::local()
        },
    );
    let events = collect(&harness.start()).await;

    assert_eq!(
        events,
        [result(
            CodingAgentStopReason::Error,
            0,
            "Claude Code failed to start: No space left on device"
        )]
    );
    assert!(harness.launches.lock().is_empty());
    assert!(!std::path::Path::new(&harness.dirs()[0]).exists());
}

// ---------------------------------------------------------- system prompt args

/// `--system-prompt` *replaces* Claude Code's default prompt, stripping the
/// sub-agent of its tool-selection, todo and search conventions — so the
/// invariant every case here checks is that the flag is never emitted, whatever
/// the mode. Plan mode's read-only constraint and any caller framing are
/// appended instead, on one flag.
fn args_of(mode: CodingAgentMode, append: Option<&str>) -> Vec<String> {
    let task = CodingAgentTask {
        mode,
        append_system_prompt: append.map(str::to_string),
        ..base_task()
    };
    build_args(&task, false, false, None, &deployment())
}

#[test]
fn never_replaces_the_default_prompt_in_any_mode() {
    for mode in [CodingAgentMode::Plan, CodingAgentMode::Edit] {
        for append in [Some("custom"), None] {
            assert!(!args_of(mode, append).contains(&"--system-prompt".to_string()));
        }
    }
}

#[test]
fn states_plan_mode_to_the_model_as_well_as_to_the_cli() {
    let args = args_of(CodingAgentMode::Plan, None);
    assert_eq!(
        value_of(&args, "--append-system-prompt"),
        Some(PLAN_ONLY_INSTRUCTION)
    );
    assert_eq!(value_of(&args, "--permission-mode"), Some("plan"));
}

#[test]
fn carries_the_plan_constraint_and_a_caller_prompt_on_one_flag() {
    let args = args_of(CodingAgentMode::Plan, Some("custom"));
    // One occurrence, so neither part can silently drop the other.
    assert_eq!(count(&args, "--append-system-prompt"), 1);
    assert_eq!(
        value_of(&args, "--append-system-prompt"),
        Some(format!("{PLAN_ONLY_INSTRUCTION}\n\ncustom").as_str())
    );
}

#[test]
fn leaves_edit_mode_with_the_caller_prompt_alone_and_no_plan_constraint() {
    let args = args_of(CodingAgentMode::Edit, Some("custom"));
    assert_eq!(value_of(&args, "--append-system-prompt"), Some("custom"));
}

#[test]
fn passes_no_prompt_flag_at_all_for_an_edit_task_with_no_caller_prompt() {
    assert!(!args_of(CodingAgentMode::Edit, None).contains(&"--append-system-prompt".to_string()));
}

// ---------------------------------------------------------- reading the stream

#[tokio::test]
#[serial_test::serial]
async fn reports_the_session_id_assistant_text_and_the_outcome_as_events() {
    let events = events_for(
        &[
            json!({ "type": "system", "subtype": "init", "session_id": "sess-init", "permissionMode": "auto" }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "hello " }] } }),
            json!({
                "type": "assistant",
                "message": { "content": [{ "type": "tool_use", "name": "Read" }, { "type": "text", "text": "world" }] }
            }),
            json!({ "type": "result", "subtype": "success", "result": "final", "num_turns": 7, "session_id": "sess-42" }),
        ],
        base_task(),
    )
    .await;

    assert_eq!(
        events,
        [
            CodingAgentEvent::Session {
                session_id: "sess-init".into()
            },
            CodingAgentEvent::Text {
                text: "hello ".into()
            },
            CodingAgentEvent::Text {
                text: "world".into()
            },
            CodingAgentEvent::Session {
                session_id: "sess-42".into()
            },
            result(CodingAgentStopReason::EndTurn, 7, "final"),
        ]
    );
}

fn parse(line: Value) -> Vec<CodingAgentEvent> {
    parse_line(&line.to_string(), &base_task(), &deployment(), false).unwrap()
}

fn usage_events(events: Vec<CodingAgentEvent>) -> Vec<CodingAgentEvent> {
    events
        .into_iter()
        .filter(|event| matches!(event, CodingAgentEvent::Usage { .. }))
        .collect()
}

#[tokio::test]
#[serial_test::serial]
async fn reports_the_usage_of_every_model_the_run_used_with_the_cost_the_cli_estimated() {
    // The `modelUsage` of a result line captured from Claude Code, which writes its
    // cache with the one-hour lifetime.
    let events = events_for(
        &[json!({
            "type": "result", "subtype": "success", "result": "OK", "num_turns": 1,
            "modelUsage": {
                "claude-haiku-5-5": {
                    "inputTokens": 2, "outputTokens": 4, "cacheReadInputTokens": 0, "cacheCreationInputTokens": 143355,
                    "webSearchRequests": 0, "costUSD": 0.14336600000000002, "contextWindow": 1000000, "maxOutputTokens": 128000,
                    "thinkingTokens": 0, "cacheCreationEphemeral5mInputTokens": 0, "cacheCreationEphemeral1hInputTokens": 143355,
                    "canonicalModel": "claude-haiku-5-5", "provider": "firstParty", "costBasis": "list",
                },
            },
        })],
        base_task(),
    )
    .await;
    assert_eq!(
        usage_events(events),
        [CodingAgentEvent::Usage {
            usage: CodingAgentUsage {
                model: "claude-haiku-5-5".into(),
                input_tokens: 2,
                cache_read_tokens: 0,
                cache_write_tokens: 143_355,
                long_cache_write_tokens: 143_355,
                output_tokens: 4,
                cost_usd: Some(0.14336600000000002),
                subscription: false,
            },
        }]
    );
}

#[test]
fn reports_the_usage_of_a_run_on_the_subscription_as_billed_to_it() {
    let events = parse_line(
        &json!({
            "type": "result", "subtype": "success", "result": "ok", "num_turns": 1,
            "modelUsage": { "claude-opus-5-5": { "inputTokens": 10, "outputTokens": 20, "costUSD": 0.01 } },
        })
        .to_string(),
        &base_task(),
        &deployment(),
        true,
    )
    .unwrap();
    assert_eq!(
        usage_events(events),
        [CodingAgentEvent::Usage {
            usage: CodingAgentUsage {
                model: "claude-opus-5-5".into(),
                input_tokens: 10,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                long_cache_write_tokens: 0,
                output_tokens: 20,
                cost_usd: Some(0.01),
                subscription: true,
            },
        }]
    );
}

#[test]
fn maps_each_subtype_to_its_stop_reason() {
    for (subtype, stop_reason) in [
        ("success", CodingAgentStopReason::EndTurn),
        ("error_max_turns", CodingAgentStopReason::MaxTurns),
        ("error", CodingAgentStopReason::Error),
        ("error_during_execution", CodingAgentStopReason::Error),
    ] {
        assert_eq!(
            parse(
                json!({ "type": "result", "subtype": subtype, "result": "text", "num_turns": 3 })
            ),
            [result(stop_reason, 3, "text")]
        );
    }
}

#[test]
fn reports_a_failed_model_call_as_an_error_though_its_subtype_reads_success() {
    // A result line captured from Claude Code 2.1.296 when Bedrock answered 503.
    assert_eq!(
        parse(json!({
            "type": "result", "subtype": "success", "is_error": true, "terminal_reason": "api_error",
            "num_turns": 1, "permission_denials": [],
            "result": "API Error: 503 Bedrock is unable to process your request."
        })),
        [result(
            CodingAgentStopReason::Error,
            1,
            "API Error: 503 Bedrock is unable to process your request."
        )]
    );
}

fn refused(action: &str, target: &str) -> CodingAgentRefusal {
    CodingAgentRefusal {
        action: action.to_string(),
        target: target.to_string(),
    }
}

fn refusals_of(events: &[CodingAgentEvent]) -> Vec<CodingAgentRefusal> {
    match events {
        [CodingAgentEvent::Result { refusals, .. }] => refusals.clone().unwrap_or_default(),
        other => panic!("not one result: {other:?}"),
    }
}

#[test]
fn carries_each_refused_action_and_its_target_on_the_result() {
    // Shapes captured from Claude Code 2.1.296: the auto-mode classifier
    // refusing a force push, and a deny rule refusing a write.
    assert_eq!(
        parse(json!({
            "type": "result", "subtype": "success", "is_error": false, "num_turns": 5,
            "result": "Steps 1 and 2 are done.",
            "permission_denials": [
                { "tool_name": "Bash", "tool_use_id": "toolu_1", "tool_input": { "command": "git push --force origin main" } },
                { "tool_name": "Write", "tool_use_id": "toolu_2", "tool_input": { "file_path": "/work/forbidden.txt", "content": "nope\n" } }
            ]
        })),
        [CodingAgentEvent::Result {
            stop_reason: CodingAgentStopReason::EndTurn,
            turns: 5,
            message: "Steps 1 and 2 are done.".into(),
            refusals: Some(vec![
                refused("Bash", "git push --force origin main"),
                refused("Write", "/work/forbidden.txt"),
            ]),
        }]
    );
}

#[test]
fn names_a_refused_call_without_a_known_target_field_by_its_input_cut_short() {
    let events = parse(json!({
        "type": "result", "subtype": "success", "num_turns": 1, "result": "ok",
        "permission_denials": [
            { "tool_name": "mcp__deploy__run", "tool_input": { "service": "api" } },
            { "tool_name": "Bash", "tool_input": { "command": "x".repeat(300) } }
        ]
    }));
    assert_eq!(
        refusals_of(&events),
        [
            refused("mcp__deploy__run", r#"{"service":"api"}"#),
            refused("Bash", &format!("{}…", "x".repeat(200))),
        ]
    );
}

#[test]
fn folds_a_multi_line_refused_command_onto_one_line() {
    let events = parse(json!({
        "type": "result", "subtype": "success", "num_turns": 1, "result": "ok",
        "permission_denials": [{ "tool_name": "Bash", "tool_input": { "command": "python3 - <<'PY'\nprint(1)\nPY" } }]
    }));
    assert_eq!(
        refusals_of(&events),
        [refused("Bash", "python3 - <<'PY' print(1) PY")]
    );
}

#[test]
fn warns_when_a_task_starts_in_another_permission_mode() {
    // The opening line of Claude Code 2.1.296 on Bedrock with `--model haiku`.
    let model = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    for (mode, permission_mode, warns) in [
        ("edit", "default", true),
        ("edit", "auto", false),
        ("plan", "plan", false),
        ("plan", "default", true),
    ] {
        let expected = if mode == "plan" { "plan" } else { "auto" };
        let line = json!({
            "type": "system", "subtype": "init", "session_id": "s1", "permissionMode": permission_mode, "model": model
        });
        let fields = unexpected_mode(&line, "t1", expected);
        assert_eq!(fields.is_some(), warns, "{mode} in {permission_mode}");
        if warns {
            assert_eq!(
                fields.unwrap().to_string(),
                json!({ "taskId": "t1", "model": model, "permissionMode": permission_mode, "expectedMode": expected })
                    .to_string()
            );
        }
    }
}

#[test]
fn with_skip_permissions_on_warns_when_an_edit_task_starts_outside_the_bypass() {
    // Settings with `permissions.disableBypassPermissionsMode: "disable"` start
    // the CLI in `default` instead.
    let expected = permission_mode_for(&base_task(), &skipping_permissions()).as_str();
    assert_eq!(expected, "bypassPermissions");
    for (permission_mode, warns) in [("default", true), ("bypassPermissions", false)] {
        let line = json!({ "type": "system", "subtype": "init", "session_id": "s1", "permissionMode": permission_mode });
        assert_eq!(unexpected_mode(&line, "t1", expected).is_some(), warns);
    }
}

#[test]
fn falls_back_to_the_subtype_as_the_message_when_the_result_line_has_no_text() {
    assert_eq!(
        parse(json!({ "type": "result", "subtype": "error_during_execution" })),
        [result(
            CodingAgentStopReason::Error,
            0,
            "error_during_execution"
        )]
    );
}

#[test]
fn ignores_lines_of_other_types() {
    assert_eq!(
        parse(
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "content": "x" }] } })
        ),
        []
    );
    assert_eq!(
        parse(json!({ "type": "result", "subtype": "success", "result": "ok", "num_turns": 1 })),
        [result(CodingAgentStopReason::EndTurn, 1, "ok")]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn names_claude_code_in_the_closing_message_when_the_binary_is_missing() {
    let started = start(base_task(), None);
    let Launch { child, .. } = started.launched().await;
    child.fail("spawn claude ENOENT");
    assert_eq!(
        collect(&started.run).await,
        [result(
            CodingAgentStopReason::Error,
            0,
            "Claude Code failed to start: spawn claude ENOENT"
        )]
    );
}

// ---------------------------------------------------------------- the home

struct Home {
    _tmp: tempfile::TempDir,
    skills_dir: String,
    claude_home: String,
    root: std::path::PathBuf,
}

fn home() -> Home {
    let tmp = tempfile::Builder::new()
        .prefix("prism-claude-home-")
        .tempdir()
        .unwrap();
    let root = tmp.path().to_path_buf();
    let skills_dir = root.join("skills");
    std::fs::create_dir(&skills_dir).unwrap();
    Home {
        skills_dir: skills_dir.to_string_lossy().into_owned(),
        claude_home: root.join(".claude").to_string_lossy().into_owned(),
        root,
        _tmp: tmp,
    }
}

/// A fake environment over the real filesystem, so a link is a real link.
fn environment_for(home: &Home, claude_home: &str) -> FakeEnvironment {
    let mut paths = fake_paths("/workspace");
    paths.skills_dir = home.skills_dir.clone();
    paths.claude_home = claude_home.to_string();
    FakeEnvironment {
        paths,
        files: FakeFiles::local(),
        ..Default::default()
    }
}

#[cfg(unix)]
#[tokio::test]
async fn creates_the_config_dir_and_links_the_skills_dir_into_it() {
    let home = home();
    let environment = environment_for(&home, &home.claude_home);
    let prepared = prepare_shared_skills_home(&environment, &home.claude_home, None)
        .await
        .unwrap();

    assert_eq!(prepared.config_dir, home.claude_home);
    assert!(std::fs::metadata(&prepared.config_dir).unwrap().is_dir());
    assert!(prepared.skills_linked);
    let link = std::path::Path::new(&prepared.config_dir).join("skills");
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        std::fs::canonicalize(&link).unwrap(),
        std::fs::canonicalize(&home.skills_dir).unwrap()
    );
    // Only skills are exposed — Claude Code's plugin layout differs from the
    // Agent Plugins one, so plugins are not linked across.
    assert!(
        !std::path::Path::new(&prepared.config_dir)
            .join("plugins")
            .exists()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn leaves_an_operator_set_home_alone() {
    for directory in ["theirs", "theirs "] {
        let home = home();
        let theirs = home.root.join(directory).to_string_lossy().into_owned();
        std::fs::create_dir(&theirs).unwrap();
        let environment = environment_for(&home, &theirs);

        let prepared = prepare_shared_skills_home(&environment, &theirs, Some(&theirs))
            .await
            .unwrap();

        assert_eq!(
            prepared,
            CodingAgentHome {
                config_dir: theirs.clone(),
                skills_linked: false
            }
        );
        // Their directory is usually their real ~/.claude, so nothing is put in it.
        assert_eq!(std::fs::read_dir(&theirs).unwrap().count(), 0);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn reports_skills_as_linked_when_the_operator_set_home_already_points_at_them() {
    let home = home();
    let theirs = home.root.join("theirs").to_string_lossy().into_owned();
    std::fs::create_dir(&theirs).unwrap();
    std::os::unix::fs::symlink(&home.skills_dir, format!("{theirs}/skills")).unwrap();
    let environment = environment_for(&home, &theirs);

    let prepared = prepare_shared_skills_home(&environment, &theirs, Some(&theirs))
        .await
        .unwrap();
    assert_eq!(
        prepared,
        CodingAgentHome {
            config_dir: theirs,
            skills_linked: true
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn reports_the_skills_as_unlinked_when_a_populated_dir_sits_at_the_link_path() {
    let home = home();
    let claude_skills = format!("{}/skills", home.claude_home);
    std::fs::create_dir_all(&claude_skills).unwrap();
    std::fs::write(format!("{claude_skills}/keep.txt"), "x").unwrap();
    let environment = environment_for(&home, &home.claude_home);

    let prepared = prepare_shared_skills_home(&environment, &home.claude_home, None)
        .await
        .unwrap();
    assert!(!prepared.skills_linked);
    // Somebody's files, so the link is refused rather than written over them.
    assert!(std::path::Path::new(&format!("{claude_skills}/keep.txt")).exists());
}

// ------------------------------------------------------ model tier and effort

fn args_with(
    task: CodingAgentTask,
    on_bedrock: bool,
    subscription: bool,
    settings: &Settings,
) -> Vec<String> {
    build_args(&task, on_bedrock, subscription, None, settings)
}

const TIERS: [(ModelTier, &str); 3] = [
    (ModelTier::Small, "haiku"),
    (ModelTier::Medium, "sonnet"),
    (ModelTier::Large, "opus"),
];

#[test]
fn maps_each_tier_with_and_without_a_session() {
    for session_id in [None, Some("session-1".to_string())] {
        for (tier, model) in TIERS {
            let args = args_with(
                CodingAgentTask {
                    model_tier: Some(tier),
                    session_id: session_id.clone(),
                    ..base_task()
                },
                false,
                false,
                &deployment(),
            );
            assert_eq!(value_of(&args, "--model"), Some(model));
        }
        for effort in [Effort::Low, Effort::Medium, Effort::High] {
            let args = args_with(
                CodingAgentTask {
                    effort: Some(effort),
                    session_id: session_id.clone(),
                    ..base_task()
                },
                false,
                false,
                &deployment(),
            );
            assert_eq!(value_of(&args, "--effort"), Some(effort.as_str()));
            assert!(!args.contains(&"--model".to_string()));
        }
    }
}

#[tokio::test]
#[serial_test::serial]
async fn maps_a_tier_to_the_bedrock_model_when_claude_code_runs_on_bedrock() {
    for (tier, model) in [
        (ModelTier::Small, "global.anthropic.claude-haiku-5-5"),
        (ModelTier::Medium, "global.anthropic.claude-sonnet-5-5"),
        (ModelTier::Large, "opus"),
    ] {
        let started = start(
            CodingAgentTask {
                env: env_of(&[
                    ("AWS_BEARER_TOKEN_BEDROCK", "test-token"),
                    ("HOME", "/nonexistent"),
                ]),
                model_tier: Some(tier),
                ..base_task()
            },
            None,
        );
        let Launch { args, child, .. } = started.launched().await;
        child.finish(Some(0));
        collect(&started.run).await;
        assert_eq!(value_of(&args, "--model"), Some(model));
    }
}

#[tokio::test]
#[serial_test::serial]
async fn maps_a_tier_to_the_subscription_model_bedrock_credentials_or_not() {
    let _on = SubscriptionOn::new();
    for (tier, model) in TIERS {
        let started = start(
            CodingAgentTask {
                env: env_of(&[
                    ("AWS_BEARER_TOKEN_BEDROCK", "test-token"),
                    ("HOME", "/nonexistent"),
                ]),
                model_tier: Some(tier),
                ..base_task()
            },
            Some(SUBSCRIPTION_STATUS),
        );
        let Launch { args, child, .. } = started.launched().await;
        child.finish(Some(0));
        collect(&started.run).await;
        assert_eq!(value_of(&args, "--model"), Some(model));
    }
}

#[test]
fn uses_the_override_for_each_tier() {
    for (tier, _) in TIERS {
        let mut settings = deployment();
        let custom = ClaudeCodeTierModel {
            default: "custom-model".to_string(),
            bedrock: "custom-model".to_string(),
        };
        match tier {
            ModelTier::Small => settings.models.small = custom,
            ModelTier::Medium => settings.models.medium = custom,
            ModelTier::Large => settings.models.large = custom,
        }
        let args = args_with(
            CodingAgentTask {
                model_tier: Some(tier),
                effort: Some(Effort::High),
                session_id: Some("session-1".to_string()),
                ..base_task()
            },
            false,
            false,
            &settings,
        );
        assert_eq!(value_of(&args, "--model"), Some("custom-model"));
    }
}

#[test]
fn preserves_deployment_defaults_when_both_parameters_are_omitted() {
    let args = args_with(base_task(), false, false, &deployment());
    assert!(!args.contains(&"--model".to_string()));
    assert!(!args.contains(&"--effort".to_string()));
    assert!(
        !args
            .iter()
            .any(|arg| arg.starts_with("model_reasoning_effort="))
    );
}
