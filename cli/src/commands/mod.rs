//! The slash commands. They run locally and are never sent to the agent. Each
//! gets the chat state it needs and returns a short text the chat shows as a
//! SYSTEM line; an empty text shows nothing.

mod catalog;
mod files;
mod goal;
mod heartbeat;
mod session;
mod settings;

use crate::event::{AppEvent, Ctx, PanelId};
use crate::protocol::AttachmentMeta;

pub use session::reason_text;

/// The name of the `/attach` command, shared with the path completion.
pub const ATTACH_COMMAND: &str = "/attach";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandId {
    Copy,
    Schedules,
    Webhooks,
    Config,
    AgentGuide,
    Rename,
    Model,
    HeartbeatModel,
    CronModel,
    ModelMode,
    Heartbeat,
    Goal,
    Skills,
    Plugins,
    Compact,
    Attach,
    Detach,
    Save,
    Update,
    Help,
    Exit,
}

pub struct SlashCommand {
    pub id: CommandId,
    pub name: &'static str,
    pub description: &'static str,
}

pub const COMMANDS: &[SlashCommand] = &[
    SlashCommand {
        id: CommandId::Copy,
        name: "/copy",
        description: "Copy the last message to the clipboard",
    },
    SlashCommand {
        id: CommandId::Schedules,
        name: "/schedules",
        description: "Manage scheduled cron tasks (list, create, delete)",
    },
    SlashCommand {
        id: CommandId::Webhooks,
        name: "/webhooks",
        description: "Manage webhook subscriptions (list, pause, edit)",
    },
    SlashCommand {
        id: CommandId::Config,
        name: "/config",
        description: "View agent identity and config files",
    },
    SlashCommand {
        id: CommandId::AgentGuide,
        name: "/agent-guide",
        description: "Edit the agent guide in $EDITOR",
    },
    SlashCommand {
        id: CommandId::Rename,
        name: "/rename",
        description: "Rename the agent (up to 64 characters: letters, digits, spaces and - ' . &)",
    },
    SlashCommand {
        id: CommandId::Model,
        name: "/model",
        description: "Set the agent model (id or \"reset\")",
    },
    SlashCommand {
        id: CommandId::HeartbeatModel,
        name: "/heartbeat-model",
        description: "Set the heartbeat model (id or \"reset\" to use the main model)",
    },
    SlashCommand {
        id: CommandId::CronModel,
        name: "/cron-model",
        description: "Set the scheduled-task model (id or \"reset\" to use the main model)",
    },
    SlashCommand {
        id: CommandId::ModelMode,
        name: "/model-mode",
        description: "Show or switch Auto and Fixed model selection (auto|fixed)",
    },
    SlashCommand {
        id: CommandId::Heartbeat,
        name: "/heartbeat",
        description: "Control the heartbeat (status|start|stop|trigger|every Nm|Nh)",
    },
    SlashCommand {
        id: CommandId::Goal,
        name: "/goal",
        description: "Set or manage a background goal (/goal <objective> | status | stop | pause | resume | list)",
    },
    SlashCommand {
        id: CommandId::Skills,
        name: "/skills",
        description: "List available skills, or run one (/skills [list] | /skills run <name>)",
    },
    SlashCommand {
        id: CommandId::Plugins,
        name: "/plugins",
        description: "List installed plugins and what each contributes",
    },
    SlashCommand {
        id: CommandId::Compact,
        name: "/compact",
        description: "Summarize older history to free up context",
    },
    SlashCommand {
        id: CommandId::Attach,
        name: ATTACH_COMMAND,
        description: "Attach a file to your next message (/attach <path>)",
    },
    SlashCommand {
        id: CommandId::Detach,
        name: "/detach",
        description: "Remove all staged attachments",
    },
    SlashCommand {
        id: CommandId::Save,
        name: "/save",
        description: "Save the agent’s shared file(s) to disk (/save [dir|file])",
    },
    SlashCommand {
        id: CommandId::Update,
        name: "/update",
        description: "Check for a newer Prism release and install it",
    },
    SlashCommand {
        id: CommandId::Help,
        name: "/help",
        description: "List all commands",
    },
    SlashCommand {
        id: CommandId::Exit,
        name: "/exit",
        description: "Shut down the TUI",
    },
];

pub fn find_exact(name: &str) -> Option<&'static SlashCommand> {
    COMMANDS.iter().find(|c| c.name == name)
}

pub fn filter_by_prefix(prefix: &str) -> Vec<&'static SlashCommand> {
    if !prefix.starts_with('/') {
        return Vec::new();
    }
    COMMANDS
        .iter()
        .filter(|c| c.name.starts_with(prefix))
        .collect()
}

/// A trimmed input line as its command word, its arguments split on whitespace,
/// and everything after the word with inner spaces kept.
pub fn parse_command_line(trimmed: &str) -> (String, Vec<String>, String) {
    let Some(first_space) = trimmed.find(char::is_whitespace) else {
        return (trimmed.to_string(), Vec::new(), String::new());
    };
    let head = trimmed[..first_space].to_string();
    let rest_start = first_space
        + trimmed[first_space..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
    let raw_args = trimmed[rest_start..].trim().to_string();
    let args = if raw_args.is_empty() {
        Vec::new()
    } else {
        raw_args.split_whitespace().map(str::to_string).collect()
    };
    (head, args, raw_args)
}

/// What a command gets to work with.
pub struct CommandContext {
    pub ctx: Ctx,
    /// The content of the newest message in the chat, of any role.
    pub last_message_content: Option<String>,
    pub args: Vec<String>,
    pub raw_args: String,
    pub thread_id: Option<String>,
    /// The files of the latest turn that delivered any: the `/save` candidates.
    pub recent_attachments: Vec<AttachmentMeta>,
    pub staged_attachments: Vec<AttachmentMeta>,
}

impl CommandContext {
    fn open_panel(&self, id: PanelId) {
        self.ctx.send(AppEvent::OpenPanel(id));
    }
}

pub async fn run(id: CommandId, c: CommandContext) -> String {
    match id {
        CommandId::Copy => files::copy(&c).await,
        CommandId::Schedules => {
            c.open_panel(PanelId::Schedules);
            String::new()
        }
        CommandId::Webhooks => {
            c.open_panel(PanelId::Webhooks);
            String::new()
        }
        CommandId::Config => {
            c.open_panel(PanelId::Config);
            String::new()
        }
        CommandId::AgentGuide => settings::agent_guide(&c).await,
        CommandId::Rename => settings::rename(&c).await,
        CommandId::Model => settings::model(&c).await,
        CommandId::HeartbeatModel => settings::run_model(&c, &settings::HEARTBEAT_MODEL).await,
        CommandId::CronModel => settings::run_model(&c, &settings::CRON_MODEL).await,
        CommandId::ModelMode => settings::model_mode(&c).await,
        CommandId::Heartbeat => heartbeat::heartbeat(&c).await,
        CommandId::Goal => goal::goal(&c).await,
        CommandId::Skills => catalog::skills(&c).await,
        CommandId::Plugins => catalog::plugins(&c).await,
        CommandId::Compact => session::compact(&c).await,
        CommandId::Attach => files::attach(&c).await,
        CommandId::Detach => files::detach(&c).await,
        CommandId::Save => files::save(&c).await,
        CommandId::Update => session::update(&c).await,
        CommandId::Help => COMMANDS
            .iter()
            .map(|c| format!("{} — {}", c.name, c.description))
            .collect::<Vec<_>>()
            .join("\n"),
        CommandId::Exit => {
            c.ctx.send(AppEvent::Shutdown);
            "Shutting down…".into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_command_line() {
        assert_eq!(
            parse_command_line("/rename My Agent"),
            (
                "/rename".into(),
                vec!["My".into(), "Agent".into()],
                "My Agent".into()
            )
        );
        assert_eq!(
            parse_command_line("/help"),
            ("/help".into(), vec![], String::new())
        );
        assert_eq!(
            parse_command_line("/goal   do  it "),
            (
                "/goal".into(),
                vec!["do".into(), "it".into()],
                "do  it".into()
            )
        );
    }

    #[test]
    fn filters_by_prefix() {
        let names: Vec<_> = filter_by_prefix("/he").iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["/heartbeat-model", "/heartbeat", "/help"]);
        assert!(filter_by_prefix("x").is_empty());
        assert_eq!(filter_by_prefix("/").len(), COMMANDS.len());
    }

    #[test]
    fn lists_copy_first() {
        assert_eq!(COMMANDS[0].name, "/copy");
        assert_eq!(COMMANDS[1].name, "/schedules");
    }
}
