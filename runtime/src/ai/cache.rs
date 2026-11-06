//! The E2E LLM cache: a model call whose options match a recorded one gets the
//! recorded response, and any other call goes to the model and is recorded.
//!
//! Keys, file layout and entries are those of the `agentic-evals` cache middleware,
//! so a recording made by either runtime replays in the other. A key is the SHA-256
//! of the call options as JSON, without the abort signal and the headers, with
//! object keys sorted and bytes as base64, after each variable's matches are
//! replaced by numbered placeholders. An entry is `<dir>/<provider>/<model>/<key>.json`.
//!
//! The cache is on when `PRISM_LLM_CACHE_DIR` is set. `AGENTIC_EVALS_CACHE_MODE` is
//! `record` (the default), `replay` or `off`; `PRISM_LLM_CACHE_VARIABLES` is a JSON
//! object of variable name to regular expression source; and with
//! `PRISM_LLM_CACHE_STATS_DIR` set, the hit and miss counts are written to
//! `<dir>/<pid>.json` whenever they change, at most once a second.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::json::{js_stringify, js_stringify_pretty, js_stringify_sorted};
use super::model::{
    LanguageModel, LanguageModelMiddleware, WrapLanguageModelOptions, wrap_language_model,
};
use super::provider::{LanguageModelV4CallOptions, LanguageModelV4GenerateResult};

const DEFAULT_MAX_SIZE: u64 = 10 * 1024 * 1024;

/// What the cache does with a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheMode {
    /// Answer from the cache, and record a miss.
    Record,
    /// Answer from the cache; a miss is an error.
    Replay,
    /// Call the model every time.
    Off,
}

/// The cache's counts in this process.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub saved_ms: i64,
}

impl CacheStats {
    fn to_json(self) -> String {
        js_stringify(&json!({ "hits": self.hits, "misses": self.misses, "savedMs": self.saved_ms }))
    }
}

static STATS: Mutex<CacheStats> = Mutex::new(CacheStats {
    hits: 0,
    misses: 0,
    saved_ms: 0,
});

/// `cacheStats()`.
pub fn cache_stats() -> CacheStats {
    *STATS.lock()
}

/// A named pattern whose matches a key leaves out.
pub struct CacheVariable {
    pub name: String,
    pub pattern: fancy_regex::Regex,
}

/// A JavaScript regular expression source in the syntax `fancy_regex` reads: `\d`
/// and `\w` stay ASCII, and `\/` is a slash.
pub fn js_regex_source(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('d') => out.push_str(if in_class { "0-9" } else { "[0-9]" }),
                Some('D') if !in_class => out.push_str("[^0-9]"),
                Some('w') => out.push_str(if in_class {
                    "A-Za-z0-9_"
                } else {
                    "[A-Za-z0-9_]"
                }),
                Some('W') if !in_class => out.push_str("[^A-Za-z0-9_]"),
                Some('/') => out.push('/'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            },
            '[' if !in_class => {
                in_class = true;
                out.push(c);
                if chars.peek() == Some(&'^') {
                    out.push(chars.next().unwrap_or('^'));
                }
                if chars.peek() == Some(&']') {
                    out.push_str("\\]");
                    chars.next();
                }
            }
            '[' | '&' | '~' if in_class => {
                out.push('\\');
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Parses `PRISM_LLM_CACHE_VARIABLES`.
pub fn parse_variables(text: &str) -> anyhow::Result<Vec<CacheVariable>> {
    let value: Value = serde_json::from_str(text)?;
    let Value::Object(map) = value else {
        anyhow::bail!("PRISM_LLM_CACHE_VARIABLES must be a JSON object");
    };
    map.into_iter()
        .map(|(name, source)| {
            let source = source
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("variable {name} is not a string"))?
                .to_string();
            let pattern = fancy_regex::Regex::new(&js_regex_source(&source))?;
            Ok(CacheVariable { name, pattern })
        })
        .collect()
}

/// The values the variables matched, each with its placeholder, in order of first
/// appearance.
pub type Bindings = Vec<(String, String)>;

/// `bindVariables`: every match of each variable replaced by `«name:n»`, the same
/// value by the same placeholder.
pub fn bind_variables(json: &str, variables: &[CacheVariable]) -> (String, Bindings) {
    let mut bindings: Bindings = Vec::new();
    let mut text = json.to_string();
    for variable in variables {
        let mut count = 0;
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        let mut position = 0;
        while position <= text.len() {
            let Ok(Some(found)) = variable.pattern.find_from_pos(&text, position) else {
                break;
            };
            let value = found.as_str().to_string();
            let placeholder = match bindings.iter().find(|(v, _)| *v == value) {
                Some((_, p)) => p.clone(),
                None => {
                    count += 1;
                    let p = format!("«{}:{}»", variable.name, count);
                    bindings.push((value.clone(), p.clone()));
                    p
                }
            };
            out.push_str(&text[last..found.start()]);
            out.push_str(&placeholder);
            last = found.end();
            position = if found.end() == found.start() {
                match text[found.end()..].chars().next() {
                    Some(c) => found.end() + c.len_utf8(),
                    None => text.len() + 1,
                }
            } else {
                found.end()
            };
        }
        out.push_str(&text[last..]);
        text = out;
    }
    (text, bindings)
}

/// `toPlaceholders`: each bound value replaced by its placeholder, longest first.
pub fn to_placeholders(json: &str, bindings: &Bindings) -> String {
    let mut longest_first: Vec<&(String, String)> = bindings.iter().collect();
    longest_first
        .sort_by(|a, b| crate::support::js::len16(&b.0).cmp(&crate::support::js::len16(&a.0)));
    longest_first
        .into_iter()
        .fold(json.to_string(), |text, (value, placeholder)| {
            text.replace(value, placeholder)
        })
}

/// `fromPlaceholders`: each placeholder replaced by its value.
pub fn from_placeholders(json: &str, bindings: &Bindings) -> String {
    bindings
        .iter()
        .fold(json.to_string(), |text, (value, placeholder)| {
            text.replace(placeholder, value)
        })
}

/// `callKey`: the key of a call and the variables bound in it.
pub fn call_key(
    params: &LanguageModelV4CallOptions,
    variables: &[CacheVariable],
) -> anyhow::Result<(String, Bindings)> {
    let mut value = serde_json::to_value(params)?;
    if let Value::Object(map) = &mut value {
        map.remove("headers");
        map.remove("abortSignal");
    }
    let json = js_stringify_sorted(&value);
    let (bound, bindings) = bind_variables(&json, variables);
    let key = hex::encode(Sha256::digest(bound.as_bytes()));
    Ok((key, bindings))
}

/// `toStored`: the result without the request, with the response reduced to its
/// id, timestamp and model id.
fn to_stored(result: &LanguageModelV4GenerateResult) -> anyhow::Result<Value> {
    let Value::Object(map) = serde_json::to_value(result)? else {
        anyhow::bail!("a generate result is an object");
    };
    let mut stored = Map::new();
    let mut response = None;
    for (key, value) in map {
        match key.as_str() {
            "request" => {}
            "response" => response = Some(value),
            _ => {
                stored.insert(key, value);
            }
        }
    }
    if let Some(Value::Object(response)) = response {
        let mut reduced = Map::new();
        for key in ["id", "timestamp", "modelId"] {
            if let Some(v) = response.get(key) {
                reduced.insert(key.to_string(), v.clone());
            }
        }
        stored.insert("response".to_string(), Value::Object(reduced));
    }
    Ok(Value::Object(stored))
}

fn replay(stored: &Value, bindings: &Bindings) -> anyhow::Result<LanguageModelV4GenerateResult> {
    let text = from_placeholders(&js_stringify(stored), bindings);
    Ok(serde_json::from_str(&text)?)
}

/// Provider and model ids as directory names.
fn path_segment(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// A directory of JSON files, one per entry, named by key. A write goes to a
/// temporary file that is renamed into place. Past `max_size`, the oldest entries
/// are removed.
pub struct FileCache {
    dir: PathBuf,
    max_size: u64,
    size: tokio::sync::Mutex<Option<u64>>,
}

impl FileCache {
    pub fn new(dir: PathBuf, max_size: u64) -> Self {
        Self {
            dir,
            max_size,
            size: tokio::sync::Mutex::new(None),
        }
    }

    fn file(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }

    pub async fn get(&self, key: &str) -> anyhow::Result<Option<Value>> {
        match tokio::fs::read_to_string(self.file(key)).await {
            Ok(text) => Ok(Some(serde_json::from_str(&text)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn set(&self, key: &str, entry: &Value) -> anyhow::Result<()> {
        let json = format!("{}\n", js_stringify_pretty(entry));
        tokio::fs::create_dir_all(&self.dir).await?;
        let mut size = self.size.lock().await;
        if size.is_none() {
            *size = Some(self.measure().await?);
        }
        let temporary = self
            .dir
            .join(format!(".{}.{}.tmp", key, uuid::Uuid::new_v4()));
        tokio::fs::write(&temporary, json.as_bytes()).await?;
        tokio::fs::rename(&temporary, self.file(key)).await?;
        let total = size.unwrap_or(0) + json.len() as u64;
        *size = Some(total);
        if total > self.max_size {
            *size = Some(self.prune().await?);
        }
        Ok(())
    }

    async fn entry_files(&self) -> anyhow::Result<Vec<PathBuf>> {
        let mut files = Vec::new();
        let mut dir = tokio::fs::read_dir(&self.dir).await?;
        while let Some(entry) = dir.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") {
                files.push(entry.path());
            }
        }
        Ok(files)
    }

    async fn measure(&self) -> anyhow::Result<u64> {
        let mut size = 0;
        for file in self.entry_files().await? {
            size += tokio::fs::metadata(&file)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
        }
        Ok(size)
    }

    async fn prune(&self) -> anyhow::Result<u64> {
        let mut entries: Vec<(PathBuf, u64, f64)> = Vec::new();
        for file in self.entry_files().await? {
            let Ok(meta) = tokio::fs::metadata(&file).await else {
                continue;
            };
            let Ok(text) = tokio::fs::read_to_string(&file).await else {
                continue;
            };
            let timestamp = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("timestamp").and_then(Value::as_f64))
                .unwrap_or(0.0);
            entries.push((file, meta.len(), timestamp));
        }
        entries.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
        let mut size: u64 = entries.iter().map(|e| e.1).sum();
        for (file, len, _) in entries {
            if size <= self.max_size {
                break;
            }
            let _ = tokio::fs::remove_file(&file).await;
            size -= len;
        }
        Ok(size)
    }
}

/// The cache middleware (`createCacheMiddleware`).
pub struct CacheMiddleware {
    cache_dir: PathBuf,
    mode: CacheMode,
    max_size: u64,
    variables: Vec<CacheVariable>,
    caches: Mutex<HashMap<PathBuf, Arc<FileCache>>>,
}

impl CacheMiddleware {
    pub fn new(cache_dir: PathBuf, mode: CacheMode, variables: Vec<CacheVariable>) -> Self {
        Self {
            cache_dir,
            mode,
            max_size: DEFAULT_MAX_SIZE,
            variables,
            caches: Mutex::new(HashMap::new()),
        }
    }

    fn cache_for(&self, model: &dyn LanguageModel) -> Arc<FileCache> {
        let dir = self
            .cache_dir
            .join(path_segment(model.provider()))
            .join(path_segment(model.model_id()));
        self.caches
            .lock()
            .entry(dir.clone())
            .or_insert_with(|| Arc::new(FileCache::new(dir, self.max_size)))
            .clone()
    }
}

#[async_trait]
impl LanguageModelMiddleware for CacheMiddleware {
    async fn wrap_generate(
        &self,
        params: LanguageModelV4CallOptions,
        model: &Arc<dyn LanguageModel>,
    ) -> anyhow::Result<LanguageModelV4GenerateResult> {
        if self.mode == CacheMode::Off {
            return model.do_generate(params).await;
        }
        let cache = self.cache_for(model.as_ref());
        let (key, bindings) = call_key(&params, &self.variables)?;
        if let Some(entry) = cache.get(&key).await? {
            {
                let mut stats = STATS.lock();
                stats.hits += 1;
                stats.saved_ms += entry
                    .get("durationMs")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0) as i64;
            }
            let result = entry.get("result").cloned().unwrap_or(Value::Null);
            return replay(&result, &bindings);
        }
        STATS.lock().misses += 1;
        if self.mode == CacheMode::Replay {
            anyhow::bail!(
                "agentic-evals: no cached response for {}/{} (key {}) in replay mode.",
                model.provider(),
                model.model_id(),
                key
            );
        }
        let started = std::time::Instant::now();
        let result = model.do_generate(params).await?;
        let duration_ms = (started.elapsed().as_secs_f64() * 1000.0).round() as i64;
        let placeheld = to_placeholders(&js_stringify(&to_stored(&result)?), &bindings);
        let stored: Value = serde_json::from_str(&placeheld)?;
        cache
            .set(
                &key,
                &json!({ "timestamp": crate::support::now_ms(), "durationMs": duration_ms, "result": stored }),
            )
            .await?;
        replay(&stored, &bindings)
    }
}

fn resolve_dir(dir: &str) -> PathBuf {
    let path = Path::new(dir);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

/// The mode `AGENTIC_EVALS_CACHE_MODE` names; an unknown mode is an error.
pub fn parse_mode(value: Option<&str>) -> anyhow::Result<CacheMode> {
    match value.filter(|v| !v.is_empty()).unwrap_or("record") {
        "record" => Ok(CacheMode::Record),
        "replay" => Ok(CacheMode::Replay),
        "off" => Ok(CacheMode::Off),
        other => anyhow::bail!(
            "agentic-evals: unknown cache mode \"{other}\". Use one of: record, replay, off."
        ),
    }
}

static MIDDLEWARE: LazyLock<Option<Arc<CacheMiddleware>>> = LazyLock::new(|| {
    let dir = std::env::var("PRISM_LLM_CACHE_DIR")
        .ok()
        .filter(|d| !d.is_empty())?;
    let mode = parse_mode(std::env::var("AGENTIC_EVALS_CACHE_MODE").ok().as_deref())
        .unwrap_or_else(|e| panic!("{e}"));
    let variables = match std::env::var("PRISM_LLM_CACHE_VARIABLES")
        .ok()
        .filter(|v| !v.is_empty())
    {
        Some(text) => {
            parse_variables(&text).unwrap_or_else(|e| panic!("PRISM_LLM_CACHE_VARIABLES: {e}"))
        }
        None => Vec::new(),
    };
    if let Some(stats_dir) = std::env::var("PRISM_LLM_CACHE_STATS_DIR")
        .ok()
        .filter(|d| !d.is_empty())
    {
        start_stats_writer(PathBuf::from(stats_dir));
    }
    Some(Arc::new(CacheMiddleware::new(
        resolve_dir(&dir),
        mode,
        variables,
    )))
});

/// Rewrites `<dir>/<pid>.json` whole (temporary file, then rename) each second the
/// counts changed. The E2E runner stops the runtime with SIGKILL and reads the file
/// while it still runs.
fn start_stats_writer(dir: PathBuf) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    handle.spawn(async move {
        let file = dir.join(format!("{}.json", std::process::id()));
        let temporary = dir.join(format!("{}.json.tmp", std::process::id()));
        let mut written = String::new();
        let mut interval = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(1),
            Duration::from_secs(1),
        );
        loop {
            interval.tick().await;
            let counts = cache_stats().to_json();
            if counts == written {
                continue;
            }
            let write = async {
                tokio::fs::create_dir_all(&dir).await?;
                tokio::fs::write(&temporary, counts.as_bytes()).await?;
                tokio::fs::rename(&temporary, &file).await
            };
            if write.await.is_ok() {
                written = counts;
            }
        }
    });
}

/// Whether the E2E LLM cache is on.
pub fn is_llm_cache_enabled() -> bool {
    MIDDLEWARE.is_some()
}

/// The model with the E2E LLM cache in front of it when the cache is on, else the
/// model itself. The provider factory calls this last, on the model it hands out,
/// so the cache sees the call options `generate_text` and `generate_object` send.
pub fn with_llm_cache(model: Arc<dyn LanguageModel>) -> Arc<dyn LanguageModel> {
    match MIDDLEWARE.as_ref() {
        Some(middleware) => wrap_language_model(WrapLanguageModelOptions {
            model,
            middleware: middleware.clone() as Arc<dyn LanguageModelMiddleware>,
        }),
        None => model,
    }
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
