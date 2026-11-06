//! Runtime benchmarks: the same scenarios against any build of the Prism runtime.
//!
//! `prism-bench run --name rust --cmd runtime/target/release/prism-server --out rust.json`
//! starts a mock model server, boots the runtime on a fresh database, and measures
//! boot time, memory, CPU time, HTTP and WebSocket latency and throughput, and
//! chat turns end to end. `prism-bench report a.json b.json` prints a Markdown
//! comparison.

mod mock_llm;
mod report;
mod runtime;
mod scenarios;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(about = "Prism runtime benchmarks")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Boot one runtime build and run every scenario against it.
    Run(runtime::RunArgs),
    /// Print a Markdown comparison of result files.
    Report {
        files: Vec<std::path::PathBuf>,
    },
    /// Serve the mock model on a port (for manual runs).
    MockLlm {
        #[arg(long, default_value_t = 4100)]
        port: u16,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Run(args) => runtime::run(args).await,
        Command::Report { files } => report::print(&files),
        Command::MockLlm { port } => {
            let (addr, _) = mock_llm::serve(port).await?;
            println!("mock model on http://{addr}/v1");
            tokio::signal::ctrl_c().await?;
            Ok(())
        }
    }
}
