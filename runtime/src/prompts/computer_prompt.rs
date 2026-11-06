//! The system-prompt section about the agent's computers, and the notices about
//! computer help requests.

use crate::services::computer::computer_help_service::{ComputerHelp, HelpStatus};

pub const COMPUTER_INSTRUCTIONS: &str = r#"# Your computer

You have a persistent desktop and browser, which you use with the computer_* tools. Your user can watch it or take control on the Computer page, including while you work on a task they started elsewhere.

When an available, authorized connector can do the requested operation, use it. Read a web page with web_fetch. Use the computer for a website that needs a sign-in, a form or JavaScript, for work your user wants to watch, and for desktop apps. If a connector's authentication fails, explain the failure before you switch to the browser. Do GUI work with the computer tools and commands and files with the shell tools: the computer tools are what let the user see and take over each action, so do not drive the GUI from the shell.

One invocation uses the computer at a time, and subagents have none, so keep computer work in this invocation. Another invocation that needs the computer waits until your turn ends or you ask for help. When a website blocks you, finish the work that does not depend on it. Computer use itself creates no goal or schedule."#;

/// The section for a runtime with no desktop of its own, whose computers are all the user's.
pub const REMOTE_COMPUTER_INSTRUCTIONS: &str = r#"# Your user's computers

You can use the computers your user connected, such as their laptop, with the computer_* tools; the computers notice names them. Your user can watch one or take control on the Computer page, including while you work on a task they started elsewhere.

When an available, authorized connector can do the requested operation, use it. Read a web page with web_fetch. Use a computer for a website that needs a sign-in, a form or JavaScript, for work your user wants to watch, and for desktop apps. You have no browser of your own: use a computer's browser through its desktop. If a connector's authentication fails, explain the failure before you switch to a computer. Do GUI work with the computer tools, and commands and files with the shell tools, which run where you run and not on those computers.

One invocation uses each computer at a time, and subagents have none, so keep computer work in this invocation. Another invocation that needs the same computer waits until your turn ends or you ask for help. When a website blocks you, finish the work that does not depend on it. Computer use itself creates no goal or schedule."#;

/// Current help state overrides historical requests in the conversation. A run that
/// waits for help (`waits_for_answer`) is told to join a waiting request, and a
/// conversation is told how to answer one.
pub fn computer_help_notices(help: &[ComputerHelp], run_waits_for_answer: bool) -> Vec<String> {
    if help.is_empty() {
        return Vec::new();
    }
    let mut notices = vec![
        "Current computer help status follows. These statuses supersede earlier chat messages and tool results. A dismissed request is closed by the user; proceed with their current request without asking them to dismiss it again. Waiting help only blocks the work that depends on it.".to_string(),
    ];
    for item in help {
        let instruction = match item.status {
            HelpStatus::Waiting => {
                if run_waits_for_answer {
                    "If the step it asks for blocks this run too, call computer_help now: the call joins this request, sends nothing new and waits for its answer, so this run continues once the user answers.".to_string()
                } else {
                    let broadcast = if item.broadcast == Some(true) {
                        "A background run asked for it in every channel, so the user can answer it here. "
                    } else {
                        ""
                    };
                    format!(
                        "{broadcast}If the user says they finished helping, resolve it with computer_continue and inspect the screen."
                    )
                }
            }
            HelpStatus::Continued => "The user has already continued this request.".to_string(),
            HelpStatus::Dismissed => "The user has dismissed this request.".to_string(),
        };
        notices.push(format!(
            "Computer help {} ({}): {instruction}",
            item.id,
            item.status.as_str()
        ));
    }
    notices
}
