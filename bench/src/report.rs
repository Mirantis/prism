//! A Markdown comparison of result files.

use std::path::PathBuf;

use serde_json::Value;

/// The value at fraction `p` of the sorted values (0.5 the median, 0.99 the 99th percentile).
pub fn percentile(values: &[f64], p: f64) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        return 0.0;
    }
    v[((v.len() - 1) as f64 * p).round() as usize]
}

fn median(values: &[f64]) -> f64 {
    percentile(values, 0.5)
}

/// The result files, and each one's build name.
pub fn load(files: &[PathBuf]) -> anyhow::Result<(Vec<Value>, Vec<String>)> {
    let runs: Vec<Value> = files
        .iter()
        .map(|f| Ok(serde_json::from_str(&std::fs::read_to_string(f)?)?))
        .collect::<anyhow::Result<_>>()?;
    let names = runs
        .iter()
        .map(|r| r["name"].as_str().unwrap_or("?").to_string())
        .collect();
    Ok((runs, names))
}

pub fn print(files: &[PathBuf]) -> anyhow::Result<()> {
    let (runs, names) = load(files)?;

    println!("| Metric | {} |", names.join(" | "));
    println!(
        "|---|{}|",
        names.iter().map(|_| "---:").collect::<Vec<_>>().join("|")
    );
    let boots: Vec<String> = runs
        .iter()
        .map(|r| {
            let v: Vec<f64> = r["boot_ms"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default();
            format!("{:.0} ms", median(&v))
        })
        .collect();
    println!(
        "| Boot to first `/health` (median) | {} |",
        boots.join(" | ")
    );
    let rss: Vec<String> = runs
        .iter()
        .map(|r| {
            format!(
                "{:.1} MiB",
                r["idle_rss_kb"].as_f64().unwrap_or(0.0) / 1024.0
            )
        })
        .collect();
    println!("| Idle memory (RSS) | {} |", rss.join(" | "));
    println!();

    let scenario_names: Vec<String> = runs[0]["scenarios"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s["name"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    println!("| Scenario | Metric | {} |", names.join(" | "));
    println!(
        "|---|---|{}|",
        names.iter().map(|_| "---:").collect::<Vec<_>>().join("|")
    );
    for scenario in &scenario_names {
        let rows: Vec<Option<&Value>> = runs
            .iter()
            .map(|r| {
                r["scenarios"]
                    .as_array()
                    .and_then(|a| a.iter().find(|s| s["name"] == scenario.as_str()))
            })
            .collect();
        let description = rows
            .iter()
            .flatten()
            .next()
            .and_then(|s| s["description"].as_str())
            .unwrap_or("");
        let cell = |f: &dyn Fn(&Value) -> String| -> String {
            rows.iter()
                .map(|r| r.map(f).unwrap_or_else(|| "—".into()))
                .collect::<Vec<_>>()
                .join(" | ")
        };
        println!(
            "| {description} | throughput | {} |",
            cell(&|s| format!("{:.0}/s", s["ops_per_sec"].as_f64().unwrap_or(0.0)))
        );
        println!(
            "| | p50 / p99 latency | {} |",
            cell(&|s| format!(
                "{:.2} / {:.2} ms",
                s["p50_ms"].as_f64().unwrap_or(0.0),
                s["p99_ms"].as_f64().unwrap_or(0.0)
            ))
        );
        println!(
            "| | CPU per operation | {} |",
            cell(&|s| format!("{:.3} ms", s["cpu_ms_per_op"].as_f64().unwrap_or(0.0)))
        );
        println!(
            "| | peak memory | {} |",
            cell(&|s| format!(
                "{:.1} MiB",
                s["peak_rss_kb"].as_f64().unwrap_or(0.0) / 1024.0
            ))
        );
        let errors: u64 = rows
            .iter()
            .flatten()
            .map(|s| s["errors"].as_u64().unwrap_or(0))
            .sum();
        if errors > 0 {
            println!(
                "| | errors | {} |",
                cell(&|s| s["errors"].as_u64().unwrap_or(0).to_string())
            );
        }
    }
    Ok(())
}
