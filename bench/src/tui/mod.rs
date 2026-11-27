//! Terminal UI benchmarks: the same scenarios against any build of `prism`.
//!
//! `prism-bench tui --name rust --cmd cli/target/release/prism --out rust.json`
//! runs each scenario against a fake runtime, with the TUI under a real
//! pseudo-terminal, and records start-up time, memory, CPU time, the bytes the
//! TUI writes to the terminal, keystroke echo latency and message throughput.
//! `prism-bench tui-report a.json b.json` prints a Markdown comparison.

mod fake_runtime;
mod pty;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use self::fake_runtime::{FakeRuntime, THREAD_ID, message};
use self::pty::Tui;
use crate::report::{load, percentile};

const COLS: u16 = 120;
const ROWS: u16 = 40;
const BOOT_TIMEOUT: Duration = Duration::from_secs(30);
/// The header's text, drawn in the first frame.
const BOOTED: &str = "ctrl+c to exit";

#[derive(clap::Args, Clone)]
pub struct TuiArgs {
    /// A label for this build, e.g. `ink` or `rust`.
    #[arg(long)]
    pub name: String,
    /// The command that starts the TUI, split on spaces.
    #[arg(long)]
    pub cmd: String,
    /// How many start-ups to time.
    #[arg(long, default_value_t = 10)]
    pub runs: usize,
    /// Messages in the conversation the long-session scenarios open.
    #[arg(long, default_value_t = 50)]
    pub history: usize,
    /// Seconds the spinner scenario measures.
    #[arg(long, default_value_t = 10)]
    pub spinner_secs: u64,
    /// Where to write the JSON results.
    #[arg(long)]
    pub out: PathBuf,
}

#[derive(Serialize, Default)]
pub struct TuiResult {
    pub name: String,
    pub binary_bytes: u64,
    pub startup_ms: Vec<f64>,
    pub idle_rss_kb: u64,
    pub idle_cpu_ms_per_s: f64,
    pub history_ms: Vec<f64>,
    pub history_rss_kb: u64,
    pub key_echo_ms: Vec<f64>,
    pub key_bytes: f64,
    pub spinner_bytes_per_s: f64,
    pub spinner_cpu_ms_per_s: f64,
    pub spinner_rss_kb: u64,
    pub stream_messages: usize,
    pub stream_ms: f64,
    pub stream_cpu_ms: f64,
    pub stream_bytes: f64,
}

/// A message of the kind an agent writes: a heading, prose, a list, a code block and a table.
fn agent_markdown(i: usize, marker: &str) -> String {
    format!(
        "## Step {i}: checking the deployment\n\n\
         The rollout of **service-{i}** finished on the staging cluster, and the health checks \
         pass on every replica. Two follow-ups are left before production, listed below.\n\n\
         - Rotate the `api-token` secret, which expires in 3 days\n\
         - Raise the memory limit of the worker pool from 512Mi to 1Gi\n\
         - Re-run the smoke tests against the new ingress\n\n\
         ```bash\nkubectl -n staging rollout status deploy/service-{i}\nkubectl -n staging get pods -l app=service-{i}\n```\n\n\
         | Replica | Status | Restarts |\n|---|---|---|\n| service-{i}-a | Running | 0 |\n| service-{i}-b | Running | 1 |\n\n\
         {marker}"
    )
}

fn history(count: usize) -> Vec<Value> {
    (0..count)
        .map(|i| {
            let at = format!("2026-11-27T10:{:02}:{:02}.000Z", i / 60, i % 60);
            if i % 2 == 0 {
                message(
                    &format!("h-{i}"),
                    "USER",
                    &format!("Check deployment {i} please. HISTORY-{i}"),
                    &at,
                )
            } else {
                message(
                    &format!("h-{i}"),
                    "AGENT",
                    &agent_markdown(i, &format!("HISTORY-{i}")),
                    &at,
                )
            }
        })
        .collect()
}

fn env_for(runtime: &FakeRuntime, home: &std::path::Path) -> Vec<(String, String)> {
    vec![
        ("PRISM_HTTP_URL".into(), runtime.url()),
        ("HOME".into(), home.display().to_string()),
        ("NO_COLOR".into(), String::new()),
    ]
}

fn boot(
    cmd: &str,
    runtime: &FakeRuntime,
    home: &std::path::Path,
) -> anyhow::Result<(Tui, Duration)> {
    let start = Instant::now();
    let tui = Tui::spawn(cmd, COLS, ROWS, &env_for(runtime, home))?;
    tui.wait_for(BOOTED, 0, BOOT_TIMEOUT)
        .ok_or_else(|| anyhow::anyhow!("no first frame from `{cmd}`"))?;
    Ok((tui, start.elapsed()))
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

pub async fn run(args: TuiArgs) -> anyhow::Result<()> {
    let home = std::env::temp_dir().join(format!("prism-tui-bench-{}", std::process::id()));
    std::fs::create_dir_all(&home)?;
    let binary = args
        .cmd
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string();
    let mut result = TuiResult {
        name: args.name.clone(),
        binary_bytes: std::fs::metadata(&binary).map(|m| m.len()).unwrap_or(0),
        ..TuiResult::default()
    };
    let cmd = args.cmd.clone();

    // Start-up to the first frame, and idle cost.
    let multi = FakeRuntime::start(false, Vec::new()).await?;
    for run in 0..args.runs {
        let (tui, took) = boot(&cmd, &multi, &home)?;
        result.startup_ms.push(ms(took));
        if run == 0 {
            std::thread::sleep(Duration::from_secs(2));
            let before = tui.usage();
            std::thread::sleep(Duration::from_secs(5));
            let after = tui.usage();
            result.idle_rss_kb = after.rss_kb;
            result.idle_cpu_ms_per_s = (after.cpu_ms - before.cpu_ms) / 5.0;
        }
        tui.kill();
    }
    eprintln!("[{}] startup done", args.name);

    // Typing: each key until its echo is on screen.
    {
        let (mut tui, _) = boot(&cmd, &multi, &home)?;
        std::thread::sleep(Duration::from_millis(1500));
        let typed = "the quick brown fox jumps over the lazy dog and keeps running";
        let bytes_before = tui.bytes();
        let mut value = String::new();
        for c in typed.chars() {
            value.push(c);
            let from = tui.text_len();
            tui.send(&c.to_string());
            let needle = format!("› {value}");
            let took = tui
                .wait_for(&needle, from, Duration::from_secs(5))
                .ok_or_else(|| anyhow::anyhow!("no echo"))?;
            result.key_echo_ms.push(ms(took));
        }
        result.key_bytes = (tui.bytes() - bytes_before) as f64 / typed.len() as f64;
        tui.kill();
    }
    eprintln!("[{}] typing done", args.name);

    // A long conversation: open it, keep a turn running, then stream replies into it.
    let messages = history(args.history);
    let last = format!("HISTORY-{}", args.history - 1);
    let single = FakeRuntime::start(true, messages).await?;
    for _ in 0..3 {
        let start = Instant::now();
        let tui = Tui::spawn(&cmd, COLS, ROWS, &env_for(&single, &home))?;
        tui.wait_for(&last, 0, BOOT_TIMEOUT)
            .ok_or_else(|| anyhow::anyhow!("history never shown"))?;
        result.history_ms.push(ms(start.elapsed()));
        tui.kill();
    }
    {
        let tui = Tui::spawn(&cmd, COLS, ROWS, &env_for(&single, &home))?;
        tui.wait_for(&last, 0, BOOT_TIMEOUT)
            .ok_or_else(|| anyhow::anyhow!("history never shown"))?;
        std::thread::sleep(Duration::from_secs(2));
        result.history_rss_kb = tui.usage().rss_kb;

        single.turn("running");
        std::thread::sleep(Duration::from_millis(500));
        let (bytes, usage) = (tui.bytes(), tui.usage());
        std::thread::sleep(Duration::from_secs(args.spinner_secs));
        let after = tui.usage();
        let secs = args.spinner_secs as f64;
        result.spinner_bytes_per_s = (tui.bytes() - bytes) as f64 / secs;
        result.spinner_cpu_ms_per_s = (after.cpu_ms - usage.cpu_ms) / secs;
        result.spinner_rss_kb = after.rss_kb;
        single.turn("idle");
        std::thread::sleep(Duration::from_millis(500));

        let count = 100;
        let (bytes, usage, from) = (tui.bytes(), tui.usage(), tui.text_len());
        let start = Instant::now();
        for i in 0..count {
            let at = format!("2026-11-27T11:{:02}:{:02}.000Z", i / 60, i % 60);
            let body = agent_markdown(1000 + i, &format!("STREAM-{i}"));
            single.push("message", message(&format!("s-{i}"), "AGENT", &body, &at));
        }
        let took = tui
            .wait_for(
                &format!("STREAM-{}", count - 1),
                from,
                Duration::from_secs(120),
            )
            .ok_or_else(|| anyhow::anyhow!("streamed messages never shown"))?;
        let _ = start;
        std::thread::sleep(Duration::from_millis(300));
        result.stream_messages = count;
        result.stream_ms = ms(took);
        result.stream_cpu_ms = tui.usage().cpu_ms - usage.cpu_ms;
        result.stream_bytes = (tui.bytes() - bytes) as f64;
        tui.kill();
    }
    let _ = THREAD_ID;
    eprintln!("[{}] long session done", args.name);

    std::fs::write(&args.out, serde_json::to_string_pretty(&result)?)?;
    let _ = std::fs::remove_dir_all(&home);
    Ok(())
}

/// A Markdown table comparing result files, with each build against the first.
pub fn report(files: &[PathBuf]) -> anyhow::Result<()> {
    let (runs, names) = load(files)?;
    let num = |r: &Value, k: &str| r[k].as_f64().unwrap_or(0.0);
    let list = |r: &Value, k: &str| -> Vec<f64> {
        r[k].as_array()
            .map(|a| a.iter().filter_map(Value::as_f64).collect())
            .unwrap_or_default()
    };
    type Row = (
        &'static str,
        Box<dyn Fn(&Value) -> f64>,
        Box<dyn Fn(f64) -> String>,
    );
    let mib = |v: f64| format!("{:.1} MiB", v / 1024.0);
    let rows: Vec<Row> = vec![
        (
            "Binary size",
            Box::new(move |r| num(r, "binary_bytes")),
            Box::new(|v| format!("{:.1} MiB", v / 1024.0 / 1024.0)),
        ),
        (
            "Start-up to first frame (median)",
            Box::new(move |r| percentile(&list(r, "startup_ms"), 0.5)),
            Box::new(|v| format!("{v:.0} ms")),
        ),
        (
            "Memory when idle (RSS)",
            Box::new(move |r| num(r, "idle_rss_kb")),
            Box::new(mib),
        ),
        (
            "CPU when idle",
            Box::new(move |r| num(r, "idle_cpu_ms_per_s")),
            Box::new(|v| format!("{v:.2} ms/s")),
        ),
        (
            "Keystroke to echo (p50)",
            Box::new(move |r| percentile(&list(r, "key_echo_ms"), 0.5)),
            Box::new(|v| format!("{v:.2} ms")),
        ),
        (
            "Keystroke to echo (p99)",
            Box::new(move |r| percentile(&list(r, "key_echo_ms"), 0.99)),
            Box::new(|v| format!("{v:.2} ms")),
        ),
        (
            "Bytes written per keystroke",
            Box::new(move |r| num(r, "key_bytes")),
            Box::new(|v| format!("{v:.0} B")),
        ),
        (
            "Open a 50-message conversation (median)",
            Box::new(move |r| percentile(&list(r, "history_ms"), 0.5)),
            Box::new(|v| format!("{v:.0} ms")),
        ),
        (
            "Memory with that conversation open",
            Box::new(move |r| num(r, "history_rss_kb")),
            Box::new(mib),
        ),
        (
            "Spinner over it: bytes written",
            Box::new(move |r| num(r, "spinner_bytes_per_s")),
            Box::new(|v| format!("{:.1} KiB/s", v / 1024.0)),
        ),
        (
            "Spinner over it: CPU",
            Box::new(move |r| num(r, "spinner_cpu_ms_per_s")),
            Box::new(|v| format!("{v:.1} ms/s")),
        ),
        (
            "100 replies arriving: time to show the last",
            Box::new(move |r| num(r, "stream_ms")),
            Box::new(|v| format!("{v:.0} ms")),
        ),
        (
            "100 replies arriving: CPU",
            Box::new(move |r| num(r, "stream_cpu_ms")),
            Box::new(|v| format!("{v:.0} ms")),
        ),
        (
            "100 replies arriving: bytes written",
            Box::new(move |r| num(r, "stream_bytes")),
            Box::new(|v| format!("{:.1} MiB", v / 1024.0 / 1024.0)),
        ),
    ];
    let compare = runs.len() == 2;
    println!(
        "| Metric | {}{} |",
        names.join(" | "),
        if compare { " | Change" } else { "" }
    );
    println!(
        "|---|{}{}|",
        names.iter().map(|_| "---:").collect::<Vec<_>>().join("|"),
        if compare { "|---:" } else { "" }
    );
    for (label, value, show) in &rows {
        let values: Vec<f64> = runs.iter().map(|r| value(r)).collect();
        let cells: Vec<String> = values.iter().map(|v| show(*v)).collect();
        let change = if compare && values[0] > 0.0 && values[1] > 0.0 {
            let ratio = values[0] / values[1];
            if ratio >= 1.0 {
                format!(" | {ratio:.1}× less")
            } else {
                format!(" | {:.1}× more", 1.0 / ratio)
            }
        } else if compare {
            " | —".to_string()
        } else {
            String::new()
        };
        println!("| {label} | {}{change} |", cells.join(" | "));
    }
    Ok(())
}
