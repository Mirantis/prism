//! The Codex adapter against a fake `codex`: the argv and env of each auth
//! method, the events it reads from `codex exec --json`, and the subscription.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use parking_lot::Mutex;
use serde_json::json;

use super::*;
use crate::lib::coding_agents::coding_agent::{Effort, ModelTier};
use crate::lib::coding_agents::subscription_switch::set_subscription_in_memory_for_tests;
use crate::lib::coding_agents::testing::{
    FakeChild, FakeEnvironment, FakeFiles, env_of, fake_paths, wait_for,
};
use crate::lib::execution_environments::execution_environment::RunOptions;
use crate::lib::execution_environments::get_execution_environment::set_execution_environment_for_tests;

fn task() -> CodingAgentTask {
    CodingAgentTask {
        task_id: "task-1".to_string(),
        prompt: "Inspect the project".to_string(),
        workdir: Some("/work".to_string()),
        env: env_of(&[("OPENAI_API_KEY", "test-key")]),
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

type Spawns = Arc<Mutex<Vec<(String, Vec<String>, RunOptions)>>>;

/// An environment whose every launch is `child`, recorded.
fn spawning(child: Arc<FakeChild>) -> (FakeEnvironment, Spawns) {
    let spawns: Spawns = Arc::default();
    let sink = spawns.clone();
    let environment = FakeEnvironment::with_run_program(move |command, args, options| {
        sink.lock()
            .push((command.to_string(), args.to_vec(), options));
        child.process()
    });
    (environment, spawns)
}

fn args_of(spawns: &Spawns) -> Vec<String> {
    spawns.lock()[0].1.clone()
}

async fn collect(run: &Arc<dyn CodingAgentRun>) -> Vec<CodingAgentEvent> {
    run.take_events().unwrap().collect().await
}

async fn events_for(lines: &[serde_json::Value]) -> Vec<CodingAgentEvent> {
    let child = FakeChild::new();
    let (environment, _) = spawning(child.clone());
    let run = create_codex_agent(Some(environment.arc())).run(task());
    for line in lines {
        child.emit_line(&line.to_string());
    }
    child.finish(Some(0));
    collect(&run).await
}

fn result(stop_reason: CodingAgentStopReason, turns: i64, message: &str) -> CodingAgentEvent {
    CodingAgentEvent::Result {
        stop_reason,
        turns,
        message: message.to_string(),
        refusals: None,
    }
}

fn has(args: &[String], arg: &str) -> bool {
    args.iter().any(|a| a == arg)
}

fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == flag)?;
    args.get(i + 1).map(String::as_str)
}

#[tokio::test]
#[serial_test::serial]
async fn names_its_process_to_the_next_boot() {
    let child = FakeChild::new();
    *child.mark.lock() = Some(ProcessMark {
        pid: 4242,
        started_at: 1_000,
    });
    let (environment, _) = spawning(child.clone());
    let run = create_codex_agent(Some(environment.arc())).run(task());

    assert_eq!(
        run.mark(),
        Some(ProcessMark {
            pid: 4242,
            started_at: 1_000
        })
    );
    child.finish(Some(0));
    collect(&run).await;
}

#[tokio::test]
#[serial_test::serial]
async fn runs_each_mode_without_the_sandbox_and_with_its_instruction() {
    for (mode, instruction) in [
        (
            CodingAgentMode::Edit,
            "Implement the requested changes and verify the result.",
        ),
        (CodingAgentMode::Plan, PLAN_ONLY_INSTRUCTION),
    ] {
        let child = FakeChild::new();
        let (mut environment, spawns) = spawning(child.clone());
        environment.paths.codex_home = "/auth-home".to_string();
        let run =
            create_codex_agent(Some(environment.arc())).run(CodingAgentTask { mode, ..task() });
        let (command, args, options) = spawns.lock()[0].clone();
        assert_eq!(command, "codex");
        for arg in [
            "exec",
            "--json",
            "approval_policy=\"never\"",
            "sandbox_mode=\"danger-full-access\"",
        ] {
            assert!(has(&args, arg), "{arg}");
        }
        assert_eq!(options.cwd, "/work");
        assert_eq!(
            options.env,
            env_of(&[
                ("OPENAI_API_KEY", "test-key"),
                ("CODEX_API_KEY", "test-key"),
                ("CODEX_HOME", "/auth-home"),
            ])
        );
        assert_eq!(
            options.stdin,
            crate::lib::execution_environments::execution_environment::StdinMode::Pipe
        );
        let policies: Vec<&String> = args
            .iter()
            .filter(|arg| arg.starts_with("approval_policy=") || arg.starts_with("sandbox_mode="))
            .collect();
        assert_eq!(
            policies,
            [
                "approval_policy=\"never\"",
                "sandbox_mode=\"danger-full-access\""
            ]
        );
        assert_eq!(
            args.last().unwrap(),
            &format!("{instruction}\n\nInspect the project")
        );
        child.finish(Some(1));
        collect(&run).await;
    }
}

#[tokio::test]
#[serial_test::serial]
async fn configures_bedrock_authentication() {
    for pairs in [
        vec![
            ("AWS_BEARER_TOKEN_BEDROCK", "test-key"),
            ("AWS_REGION", "us-west-2"),
        ],
        vec![
            ("AWS_ACCESS_KEY_ID", "test-id"),
            ("AWS_SECRET_ACCESS_KEY", "test-secret"),
            ("AWS_REGION", "us-west-2"),
        ],
        vec![
            ("AWS_PROFILE", "test-profile"),
            ("AWS_DEFAULT_REGION", "us-west-2"),
        ],
    ] {
        let child = FakeChild::new();
        let (environment, spawns) = spawning(child.clone());
        let env = env_of(&pairs);
        let run = create_codex_agent(Some(environment.arc())).run(CodingAgentTask {
            env: env.clone(),
            ..task()
        });
        let (_, args, options) = spawns.lock()[0].clone();
        for arg in [
            "model_provider=\"amazon-bedrock\"",
            "model=\"openai.gpt-5.6-terra\"",
            "model_providers.amazon-bedrock.aws.region=\"us-west-2\"",
        ] {
            assert!(has(&args, arg), "{arg}");
        }
        for (key, value) in &env {
            assert_eq!(&options.env[key], value);
        }
        child.finish(Some(0));
        collect(&run).await;
    }
}

#[tokio::test]
#[serial_test::serial]
async fn passes_the_default_region_with_iam_credentials() {
    let child = FakeChild::new();
    let (environment, spawns) = spawning(child.clone());
    let run = create_codex_agent(Some(environment.arc())).run(CodingAgentTask {
        env: env_of(&[("AWS_PROFILE", "test-profile"), ("HOME", "/nonexistent")]),
        ..task()
    });
    assert!(has(
        &args_of(&spawns),
        "model_providers.amazon-bedrock.aws.region=\"us-east-1\""
    ));
    child.finish(Some(0));
    collect(&run).await;
}

#[tokio::test]
#[serial_test::serial]
async fn prefers_a_direct_openai_key_when_aws_credentials_are_also_present() {
    let child = FakeChild::new();
    let (environment, spawns) = spawning(child.clone());
    let run = create_codex_agent(Some(environment.arc())).run(CodingAgentTask {
        env: env_of(&[
            ("OPENAI_API_KEY", "test-key"),
            ("AWS_BEARER_TOKEN_BEDROCK", "test-bedrock-key"),
        ]),
        ..task()
    });
    let args = args_of(&spawns);
    assert!(has(&args, "model_provider=\"openai\""));
    assert!(has(&args, "forced_login_method=\"api\""));
    child.finish(Some(0));
    collect(&run).await;
}

#[tokio::test]
#[serial_test::serial]
async fn uses_the_saved_login_unless_an_api_key_is_set() {
    for api_key in [None, Some("test-openai-key")] {
        let auth_home = tempfile::tempdir().unwrap();
        std::fs::write(
            auth_home.path().join("auth.json"),
            r#"{"auth_mode":"chatgpt","tokens":{"access_token":"test-access","refresh_token":"test-refresh"}}"#,
        )
        .unwrap();
        let home = auth_home.path().to_string_lossy().into_owned();
        let child = FakeChild::new();
        let (mut environment, spawns) = spawning(child.clone());
        environment.paths.codex_home = home.clone();
        environment.files = FakeFiles::local();
        let agent = create_codex_agent(Some(environment.arc()));
        // The saved login is read when availability is probed, which is what a
        // task's argv then reflects.
        agent
            .is_available(&env_of(&[("AWS_PROFILE", "test-profile")]))
            .await
            .unwrap();
        let mut env = env_of(&[("AWS_PROFILE", "test-profile")]);
        if let Some(key) = api_key {
            env.insert("OPENAI_API_KEY".into(), key.into());
        }
        let run = agent.run(CodingAgentTask { env, ..task() });
        let (_, args, options) = spawns.lock()[0].clone();
        assert!(has(&args, "model_provider=\"openai\""));
        assert_eq!(has(&args, "forced_login_method=\"api\""), api_key.is_some());
        assert_eq!(
            has(&args, "cli_auth_credentials_store=\"file\""),
            api_key.is_none()
        );
        assert_eq!(options.env["CODEX_HOME"], home);
        child.emit_line(r#"{"type":"turn.completed"}"#);
        child.finish(Some(0));
        collect(&run).await;
    }
}

#[tokio::test]
#[serial_test::serial]
async fn preserves_an_explicit_codex_api_key() {
    let child = FakeChild::new();
    let (environment, spawns) = spawning(child.clone());
    let run = create_codex_agent(Some(environment.arc())).run(CodingAgentTask {
        env: env_of(&[
            ("OPENAI_API_KEY", "test-key"),
            ("CODEX_API_KEY", "test-codex-key"),
        ]),
        ..task()
    });
    let (_, args, options) = spawns.lock()[0].clone();
    assert!(has(&args, "forced_login_method=\"api\""));
    assert_eq!(options.env["CODEX_API_KEY"], "test-codex-key");
    child.finish(Some(1));
    collect(&run).await;
}

#[tokio::test]
#[serial_test::serial]
async fn reports_a_saved_login_failure_and_its_exit() {
    let auth_home = tempfile::tempdir().unwrap();
    std::fs::write(auth_home.path().join("auth.json"), "{}").unwrap();
    let child = FakeChild::new();
    let (mut environment, _) = spawning(child.clone());
    environment.paths.codex_home = auth_home.path().to_string_lossy().into_owned();
    environment.files = FakeFiles::local();
    let agent = create_codex_agent(Some(environment.arc()));
    agent.is_available(&ProcessEnv::new()).await.unwrap();
    let run = agent.run(CodingAgentTask {
        env: ProcessEnv::new(),
        ..task()
    });
    child.emit_line(r#"{"type":"turn.failed","error":{"message":"Login required"}}"#);
    child.finish(Some(1));
    assert_eq!(
        collect(&run).await.last(),
        Some(&result(CodingAgentStopReason::Error, 1, "Login required"))
    );
    assert!(run.exited());
}

#[tokio::test]
#[serial_test::serial]
async fn resumes_with_the_requested_permissions_and_preserves_prompt_text() {
    let child = FakeChild::new();
    let (environment, spawns) = spawning(child.clone());
    let run = create_codex_agent(Some(environment.arc())).run(CodingAgentTask {
        session_id: Some("session-1".to_string()),
        prompt: "--inspect".to_string(),
        append_system_prompt: Some("Use \"examples\".\nKeep it short.".to_string()),
        ..task()
    });
    let args = args_of(&spawns);
    let tail: Vec<&str> = args[args.len() - 6..].iter().map(String::as_str).collect();
    assert_eq!(
        tail,
        [
            "-c",
            "developer_instructions=\"Use \\\"examples\\\".\\nKeep it short.\"",
            "resume",
            "session-1",
            "--",
            "Implement the requested changes and verify the result.\n\n--inspect",
        ]
    );
    child.finish(Some(1));
    collect(&run).await;
}

#[tokio::test]
#[serial_test::serial]
async fn reads_the_documented_json_event_stream() {
    assert_eq!(
        events_for(&[
            json!({ "type": "thread.started", "thread_id": "session-1" }),
            json!({ "type": "turn.started" }),
            json!({ "type": "item.started", "item": { "type": "command_execution", "command": "ls" } }),
            json!({ "type": "item.completed", "item": { "type": "agent_message", "text": "Project inspected." } }),
            json!({ "type": "turn.completed", "usage": { "input_tokens": 12, "output_tokens": 4 } }),
        ])
        .await,
        [
            CodingAgentEvent::Session {
                session_id: "session-1".into()
            },
            CodingAgentEvent::Text {
                text: "Project inspected.".into()
            },
            CodingAgentEvent::Usage {
                usage: CodingAgentUsage {
                    model: "codex".into(),
                    input_tokens: 12,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                    long_cache_write_tokens: 0,
                    output_tokens: 4,
                    cost_usd: None,
                    subscription: false,
                },
            },
            result(CodingAgentStopReason::EndTurn, 1, "Project inspected."),
        ]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn reports_the_tokens_of_a_turn_against_the_model_the_task_asked_for_cached_input_apart() {
    let child = FakeChild::new();
    let (environment, _) = spawning(child.clone());
    let run = create_codex_agent(Some(environment.arc())).run(CodingAgentTask {
        model_tier: Some(ModelTier::Small),
        ..task()
    });
    // A `turn.completed` line captured from Codex.
    child.emit_line(
        &json!({
            "type": "turn.completed",
            "usage": { "input_tokens": 19830, "cached_input_tokens": 8448, "cache_write_input_tokens": 0, "output_tokens": 40, "reasoning_output_tokens": 33 },
        })
        .to_string(),
    );
    child.finish(Some(0));
    let usage: Vec<CodingAgentEvent> = collect(&run)
        .await
        .into_iter()
        .filter(|event| matches!(event, CodingAgentEvent::Usage { .. }))
        .collect();
    let small = CONFIG
        .coding_agent_models
        .codex
        .get("small")
        .unwrap()
        .openai
        .clone();
    assert_eq!(
        usage,
        [CodingAgentEvent::Usage {
            usage: CodingAgentUsage {
                model: small,
                input_tokens: 11382,
                cache_read_tokens: 8448,
                cache_write_tokens: 0,
                long_cache_write_tokens: 0,
                output_tokens: 40,
                cost_usd: None,
                subscription: false,
            },
        }]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn reports_terminal_failures() {
    assert_eq!(
        events_for(&[json!({ "type": "turn.failed", "error": { "message": "Quota exceeded" } })])
            .await,
        [result(CodingAgentStopReason::Error, 1, "Quota exceeded")]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn allows_a_successful_retry_after_an_error_event() {
    let events = events_for(&[
        json!({ "type": "error", "message": "Reconnecting" }),
        json!({ "type": "item.completed", "item": { "type": "agent_message", "text": "Done" } }),
        json!({ "type": "turn.completed" }),
    ])
    .await;
    let results: Vec<_> = events
        .into_iter()
        .filter(|event| matches!(event, CodingAgentEvent::Result { .. }))
        .collect();
    assert_eq!(results, [result(CodingAgentStopReason::EndTurn, 1, "Done")]);
}

#[test]
fn names_the_last_error_when_a_failed_turn_gives_none() {
    let mut parse = create_parser("codex".into(), false);
    assert_eq!(
        parse(r#"{"type":"error","message":"Reconnecting"}"#).unwrap(),
        []
    );
    assert_eq!(
        parse(r#"{"type":"turn.failed"}"#).unwrap(),
        [result(CodingAgentStopReason::Error, 1, "Reconnecting")]
    );
    assert_eq!(
        create_parser("codex".into(), false)(r#"{"type":"turn.failed","error":{"message":""}}"#)
            .unwrap(),
        [result(CodingAgentStopReason::Error, 1, "Codex task failed")]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_concurrent_task_results_separate() {
    let children = [FakeChild::new(), FakeChild::new()];
    let index = Arc::new(AtomicUsize::new(0));
    let handed = children.clone();
    let agent = create_codex_agent(Some(
        FakeEnvironment::with_run_program(move |_, _, _| {
            handed[index.fetch_add(1, Ordering::SeqCst)].process()
        })
        .arc(),
    ));
    let runs = [agent.run(task()), agent.run(task())];
    children[0]
        .emit_line(r#"{"type":"item.completed","item":{"type":"agent_message","text":"First"}}"#);
    children[1]
        .emit_line(r#"{"type":"item.completed","item":{"type":"agent_message","text":"Second"}}"#);
    for child in &children {
        child.emit_line(r#"{"type":"turn.completed"}"#);
        child.finish(Some(0));
    }
    let first = collect(&runs[0]).await;
    let second = collect(&runs[1]).await;
    assert_eq!(
        first.last(),
        Some(&result(CodingAgentStopReason::EndTurn, 1, "First"))
    );
    assert_eq!(
        second.last(),
        Some(&result(CodingAgentStopReason::EndTurn, 1, "Second"))
    );
}

#[cfg(unix)]
#[tokio::test]
async fn prepares_an_isolated_home_with_shared_skills() {
    let root = tempfile::tempdir().unwrap();
    let skills_dir = root.path().join("skills");
    let codex_home = root.path().join(".codex");
    std::fs::create_dir(&skills_dir).unwrap();
    let mut paths = fake_paths("/workspace");
    paths.skills_dir = skills_dir.to_string_lossy().into_owned();
    paths.codex_home = codex_home.to_string_lossy().into_owned();
    let environment = FakeEnvironment {
        paths,
        files: FakeFiles::local(),
        ..Default::default()
    };
    // The real local filesystem behind a fake environment, so the link is a
    // link rather than a recorded call.
    let home = crate::lib::coding_agents::shared_skills_home::prepare_shared_skills_home(
        &environment,
        &codex_home.to_string_lossy(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        home,
        CodingAgentHome {
            config_dir: codex_home.to_string_lossy().into_owned(),
            skills_linked: true
        }
    );
    assert_eq!(
        std::fs::canonicalize(codex_home.join("skills")).unwrap(),
        std::fs::canonicalize(&skills_dir).unwrap()
    );
}

// ------------------------------------------------- the ChatGPT subscription

/// `codex login status` for a ChatGPT login, as Codex 0.163 prints it on stderr.
const CHATGPT: &str = "Logged in using ChatGPT";
const NO_LOGIN: &str = "Codex failed to start: Codex is set to use your ChatGPT subscription, and nobody is signed in to it: sign in again from Coding agents";

fn subscription_env() -> ProcessEnv {
    env_of(&[
        ("PATH", "/bin"),
        ("OPENAI_API_KEY", "test-key"),
        ("CODEX_API_KEY", "test-codex-key"),
        ("CODEX_ACCESS_TOKEN", "test-token"),
        ("AWS_BEARER_TOKEN_BEDROCK", "test-bedrock-key"),
    ])
}

#[derive(Clone)]
struct Launch {
    args: Vec<String>,
    options: RunOptions,
    child: Arc<FakeChild>,
}

struct Harness {
    agent: Arc<dyn CodingAgent>,
    launches: Arc<Mutex<Vec<Launch>>>,
    asked: Arc<AtomicUsize>,
}

/// An environment whose `codex login status` prints `status` (`None` never
/// ends), recording every other launch.
fn subscription_harness(status: Option<&'static str>, finish_status: bool) -> Harness {
    let launches: Arc<Mutex<Vec<Launch>>> = Arc::default();
    let asked = Arc::new(AtomicUsize::new(0));
    let (sink, count) = (launches.clone(), asked.clone());
    let mut paths = fake_paths("/workspace");
    paths.codex_home = "/home/.codex".to_string();
    let environment = FakeEnvironment {
        paths,
        ..FakeEnvironment::with_run_program(move |_, args, options| {
            let child = FakeChild::new();
            if args.first().map(String::as_str) != Some("login") {
                sink.lock().push(Launch {
                    args: args.to_vec(),
                    options,
                    child: child.clone(),
                });
                return child.process();
            }
            count.fetch_add(1, Ordering::SeqCst);
            if let Some(status) = status {
                child.write_stderr(&format!("{status}\n"));
                if finish_status {
                    child.finish(Some(0));
                }
            }
            child.process()
        })
    };
    Harness {
        agent: create_codex_agent(Some(environment.arc())),
        launches,
        asked,
    }
}

struct CodexSubscriptionOn;

impl CodexSubscriptionOn {
    fn new() -> CodexSubscriptionOn {
        set_subscription_in_memory_for_tests(CodingAgentName::Codex, true);
        CodexSubscriptionOn
    }
}

impl Drop for CodexSubscriptionOn {
    fn drop(&mut self) {
        set_subscription_in_memory_for_tests(CodingAgentName::Codex, false);
    }
}

#[tokio::test]
#[serial_test::serial]
async fn asks_nothing_and_keeps_the_api_key_while_the_subscription_is_off() {
    let harness = subscription_harness(Some(CHATGPT), true);
    let run = harness.agent.run(CodingAgentTask {
        env: subscription_env(),
        ..task()
    });
    assert_eq!(harness.asked.load(Ordering::SeqCst), 0);
    let launch = harness.launches.lock()[0].clone();
    assert_eq!(launch.options.env["OPENAI_API_KEY"], "test-key");
    assert_eq!(launch.options.env["CODEX_API_KEY"], "test-codex-key");
    assert!(has(&launch.args, "forced_login_method=\"api\""));
    launch.child.finish(Some(0));
    collect(&run).await;
}

#[tokio::test]
#[serial_test::serial]
async fn runs_a_task_on_the_chatgpt_login_with_no_api_key_and_no_bedrock() {
    let _on = CodexSubscriptionOn::new();
    let harness = subscription_harness(Some(CHATGPT), true);
    let run = harness.agent.run(CodingAgentTask {
        env: subscription_env(),
        model_tier: Some(ModelTier::Medium),
        ..task()
    });
    let launches = harness.launches.clone();
    wait_for(move || launches.lock().len() == 1).await;
    let Launch {
        args,
        options,
        child,
    } = harness.launches.lock()[0].clone();
    assert_eq!(
        options.env,
        env_of(&[
            ("PATH", "/bin"),
            ("AWS_BEARER_TOKEN_BEDROCK", "test-bedrock-key"),
            ("CODEX_HOME", "/home/.codex"),
        ])
    );
    for arg in [
        "model_provider=\"openai\"",
        "openai_base_url=\"\"",
        "chatgpt_base_url=\"https://chatgpt.com/backend-api/\"",
        "forced_login_method=\"chatgpt\"",
        "cli_auth_credentials_store=\"file\"",
    ] {
        assert!(has(&args, arg), "{arg}");
    }
    assert!(!has(&args, "model_provider=\"amazon-bedrock\""));
    assert_eq!(value_after(&args, "--model"), Some("gpt-5.6-terra"));
    child.emit_line(r#"{"type":"turn.completed"}"#);
    child.finish(Some(0));
    collect(&run).await;
}

#[tokio::test]
#[serial_test::serial]
async fn fails_the_task_and_starts_nothing_without_a_chatgpt_login() {
    let _on = CodexSubscriptionOn::new();
    for (status, message) in [
        ("Not logged in", NO_LOGIN),
        ("Logged in using an API key - sk-test-***-real", NO_LOGIN),
        (
            "",
            "Codex failed to start: codex login status exited with 0 and no status",
        ),
    ] {
        let harness = subscription_harness(Some(status), true);
        let run = harness.agent.run(CodingAgentTask {
            env: subscription_env(),
            ..task()
        });
        assert_eq!(
            collect(&run).await,
            [result(CodingAgentStopReason::Error, 0, message)]
        );
        assert!(harness.launches.lock().is_empty());
    }
}

/// An environment with its Codex home at `codex_home`, whose `codex login
/// status` prints `status` and whose task finishes, recording each home.
fn host_environment(
    codex_home: &str,
    status: &'static str,
    homes: Arc<Mutex<Vec<String>>>,
) -> FakeEnvironment {
    let mut paths = fake_paths("/workspace");
    paths.codex_home = codex_home.to_string();
    FakeEnvironment {
        paths,
        ..FakeEnvironment::with_run_program(move |_, args, options| {
            homes
                .lock()
                .push(options.env.get("CODEX_HOME").cloned().unwrap_or_default());
            let child = FakeChild::new();
            if args.first().map(String::as_str) == Some("login") {
                child.write_stderr(&format!("{status}\n"));
            } else {
                child.emit_line(r#"{"type":"turn.completed"}"#);
            }
            child.finish(Some(0));
            child.process()
        })
    }
}

#[tokio::test]
#[serial_test::serial]
async fn reads_the_login_and_runs_a_task_on_the_host_from_the_hosts_home() {
    let _on = CodexSubscriptionOn::new();
    let homes: Arc<Mutex<Vec<String>>> = Arc::default();
    let host = host_environment("/host/.codex", CHATGPT, homes.clone());
    let run = create_codex_agent(Some(host.arc())).run(CodingAgentTask {
        workdir: Some("/repo".to_string()),
        env: subscription_env(),
        ..task()
    });
    let events = collect(&run).await;
    assert_eq!(
        events.last(),
        Some(&result(CodingAgentStopReason::EndTurn, 1, ""))
    );
    assert_eq!(*homes.lock(), ["/host/.codex", "/host/.codex"]);
}

#[tokio::test]
#[serial_test::serial]
async fn names_the_command_that_signs_in_the_hosts_home_when_a_task_on_the_host_finds_nobody_signed_in()
 {
    let _on = CodexSubscriptionOn::new();
    let host = host_environment("/host/.codex", "Not logged in", Arc::default());
    set_execution_environment_for_tests(Some(
        FakeEnvironment {
            serves_path: Arc::new(|_| false),
            ..Default::default()
        }
        .arc(),
    ));
    let run = create_codex_agent(Some(host.arc())).run(CodingAgentTask {
        workdir: Some("/repo".to_string()),
        env: subscription_env(),
        ..task()
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
        "on this computer, where this conversation's folder is. Coding agents signs in elsewhere: sign in by running `CODEX_HOME='/host/.codex' codex login -c 'cli_auth_credentials_store=\"file\"'`"
    ));
}

#[tokio::test]
#[serial_test::serial]
async fn asks_again_for_every_task_so_a_sign_in_applies_to_the_next_one() {
    let _on = CodexSubscriptionOn::new();
    let status = Arc::new(Mutex::new("Not logged in"));
    let launches: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let (now, sink) = (status.clone(), launches.clone());
    let mut paths = fake_paths("/workspace");
    paths.codex_home = "/home/.codex".to_string();
    let agent = create_codex_agent(Some(
        FakeEnvironment {
            paths,
            ..FakeEnvironment::with_run_program(move |_, args, _| {
                let child = FakeChild::new();
                if args.first().map(String::as_str) == Some("login") {
                    child.write_stderr(&format!("{}\n", *now.lock()));
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
        env: subscription_env(),
        ..task()
    }))
    .await;
    *status.lock() = CHATGPT;
    collect(&agent.run(CodingAgentTask {
        env: subscription_env(),
        ..task()
    }))
    .await;

    assert_eq!(first, [result(CodingAgentStopReason::Error, 0, NO_LOGIN)]);
    assert_eq!(launches.lock().len(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn starts_nothing_when_the_task_is_stopped_while_the_login_is_read() {
    let _on = CodexSubscriptionOn::new();
    for printed in [None, Some(CHATGPT)] {
        let harness = subscription_harness(printed, false);
        let run = harness.agent.run(CodingAgentTask {
            env: subscription_env(),
            ..task()
        });
        let asked = harness.asked.clone();
        wait_for(move || asked.load(Ordering::SeqCst) == 1).await;

        run.stop();

        assert_eq!(
            collect(&run).await,
            [result(
                CodingAgentStopReason::Error,
                0,
                "Codex was stopped before it started"
            )]
        );
        assert!(harness.launches.lock().is_empty());
    }
}

// ------------------------------------------------------ model tier and effort

fn models() -> TierSet<CodexTierModel> {
    CONFIG.coding_agent_models.codex.clone()
}

const TIERS: [(ModelTier, &str, &str); 3] = [
    (ModelTier::Small, "gpt-5.6-luna", "openai.gpt-5.6-luna"),
    (ModelTier::Medium, "gpt-5.6-terra", "openai.gpt-5.6-terra"),
    (ModelTier::Large, "gpt-5.6-sol", "openai.gpt-5.6-sol"),
];

#[test]
fn maps_each_tier_and_effort_with_and_without_a_session() {
    for session_id in [None, Some("session-1".to_string())] {
        for (tier, model, _) in TIERS {
            let args = build_args(
                &CodingAgentTask {
                    model_tier: Some(tier),
                    session_id: session_id.clone(),
                    ..task()
                },
                Some(CodexAuthMethod::Api),
                &models(),
            );
            assert_eq!(value_after(&args, "--model"), Some(model));
        }
        for effort in [Effort::Low, Effort::Medium, Effort::High] {
            let args = build_args(
                &CodingAgentTask {
                    effort: Some(effort),
                    session_id: session_id.clone(),
                    ..task()
                },
                Some(CodexAuthMethod::Api),
                &models(),
            );
            assert!(has(
                &args,
                &format!("model_reasoning_effort=\"{}\"", effort.as_str())
            ));
            assert!(!has(&args, "--model"));
        }
    }
}

#[test]
fn uses_the_override_for_each_tier() {
    for (tier, _, _) in TIERS {
        let mut models = models();
        let custom = CodexTierModel {
            openai: "custom-model".to_string(),
            bedrock: "custom-model".to_string(),
        };
        match tier {
            ModelTier::Small => models.small = custom,
            ModelTier::Medium => models.medium = custom,
            ModelTier::Large => models.large = custom,
        }
        let args = build_args(
            &CodingAgentTask {
                model_tier: Some(tier),
                effort: Some(Effort::High),
                session_id: Some("session-1".to_string()),
                ..task()
            },
            Some(CodexAuthMethod::Api),
            &models,
        );
        assert_eq!(value_after(&args, "--model"), Some("custom-model"));
    }
}

#[test]
fn preserves_deployment_defaults_when_both_parameters_are_omitted() {
    let args = build_args(&task(), Some(CodexAuthMethod::Api), &models());
    assert!(!has(&args, "--model"));
    assert!(!has(&args, "--effort"));
    assert!(
        !args
            .iter()
            .any(|arg| arg.starts_with("model_reasoning_effort="))
    );
}

#[test]
fn uses_the_bedrock_model_for_each_tier() {
    for (tier, _, model) in TIERS {
        let args = build_args(
            &CodingAgentTask {
                env: env_of(&[("AWS_PROFILE", "test-profile"), ("HOME", "/nonexistent")]),
                model_tier: Some(tier),
                effort: Some(Effort::Low),
                session_id: Some("session-1".to_string()),
                ..task()
            },
            Some(CodexAuthMethod::Bedrock),
            &models(),
        );
        assert_eq!(value_after(&args, "--model"), Some(model));
        assert!(!args.iter().any(|arg| arg.starts_with("model=")));
        assert!(has(&args, "model_reasoning_effort=\"low\""));
    }
}
