//! `prism-server`: the Prism Agent runtime.
//!
//! - `prism-server` boots the runtime (HTTP and WebSocket on `PORT`, the web UI).
//! - `prism-server --version` prints the release version.
//! - `prism-server apply-pending-import` promotes a staged `.prism` restore
//!   (`start.sh` runs it before the runtime opens the database).
//! - `prism-server coding-agent-exec --wrappers <dir> <claude|codex> [args…]` runs a
//!   coding agent for the desktop's terminal.
//! - `prism-server backfill-embeddings` embeds the memory entries that have none.
//! - `prism-server generate-model-limits` regenerates the bundled model catalog
//!   from models.dev (`npm run generate:model-limits`).
//! - `prism-server eval` serves the prompt eval set (`evals/`) over stdin and stdout.

use prism_runtime::lib::coding_agents::terminal::EXEC_SUBCOMMAND;
use prism_runtime::lib::environment::is_sea;
use prism_runtime::scripts::coding_agent_exec;

fn main() {
    // SAFETY: `main` is synchronous and nothing before this line starts a thread.
    // Each subcommand below builds its Tokio runtime, and the server its threads,
    // only after this call.
    unsafe { prism_runtime::lib::environment::remove_terminal_resume_token() };
    prism_runtime::lib::environment::install_tls_provider();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version" | "-v") => {
            println!(
                "{}",
                option_env!("PRISM_VERSION")
                    .filter(|v| !v.is_empty())
                    .unwrap_or("0.0.0-dev")
            );
        }
        Some("--help" | "-h") => {
            println!(
                "prism-server — Prism Agent runtime (HTTP + WebSocket on :3003, serves the bundled web UI)."
            );
        }
        Some("apply-pending-import") => {
            if let Err(err) = prism_runtime::scripts::apply_pending_import::run() {
                eprintln!("[apply-pending-import] {err:#}");
                std::process::exit(1);
            }
        }
        Some(EXEC_SUBCOMMAND) => {
            let env = std::env::vars().collect();
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            let code = runtime.block_on(coding_agent_exec::main(
                args[1..].to_vec(),
                env,
                Default::default(),
            ));
            std::process::exit(code);
        }
        Some("eval") => {
            std::sync::LazyLock::force(&prism_runtime::lib::environment::DOTENV_LOAD_INFO);
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("runtime");
            let code = runtime.block_on(prism_runtime::scripts::eval::main());
            std::process::exit(code);
        }
        Some("generate-model-limits") => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            let code = runtime.block_on(prism_runtime::scripts::generate_model_limits::main());
            std::process::exit(code);
        }
        Some("backfill-embeddings") => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("runtime");
            let code = runtime.block_on(prism_runtime::scripts::backfill_embeddings::main());
            std::process::exit(code);
        }
        _ => {
            if is_sea()
                && let Err(err) = prism_runtime::sea::server_entry::apply_standalone_defaults()
            {
                eprintln!("[prism-server] fatal startup error {err:#}");
                std::process::exit(1);
            }
            prism_runtime::index::main();
        }
    }
}
