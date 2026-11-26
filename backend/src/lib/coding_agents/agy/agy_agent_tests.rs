//! The Antigravity CLI adapter against a fake `agy`: argv for each mode and
//! option, availability detection, and the events read from
//! `agy -p ... --output-format stream-json`.

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::json;

use super::*;
use crate::lib::coding_agents::coding_agent::{Effort, ModelTier};
use crate::lib::coding_agents::testing::{
    FakeChild, FakeEnvironment, FakeFiles, env_of, fake_paths,
};
use crate::lib::execution_environments::execution_environment::{RunOptions, StdinMode};

fn task() -> CodingAgentTask {
    CodingAgentTask {
        task_id: "task-1".to_string(),
        prompt: "Inspect the project".to_string(),
        workdir: Some("/work".to_string()),
        env: env_of(&[("HOME", "/home/test")]),
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

async fn collect(run: &Arc<dyn CodingAgentRun>) -> Vec<CodingAgentEvent> {
    run.take_events().unwrap().collect().await
}

fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == flag)?;
    args.get(i + 1).map(String::as_str)
}

#[tokio::test]
async fn builds_edit_and_plan_arguments() {
    let child = FakeChild::new();
    let (environment, spawns) = spawning(child.clone());
    let run = create_agy_agent(Some(environment.arc())).run(task());
    let (command, args, options) = spawns.lock()[0].clone();
    assert_eq!(command, "agy");
    assert_eq!(options.cwd, "/work");
    assert_eq!(options.stdin, StdinMode::Pipe);
    assert_eq!(value_after(&args, "-p"), Some("Inspect the project"));
    assert_eq!(value_after(&args, "--output-format"), Some("stream-json"));
    assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"));
    assert_eq!(value_after(&args, "--mode"), None);
    assert_eq!(value_after(&args, "--model"), None);
    assert_eq!(value_after(&args, "--effort"), None);
    assert_eq!(value_after(&args, "--resume"), None);
    child.finish(Some(0));
    collect(&run).await;

    let child = FakeChild::new();
    let (environment, spawns) = spawning(child.clone());
    let run = create_agy_agent(Some(environment.arc())).run(CodingAgentTask {
        mode: CodingAgentMode::Plan,
        model_tier: Some(ModelTier::Small),
        effort: Some(Effort::Low),
        append_system_prompt: Some("Keep it brief.".to_string()),
        session_id: Some("conv-42".to_string()),
        ..task()
    });
    let (_, args, _) = spawns.lock()[0].clone();
    assert_eq!(
        value_after(&args, "-p"),
        Some(format!("{PLAN_ONLY_INSTRUCTION}\n\nKeep it brief.\n\nInspect the project").as_str())
    );
    assert_eq!(value_after(&args, "--mode"), Some("plan"));
    assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
    assert_eq!(value_after(&args, "--model"), Some("gemini-3.8-flash"));
    assert_eq!(value_after(&args, "--effort"), Some("low"));
    assert_eq!(value_after(&args, "--resume"), Some("conv-42"));
    child.finish(Some(0));
    collect(&run).await;
}

#[tokio::test]
async fn parses_stream_json_session_deltas_usage_and_result() {
    let child = FakeChild::new();
    let (environment, _) = spawning(child.clone());
    let run = create_agy_agent(Some(environment.arc())).run(task());

    // Observed lines from `agy -p ... --output-format stream-json`.
    child.emit_line(
        &json!({
            "event": "init",
            "conversation_id": "ab51a318-604e-40ff-8576-f2356379a5e0",
            "init": { "model": "gemini-3.8-flash-low", "permission_mode": "always-proceed" }
        })
        .to_string(),
    );
    child.emit_line(
        &json!({
            "event": "step_update",
            "step_update": { "step_index": 0, "state": "DONE", "step_type": "user_input" }
        })
        .to_string(),
    );
    child.emit_line(
        &json!({
            "event": "step_update",
            "step_update": {
                "step_index": 1,
                "state": "ACTIVE",
                "step_type": "agent_response",
                "text_delta": "hel"
            }
        })
        .to_string(),
    );
    child.emit_line(
        &json!({
            "event": "step_update",
            "step_update": {
                "step_index": 1,
                "state": "DONE",
                "step_type": "agent_response",
                "text_delta": "lo\n"
            }
        })
        .to_string(),
    );
    child.emit_line(
        &json!({
            "event": "result",
            "result": {
                "conversation_id": "ab51a318-604e-40ff-8576-f2356379a5e0",
                "status": "SUCCESS",
                "response": "hello\n",
                "num_turns": 1,
                "usage": {
                    "input_tokens": 18266,
                    "output_tokens": 36,
                    "thinking_tokens": 0,
                    "cache_read_tokens": 14042,
                    "total_tokens": 18302
                }
            }
        })
        .to_string(),
    );
    child.finish(Some(0));

    assert_eq!(
        collect(&run).await,
        vec![
            CodingAgentEvent::Session {
                session_id: "ab51a318-604e-40ff-8576-f2356379a5e0".to_string(),
            },
            CodingAgentEvent::Text {
                text: "hel".to_string(),
            },
            CodingAgentEvent::Text {
                text: "lo\n".to_string(),
            },
            CodingAgentEvent::Usage {
                usage: CodingAgentUsage {
                    model: "gemini-3.8-flash-low".to_string(),
                    input_tokens: 18266,
                    cache_read_tokens: 14042,
                    cache_write_tokens: 0,
                    long_cache_write_tokens: 0,
                    output_tokens: 36,
                    cost_usd: None,
                    subscription: false,
                },
            },
            CodingAgentEvent::Result {
                stop_reason: CodingAgentStopReason::EndTurn,
                turns: 1,
                message: "hello\n".to_string(),
                refusals: None,
            },
        ]
    );
}

#[tokio::test]
async fn reports_denied_actions_and_error_results() {
    let child = FakeChild::new();
    let (environment, _) = spawning(child.clone());
    let run = create_agy_agent(Some(environment.arc())).run(task());
    child.emit_line(
        &json!({
            "event": "result",
            "result": {
                "conversation_id": "e4ce33f2-d417-4053-bf19-8856a99c94c2",
                "status": "SUCCESS",
                "response": "",
                "num_turns": 1,
                "denied_actions": [{ "action": "command", "display_name": "Bash" }]
            }
        })
        .to_string(),
    );
    child.finish(Some(0));

    assert_eq!(
        collect(&run).await,
        vec![CodingAgentEvent::Result {
            stop_reason: CodingAgentStopReason::EndTurn,
            turns: 1,
            message: String::new(),
            refusals: Some(vec![CodingAgentRefusal {
                action: "command".to_string(),
                target: "Bash".to_string(),
            }]),
        }]
    );

    let child = FakeChild::new();
    let (environment, _) = spawning(child.clone());
    let run = create_agy_agent(Some(environment.arc())).run(task());
    child.emit_line(
        &json!({
            "event": "result",
            "result": {
                "conversation_id": "",
                "status": "ERROR",
                "response": "",
                "error": "invalid model selection",
                "num_turns": 0,
                "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0 }
            }
        })
        .to_string(),
    );
    child.finish(Some(1));

    assert_eq!(
        collect(&run).await,
        vec![CodingAgentEvent::Result {
            stop_reason: CodingAgentStopReason::Error,
            turns: 0,
            message: "invalid model selection".to_string(),
            refusals: None,
        }]
    );
}

#[tokio::test]
async fn checks_credentials_and_binary_for_availability() {
    let home = tempfile::tempdir().unwrap();
    let config_dir = home.path().join(".gemini/config");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(config_dir.join("config.json"), "{}").unwrap();
    let home_str = home.path().to_string_lossy().into_owned();

    let version_ok = || FakeEnvironment {
        files: FakeFiles::local(),
        ..FakeEnvironment::with_run_program(|_, _, _| {
            let child = FakeChild::new();
            child.emit_line("1.5.18");
            child.finish(Some(0));
            child.process()
        })
    };
    let version_missing = || FakeEnvironment {
        files: FakeFiles::local(),
        ..FakeEnvironment::with_run_program(|_, _, _| {
            let child = FakeChild::new();
            child.fail("spawn agy ENOENT");
            child.process()
        })
    };

    let agent = create_agy_agent(Some(version_ok().arc()));
    assert!(
        agent
            .is_available(&env_of(&[("HOME", &home_str)]))
            .await
            .unwrap()
    );
    assert!(
        agent
            .is_available(&env_of(&[("GEMINI_API_KEY", "test-key")]))
            .await
            .unwrap()
    );
    assert!(
        agent
            .is_available(&env_of(&[("GOOGLE_API_KEY", "test-key")]))
            .await
            .unwrap()
    );
    assert!(
        agent
            .is_available(&env_of(&[("AGY_ADC_AUTH", "true")]))
            .await
            .unwrap()
    );
    assert!(
        !agent
            .is_available(&env_of(&[("HOME", "/nonexistent")]))
            .await
            .unwrap()
    );

    let missing_bin = create_agy_agent(Some(version_missing().arc()));
    assert!(
        !missing_bin
            .is_available(&env_of(&[("HOME", &home_str)]))
            .await
            .unwrap()
    );
    assert!(
        !missing_bin
            .is_available(&env_of(&[("GEMINI_API_KEY", "test-key")]))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn prepares_home_without_creating_files_in_users_home() {
    let dir = tempfile::tempdir().unwrap();
    let skills = dir.path().join("skills");
    std::fs::create_dir_all(&skills).unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let home_str = home.to_string_lossy().into_owned();

    let mut paths = fake_paths("/workspace");
    paths.skills_dir = skills.to_string_lossy().into_owned();
    let environment = FakeEnvironment {
        paths,
        base_env: env_of(&[("HOME", &home_str)]),
        files: FakeFiles::local(),
        ..Default::default()
    };

    let prepared = create_agy_agent(Some(environment.arc()))
        .prepare_home()
        .await
        .unwrap();
    assert_eq!(
        prepared.config_dir,
        format!("{home_str}/.gemini/antigravity-cli")
    );
    assert!(!prepared.skills_linked);
    assert!(!home.join(".gemini").exists());
}

#[tokio::test]
async fn reports_process_mark() {
    let child = FakeChild::new();
    *child.mark.lock() = Some(ProcessMark {
        pid: 4242,
        started_at: 1_000,
    });
    let (environment, _) = spawning(child.clone());
    let run = create_agy_agent(Some(environment.arc())).run(task());
    assert_eq!(
        run.mark(),
        Some(ProcessMark {
            pid: 4242,
            started_at: 1_000,
        })
    );
    child.finish(Some(0));
    collect(&run).await;
}
