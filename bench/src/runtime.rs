//! Starting, measuring and stopping one runtime build.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::process::{Child, Command};

use crate::scenarios::{self, ScenarioResult};

#[derive(clap::Args, Clone)]
pub struct RunArgs {
    /// A label for this build, e.g. `node` or `rust`.
    #[arg(long)]
    pub name: String,
    /// The command that starts the runtime, split on spaces.
    #[arg(long)]
    pub cmd: String,
    /// The directory to start it in.
    #[arg(long, default_value = ".")]
    pub cwd: PathBuf,
    /// A command run once on the fresh database before the first boot (migrations).
    #[arg(long)]
    pub prepare: Option<String>,
    /// How many boots to time.
    #[arg(long, default_value_t = 5)]
    pub boots: usize,
    /// Seconds each throughput scenario runs.
    #[arg(long, default_value_t = 10)]
    pub duration: u64,
    /// Concurrent clients in each throughput scenario.
    #[arg(long, default_value_t = 32)]
    pub concurrency: usize,
    /// Chat turns per turn scenario.
    #[arg(long, default_value_t = 100)]
    pub turns: usize,
    /// Where to write the JSON results.
    #[arg(long)]
    pub out: PathBuf,
}

#[derive(Serialize)]
pub struct RunResult {
    pub name: String,
    pub boot_ms: Vec<f64>,
    pub idle_rss_kb: u64,
    pub binary_or_bundle: String,
    pub scenarios: Vec<ScenarioResult>,
    pub mock_requests: u64,
}

pub struct Runtime {
    pub child: Child,
    pub base: String,
    pub port: u16,
}

impl Runtime {
    pub fn pid(&self) -> u32 {
        self.child.id().unwrap_or(0)
    }
}

pub struct Env {
    pub vars: Vec<(String, String)>,
    pub dir: PathBuf,
    pub port: u16,
    pub db: PathBuf,
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .expect("free port")
}

fn build_env(mock: &str, dir: &Path) -> Env {
    let port = free_port();
    let db = dir.join("agent.db");
    let data = dir.join("data");
    let ws = dir.join("workspace");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&ws).unwrap();
    let vars = vec![
        ("PORT", port.to_string()),
        ("WEBHOOK_PORT", free_port().to_string()),
        ("AGENT_MESSAGES_PORT", free_port().to_string()),
        ("PRISM_HOST", "127.0.0.1".into()),
        ("DATABASE_URL", format!("file:{}", db.display())),
        ("PRISM_DATA_DIR", data.display().to_string()),
        ("SHELL_WORKSPACE_ROOT", ws.display().to_string()),
        ("EXECUTION_ENVIRONMENT", "local".into()),
        ("NODE_ENV", "production".into()),
        ("LOG_LEVEL", "warn".into()),
        ("LLM_PROVIDER", "anthropic".into()),
        ("ANTHROPIC_API_KEY", "bench-key".into()),
        ("ANTHROPIC_BASE_URL", format!("{mock}/v1")),
        ("AGENT_ID", "6d6b8f7e-3c2a-4b8e-9f1d-0a1b2c3d4e5f".into()),
        ("OWNER_USER_ID", "bench-user".into()),
        ("MODELS_DEV_URL", String::new()),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", String::new()),
        ("LANGFUSE_SECRET_KEY", String::new()),
        ("LANGFUSE_PUBLIC_KEY", String::new()),
        ("SLACK_BOT_TOKEN", String::new()),
        ("SLACK_APP_TOKEN", String::new()),
        ("TEAMS_APP_ID", String::new()),
        ("OPENAI_API_KEY", String::new()),
        ("NEXUS_API_URL", String::new()),
        ("DISABLE_UPDATER", "1".into()),
        ("PRISM_PROGRAM_STATUS", "off".into()),
        ("HEARTBEAT_INTERVAL_MS", "604800000".into()),
        ("TOOL_SEARCH", "off".into()),
        ("COMPACTION_THRESHOLD_PERCENT", "0".into()),
        ("IDLE_COMPACTION", "off".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    Env {
        vars,
        dir: dir.to_path_buf(),
        port,
        db,
    }
}

async fn start(args: &RunArgs, env: &Env) -> anyhow::Result<(Runtime, f64)> {
    let parts: Vec<&str> = args.cmd.split_whitespace().collect();
    let mut cmd = Command::new(parts[0]);
    cmd.args(&parts[1..])
        .current_dir(&args.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(std::fs::File::create(
            env.dir.join("runtime.log"),
        )?))
        .stderr(Stdio::from(
            std::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(env.dir.join("runtime.log"))?,
        ))
        .kill_on_drop(true);
    for (k, v) in &env.vars {
        cmd.env(k, v);
    }
    let base = format!("http://127.0.0.1:{}", env.port);
    let client = reqwest::Client::new();
    let started = Instant::now();
    let child = cmd.spawn()?;
    let deadline = started + Duration::from_secs(120);
    loop {
        if Instant::now() > deadline {
            anyhow::bail!(
                "runtime did not answer /health in 120 s; see {}",
                env.dir.join("runtime.log").display()
            );
        }
        if let Ok(res) = client.get(format!("{base}/health")).send().await {
            if res.status().is_success() {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let boot_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok((
        Runtime {
            child,
            base,
            port: env.port,
        },
        boot_ms,
    ))
}

async fn stop(mut runtime: Runtime) {
    if let Some(pid) = runtime.child.id() {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status()
            .await;
    }
    if tokio::time::timeout(Duration::from_secs(15), runtime.child.wait())
        .await
        .is_err()
    {
        let _ = runtime.child.kill().await;
    }
}

/// Resident set size of a process, in KiB.
pub fn rss_kb(pid: u32) -> u64 {
    std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// User plus system CPU time of a process, in milliseconds.
pub fn cpu_ms(pid: u32) -> f64 {
    if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        let fields: Vec<&str> = stat
            .rsplit(')')
            .next()
            .unwrap_or("")
            .split_whitespace()
            .collect();
        let ticks: f64 = fields.get(11).and_then(|v| v.parse().ok()).unwrap_or(0.0)
            + fields.get(12).and_then(|v| v.parse().ok()).unwrap_or(0.0);
        return ticks * 10.0;
    }
    let text = std::process::Command::new("ps")
        .args(["-o", "time=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    let mut total = 0.0;
    for part in text.trim().split(':') {
        total = total * 60.0 + part.parse::<f64>().unwrap_or(0.0);
    }
    total * 1000.0
}

pub async fn run(args: RunArgs) -> anyhow::Result<()> {
    let (mock_addr, mock_stats) = crate::mock_llm::serve(0).await?;
    let mock = format!("http://{mock_addr}");
    let dir =
        std::env::temp_dir().join(format!("prism-bench-{}-{}", args.name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let env = build_env(&mock, &dir);
    eprintln!("[{}] working dir {}", args.name, dir.display());

    if let Some(prepare) = &args.prepare {
        let parts: Vec<&str> = prepare.split_whitespace().collect();
        let mut cmd = Command::new(parts[0]);
        cmd.args(&parts[1..])
            .current_dir(&args.cwd)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (k, v) in &env.vars {
            cmd.env(k, v);
        }
        let status = cmd.status().await?;
        anyhow::ensure!(status.success(), "prepare command failed");
    }

    // The first boot creates the agent; the timed boots start on that database.
    let (first, first_ms) = start(&args, &env).await?;
    eprintln!("[{}] first boot {first_ms:.0} ms", args.name);
    stop(first).await;
    let mut boot_ms = Vec::new();
    for _ in 0..args.boots {
        let (rt, ms) = start(&args, &env).await?;
        boot_ms.push(ms);
        stop(rt).await;
    }
    eprintln!("[{}] boots {:?}", args.name, boot_ms);

    let (rt, _) = start(&args, &env).await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let idle_rss_kb = rss_kb(rt.pid());
    eprintln!("[{}] idle RSS {} KiB", args.name, idle_rss_kb);

    let scenarios = scenarios::run_all(&args, &env, &rt).await?;
    stop(rt).await;

    let result = RunResult {
        name: args.name.clone(),
        boot_ms,
        idle_rss_kb,
        binary_or_bundle: args.cmd.clone(),
        scenarios,
        mock_requests: mock_stats
            .requests
            .load(std::sync::atomic::Ordering::Relaxed),
    };
    std::fs::write(&args.out, serde_json::to_string_pretty(&result)?)?;
    eprintln!("[{}] wrote {}", args.name, args.out.display());
    Ok(())
}
