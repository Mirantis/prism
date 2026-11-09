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
    let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(raw) else {
        return None;
    };

    // Closed top level (spec §7.2.1).
    if parsed
        .keys()
        .any(|k| !TOP_LEVEL_FIELDS.contains(&k.as_str()))
    {
        return None;
    }

    let mut servers = Vec::new();
    let mut warnings = Vec::new();

    // §10.1: when `$schema` is present it must match the version `plugin.json`
    // declares, so a file targeting a version we don't implement is refused.
    //
    // Absent is tolerated, which the spec's schema (`required: ["$schema", …]`)
    // does not require of us. Practically no `mcp.json` in the wild carries it,
    // and rejecting the whole file for that means every server silently fails to
    // load while the plugin's skills keep working, which reads as a runtime bug
    // rather than a malformed file. Same leniency as the missing `type` below,
    // and equally visible: it comes back as a diagnostic.
    match parsed.get("$schema") {
        None => warnings.push(format!(
            "mcp.json has no \"$schema\" — assuming {MCP_SCHEMA_1_0_0}"
        )),
        Some(Value::String(schema)) if schema == MCP_SCHEMA_1_0_0 => {}
        Some(_) => return None,
    }

    let Some(Value::Object(mcp_servers)) = parsed.get("mcpServers") else {
        return None;
    };

    let mut names: Vec<&String> = mcp_servers.keys().collect();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    for name in names {
        if let Some(server) = resolve_server(name, &mcp_servers[name], ctx, &mut warnings) {
            servers.push(server);
        }
    }

    Some(ParseResult { servers, warnings })
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
    if !SERVER_NAME_RE.is_match(name) {
        return skip(
            warnings,
            name,
            "name must start alphanumeric and contain only letters, digits, \"_\" or \"-\"",
        );
    }
    let Value::Object(entry) = raw_entry else {
        return skip(warnings, name, "configuration must be an object");
    };

    // The spec requires `type`, but omitting it for stdio is a common habit in
    // hand-written MCP configs. Default it rather than reject — and say so, so the
    // leniency is visible rather than silent.
    let assumed = Value::String("stdio".to_string());
    let kind = match entry.get("type") {
        Some(kind) => kind,
        None => {
            warnings.push(format!(
                "MCP server \"{name}\": no \"type\" declared, assuming \"stdio\""
            ));
            &assumed
        }
    };

    match kind.as_str() {
        Some("stdio") => resolve_stdio(name, entry, ctx, warnings),
        Some("streamable-http") => resolve_remote(name, RemoteKind::Http, entry, warnings),
        Some("sse") => resolve_remote(name, RemoteKind::Sse, entry, warnings),
        _ => skip(
            warnings,
            name,
            &format!(
                "unsupported transport type {}",
                crate::ai::json::js_stringify(kind)
            ),
        ),
    }
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
    let unknown = unknown_fields(entry, &STDIO_FIELDS);
    if !unknown.is_empty() {
        return skip(
            warnings,
            name,
            &format!(
                "stdio configuration has unsupported field(s) {} — remove them, or move the server to a client that understands them (allowed: {})",
                unknown.join(", "),
                STDIO_FIELDS.join(", ")
            ),
        );
    }

    // `command` is never expanded (§9.2) and must be a single token: a bare
    // executable name, or a `./` path contained by the plugin.
    let command = match entry.get("command") {
        Some(Value::String(command)) if !command.is_empty() => command,
        _ => {
            return skip(
                warnings,
                name,
                "stdio \"command\" must be a non-empty string",
            );
        }
    };
    if !COMMAND_TOKEN_RE.is_match(command) {
        return skip(
            warnings,
            name,
            "stdio \"command\" must be a single token — put arguments in \"args\"",
        );
    }
    let mut resolved_command = command.clone();
    if command.starts_with("./") {
        let abs = path_text(&resolve_path(&ctx.plugin_root, command));
        if !contains(&ctx.plugin_root, &abs) {
            return skip(
                warnings,
                name,
                "stdio \"command\" escapes the plugin directory",
            );
        }
        resolved_command = abs;
    } else if command.contains('/') || command.contains('\\') {
        return skip(
            warnings,
            name,
            "stdio \"command\" must be a bare executable name or begin with \"./\"",
        );
    }

    if entry.get("args").is_some_and(|args| !is_string_array(args)) {
        return skip(warnings, name, "stdio \"args\" must be an array of strings");
    }
    let args: Vec<String> = entry
        .get("args")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|arg| expand(arg, ctx))
                .collect()
        })
        .unwrap_or_default();

    if entry.get("env").is_some_and(|env| !is_string_record(env)) {
        return skip(warnings, name, "stdio \"env\" must be an object of strings");
    }
    let empty = Map::new();
    let raw_env = entry
        .get("env")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    if let Some(reserved) = raw_env
        .keys()
        .find(|key| RESERVED_ENV.contains(key.as_str()))
    {
        return skip(
            warnings,
            name,
            &format!("stdio \"env\" must not define {reserved} — the runtime supplies it"),
        );
    }
    let mut env: IndexMap<String, String> = raw_env
        .iter()
        .map(|(key, value)| (key.clone(), expand(value.as_str().unwrap_or_default(), ctx)))
        .collect();
    // Injected last, which is exactly why the two names are reserved above.
    env.insert("PLUGIN_ROOT".into(), ctx.plugin_root.clone());
    env.insert("PLUGIN_DATA".into(), ctx.plugin_data.clone());

    // Defaults to the plugin root (§7.2.1) and must stay inside one of the two
    // directories the plugin owns.
    let raw_cwd = match entry.get("cwd") {
        None => None,
        Some(Value::String(cwd)) => Some(cwd),
        Some(_) => return skip(warnings, name, "stdio \"cwd\" must be a string"),
    };
    let mut cwd = ctx.plugin_root.clone();
    if let Some(raw_cwd) = raw_cwd {
        let Some(base) = cwd_base(raw_cwd, ctx) else {
            return skip(
                warnings,
                name,
                "stdio \"cwd\" must be a \"./\" path, ${PLUGIN_ROOT} or ${PLUGIN_DATA}",
            );
        };
        let abs = path_text(&resolve_path(base, &expand(raw_cwd, ctx)));
        if !contains(base, &abs) {
            return skip(warnings, name, "stdio \"cwd\" escapes the plugin directory");
        }
        cwd = abs;
    }

    Some(ResolvedServer::Stdio {
        name: name.to_string(),
        command: resolved_command,
        args,
        env,
        cwd,
    })
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
    let unknown = unknown_fields(entry, &REMOTE_FIELDS);
    if !unknown.is_empty() {
        return skip(
            warnings,
            name,
            &format!(
                "{} configuration has unsupported field(s) {} — remove them (allowed: {})",
                kind.as_str(),
                unknown.join(", "),
                REMOTE_FIELDS.join(", ")
            ),
        );
    }
    let raw_url = match entry.get("url") {
        Some(Value::String(url)) if !url.is_empty() => url,
        _ => return skip(warnings, name, "\"url\" must be a non-empty string"),
    };

    let Ok(url) = url::Url::parse(raw_url) else {
        return skip(warnings, name, "\"url\" must be an absolute URL");
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return skip(warnings, name, "\"url\" must use http or https");
    }
    if !url.username().is_empty() || url.password().is_some_and(|p| !p.is_empty()) {
        return skip(warnings, name, "\"url\" must not contain user information");
    }
    if url.fragment().is_some_and(|f| !f.is_empty()) {
        return skip(warnings, name, "\"url\" must not contain a fragment");
    }
    if url.scheme() == "http" && !is_loopback(url.host_str().unwrap_or_default()) {
        return skip(warnings, name, "a non-loopback \"url\" must use https");
    }

    if entry
        .get("headers")
        .is_some_and(|headers| !is_string_record(headers))
    {
        return skip(warnings, name, "\"headers\" must be an object of strings");
    }
    let mut headers = IndexMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    if let Some(Value::Object(raw_headers)) = entry.get("headers") {
        for (key, value) in raw_headers {
            let lower = key.to_lowercase();
            if !HEADER_NAME_RE.is_match(key) {
                warnings.push(format!(
                    "MCP server \"{name}\": ignoring invalid header name \"{key}\""
                ));
                continue;
            }
            if seen.contains(&lower) {
                warnings.push(format!(
                    "MCP server \"{name}\": ignoring duplicate header \"{key}\""
                ));
                continue;
            }
            if CLIENT_OWNED_HEADERS.contains(lower.as_str()) {
                // Spec: headers are visible package data, not a credential channel.
                warnings.push(format!(
                    "MCP server \"{name}\": ignoring header \"{key}\" — the runtime owns it"
                ));
                continue;
            }
            seen.insert(lower);
            headers.insert(key.clone(), value.as_str().unwrap_or_default().to_string());
        }
    }

    let name = name.to_string();
    let url = raw_url.clone();
    Some(match kind {
        RemoteKind::Http => ResolvedServer::Http { name, url, headers },
        RemoteKind::Sse => ResolvedServer::Sse { name, url, headers },
    })
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

/// Records why the server is skipped, as `MCP server "<name>": <reason>`.
fn skip(warnings: &mut Vec<String>, name: &str, reason: &str) -> Option<ResolvedServer> {
    warnings.push(format!("MCP server \"{name}\": {reason}"));
    None
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PLUGIN_ROOT: &str = "/tmp/prism-plugins/demo";
    const PLUGIN_DATA: &str = "/tmp/prism-plugin-data/demo";

    fn ctx() -> McpParseContext {
        McpParseContext {
            plugin_id: "demo".into(),
            plugin_root: PLUGIN_ROOT.into(),
            plugin_data: PLUGIN_DATA.into(),
        }
    }

    /// An mcp.json document around the given server map.
    fn doc(servers: Value) -> String {
        json!({ "$schema": MCP_SCHEMA_1_0_0, "mcpServers": servers }).to_string()
    }

    /// Parse, asserting the file itself was usable.
    fn parse(raw: &str) -> ParseResult {
        parse_mcp_json(raw, &ctx()).expect("a usable mcp.json")
    }

    fn names(result: &ParseResult) -> Vec<&str> {
        result.servers.iter().map(ResolvedServer::name).collect()
    }

    fn stdio(server: &ResolvedServer) -> (&str, &Vec<String>, &IndexMap<String, String>, &str) {
        match server {
            ResolvedServer::Stdio {
                command,
                args,
                env,
                cwd,
                ..
            } => (command, args, env, cwd),
            other => panic!("expected a stdio server, got {other:?}"),
        }
    }

    #[test]
    fn accepts_a_well_formed_document() {
        let result = parse(&doc(
            json!({ "probe": { "type": "stdio", "command": "node" } }),
        ));
        assert_eq!(result.servers.len(), 1);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn disables_mcp_for_a_file_that_is_unusable() {
        for raw in [
            "{ not json".to_string(),
            "[]".to_string(),
            json!({
                "$schema": "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json",
                "mcpServers": {},
            })
            .to_string(),
            json!({ "$schema": MCP_SCHEMA_1_0_0, "mcpServers": {}, "extra": 1 }).to_string(),
            json!({ "$schema": MCP_SCHEMA_1_0_0, "mcpServers": [] }).to_string(),
        ] {
            assert!(parse_mcp_json(&raw, &ctx()).is_none(), "{raw}");
        }
    }

    #[test]
    fn accepts_a_file_with_no_schema_and_says_so() {
        let raw =
            json!({ "mcpServers": { "probe": { "command": "npx", "args": ["-y", "server"] } } })
                .to_string();
        let result = parse(&raw);
        assert_eq!(names(&result), vec!["probe"]);
        assert!(result.warnings.join(",").contains("no \"$schema\""));
    }

    #[test]
    fn still_rejects_a_schema_that_names_a_version_not_implemented() {
        let raw = json!({
            "$schema": "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json",
            "mcpServers": { "probe": { "type": "stdio", "command": "node" } },
        })
        .to_string();
        assert!(parse_mcp_json(&raw, &ctx()).is_none());
    }

    #[test]
    fn returns_servers_in_name_order_regardless_of_how_the_json_was_written() {
        let result = parse(&doc(json!({
            "zeta": { "type": "stdio", "command": "node" },
            "alpha": { "type": "stdio", "command": "node" },
        })));
        assert_eq!(names(&result), vec!["alpha", "zeta"]);
    }

    #[test]
    fn skips_one_bad_entry_while_its_siblings_still_load() {
        let result = parse(&doc(json!({
            "good": { "type": "stdio", "command": "node" },
            "bad": { "type": "nonsense" },
        })));
        assert_eq!(names(&result), vec!["good"]);
        assert_eq!(
            result.warnings,
            vec!["MCP server \"bad\": unsupported transport type \"nonsense\""]
        );
    }

    #[test]
    fn resolves_command_args_env_and_cwd() {
        let result = parse(&doc(json!({
            "probe": {
                "type": "stdio",
                "command": "node",
                "args": ["server.js"],
                "env": { "MODE": "live" },
                "cwd": "./work",
            },
        })));
        let (command, args, env, cwd) = stdio(&result.servers[0]);
        assert_eq!(command, "node");
        assert_eq!(args, &vec!["server.js".to_string()]);
        assert_eq!(cwd, format!("{PLUGIN_ROOT}/work"));
        assert_eq!(
            env.iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>(),
            vec![
                "MODE=live".to_string(),
                format!("PLUGIN_ROOT={PLUGIN_ROOT}"),
                format!("PLUGIN_DATA={PLUGIN_DATA}"),
            ]
        );
    }

    #[test]
    fn defaults_cwd_to_the_plugin_root() {
        let result = parse(&doc(
            json!({ "probe": { "type": "stdio", "command": "node" } }),
        ));
        assert_eq!(stdio(&result.servers[0]).3, PLUGIN_ROOT);
    }

    #[test]
    fn assumes_stdio_when_type_is_omitted_and_says_so() {
        let result = parse(&doc(json!({ "probe": { "command": "node" } })));
        assert_eq!(result.servers[0].kind(), "stdio");
        assert!(result.warnings.join(",").contains("assuming \"stdio\""));
    }

    #[test]
    fn rejects_a_server_that_defines_the_reserved_variables_itself() {
        let result = parse(&doc(json!({
            "probe": { "type": "stdio", "command": "node", "env": { "PLUGIN_ROOT": "/elsewhere" } },
        })));
        assert!(result.servers.is_empty());
        assert!(
            result
                .warnings
                .join(",")
                .contains("must not define PLUGIN_ROOT")
        );
    }

    #[test]
    fn rejects_commands_that_are_not_one_contained_token() {
        for command in ["npx -y foo", "sh; rm -rf /", "/usr/bin/node", "../escape"] {
            let result = parse(&doc(
                json!({ "probe": { "type": "stdio", "command": command } }),
            ));
            assert!(result.servers.is_empty(), "{command}");
        }
    }

    #[test]
    fn resolves_a_dot_relative_command_against_the_plugin_root() {
        let result = parse(&doc(
            json!({ "probe": { "type": "stdio", "command": "./bin/server" } }),
        ));
        assert_eq!(
            stdio(&result.servers[0]).0,
            format!("{PLUGIN_ROOT}/bin/server")
        );
    }

    #[test]
    fn rejects_unknown_stdio_fields_naming_them() {
        let result = parse(&doc(json!({
            "probe": { "type": "stdio", "command": "node", "disabled": true, "description": "x" },
        })));
        assert!(result.servers.is_empty());
        assert_eq!(
            result.warnings,
            vec![
                "MCP server \"probe\": stdio configuration has unsupported field(s) description, disabled — remove them, or move the server to a client that understands them (allowed: type, command, args, env, cwd)"
            ]
        );
    }

    #[test]
    fn rejects_a_cwd_outside_the_plugin_directories() {
        for cwd in ["${PLUGIN_ROOT}/../..", "./../..", "/etc", "${HOME}"] {
            let result = parse(&doc(
                json!({ "probe": { "type": "stdio", "command": "node", "cwd": cwd } }),
            ));
            assert!(result.servers.is_empty(), "{cwd}");
        }
    }

    #[test]
    fn anchors_a_plugin_data_cwd_to_the_data_dir() {
        let result = parse(&doc(json!({
            "probe": { "type": "stdio", "command": "node", "cwd": "${PLUGIN_DATA}/cache" },
        })));
        assert_eq!(stdio(&result.servers[0]).3, format!("{PLUGIN_DATA}/cache"));
    }

    #[test]
    fn expands_placeholders_in_args_env_values_and_cwd() {
        let result = parse(&doc(json!({
            "probe": {
                "type": "stdio",
                "command": "node",
                "args": ["${PLUGIN_ROOT}/server.js", "--state=${PLUGIN_DATA}"],
                "env": { "CONFIG": "${PLUGIN_ROOT}/config.json" },
                "cwd": "${PLUGIN_DATA}",
            },
        })));
        let (_, args, env, cwd) = stdio(&result.servers[0]);
        assert_eq!(
            args,
            &vec![
                format!("{PLUGIN_ROOT}/server.js"),
                format!("--state={PLUGIN_DATA}")
            ]
        );
        assert_eq!(env["CONFIG"], format!("{PLUGIN_ROOT}/config.json"));
        assert_eq!(cwd, PLUGIN_DATA);
    }

    #[test]
    fn rejects_a_placeholder_in_command() {
        let result = parse(&doc(json!({
            "probe": { "type": "stdio", "command": "${PLUGIN_ROOT}/bin/server" },
        })));
        assert!(result.servers.is_empty());
        assert!(result.warnings.join(",").contains("single token"));
    }

    #[test]
    fn does_not_expand_env_keys() {
        let result = parse(&doc(json!({
            "probe": { "type": "stdio", "command": "node", "env": { "${PLUGIN_ROOT}": "x" } },
        })));
        assert_eq!(stdio(&result.servers[0]).2["${PLUGIN_ROOT}"], "x");
    }

    #[test]
    fn expands_in_a_single_pass() {
        let nested = McpParseContext {
            plugin_id: "demo".into(),
            plugin_root: "${PLUGIN_DATA}".into(),
            plugin_data: PLUGIN_DATA.into(),
        };
        let result = parse_mcp_json(
            &doc(json!({ "probe": { "type": "stdio", "command": "node", "args": ["${PLUGIN_ROOT}"] } })),
            &nested,
        )
        .unwrap();
        assert_eq!(
            stdio(&result.servers[0]).1,
            &vec!["${PLUGIN_DATA}".to_string()]
        );
    }

    #[test]
    fn leaves_an_unrecognized_placeholder_literal() {
        let result = parse(&doc(json!({
            "probe": { "type": "stdio", "command": "node", "args": ["${SOMETHING_ELSE}"] },
        })));
        assert_eq!(
            stdio(&result.servers[0]).1,
            &vec!["${SOMETHING_ELSE}".to_string()]
        );
    }

    #[test]
    fn maps_streamable_http_onto_http() {
        let result = parse(&doc(
            json!({ "api": { "type": "streamable-http", "url": "https://x.dev/mcp" } }),
        ));
        assert_eq!(
            result.servers[0],
            ResolvedServer::Http {
                name: "api".into(),
                url: "https://x.dev/mcp".into(),
                headers: IndexMap::new(),
            }
        );
    }

    #[test]
    fn rejects_the_sdk_name_http_in_the_file_format() {
        let result = parse(&doc(
            json!({ "api": { "type": "http", "url": "https://x.dev/mcp" } }),
        ));
        assert!(result.servers.is_empty());
    }

    #[test]
    fn accepts_legacy_sse() {
        let result = parse(&doc(
            json!({ "api": { "type": "sse", "url": "https://x.dev/sse" } }),
        ));
        assert_eq!(result.servers[0].kind(), "sse");
    }

    #[test]
    fn rejects_urls_that_are_not_plain_https() {
        for url in [
            "not-a-url",
            "ftp://x.dev/mcp",
            "http://x.dev/mcp",
            "https://user:pw@x.dev/mcp",
            "https://x.dev/mcp#frag",
        ] {
            let result = parse(&doc(
                json!({ "api": { "type": "streamable-http", "url": url } }),
            ));
            assert!(result.servers.is_empty(), "{url}");
        }
    }

    #[test]
    fn allows_plain_http_on_loopback() {
        for url in [
            "http://localhost:8080/mcp",
            "http://127.0.0.1/mcp",
            "http://[::1]:9/mcp",
        ] {
            let result = parse(&doc(
                json!({ "api": { "type": "streamable-http", "url": url } }),
            ));
            assert_eq!(result.servers.len(), 1, "{url}");
        }
    }

    #[test]
    fn keeps_ordinary_headers_and_drops_the_ones_the_runtime_owns() {
        let result = parse(&doc(json!({
            "api": {
                "type": "streamable-http",
                "url": "https://x.dev/mcp",
                "headers": { "X-Tenant": "acme", "Authorization": "Bearer leaked", "x-tenant": "dup", "bad name": "v" },
            },
        })));
        let ResolvedServer::Http { headers, .. } = &result.servers[0] else {
            panic!("expected a remote server");
        };
        assert_eq!(headers.len(), 1);
        assert_eq!(headers["X-Tenant"], "acme");
        assert_eq!(
            result.warnings,
            vec![
                "MCP server \"api\": ignoring header \"Authorization\" — the runtime owns it",
                "MCP server \"api\": ignoring duplicate header \"x-tenant\"",
                "MCP server \"api\": ignoring invalid header name \"bad name\"",
            ]
        );
    }

    #[test]
    fn rejects_unknown_remote_fields() {
        let result = parse(&doc(json!({
            "api": { "type": "streamable-http", "url": "https://x.dev/mcp", "command": "node" },
        })));
        assert!(result.servers.is_empty());
        assert_eq!(
            result.warnings,
            vec![
                "MCP server \"api\": http configuration has unsupported field(s) command — remove them (allowed: type, url, headers)"
            ]
        );
    }

    #[test]
    fn rejects_server_names_that_are_not_prefix_safe() {
        for name in ["has space", "-leading", "dots.not.allowed", ""] {
            let mut servers = Map::new();
            servers.insert(name.into(), json!({ "type": "stdio", "command": "node" }));
            let result = parse(&doc(Value::Object(servers)));
            assert!(result.servers.is_empty(), "{name}");
        }
    }
}
