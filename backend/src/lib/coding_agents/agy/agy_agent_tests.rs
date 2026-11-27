//! The Antigravity CLI adapter against a fake `agy`: argv for each mode and
//! option, availability detection, and the events read from
//! `agy -p ... --output-format stream-json`.

use std::sync::Arc;

use futures::StreamExt;
use parking_lot::Mutex;
use serde_json::json;

use super::*;
use crate::lib::coding_agents::coding_agent::{Effort, ModelTier};
use crate::lib::coding_agents::testing::{
    FakeChild, FakeEnvironment, FakeFiles, env_of, fake_paths,
};
use crate::lib::execution_environments::execution_environment::{
    ProcessMark, RunOptions, StdinMode,
};

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
                "text_delta": "hel",
                "usage": {
                    "input_tokens": 16093,
                    "output_tokens": 35,
                    "thinking_tokens": 0,
                    "cache_read_tokens": 0,
                    "total_tokens": 16128
                }
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
                "text_delta": "lo\n",
                "usage": {
                    "input_tokens": 2173,
                    "output_tokens": 1,
                    "thinking_tokens": 0,
                    "cache_read_tokens": 14042,
                    "total_tokens": 2174
                }
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
                text: "hello\n".to_string(),
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
                    subscription: true,
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
#[serial_test::serial]
async fn keeps_split_deltas_together_through_task_manager_and_flushes_unclosed_deltas() {
    use crate::tools::shell::agent_task_manager::{
        AgentTaskManager, AgentTaskParams, TaskStopReason,
    };

    // Unclosed ACTIVE deltas (no DONE step before result) still emit one Text event.
    let child = FakeChild::new();
    let (environment, _) = spawning(child.clone());
    let run = create_agy_agent(Some(environment.arc())).run(task());
    child.emit_line(
        &json!({
            "event": "step_update",
            "step_update": { "step_index": 1, "state": "ACTIVE", "step_type": "agent_response", "text_delta": "part 1 " }
        })
        .to_string(),
    );
    child.emit_line(
        &json!({
            "event": "step_update",
            "step_update": { "step_index": 1, "state": "ACTIVE", "step_type": "agent_response", "text_delta": "part 2" }
        })
        .to_string(),
    );
    child.emit_line(
        &json!({
            "event": "result",
            "result": { "status": "SUCCESS", "response": "", "num_turns": 1 }
        })
        .to_string(),
    );
    child.finish(Some(0));
    assert_eq!(
        collect(&run).await,
        vec![
            CodingAgentEvent::Text {
                text: "part 1 part 2".to_string(),
            },
            CodingAgentEvent::Result {
                stop_reason: CodingAgentStopReason::EndTurn,
                turns: 1,
                message: "part 1 part 2".to_string(),
                refusals: None,
            },
        ]
    );

    // End-to-end through AgentTaskManager::drive: split deltas in one agent_response
    // produce "hello\n", not "hel\n\nlo\n".
    let _db = crate::db::testing::test_db();
    let child = FakeChild::new();
    let (environment, _) = spawning(child.clone());
    let agent = create_agy_agent(Some(environment.arc()));
    let manager = Arc::new(AgentTaskManager::new(Some(Arc::new(move |_| {
        Ok(agent.clone())
    }))));

    let started = manager
        .start_task(AgentTaskParams {
            agent: Some(CodingAgentName::Agy),
            prompt: "say hello".to_string(),
            workdir: Some("/work".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();

    child.emit_line(
        &json!({
            "event": "init",
            "conversation_id": "ab51a318-604e-40ff-8576-f2356379a5e0",
            "init": { "model": "gemini-3.8-flash-low" }
        })
        .to_string(),
    );
    child.emit_line(
        &json!({
            "event": "step_update",
            "step_update": { "step_index": 1, "state": "ACTIVE", "step_type": "agent_response", "text_delta": "hel" }
        })
        .to_string(),
    );
    child.emit_line(
        &json!({
            "event": "step_update",
            "step_update": { "step_index": 1, "state": "DONE", "step_type": "agent_response", "text_delta": "lo\n" }
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
                "num_turns": 1
            }
        })
        .to_string(),
    );
    child.finish(Some(0));

    let mut final_status = None;
    for _ in 0..100 {
        let status = manager
            .read_status(&started.task_id, Some(30))
            .await
            .unwrap();
        if status.completed {
            final_status = Some(status);
            break;
        }
    }
    let status = final_status.expect("agy task did not complete");
    assert_eq!(status.stop_reason, Some(TaskStopReason::EndTurn));
    assert_eq!(status.result.as_deref(), Some("hello\n"));
}

#[tokio::test]
#[serial_test::serial]
async fn flushes_active_delta_when_child_exits_or_stops_without_result() {
    use crate::tools::shell::agent_task_manager::{
        AgentTaskManager, AgentTaskParams, TaskStopReason,
    };

    // Child exits after a single ACTIVE delta and no DONE or result.
    let child = FakeChild::new();
    let (environment, _) = spawning(child.clone());
    let run = create_agy_agent(Some(environment.arc())).run(task());
    child.emit_line(
        &json!({
            "event": "step_update",
            "step_update": {
                "step_index": 1,
                "state": "ACTIVE",
                "step_type": "agent_response",
                "text_delta": "in progress"
            }
        })
        .to_string(),
    );
    child.finish(Some(143));

    assert_eq!(
        collect(&run).await,
        vec![
            CodingAgentEvent::Text {
                text: "in progress".to_string(),
            },
            CodingAgentEvent::Result {
                stop_reason: CodingAgentStopReason::Error,
                turns: 0,
                message: "Antigravity CLI exited with code 143 and no result".to_string(),
                refusals: None,
            },
        ]
    );

    // Stopping via AgentTaskManager after an ACTIVE delta keeps the buffered text.
    let _db = crate::db::testing::test_db();
    let child = FakeChild::new();
    let (environment, _) = spawning(child.clone());
    let agent = create_agy_agent(Some(environment.arc()));
    let manager = Arc::new(AgentTaskManager::new(Some(Arc::new(move |_| {
        Ok(agent.clone())
    }))));

    let started = manager
        .start_task(AgentTaskParams {
            agent: Some(CodingAgentName::Agy),
            prompt: "work".to_string(),
            workdir: Some("/work".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();

    child.emit_line(
        &json!({
            "event": "step_update",
            "step_update": {
                "step_index": 1,
                "state": "ACTIVE",
                "step_type": "agent_response",
                "text_delta": "partial answer"
            }
        })
        .to_string(),
    );
    // Let the pump read the ACTIVE line before stop_task signals the child.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    let stopped = manager.stop_task(&started.task_id).await.unwrap();
    assert_eq!(stopped.stop_reason, Some(TaskStopReason::Stopped));
    assert_eq!(stopped.result.as_deref(), Some("partial answer"));
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
async fn checks_state_and_models_probe_for_availability() {
    let home = tempfile::tempdir().unwrap();
    let state_dir = home.path().join(".gemini/antigravity-cli");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("jetski_state.pbtxt"),
        "post_onboarding: true\n",
    )
    .unwrap();
    let home_str = home.path().to_string_lossy().into_owned();

    let models_ok = || FakeEnvironment {
        files: FakeFiles::local(),
        ..FakeEnvironment::with_run_program(|_, _, _| {
            let child = FakeChild::new();
            child.emit_line(
                "\r⠋ Fetching available models...\rgemini-4-neon-high  Gemini 4 Neon (High)",
            );
            child.finish(Some(0));
            child.process()
        })
    };
    let models_signed_out = || FakeEnvironment {
        files: FakeFiles::local(),
        ..FakeEnvironment::with_run_program(|_, _, _| {
            let child = FakeChild::new();
            child.emit_line("Fetching available models...");
            child.emit_line(
                "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.",
            );
            child.finish(Some(0));
            child.process()
        })
    };
    let binary_missing = || FakeEnvironment {
        files: FakeFiles::local(),
        ..FakeEnvironment::with_run_program(|_, _, _| {
            let child = FakeChild::new();
            child.fail("spawn agy ENOENT");
            child.process()
        })
    };

    let agent = create_agy_agent(Some(models_ok().arc()));
    assert!(
        agent
            .is_available(&env_of(&[("HOME", &home_str)]))
            .await
            .unwrap()
    );
    // Windows sessions provide USERPROFILE without HOME.
    assert!(
        agent
            .is_available(&env_of(&[("USERPROFILE", &home_str)]))
            .await
            .unwrap()
    );
    assert!(
        !agent
            .is_available(&env_of(&[("HOME", "/nonexistent")]))
            .await
            .unwrap()
    );

    let signed_out = create_agy_agent(Some(models_signed_out().arc()));
    assert!(
        !signed_out
            .is_available(&env_of(&[("HOME", &home_str)]))
            .await
            .unwrap()
    );

    let missing_bin = create_agy_agent(Some(binary_missing().arc()));
    assert!(
        !missing_bin
            .is_available(&env_of(&[("HOME", &home_str)]))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn prepares_home_by_linking_skills_only_when_absent_and_never_fails_startup() {
    let dir = tempfile::tempdir().unwrap();
    let skills = dir.path().join("skills");
    std::fs::create_dir_all(&skills).unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let home_str = home.to_string_lossy().into_owned();

    let mut paths = fake_paths("/workspace");
    paths.skills_dir = skills.to_string_lossy().into_owned();
    let environment = FakeEnvironment {
        paths: paths.clone(),
        base_env: env_of(&[("HOME", &home_str)]),
        files: FakeFiles::local(),
        ..Default::default()
    };

    // Nothing at `<home>/.gemini/config/skills` -> creates the link.
    let prepared = create_agy_agent(Some(environment.clone().arc()))
        .prepare_home()
        .await
        .unwrap();
    assert_eq!(prepared.config_dir, format!("{home_str}/.gemini/config"));
    assert!(prepared.skills_linked);
    assert_eq!(
        std::fs::canonicalize(home.join(".gemini/config/skills")).unwrap(),
        std::fs::canonicalize(&skills).unwrap()
    );

    // Calling again when the link already points at the runtime's skills reports true.
    let prepared_again = create_agy_agent(Some(environment.arc()))
        .prepare_home()
        .await
        .unwrap();
    assert!(prepared_again.skills_linked);

    // An existing user-owned symlink (valid or dangling) is never replaced.
    #[cfg(unix)]
    {
        let user_skills = dir.path().join("user-skills");
        std::fs::create_dir_all(&user_skills).unwrap();
        let linked_home = dir.path().join("linked-home");
        std::fs::create_dir_all(linked_home.join(".gemini/config")).unwrap();
        let user_link = linked_home.join(".gemini/config/skills");
        std::os::unix::fs::symlink(&user_skills, &user_link).unwrap();
        let linked_str = linked_home.to_string_lossy().into_owned();
        let linked_env = FakeEnvironment {
            paths: paths.clone(),
            base_env: env_of(&[("HOME", &linked_str)]),
            files: FakeFiles::local(),
            ..Default::default()
        };
        let prepared_linked = create_agy_agent(Some(linked_env.arc()))
            .prepare_home()
            .await
            .unwrap();
        assert_eq!(
            prepared_linked.config_dir,
            format!("{linked_str}/.gemini/config")
        );
        assert!(!prepared_linked.skills_linked);
        assert_eq!(
            std::fs::canonicalize(&user_link).unwrap(),
            std::fs::canonicalize(&user_skills).unwrap()
        );

        let dangling_home = dir.path().join("dangling-home");
        std::fs::create_dir_all(dangling_home.join(".gemini/config")).unwrap();
        let dangling_link = dangling_home.join(".gemini/config/skills");
        std::os::unix::fs::symlink(dir.path().join("removed-target"), &dangling_link).unwrap();
        let dangling_str = dangling_home.to_string_lossy().into_owned();
        let dangling_env = FakeEnvironment {
            paths: paths.clone(),
            base_env: env_of(&[("HOME", &dangling_str)]),
            files: FakeFiles::local(),
            ..Default::default()
        };
        let prepared_dangling = create_agy_agent(Some(dangling_env.arc()))
            .prepare_home()
            .await
            .unwrap();
        assert!(!prepared_dangling.skills_linked);
        assert_eq!(
            std::fs::read_link(&dangling_link).unwrap(),
            dir.path().join("removed-target")
        );
    }

    // A real skills directory already owned by the user is never overwritten.
    let owned_home = dir.path().join("owned-home");
    std::fs::create_dir_all(owned_home.join(".gemini/config/skills")).unwrap();
    let owned_str = owned_home.to_string_lossy().into_owned();
    let owned_env = FakeEnvironment {
        paths: paths.clone(),
        base_env: env_of(&[("HOME", &owned_str)]),
        files: FakeFiles::local(),
        ..Default::default()
    };
    let prepared_owned = create_agy_agent(Some(owned_env.arc()))
        .prepare_home()
        .await
        .unwrap();
    assert_eq!(
        prepared_owned.config_dir,
        format!("{owned_str}/.gemini/config")
    );
    assert!(!prepared_owned.skills_linked);

    // A blocked or unwritable `.gemini` path reports skills_linked: false instead of failing boot.
    let blocked_home = dir.path().join("blocked-home");
    std::fs::create_dir_all(&blocked_home).unwrap();
    std::fs::write(blocked_home.join(".gemini"), "not a dir").unwrap();
    let blocked_str = blocked_home.to_string_lossy().into_owned();
    let blocked_env = FakeEnvironment {
        paths: paths.clone(),
        base_env: env_of(&[("HOME", &blocked_str)]),
        files: FakeFiles::local(),
        ..Default::default()
    };
    let prepared_blocked = create_agy_agent(Some(blocked_env.arc()))
        .prepare_home()
        .await
        .unwrap();
    assert_eq!(
        prepared_blocked.config_dir,
        format!("{blocked_str}/.gemini/config")
    );
    assert!(!prepared_blocked.skills_linked);

    // Windows USERPROFILE works when HOME is absent.
    let win_home = dir.path().join("win-home");
    std::fs::create_dir_all(&win_home).unwrap();
    let win_str = win_home.to_string_lossy().into_owned();
    let win_env = FakeEnvironment {
        paths: paths.clone(),
        base_env: env_of(&[("USERPROFILE", &win_str)]),
        files: FakeFiles::local(),
        ..Default::default()
    };
    let prepared_win = create_agy_agent(Some(win_env.arc()))
        .prepare_home()
        .await
        .unwrap();
    assert_eq!(prepared_win.config_dir, format!("{win_str}/.gemini/config"));
    assert!(prepared_win.skills_linked);

    let no_home = FakeEnvironment {
        paths,
        base_env: ProcessEnv::new(),
        files: FakeFiles::local(),
        ..Default::default()
    };
    let prepared_no_home = create_agy_agent(Some(no_home.arc()))
        .prepare_home()
        .await
        .unwrap();
    assert_eq!(prepared_no_home.config_dir, "");
    assert!(!prepared_no_home.skills_linked);
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
