//! `prism`, the Prism Agent terminal UI.
//!
//! The CLI does not know, and is not told, the user id or the agent id: the
//! runtime owns both. Display preferences come from `~/.prism/settings.json`.

mod acp;
mod api;
mod app;
mod attachments;
mod commands;
mod config;
mod editor;
mod event;
mod images;
mod markdown;
mod panels;
mod protocol;
mod relative_time;
mod shell_command;
mod status_report;
mod term;
mod transcript;
mod ui;
mod update_cli;
mod util;
mod ws_client;

use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};

use crate::api::ApiClient;
use crate::images::graphics::{
    PROBE, TerminalGraphics, graphics_from, parse_probe_replies, typed_during_probe,
};
use crate::protocol::ThreadMode;
use crate::term::terminal::{self, Reader, TermInput};

/// The version this binary reports: the release tag it was built as, else a dev version.
fn version() -> String {
    option_env!("PRISM_VERSION")
        .map(str::to_string)
        .or_else(|| std::env::var("PRISM_VERSION").ok())
        .unwrap_or_else(|| "0.0.0-dev".into())
}

const HELP: &str = "prism — Prism Agent terminal UI (connects to prism-server at $PRISM_HTTP_URL, default http://127.0.0.1:3003).
  update     Check for a newer Prism release and install it.
  acp        Serve the Agent Client Protocol on stdio, for an editor to start.
  --resume   Pick a previous conversation to resume instead of starting fresh.
             An agent in single-thread mode always opens its one conversation.";

/// Long enough for a terminal across an SSH connection; a local one answers within milliseconds.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
/// How much longer to wait for the rest of the answers once some have arrived by the deadline.
const LATE_REPLY: Duration = Duration::from_millis(3000);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `--version` and `--help` answer before anything else, so the binary can be smoke-tested without a TTY.
    if args.iter().any(|a| a == "--version" || a == "-v") {
        println!("{}", version());
        return;
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{HELP}");
        return;
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let code = match args.first().map(String::as_str) {
        Some("update") => runtime.block_on(update_cli::run_update_command()),
        Some("acp") => runtime.block_on(acp::run_acp_command(&version())),
        _ => runtime.block_on(chat(args.iter().any(|a| a == "--resume"))),
    };
    std::process::exit(code);
}

/// Put the terminal back the way the shell had it.
fn restore_terminal() {
    terminal::disable_raw();
    terminal::write(terminal::SHOW_CURSOR);
}

async fn chat(resume: bool) -> i32 {
    let cfg = config::load_config();
    let interactive = terminal::is_tty();
    // Raw mode from the start keeps a Ctrl+C typed during boot a key press rather than a SIGINT.
    if interactive {
        terminal::enable_raw();
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore_terminal();
            default_hook(info);
        }));
    }
    #[cfg(unix)]
    for kind in [
        tokio::signal::unix::SignalKind::terminate(),
        tokio::signal::unix::SignalKind::hangup(),
        tokio::signal::unix::SignalKind::interrupt(),
    ] {
        if let Ok(mut signal) = tokio::signal::unix::signal(kind) {
            tokio::spawn(async move {
                signal.recv().await;
                restore_terminal();
                std::process::exit(128 + kind.as_raw_value());
            });
        }
    }

    let (term_tx, mut term_rx) = mpsc::unbounded_channel::<TermInput>();
    let reader = interactive.then(|| Reader::start(term_tx));
    // The terminal answers the graphics probe as input, so it runs before the chat reads stdin.
    let (graphics, typed_early) = if interactive {
        detect_terminal_graphics(&mut term_rx).await
    } else {
        (TerminalGraphics::TEXT, String::new())
    };

    let mut sessions = None;
    if resume {
        // Fetched before the first frame, so a CLI with nothing to resume exits cleanly. An agent
        // in single-thread mode has nothing to pick: the CLI opens its one conversation.
        let api = ApiClient::new(&cfg.http_url);
        if api.thread_mode().await != Some(ThreadMode::Single) {
            let list = api.list_threads().await;
            if list.is_empty() {
                restore_terminal();
                println!("No sessions to resume.");
                return 0;
            }
            let cwd = std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            sessions = Some((list, cwd));
        }
    }

    let opts = app::Options {
        cfg,
        version: version(),
        graphics,
        resume: sessions,
        typed_early,
        interactive,
    };
    let code = app::run(opts, reader, term_rx).await;
    terminal::disable_raw();
    code
}

/// Ask the terminal what it can draw. A terminal that has begun to answer by the
/// deadline gets a little longer to finish, so its answers are not typed.
async fn detect_terminal_graphics(
    input: &mut mpsc::UnboundedReceiver<TermInput>,
) -> (TerminalGraphics, String) {
    terminal::write(PROBE);
    let mut received = String::new();
    let mut deadline = Instant::now() + PROBE_TIMEOUT;
    let mut extended = false;
    loop {
        tokio::select! {
            got = input.recv() => match got {
                Some(TermInput::Text(text)) => {
                    received.push_str(&text);
                    if parse_probe_replies(&received).complete {
                        break;
                    }
                }
                Some(TermInput::Resize) => {}
                None => break,
            },
            _ = sleep_until(deadline) => {
                if !extended && received.contains('\x1b') {
                    extended = true;
                    deadline = Instant::now() + LATE_REPLY;
                    continue;
                }
                break;
            }
        }
    }
    let replies = parse_probe_replies(&received);
    (graphics_from(&replies), typed_during_probe(&replies))
}
