//! The benchmark scenarios. Each reports latency percentiles, throughput, the
//! runtime's CPU time and its peak resident memory while it ran.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use hdrhistogram::Histogram;
use serde::Serialize;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use crate::runtime::{Env, RunArgs, Runtime, cpu_ms, rss_kb};

#[derive(Serialize, Clone)]
pub struct ScenarioResult {
    pub name: String,
    pub description: String,
    pub operations: u64,
    pub errors: u64,
    pub seconds: f64,
    pub ops_per_sec: f64,
    pub p50_ms: f64,
    pub p90_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
    pub cpu_ms: f64,
    pub cpu_ms_per_op: f64,
    pub peak_rss_kb: u64,
}

struct Probe {
    pid: u32,
    stop: Arc<AtomicBool>,
    peak: Arc<AtomicU64>,
    cpu_start: f64,
    handle: tokio::task::JoinHandle<()>,
}

impl Probe {
    fn start(pid: u32) -> Probe {
        let stop = Arc::new(AtomicBool::new(false));
        let peak = Arc::new(AtomicU64::new(rss_kb(pid)));
        let (s, p) = (stop.clone(), peak.clone());
        let handle = tokio::spawn(async move {
            while !s.load(Ordering::Relaxed) {
                p.fetch_max(rss_kb(pid), Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        });
        Probe {
            pid,
            stop,
            peak,
            cpu_start: cpu_ms(pid),
            handle,
        }
    }

    async fn finish(self) -> (f64, u64) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.handle.await;
        self.peak.fetch_max(rss_kb(self.pid), Ordering::Relaxed);
        (
            cpu_ms(self.pid) - self.cpu_start,
            self.peak.load(Ordering::Relaxed),
        )
    }
}

fn histogram() -> Histogram<u64> {
    Histogram::new_with_bounds(1, 600_000_000, 3).expect("histogram")
}

fn result(
    name: &str,
    description: &str,
    h: &Histogram<u64>,
    errors: u64,
    seconds: f64,
    cpu: f64,
    peak: u64,
) -> ScenarioResult {
    let ms = |v: u64| v as f64 / 1000.0;
    let ops = h.len();
    ScenarioResult {
        name: name.into(),
        description: description.into(),
        operations: ops,
        errors,
        seconds,
        ops_per_sec: ops as f64 / seconds,
        p50_ms: ms(h.value_at_quantile(0.5)),
        p90_ms: ms(h.value_at_quantile(0.9)),
        p99_ms: ms(h.value_at_quantile(0.99)),
        max_ms: ms(h.max()),
        cpu_ms: cpu,
        cpu_ms_per_op: if ops > 0 { cpu / ops as f64 } else { 0.0 },
        peak_rss_kb: peak,
    }
}

/// `concurrency` clients repeating `GET path` for `duration` seconds.
async fn http_load(
    rt: &Runtime,
    args: &RunArgs,
    name: &str,
    description: &str,
    path: &str,
) -> ScenarioResult {
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(args.concurrency)
        .build()
        .unwrap();
    let url = format!("{}{}", rt.base, path);
    // Warm up connections and caches.
    for _ in 0..20 {
        let _ = client
            .get(&url)
            .send()
            .await
            .and_then(|r| r.error_for_status());
    }
    let probe = Probe::start(rt.pid());
    let deadline = Instant::now() + Duration::from_secs(args.duration);
    let started = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..args.concurrency {
        let (client, url) = (client.clone(), url.clone());
        tasks.push(tokio::spawn(async move {
            let mut h = histogram();
            let mut errors = 0u64;
            while Instant::now() < deadline {
                let t = Instant::now();
                match client.get(&url).send().await {
                    Ok(res) if res.status().is_success() => {
                        let _ = res.bytes().await;
                        h.record(t.elapsed().as_micros().max(1) as u64).ok();
                    }
                    _ => errors += 1,
                }
            }
            (h, errors)
        }));
    }
    let mut h = histogram();
    let mut errors = 0;
    for task in tasks {
        let (part, e) = task.await.unwrap();
        h.add(part).ok();
        errors += e;
    }
    let seconds = started.elapsed().as_secs_f64();
    let (cpu, peak) = probe.finish().await;
    result(name, description, &h, errors, seconds, cpu, peak)
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(port: u16) -> anyhow::Result<Socket> {
    let (mut ws, _) =
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/api/ws")).await?;
    let hello = json!({
        "type": "hello",
        "id": "h1",
        "payload": { "protocol": 2, "client": { "name": "prism-bench", "version": "1.0" } },
    });
    ws.send(Message::Text(hello.to_string().into())).await?;
    loop {
        let frame = ws
            .next()
            .await
            .ok_or_else(|| anyhow::anyhow!("socket closed before welcome"))??;
        if let Message::Close(close) = &frame {
            anyhow::bail!("closed before welcome: {close:?}");
        }
        if let Message::Text(text) = frame {
            let value: Value = serde_json::from_str(&text)?;
            if value["type"] == "welcome" {
                return Ok(ws);
            }
            if value["type"] == "nack" {
                anyhow::bail!("hello refused: {text}");
            }
        }
    }
}

/// Clients opening a socket, completing the handshake and closing it, a fixed number
/// of times each. Half the gateway's 16 connections, so a socket still closing never
/// counts toward the limit, and a fixed count, so a fast build does not run the
/// client out of local ports.
const HANDSHAKE_CLIENTS: usize = 8;
const HANDSHAKES_PER_CLIENT: usize = 500;

async fn ws_handshakes(rt: &Runtime, _args: &RunArgs) -> ScenarioResult {
    let probe = Probe::start(rt.pid());
    let started = Instant::now();
    let mut tasks = Vec::new();
    for _ in 0..HANDSHAKE_CLIENTS {
        let port = rt.port;
        tasks.push(tokio::spawn(async move {
            let mut h = histogram();
            let mut errors = 0u64;
            for _ in 0..HANDSHAKES_PER_CLIENT {
                let t = Instant::now();
                match connect(port).await {
                    Ok(mut ws) => {
                        h.record(t.elapsed().as_micros().max(1) as u64).ok();
                        let _ = ws.close(None).await;
                    }
                    Err(e) => {
                        if errors == 0 {
                            eprintln!("ws_handshake: {e}");
                        }
                        errors += 1;
                    }
                }
            }
            (h, errors)
        }));
    }
    let mut h = histogram();
    let mut errors = 0;
    for task in tasks {
        let (part, e) = task.await.unwrap();
        h.add(part).ok();
        errors += e;
    }
    let seconds = started.elapsed().as_secs_f64();
    let (cpu, peak) = probe.finish().await;
    result(
        "ws_handshake",
        "Open /api/ws, hello → welcome, close (8 clients, 500 each)",
        &h,
        errors,
        seconds,
        cpu,
        peak,
    )
}

async fn create_thread(client: &reqwest::Client, rt: &Runtime) -> anyhow::Result<String> {
    let res: Value = client
        .post(format!("{}/threads", rt.base))
        .json(&json!({}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(res["threadId"].as_str().unwrap_or_default().to_string())
}

/// Sends one message and waits for its conversation to go idle, and answers how long
/// that took from the accepted send. A send the gateway's rate limit refuses is sent
/// again after the `retryAfterMs` it names, as a client does, so the scenario measures
/// the turn and not the limit.
async fn turn(ws: &mut Socket, thread_id: &str, content: &str) -> anyhow::Result<Duration> {
    let message_id = uuid::Uuid::new_v4().to_string();
    let deadline = Instant::now() + Duration::from_secs(120);
    'attempt: loop {
        let request_id = uuid::Uuid::new_v4().to_string();
        let frame = json!({
            "type": "send",
            "id": request_id,
            "payload": { "message": { "id": message_id, "threadId": thread_id, "content": content, "attachmentIds": [] } },
        });
        let started = Instant::now();
        ws.send(Message::Text(frame.to_string().into())).await?;
        let mut acked = false;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let frame = tokio::time::timeout(remaining, ws.next())
                .await
                .map_err(|_| anyhow::anyhow!("turn timed out"))?
                .ok_or_else(|| anyhow::anyhow!("socket closed"))??;
            let Message::Text(text) = frame else { continue };
            let value: Value = serde_json::from_str(&text)?;
            match value["type"].as_str() {
                Some("nack") if value["re"] == request_id.as_str() => {
                    if value["payload"]["code"] == "rate_limited" {
                        let wait = value["payload"]["retryAfterMs"].as_u64().unwrap_or(100);
                        tokio::time::sleep(Duration::from_millis(wait + 1)).await;
                        continue 'attempt;
                    }
                    anyhow::bail!("send refused: {text}")
                }
                Some("ack") if value["re"] == request_id.as_str() => acked = true,
                Some("turn")
                    if acked
                        && value["payload"]["threadId"] == thread_id
                        && value["payload"]["state"] == "idle" =>
                {
                    if value["payload"]["outcome"] == "failed" {
                        anyhow::bail!("turn failed: {text}");
                    }
                    return Ok(started.elapsed());
                }
                _ => {}
            }
        }
    }
}

async fn turns(
    rt: &Runtime,
    args: &RunArgs,
    name: &str,
    description: &str,
    content: &str,
    thread: Option<&str>,
    count: usize,
) -> anyhow::Result<ScenarioResult> {
    let client = reqwest::Client::new();
    let mut threads = Vec::new();
    for _ in 0..count {
        threads.push(match thread {
            Some(t) => t.to_string(),
            None => create_thread(&client, rt).await?,
        });
    }
    let mut ws = connect(rt.port).await?;
    // One warm-up turn outside the measurement.
    let warm = create_thread(&client, rt).await?;
    turn(&mut ws, &warm, content).await?;
    let probe = Probe::start(rt.pid());
    let started = Instant::now();
    let mut h = histogram();
    let mut errors = 0;
    for thread_id in &threads {
        match turn(&mut ws, thread_id, content).await {
            Ok(took) => {
                h.record(took.as_micros().max(1) as u64).ok();
            }
            Err(e) => {
                errors += 1;
                eprintln!("[{}] {name}: {e}", args.name);
            }
        }
    }
    let seconds = started.elapsed().as_secs_f64();
    let (cpu, peak) = probe.finish().await;
    Ok(result(name, description, &h, errors, seconds, cpu, peak))
}

/// Inserts `count` alternating user and agent messages into a new thread.
fn seed_history(env: &Env, thread_id: &str, count: usize) -> anyhow::Result<()> {
    let conn = rusqlite::Connection::open(&env.db)?;
    conn.busy_timeout(Duration::from_secs(10))?;
    let tx = conn.unchecked_transaction()?;
    let base = 1_700_000_000_000i64;
    let filler = "The quick brown fox jumps over the lazy dog while the agent reviews the deployment notes. ".repeat(4);
    for i in 0..count {
        let role = if i % 2 == 0 { "USER" } else { "AGENT" };
        tx.execute(
            "INSERT INTO conversation_messages (id, threadId, role, content, triggeredBy, isCompacted, internalStep, createdAt) VALUES (?1, ?2, ?3, ?4, 'USER_INPUT', 0, 0, ?5)",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), thread_id, role, format!("{i}: {filler}"), base + i as i64],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub async fn run_all(
    args: &RunArgs,
    env: &Env,
    rt: &Runtime,
) -> anyhow::Result<Vec<ScenarioResult>> {
    let client = reqwest::Client::new();
    let mut out = Vec::new();

    // Thread creation, sequential.
    {
        let probe = Probe::start(rt.pid());
        let started = Instant::now();
        let mut h = histogram();
        let mut errors = 0;
        for _ in 0..200 {
            let t = Instant::now();
            match create_thread(&client, rt).await {
                Ok(_) => {
                    h.record(t.elapsed().as_micros().max(1) as u64).ok();
                }
                Err(_) => errors += 1,
            }
        }
        let seconds = started.elapsed().as_secs_f64();
        let (cpu, peak) = probe.finish().await;
        out.push(result(
            "thread_create",
            "POST /threads, sequential, 200 threads",
            &h,
            errors,
            seconds,
            cpu,
            peak,
        ));
    }

    let history_thread = create_thread(&client, rt).await?;
    seed_history(env, &history_thread, 400)?;

    out.push(http_load(rt, args, "http_health", "GET /health", "/health").await);
    out.push(http_load(rt, args, "http_agent_me", "GET /agents/me", "/agents/me").await);
    out.push(
        http_load(
            rt,
            args,
            "http_threads",
            "GET /threads (200 threads)",
            "/threads",
        )
        .await,
    );
    out.push(
        http_load(
            rt,
            args,
            "http_messages",
            "GET /messages, newest 200 of a 400-message thread",
            &format!("/messages?threadId={history_thread}&limit=200"),
        )
        .await,
    );
    out.push(ws_handshakes(rt, args).await);
    out.push(
        turns(
            rt,
            args,
            "chat_turn",
            "Chat turn over /api/ws on a new thread, text reply",
            "hello",
            None,
            args.turns,
        )
        .await?,
    );
    out.push(
        turns(
            rt,
            args,
            "tool_turn",
            "Chat turn with one tool call (list_scheduled_tasks) then a text reply",
            "BENCH_TOOL please",
            None,
            args.turns / 2,
        )
        .await?,
    );
    out.push(
        turns(
            rt,
            args,
            "long_history_turn",
            "Chat turn on a thread holding 400+ messages",
            "hello again",
            Some(&history_thread),
            (args.turns / 4).max(5),
        )
        .await?,
    );
    Ok(out)
}
