//! The prompt texts of this module, compared with what the TypeScript runtime wrote
//! for the same inputs (`testdata/prompt_texts.json`). The model reads these bytes,
//! and the provider's prompt cache and the E2E LLM cache key on them.

use serde_json::{Value, json};

use super::*;
use crate::lib::task_tool::Subagent;
use crate::protocol::chat_protocol::AgentMessageKind;
use crate::services::computer::computer_help_service::ComputerHelp;
use crate::types::{AgentMessageOrigin, TaskLastSend};

const FIXTURE: &str = include_str!("testdata/prompt_texts.json");

fn check(expected: &Value, name: &str, actual: Value) {
    let want = &expected[name];
    assert!(!want.is_null(), "{name} is not in the fixture");
    if *want != actual {
        let want_text = want.to_string();
        let got_text = actual.to_string();
        let at = want_text
            .chars()
            .zip(got_text.chars())
            .position(|(a, b)| a != b)
            .unwrap_or(0);
        let window =
            |text: &str| -> String { text.chars().skip(at.saturating_sub(80)).take(240).collect() };
        panic!(
            "{name} differs at char {at}\n--- want ---\n{}\n--- got ---\n{}",
            window(&want_text),
            window(&got_text)
        );
    }
}

fn s(text: impl Into<String>) -> Value {
    Value::String(text.into())
}

fn help(id: &str, status: &str, broadcast: bool) -> ComputerHelp {
    let mut value =
        json!({ "type": "computer_help", "id": id, "reason": "Website text", "status": status });
    if broadcast {
        value["broadcast"] = json!(true);
    }
    serde_json::from_value(value).expect("a help card")
}

fn origin(
    kind: AgentMessageKind,
    sender_id: &str,
    sender_name: &str,
    message_id: &str,
) -> AgentMessageOrigin {
    AgentMessageOrigin {
        kind,
        sender_id: sender_id.into(),
        sender_name: sender_name.into(),
        message_id: message_id.into(),
    }
}

fn history_row(
    id: &str,
    role: crate::db::models::MessageRole,
    content: &str,
    internal_step: bool,
) -> context_builder::ConversationMessage {
    context_builder::ConversationMessage {
        id: id.into(),
        role,
        content: content.into(),
        tool_calls: None,
        triggered_by: None,
        trigger_name: None,
        sender_external_id: None,
        sender_name: None,
        external_message_id: None,
        internal_step,
        attachments: None,
    }
}

#[test]
fn prompt_texts_match_the_typescript() {
    let expected: Value = serde_json::from_str(FIXTURE).unwrap();
    let check = |name: &str, actual: Value| check(&expected, name, actual);

    check(
        "channel",
        s(channel_prompt::get_channel_behavior_instructions(
            "the team Slack channel **#ops**",
        )),
    );
    check("compaction", s(compaction_prompt::COMPACTION_PROMPT));
    check("computer", s(computer_prompt::COMPUTER_INSTRUCTIONS));
    check(
        "remoteComputer",
        s(computer_prompt::REMOTE_COMPUTER_INSTRUCTIONS),
    );
    check(
        "helpNotices",
        json!(computer_prompt::computer_help_notices(
            &[
                help("h1", "waiting", true),
                help("h2", "continued", false),
                help("h3", "dismissed", false),
                help("h4", "waiting", false),
            ],
            false
        )),
    );
    check(
        "helpNoticesWaiting",
        json!(computer_prompt::computer_help_notices(
            &[help("h1", "waiting", true), help("h2", "waiting", false)],
            true
        )),
    );
    check(
        "earlyStopping",
        s(early_stopping_prompt::EARLY_STOPPING_PROMPT.as_str()),
    );
    check(
        "goal",
        s(goal_prompt::build_goal_continuation_prompt(
            &goal_prompt::GoalPromptInput {
                objective: "Ship it".into(),
                turn_count: 2,
                max_turns: 100,
                tokens_used: 1234,
                token_budget: Some(50000),
            },
        )),
    );
    check(
        "goalNoBudget",
        s(goal_prompt::build_goal_continuation_prompt(
            &goal_prompt::GoalPromptInput {
                objective: "Ship it".into(),
                turn_count: 0,
                max_turns: 10,
                tokens_used: 0,
                token_budget: None,
            },
        )),
    );
    check("goalGate", s(goal_prompt::GOAL_COMPLETION_GATE_PROMPT));

    use voice_delivery_prompt::ResponseMode;
    for (name, mode) in [
        ("auto", ResponseMode::Auto),
        ("open", ResponseMode::Open),
        ("addressed", ResponseMode::Addressed),
    ] {
        check(
            &format!("meeting_{name}"),
            s(meeting_prompt::get_meeting_instructions(
                &meeting_prompt::MeetingInstructionsInput {
                    agent_name: "Prism".into(),
                    platform: "Google Meet".into(),
                    response_mode: mode,
                },
            )),
        );
        check(
            &format!("listening_{name}"),
            s(voice_delivery_prompt::listening_note(mode)),
        );
    }
    check(
        "meetingTeams",
        s(meeting_prompt::get_meeting_instructions(
            &meeting_prompt::MeetingInstructionsInput {
                agent_name: "Ada \"A\"".into(),
                platform: "Microsoft Teams".into(),
                response_mode: ResponseMode::Open,
            },
        )),
    );

    check("resumedReply", s(resume_prompt::RESUMED_REPLY_NOTICE));
    check("resumedRun", s(resume_prompt::RESUMED_RUN_NOTICE));
    check(
        "resumedCoding",
        s(resume_prompt::RESUMED_CODING_TASK_PROMPT),
    );
    let record = TaskLastSend {
        messages: "x".into(),
        at: 1,
        latest_report: None,
        reports: None,
    };
    check(
        "scheduled",
        s(scheduled_run_prompt::scheduled_run_prompt(
            "Check CI.",
            Some(&record),
        )),
    );
    check(
        "scheduledNoRecord",
        s(scheduled_run_prompt::scheduled_run_prompt(
            "Check CI.",
            None,
        )),
    );
    check(
        "taskTool",
        s(task_tool_prompt::get_task_tool_instructions(&[
            Subagent {
                name: "a".into(),
                description: "does a".into(),
            },
            Subagent {
                name: "b".into(),
                description: "does b".into(),
            },
        ])),
    );

    use voice_chat_prompt::*;
    let voice = |response_mode, computer, user_screen, conversation, summary| {
        s(get_voice_chat_instructions(&VoiceChatInstructionsInput {
            agent_name: "Prism".into(),
            response_mode,
            computer,
            user_screen,
            conversation,
            summary,
        }))
    };
    check(
        "voiceChatFull",
        voice(
            ResponseMode::Addressed,
            Some(VoiceComputer {
                desktop: Some(DesktopSize {
                    width: 1280,
                    height: 800,
                }),
            }),
            true,
            true,
            true,
        ),
    );
    check(
        "voiceChatBare",
        voice(ResponseMode::Open, None, false, false, false),
    );
    check(
        "voiceChatScreenOnly",
        voice(
            ResponseMode::Open,
            Some(VoiceComputer { desktop: None }),
            true,
            false,
            true,
        ),
    );
    check(
        "voiceChatConversation",
        voice(ResponseMode::Addressed, None, false, true, false),
    );
    check("voiceSummary", s(VOICE_CALL_SUMMARY_INSTRUCTIONS));
    check("notForYou", s(voice_delivery_prompt::NOT_FOR_YOU));
    check(
        "speaking",
        s(voice_delivery_prompt::speaking_section("LONG")),
    );
    check("toolUse", s(voice_delivery_prompt::tool_use_section("")));
    check(
        "toolUseException",
        s(voice_delivery_prompt::tool_use_section("EXC")),
    );

    check(
        "agentMessage",
        s(agent_message_prompt::render_agent_message(
            &origin(AgentMessageKind::Ask, "id\"1", "R<x>", "m1"),
            "hi <b>",
        )),
    );
    check(
        "agentPlainMessage",
        s(agent_message_prompt::render_agent_message(
            &origin(AgentMessageKind::Message, "s", "n", "m"),
            "a & b",
        )),
    );
    check(
        "agentNotice",
        s(agent_message_prompt::render_agent_message(
            &origin(AgentMessageKind::Notice, "s", "n", "m"),
            "note",
        )),
    );

    use crate::db::models::MessageRole;
    check(
        "voiceHistory",
        json!(voice_history::voice_history_content(
            &voice_history::VoiceHistoryInput {
                compaction_summary: Some(format!(
                    "{}newest </conversation-so-far>",
                    "old ".repeat(2100)
                )),
                messages: vec![
                    history_row("1", MessageRole::User, "Is the deploy done? 😀", false),
                    history_row("2", MessageRole::Agent, "step", true),
                    history_row("3", MessageRole::System, "tools changed", false),
                    history_row("4", MessageRole::Agent, "  It finished at noon.  ", false),
                    history_row("5", MessageRole::User, &"x".repeat(1100), false),
                ],
                history_readable: true,
            }
        )),
    );
    check(
        "webhookTags",
        json!([
            webhook_prompt_tags::WEBHOOK_PROMPT_TAG,
            webhook_prompt_tags::WEBHOOK_EVENT_DATA_TAG
        ]),
    );
}
