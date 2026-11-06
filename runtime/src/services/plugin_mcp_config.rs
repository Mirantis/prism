//! Agent Plugins `mcp.json` parsing and validation.
//!
//! Pure and self-contained on purpose: no MCP SDK imports, no connections, and
//! (bar one realpath check) no I/O — so the whole rule set from the Agent Plugins
//! 1.0.0 MCP schema can be unit-tested without spawning a process.
//!
//! The failure model is graduated, per spec §7.2.2. An unusable *file* disables
//! MCP for that plugin alone and leaves its skills untouched; a single bad server
//! entry is skipped while its siblings still load. Nothing here fails.
//!
//! Note the vocabulary gap: the spec's remote transport is `streamable-http`,
//! while the AI SDK calls the same thing `http`. We validate the spec's names and
//! translate at this boundary, so SDK naming never leaks into the file format we
//! accept from plugin authors.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The one Agent Plugins MCP schema this runtime implements.
pub const MCP_SCHEMA_1_0_0: &str = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/// Substituted into `args`, `env` values and `cwd` — never into `command` (§9.2).
static PLACEHOLDER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}").unwrap());

/// The client supplies these; a server that declares them is invalid (§9.2).
static RESERVED_ENV: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| HashSet::from(["PLUGIN_ROOT", "PLUGIN_DATA"]));

/// A command is one executable token. The transport spawns with no shell, so
/// these characters could never be *interpreted* — rejecting them turns
/// `"command": "uvx foo"` into a clear message instead of an ENOENT for a file
/// literally named `uvx foo`.
static COMMAND_TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^[^\s;|&$<>`"'\\\n]+$"#).unwrap());

/// A server name becomes part of every tool name, so it must be prefix-safe.
static SERVER_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]*$").unwrap());

/// RFC 7230 token characters.
static HEADER_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$").unwrap());

/// Headers the transport owns. A plugin setting these would either break the
/// connection or spoof identity, and the spec is explicit that `headers` is
/// visible package data rather than a credential channel.
static CLIENT_OWNED_HEADERS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    HashSet::from([
        "accept",
        "authorization",
        "connection",
        "content-encoding",
        "content-length",
        "content-type",
        "host",
        "mcp-protocol-version",
        "mcp-session-id",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ])
});

const TOP_LEVEL_FIELDS: [&str; 2] = ["$schema", "mcpServers"];
/// In declaration order: the diagnostics list them as written.
const STDIO_FIELDS: [&str; 5] = ["type", "command", "args", "env", "cwd"];
/// In declaration order: the diagnostics list them as written.
const REMOTE_FIELDS: [&str; 3] = ["type", "url", "headers"];

/// A validated server entry, with every placeholder already expanded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ResolvedServer {
    Stdio {
        name: String,
        command: String,
        args: Vec<String>,
        env: IndexMap<String, String>,
        cwd: String,
    },
    Http {
        name: String,
        url: String,
        headers: IndexMap<String, String>,
    },
    Sse {
        name: String,
        url: String,
        headers: IndexMap<String, String>,
    },
}

impl ResolvedServer {
    /// The server's name from `mcpServers`.
    pub fn name(&self) -> &str {
        match self {
            ResolvedServer::Stdio { name, .. }
            | ResolvedServer::Http { name, .. }
            | ResolvedServer::Sse { name, .. } => name,
        }
    }

    /// `stdio`, `http` or `sse`.
    pub fn kind(&self) -> &'static str {
        match self {
            ResolvedServer::Stdio { .. } => "stdio",
            ResolvedServer::Http { .. } => "http",
            ResolvedServer::Sse { .. } => "sse",
        }
    }
}

/// The remote transports, as the AI SDK names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteKind {
    Http,
    Sse,
}

impl RemoteKind {
    fn as_str(self) -> &'static str {
        match self {
            RemoteKind::Http => "http",
            RemoteKind::Sse => "sse",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseResult {
    pub servers: Vec<ResolvedServer>,
    /// Per-entry problems, already attributed to a server name.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpParseContext {
    pub plugin_id: String,
    /// Absolute path to the plugin root — becomes `PLUGIN_ROOT`.
    pub plugin_root: String,
    /// Absolute path to the plugin's persistent data dir — becomes `PLUGIN_DATA`.
    pub plugin_data: String,
}

/// Parse one plugin's `mcp.json`.
///
/// Returns `None` when the file itself is unusable — unparseable, an unknown
/// top-level key, or a `$schema` this runtime does not implement. A *missing*
/// `$schema` is not unusable: it is assumed to mean 1.0.0 and reported. Returns
/// a result otherwise; individual bad entries land in `warnings` and the rest
/// load.
///
/// Server names are visited sorted, so the tool block this eventually produces
/// is stable regardless of how the JSON happened to be written or reformatted.
pub fn parse_mcp_json(raw: &str, ctx: &McpParseContext) -> Option<ParseResult> {
    todo!()
}

/// One entry of `mcpServers`. A missing `type` is assumed `stdio`, with a
/// warning; `streamable-http` resolves to `http`, `sse` to `sse`; anything else
/// is skipped with `unsupported transport type <JSON of type>`.
fn resolve_server(
    name: &str,
    raw_entry: &Value,
    ctx: &McpParseContext,
    warnings: &mut Vec<String>,
) -> Option<ResolvedServer> {
    todo!()
}

/// A stdio entry: closed field set, a single-token `command` (bare name or a
/// `./` path inside the plugin), string `args`, string `env` without the
/// reserved names (which are injected last), and a `cwd` anchored to the
/// plugin root or data dir.
fn resolve_stdio(
    name: &str,
    entry: &Map<String, Value>,
    ctx: &McpParseContext,
    warnings: &mut Vec<String>,
) -> Option<ResolvedServer> {
    todo!()
}

/// A remote entry: closed field set, an absolute http(s) `url` with no user
/// information or fragment (plain http only for a loopback host), and string
/// `headers` minus invalid, duplicate and client-owned names, each reported.
fn resolve_remote(
    name: &str,
    kind: RemoteKind,
    entry: &Map<String, Value>,
    warnings: &mut Vec<String>,
) -> Option<ResolvedServer> {
    todo!()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// One non-recursive pass. A replacement is never rescanned, so a value that
/// expands to the literal characters `${PLUGIN_DATA}` stays literal — which is
/// precisely the behaviour §9.2 requires. Any other `${...}` is left alone, since
/// a server may legitimately want that text.
fn expand(value: &str, ctx: &McpParseContext) -> String {
    PLACEHOLDER_RE
        .replace_all(value, |caps: &regex::Captures| match &caps[1] {
            "PLUGIN_ROOT" => ctx.plugin_root.clone(),
            _ => ctx.plugin_data.clone(),
        })
        .into_owned()
}

/// Which directory a `cwd` is anchored to, or `None` when it is anchored to neither.
fn cwd_base<'a>(cwd: &str, ctx: &'a McpParseContext) -> Option<&'a str> {
    if cwd.starts_with("./") {
        return Some(ctx.plugin_root.as_str());
    }
    if cwd == "${PLUGIN_ROOT}" || cwd.starts_with("${PLUGIN_ROOT}/") {
        return Some(ctx.plugin_root.as_str());
    }
    if cwd == "${PLUGIN_DATA}" || cwd.starts_with("${PLUGIN_DATA}/") {
        return Some(ctx.plugin_data.as_str());
    }
    None
}

/// `path.resolve(base, target)`: `target` against `base` (itself against the
/// process cwd), with `.` and `..` removed lexically.
fn resolve_path(base: &str, target: &str) -> PathBuf {
    let mut joined = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    joined.push(base);
    joined.push(target);
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether `target` stays within `base`. Compared lexically first, then again
/// through `realpath` when both paths exist — so a symlink planted inside the
/// plugin cannot point a subprocess somewhere else. `PLUGIN_DATA` is created
/// just before launch, so a not-yet-existing path is checked lexically only.
fn contains(base: &str, target: &str) -> bool {
    if !within(&resolve_path(base, ""), &resolve_path(target, "")) {
        return false;
    }
    match (std::fs::canonicalize(base), std::fs::canonicalize(target)) {
        (Ok(real_base), Ok(real_target)) => within(&real_base, &real_target),
        // One of them doesn't exist yet — the lexical check stands.
        _ => true,
    }
}

fn within(base: &Path, target: &Path) -> bool {
    target.starts_with(base)
}

fn is_loopback(hostname: &str) -> bool {
    hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1" || hostname == "[::1]"
}

/// The keys of `entry` that aren't in `allowed`, sorted.
///
/// Named in the diagnostic rather than counted: "contains unknown fields" tells
/// an author their server was skipped but not what to delete, which leaves them
/// comparing their file to a spec by eye.
fn unknown_fields(entry: &Map<String, Value>, allowed: &[&str]) -> Vec<String> {
    let mut unknown: Vec<String> = entry
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .cloned()
        .collect();
    unknown.sort();
    unknown
}

fn is_string_array(v: &Value) -> bool {
    v.as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn is_string_record(v: &Value) -> bool {
    v.as_object()
        .is_some_and(|obj| obj.values().all(Value::is_string))
}
