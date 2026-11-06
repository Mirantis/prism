//! Plugin Catalog Service
//!
//! Discovers Agent Plugins (the open standard at agent-plugins.org) installed
//! under the persistent plugins dir. A plugin is a directory holding a
//! `plugin.json` manifest plus, optionally, the two component types v1.0.0
//! defines:
//!
//! ```text
//!   <DATA>/plugins/<id>/
//!   ├── plugin.json   — required; `$schema` + `name`
//!   ├── skills/       — optional; each immediate child with a SKILL.md is a skill
//!   └── mcp.json      — optional; MCP servers
//! ```
//!
//! Installation is deliberately out of band, exactly as it is for skills: drop a
//! folder in and it appears; delete it and it is gone. Each scan is cached on the
//! plugins dir's mtime so that costs one `stat` per turn.
//!
//! Failures are graduated, per spec §11.3. A malformed manifest rejects only that
//! plugin; a `skills` path that isn't a directory disables only that component
//! type. Nothing here ever fails — a bad plugin is skipped with a warning and
//! recorded on `diagnostics` so the management API can attribute it.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::lib::execution_environments::execution_environment::{
    DirEntry, ExecutionFiles, FileStat,
};
use crate::lib::execution_environments::get_execution_environment::get_execution_environment;
use crate::log_warn;

/// The filesystem a command sees: the agent installs a plugin by writing there.
fn files() -> Arc<dyn ExecutionFiles> {
    get_execution_environment().files()
}

/// The one Agent Plugins manifest schema this runtime implements.
pub const PLUGIN_SCHEMA_1_0_0: &str = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/// Recognized manifest schemas. Spec §5.2 requires an exact-string match against
/// a local list and forbids fetching the schema while loading, so supporting a
/// future version is a one-line addition here.
const SUPPORTED_PLUGIN_SCHEMAS: [&str; 1] = [PLUGIN_SCHEMA_1_0_0];

/// Marks a manifest as *ours but the wrong version*, rather than not ours at all.
const PLUGIN_SCHEMA_PREFIX: &str = "https://agent-plugins.org/schemas/";

/// The closed set of top-level manifest fields (spec §5.3–5.4).
const MANIFEST_FIELDS: [&str; 10] = [
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
];

/// Spec §5.5: 1–64 chars, lowercase alphanumeric plus `-`/`.`, no `--` or `..`.
/// The "no `--` or `..`" half is checked apart from this pattern, which the
/// `regex` crate cannot express as a lookahead.
static PLUGIN_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$").unwrap());

/// A manifest is metadata; there is no reason for one to be large.
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    /// Directory name under the plugins dir — the stable local id.
    pub id: String,
    /// Manifest `name`. Display only; `id` is what addresses the plugin.
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Absolute path to the plugin root.
    pub dir: String,
    /// Absolute path to `<dir>/skills`, when it exists and is a directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills_dir: Option<String>,
    /// Absolute path to `<dir>/mcp.json`, when it exists and is a regular file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_config_path: Option<String>,
    /// Non-fatal problems worth surfacing (ignored fields, unreadable components).
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone)]
struct CachedScan {
    key: String,
    entries: Vec<PluginEntry>,
}

pub struct PluginCatalogService {
    cache: Mutex<Option<CachedScan>>,
}

impl PluginCatalogService {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(None),
        }
    }

    /// Every installed plugin, in directory-name order. Cheap to call repeatedly:
    /// rescans only when something on disk changed, so a plugin dropped in — or
    /// corrected in place — appears without a restart.
    ///
    /// No plugins dir (e.g. `PRISM_PLUGINS_DIR` points somewhere absent) caches
    /// an empty scan under the key `''` and returns no plugins.
    pub async fn get_plugins(&self) -> Vec<PluginEntry> {
        todo!()
    }

    /// Look up an installed plugin by its directory id.
    pub async fn find(&self, id: &str) -> Option<PluginEntry> {
        self.get_plugins().await.into_iter().find(|p| p.id == id)
    }

    /// Force a rescan on the next `get_plugins()` call.
    pub fn invalidate(&self) {
        *self.cache.lock() = None;
    }
}

impl Default for PluginCatalogService {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// A fingerprint of the plugins tree, or `None` when there is no plugins dir.
///
/// Keying on the plugins dir's mtime alone sees a plugin appear or vanish but
/// never one edited in place, because a directory's mtime moves only when an
/// immediate child is added, removed or renamed — **not** when an existing child
/// is rewritten. That is precisely the fix-it-and-retry loop an author is in:
/// `/plugins` says "plugin.json is not valid JSON", they correct the file, and
/// nothing about `plugins/` or `plugins/<id>/` has changed.
///
/// So the manifest and `mcp.json` are fingerprinted directly, by mtime *and*
/// size — the same pair `plugin_mcp_service` uses, and size is what saves it
/// when two writes land inside one filesystem timestamp tick. The directory's
/// own mtime still covers a `skills/` dir appearing.
///
/// The key is `<root mtime>` then, per sorted child name,
/// `<name>:<stamp dir>:<stamp plugin.json>:<stamp mcp.json>`, joined with `|`;
/// a stamp is `<mtimeMs>:<size>` (JavaScript number text) or `-` when the path
/// cannot be stat'ed.
async fn cache_key(plugins_dir: &str) -> Option<String> {
    todo!()
}

/// Every plugin under `plugins_dir`: directories and symlinks, sorted by name so
/// the resulting skill roots — and downstream, the MCP tool block — are in a
/// deterministic order across restarts. An unreadable dir scans as empty.
async fn scan(plugins_dir: &str) -> Vec<PluginEntry> {
    todo!()
}

/// One plugin, or `None` when the directory holds no usable manifest.
///
/// The manifest is `lstat`ed so a symlinked `plugin.json` is rejected (warn
/// `[Plugins] skipping "<id>": plugin.json is a symlink`); one over 256 KiB is
/// rejected (warn `[Plugins] skipping "<id>": plugin.json is larger than 256 KiB`);
/// a missing one is silent. An invalid manifest warns
/// `[Plugins] skipping "<id>": <error>`. Components live at fixed locations
/// (spec §6.1); a location of the wrong kind disables that component type only,
/// with the diagnostics `skills cannot be read — no skills loaded`,
/// `skills exists but is not a directory — no skills loaded`,
/// `mcp.json cannot be read — no MCP servers loaded` and
/// `mcp.json exists but is not a regular file — no MCP servers loaded`. Each
/// diagnostic is logged `[Plugins] "<id>": <diagnostic>`.
async fn load_plugin(plugins_dir: &str, id: &str) -> Option<PluginEntry> {
    todo!()
}

/// What a plugin directory holds, so a component that is simply absent is told
/// apart from one that is present but unreadable. An empty set for a directory
/// that cannot be listed: every component then reads as absent, which is the
/// same outcome as the plugin having none.
async fn component_names(dir: &str) -> HashSet<String> {
    match files().read_dir(dir).await {
        Ok(entries) => entries.into_iter().map(|entry| entry.name).collect(),
        Err(_) => HashSet::new(),
    }
}

/// `stat` for a component location, guaranteed not to fail: `None` stands for
/// "unreadable". This scan's contract is that one broken plugin degrades the
/// catalog, never crashes it: `get_plugins()` feeds every system-prompt build,
/// so a failure here would fail every turn. Follows symlinks, so a symlinked
/// `skills` directory still counts as one.
async fn component_stat(p: &str) -> Option<FileStat> {
    files().stat(p).await.ok()
}

// ---------------------------------------------------------------------------
// Manifest validation (spec §5)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Manifest {
    name: String,
    version: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ValidationResult {
    Ok {
        manifest: Manifest,
        diagnostics: Vec<String>,
    },
    Err {
        error: String,
    },
}

fn is_valid_plugin_name(name: &serde_json::Value) -> bool {
    let Some(name) = name.as_str() else {
        return false;
    };
    crate::support::js::len16(name) <= 64
        && PLUGIN_NAME_RE.is_match(name)
        && !name.contains("--")
        && !name.contains("..")
}

/// Parse and validate a `plugin.json` against Agent Plugins 1.0.0.
///
/// Two classes of problem, per spec §5.2. An unknown top-level field or a
/// non-object `extensions` is reported and ignored — the plugin still loads.
/// Everything else is fatal for that plugin. The error texts are:
/// - `plugin.json is not valid JSON (<parser message>)`
/// - `plugin.json must contain a JSON object`
/// - `unsupported Agent Plugins version — plugin.json declares "<schema>", this runtime implements "<PLUGIN_SCHEMA_1_0_0>"`
///   (a `$schema` starting with `PLUGIN_SCHEMA_PREFIX`)
/// - `plugin.json is not an Agent Plugins manifest (expected $schema "<PLUGIN_SCHEMA_1_0_0>")`
/// - `plugin.json "name" must be 1-64 characters of lowercase letters, digits, "-" or ".", starting and ending alphanumeric, with no "--" or ".."`
/// - `plugin.json "<field>" must be a string` for `version`, `description`,
///   `homepage`, `repository`, `license`, in that order
/// - `plugin.json "keywords" must be an array of strings`
/// - `plugin.json "author" must be an object`
///
/// and the diagnostics `ignoring "extensions": expected an object`,
/// `ignoring unknown plugin.json field(s): <sorted, comma-joined>` and
/// `manifest name "<name>" differs from directory name "<id>"`.
fn validate_manifest(raw: &str, id: &str) -> ValidationResult {
    todo!()
}

pub static PLUGIN_CATALOG_SERVICE: LazyLock<PluginCatalogService> =
    LazyLock::new(PluginCatalogService::new);
