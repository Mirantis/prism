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

use crate::lib::execution_environments::execution_environment::{ExecutionFiles, FileStat};
use crate::lib::execution_environments::get_execution_environment::get_execution_environment;
use crate::log_warn;
use crate::support::js::number_text;
use serde_json::Value;

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
        let dir = get_execution_environment().paths().plugins_dir;
        let Some(key) = cache_key(&dir).await else {
            // No plugins dir (e.g. PRISM_PLUGINS_DIR points somewhere absent).
            *self.cache.lock() = Some(CachedScan {
                key: String::new(),
                entries: Vec::new(),
            });
            return Vec::new();
        };
        if let Some(cache) = self.cache.lock().as_ref().filter(|c| c.key == key) {
            return cache.entries.clone();
        }
        let entries = scan(&dir).await;
        *self.cache.lock() = Some(CachedScan {
            key,
            entries: entries.clone(),
        });
        entries
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
    let files = files();
    let root_mtime = files.stat(plugins_dir).await.ok()?.mtime_ms;
    let mut names: Vec<String> = files
        .read_dir(plugins_dir)
        .await
        .ok()?
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));

    // Guarded: a path that is missing, or present but unreadable, stamps the same
    // — either way there is nothing here to fingerprint, and this runs on every
    // prompt build.
    async fn stamp(files: &Arc<dyn ExecutionFiles>, path: &str) -> String {
        match files.stat(path).await {
            Ok(st) => format!("{}:{}", number_text(st.mtime_ms), st.size),
            Err(_) => "-".to_string(),
        }
    }

    let mut parts = vec![number_text(root_mtime)];
    for name in names {
        let dir = join(plugins_dir, &name);
        parts.push(format!(
            "{name}:{}:{}:{}",
            stamp(&files, &dir).await,
            stamp(&files, &join(&dir, "plugin.json")).await,
            stamp(&files, &join(&dir, "mcp.json")).await
        ));
    }
    Some(parts.join("|"))
}

/// Every plugin under `plugins_dir`: directories and symlinks, sorted by name so
/// the resulting skill roots — and downstream, the MCP tool block — are in a
/// deterministic order across restarts. An unreadable dir scans as empty.
async fn scan(plugins_dir: &str) -> Vec<PluginEntry> {
    let Ok(dirents) = files().read_dir(plugins_dir).await else {
        return Vec::new();
    };

    // Sorted so the resulting skill roots — and downstream, the MCP tool block —
    // are in a deterministic order across restarts.
    let mut ids: Vec<String> = dirents
        .into_iter()
        .filter(|d| d.is_directory || d.is_symbolic_link)
        .map(|d| d.name)
        .collect();
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));

    let mut entries = Vec::new();
    for id in ids {
        if let Some(entry) = load_plugin(plugins_dir, &id).await {
            entries.push(entry);
        }
    }
    entries
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
    let dir = join(plugins_dir, id);
    let manifest_path = join(&dir, "plugin.json");
    let files = files();

    // lstat the final component so a symlinked plugin.json is rejected — that
    // would let a bundle present a manifest from outside its own root. A
    // symlinked plugin *directory* stays fine. No plugin.json is not a plugin
    // directory, which is silent: the dir may be anything.
    let st = files.lstat(&manifest_path).await.ok()?;
    if st.is_symbolic_link {
        log_warn!("[Plugins] skipping \"{}\": plugin.json is a symlink", id);
        return None;
    }
    if !st.is_file {
        return None;
    }
    if st.size > MAX_MANIFEST_BYTES {
        log_warn!(
            "[Plugins] skipping \"{}\": plugin.json is larger than 256 KiB",
            id
        );
        return None;
    }
    let raw = files.read_text(&manifest_path, None).await.ok()?;

    let (manifest, mut diagnostics) = match validate_manifest(&raw, id) {
        ValidationResult::Ok {
            manifest,
            diagnostics,
        } => (manifest, diagnostics),
        ValidationResult::Err { error } => {
            log_warn!("[Plugins] skipping \"{}\": {}", id, error);
            return None;
        }
    };

    let mut entry = PluginEntry {
        id: id.to_string(),
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        dir: dir.clone(),
        skills_dir: None,
        mcp_config_path: None,
        diagnostics: Vec::new(),
    };

    // Components live at fixed locations (spec §6.1); the manifest cannot move
    // them. A location of the wrong kind disables that component type only.
    let present = component_names(&dir).await;

    let skills_path = join(&dir, "skills");
    if present.contains("skills") {
        match component_stat(&skills_path).await {
            None => diagnostics.push("skills cannot be read — no skills loaded".to_string()),
            Some(st) if st.is_directory => entry.skills_dir = Some(skills_path),
            Some(_) => diagnostics
                .push("skills exists but is not a directory — no skills loaded".to_string()),
        }
    }

    let mcp_path = join(&dir, "mcp.json");
    if present.contains("mcp.json") {
        match component_stat(&mcp_path).await {
            None => diagnostics.push("mcp.json cannot be read — no MCP servers loaded".to_string()),
            Some(st) if st.is_file => entry.mcp_config_path = Some(mcp_path),
            Some(_) => diagnostics.push(
                "mcp.json exists but is not a regular file — no MCP servers loaded".to_string(),
            ),
        }
    }

    for diagnostic in &diagnostics {
        log_warn!("[Plugins] \"{}\": {}", id, diagnostic);
    }
    entry.diagnostics = diagnostics;
    Some(entry)
}

/// `path.join(dir, name)` for a plain name.
fn join(dir: &str, name: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), name)
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
    let parsed = match crate::ai::mcp::json_parse(raw) {
        Ok(parsed) => parsed,
        Err(error) => {
            return ValidationResult::Err {
                error: format!("plugin.json is not valid JSON ({error})"),
            };
        }
    };
    let Value::Object(obj) = parsed else {
        return ValidationResult::Err {
            error: "plugin.json must contain a JSON object".to_string(),
        };
    };
    let mut diagnostics = Vec::new();

    // `$schema` selects the rules to validate by; it is never fetched (spec §5.2).
    let schema = obj.get("$schema").and_then(Value::as_str);
    if !schema.is_some_and(|s| SUPPORTED_PLUGIN_SCHEMAS.contains(&s)) {
        // Distinguish "an Agent Plugin targeting a version we don't implement" from
        // "not an Agent Plugins manifest at all" — different problems, different fixes.
        if let Some(schema) = schema.filter(|s| s.starts_with(PLUGIN_SCHEMA_PREFIX)) {
            return ValidationResult::Err {
                error: format!(
                    "unsupported Agent Plugins version — plugin.json declares \"{schema}\", this runtime implements \"{PLUGIN_SCHEMA_1_0_0}\""
                ),
            };
        }
        return ValidationResult::Err {
            error: format!(
                "plugin.json is not an Agent Plugins manifest (expected $schema \"{PLUGIN_SCHEMA_1_0_0}\")"
            ),
        };
    }

    let name_value = obj.get("name").cloned().unwrap_or(Value::Null);
    if !obj.contains_key("name") || !is_valid_plugin_name(&name_value) {
        return ValidationResult::Err {
            error: "plugin.json \"name\" must be 1-64 characters of lowercase letters, digits, \"-\" or \".\", starting and ending alphanumeric, with no \"--\" or \"..\"".to_string(),
        };
    }

    // Optional metadata is loosely validated on purpose (spec §5.4): a `version`
    // that isn't semver or a `license` that isn't SPDX must not reject a plugin.
    // Only the declared *type* is enforced.
    for field in [
        "version",
        "description",
        "homepage",
        "repository",
        "license",
    ] {
        if obj.get(field).is_some_and(|v| !v.is_string()) {
            return ValidationResult::Err {
                error: format!("plugin.json \"{field}\" must be a string"),
            };
        }
    }
    if let Some(keywords) = obj.get("keywords") {
        let all_strings = keywords
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string));
        if !all_strings {
            return ValidationResult::Err {
                error: "plugin.json \"keywords\" must be an array of strings".to_string(),
            };
        }
    }
    if obj.get("author").is_some_and(|author| !author.is_object()) {
        return ValidationResult::Err {
            error: "plugin.json \"author\" must be an object".to_string(),
        };
    }

    // Non-fatal: reported so a typo is diagnosable rather than silently dropped.
    // Contents are never validated — a namespace we don't implement is ignored
    // wholesale (spec §8.1), which is what keeps a plugin portable across clients.
    if obj.get("extensions").is_some_and(|ext| !ext.is_object()) {
        diagnostics.push("ignoring \"extensions\": expected an object".to_string());
    }

    let mut unknown: Vec<&String> = obj
        .keys()
        .filter(|k| !MANIFEST_FIELDS.contains(&k.as_str()))
        .collect();
    if !unknown.is_empty() {
        unknown.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        diagnostics.push(format!(
            "ignoring unknown plugin.json field(s): {}",
            unknown
                .iter()
                .map(|k| k.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let name = name_value.as_str().unwrap_or_default().to_string();
    if name != id {
        // Not a problem — `id` addresses the plugin, `name` is display — but a
        // mismatch is worth surfacing since most authors expect them to agree.
        diagnostics.push(format!(
            "manifest name \"{name}\" differs from directory name \"{id}\""
        ));
    }

    ValidationResult::Ok {
        manifest: Manifest {
            name,
            version: obj
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string),
            description: obj
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        diagnostics,
    }
}

pub static PLUGIN_CATALOG_SERVICE: LazyLock<PluginCatalogService> =
    LazyLock::new(PluginCatalogService::new);

/// A data dir of its own for a test: `PRISM_DATA_DIR`, `PRISM_PLUGINS_DIR` and
/// `PRISM_SKILLS_DIR` point into a temp dir until the guard drops, and the local
/// environment serves them. Tests that use it run `#[serial_test::serial]`.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use serde_json::json;

    const VARS: [&str; 3] = ["PRISM_DATA_DIR", "PRISM_PLUGINS_DIR", "PRISM_SKILLS_DIR"];

    pub(crate) struct TestDataDir {
        pub root: tempfile::TempDir,
        pub plugins_dir: String,
        pub skills_dir: String,
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl TestDataDir {
        pub(crate) fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let base = root.path().to_string_lossy().into_owned();
            let plugins_dir = format!("{base}/plugins");
            let skills_dir = format!("{base}/skills");
            std::fs::create_dir_all(&plugins_dir).unwrap();
            let saved = VARS.iter().map(|v| (*v, std::env::var(v).ok())).collect();
            // SAFETY: tests that change these run serially.
            unsafe {
                std::env::set_var("PRISM_DATA_DIR", &base);
                std::env::set_var("PRISM_PLUGINS_DIR", &plugins_dir);
                std::env::set_var("PRISM_SKILLS_DIR", &skills_dir);
            }
            crate::lib::execution_environments::get_execution_environment::set_execution_environment_for_tests(None);
            PLUGIN_CATALOG_SERVICE.invalidate();
            TestDataDir {
                root,
                plugins_dir,
                skills_dir,
                saved,
            }
        }

        pub(crate) fn base(&self) -> String {
            self.root.path().to_string_lossy().into_owned()
        }

        /// A plugin directory holding the given manifest text.
        pub(crate) fn write_plugin(&self, id: &str, manifest: &str) -> String {
            let dir = format!("{}/{id}", self.plugins_dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(format!("{dir}/plugin.json"), manifest).unwrap();
            dir
        }
    }

    impl Drop for TestDataDir {
        fn drop(&mut self) {
            for (var, value) in &self.saved {
                // SAFETY: tests that change these run serially.
                unsafe {
                    match value {
                        Some(value) => std::env::set_var(var, value),
                        None => std::env::remove_var(var),
                    }
                }
            }
            PLUGIN_CATALOG_SERVICE.invalidate();
        }
    }

    /// A minimal valid manifest, with extra fields.
    pub(crate) fn manifest(name: &str, extra: serde_json::Value) -> String {
        let mut value = json!({ "$schema": PLUGIN_SCHEMA_1_0_0, "name": name });
        if let serde_json::Value::Object(extra) = extra {
            for (k, v) in extra {
                value[&k] = v;
            }
        }
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{TestDataDir, manifest};
    use super::*;
    use serde_json::json;
    use serial_test::serial;

    fn ids(plugins: &[PluginEntry]) -> Vec<&str> {
        plugins.iter().map(|p| p.id.as_str()).collect()
    }

    fn ok(raw: &str, id: &str) -> (Manifest, Vec<String>) {
        match validate_manifest(raw, id) {
            ValidationResult::Ok {
                manifest,
                diagnostics,
            } => (manifest, diagnostics),
            ValidationResult::Err { error } => panic!("rejected: {error}"),
        }
    }

    fn rejected(raw: &str) -> String {
        match validate_manifest(raw, "demo") {
            ValidationResult::Err { error } => error,
            ValidationResult::Ok { .. } => panic!("accepted: {raw}"),
        }
    }

    #[tokio::test]
    #[serial]
    async fn loads_a_minimal_plugin_with_only_the_two_required_fields() {
        let data = TestDataDir::new();
        let dir = data.write_plugin("demo", &manifest("demo", json!({})));

        let plugins = PLUGIN_CATALOG_SERVICE.get_plugins().await;

        assert_eq!(
            plugins,
            vec![PluginEntry {
                id: "demo".into(),
                name: "demo".into(),
                version: None,
                description: None,
                dir,
                skills_dir: None,
                mcp_config_path: None,
                diagnostics: vec![],
            }]
        );
    }

    #[tokio::test]
    #[serial]
    async fn records_the_fixed_component_locations_when_they_exist() {
        let data = TestDataDir::new();
        let dir = data.write_plugin(
            "demo",
            &manifest(
                "demo",
                json!({ "version": "1.2.0", "description": "A demo" }),
            ),
        );
        std::fs::create_dir_all(format!("{dir}/skills/greet")).unwrap();
        std::fs::write(format!("{dir}/mcp.json"), "{}").unwrap();

        let plugin = &PLUGIN_CATALOG_SERVICE.get_plugins().await[0];

        assert_eq!(plugin.version.as_deref(), Some("1.2.0"));
        assert_eq!(plugin.description.as_deref(), Some("A demo"));
        assert_eq!(plugin.skills_dir, Some(format!("{dir}/skills")));
        assert_eq!(plugin.mcp_config_path, Some(format!("{dir}/mcp.json")));
    }

    #[tokio::test]
    #[serial]
    async fn returns_plugins_in_directory_name_order() {
        let data = TestDataDir::new();
        data.write_plugin("zeta", &manifest("zeta", json!({})));
        data.write_plugin("alpha", &manifest("alpha", json!({})));

        assert_eq!(
            ids(&PLUGIN_CATALOG_SERVICE.get_plugins().await),
            vec!["alpha", "zeta"]
        );
    }

    #[tokio::test]
    #[serial]
    async fn skips_a_directory_with_no_plugin_json() {
        let data = TestDataDir::new();
        std::fs::create_dir_all(format!("{}/not-a-plugin", data.plugins_dir)).unwrap();

        assert!(PLUGIN_CATALOG_SERVICE.get_plugins().await.is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn skips_a_malformed_plugin_without_affecting_its_siblings() {
        let data = TestDataDir::new();
        data.write_plugin("broken", "{ not json");
        data.write_plugin("good", &manifest("good", json!({})));

        assert_eq!(
            ids(&PLUGIN_CATALOG_SERVICE.get_plugins().await),
            vec!["good"]
        );
    }

    #[tokio::test]
    #[serial]
    async fn disables_only_the_skills_component_when_skills_is_not_a_directory() {
        let data = TestDataDir::new();
        let dir = data.write_plugin("demo", &manifest("demo", json!({})));
        std::fs::write(format!("{dir}/skills"), "oops").unwrap();
        std::fs::write(format!("{dir}/mcp.json"), "{}").unwrap();

        let plugin = &PLUGIN_CATALOG_SERVICE.get_plugins().await[0];

        assert_eq!(plugin.skills_dir, None);
        assert_eq!(plugin.mcp_config_path, Some(format!("{dir}/mcp.json")));
        assert_eq!(
            plugin.diagnostics,
            vec!["skills exists but is not a directory — no skills loaded"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial]
    async fn survives_a_component_that_cannot_be_stat_ed() {
        let data = TestDataDir::new();
        let dir = data.write_plugin("demo", &manifest("demo", json!({})));
        std::os::unix::fs::symlink("skills", format!("{dir}/skills")).unwrap();
        std::fs::write(format!("{dir}/mcp.json"), "{}").unwrap();

        let plugins = PLUGIN_CATALOG_SERVICE.get_plugins().await;

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].skills_dir, None);
        assert_eq!(plugins[0].mcp_config_path, Some(format!("{dir}/mcp.json")));
        assert_eq!(
            plugins[0].diagnostics,
            vec!["skills cannot be read — no skills loaded"]
        );
    }

    #[tokio::test]
    #[serial]
    async fn rescans_when_the_plugins_dir_changes() {
        let data = TestDataDir::new();
        data.write_plugin("one", &manifest("one", json!({})));
        assert_eq!(PLUGIN_CATALOG_SERVICE.get_plugins().await.len(), 1);

        data.write_plugin("two", &manifest("two", json!({})));
        assert_eq!(PLUGIN_CATALOG_SERVICE.get_plugins().await.len(), 2);
    }

    #[tokio::test]
    #[serial]
    async fn notices_a_plugin_corrected_in_place() {
        let data = TestDataDir::new();
        let dir = data.write_plugin("demo", "{ not json");
        assert!(PLUGIN_CATALOG_SERVICE.get_plugins().await.is_empty());

        std::fs::write(format!("{dir}/plugin.json"), manifest("demo", json!({}))).unwrap();

        assert_eq!(
            ids(&PLUGIN_CATALOG_SERVICE.get_plugins().await),
            vec!["demo"]
        );
    }

    #[tokio::test]
    #[serial]
    async fn notices_an_mcp_json_added_to_a_loaded_plugin() {
        let data = TestDataDir::new();
        let dir = data.write_plugin("demo", &manifest("demo", json!({})));
        assert_eq!(
            PLUGIN_CATALOG_SERVICE.get_plugins().await[0].mcp_config_path,
            None
        );

        std::fs::write(format!("{dir}/mcp.json"), "{}").unwrap();

        assert_eq!(
            PLUGIN_CATALOG_SERVICE.get_plugins().await[0].mcp_config_path,
            Some(format!("{dir}/mcp.json"))
        );
    }

    #[tokio::test]
    #[serial]
    async fn is_empty_when_the_plugins_dir_does_not_exist() {
        let data = TestDataDir::new();
        // SAFETY: serial test; the guard restores the variable.
        unsafe { std::env::set_var("PRISM_PLUGINS_DIR", format!("{}/absent", data.base())) };
        PLUGIN_CATALOG_SERVICE.invalidate();

        assert!(PLUGIN_CATALOG_SERVICE.get_plugins().await.is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn finds_a_plugin_by_its_directory_id() {
        let data = TestDataDir::new();
        data.write_plugin("demo", &manifest("demo", json!({})));

        assert_eq!(
            PLUGIN_CATALOG_SERVICE.find("demo").await.map(|p| p.name),
            Some("demo".to_string())
        );
        assert_eq!(PLUGIN_CATALOG_SERVICE.find("missing").await, None);
    }

    #[test]
    fn accepts_the_minimal_manifest() {
        let (manifest, diagnostics) = ok(&manifest("demo", json!({})), "demo");
        assert_eq!(manifest.name, "demo");
        assert!(diagnostics.is_empty());
    }

    #[test]
    fn rejects_a_manifest_for_a_version_not_implemented_naming_it() {
        let error = rejected(
            &json!({
                "$schema": "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
                "name": "demo",
            })
            .to_string(),
        );
        assert_eq!(
            error,
            format!(
                "unsupported Agent Plugins version — plugin.json declares \"https://agent-plugins.org/schemas/2.0.0/plugin.schema.json\", this runtime implements \"{PLUGIN_SCHEMA_1_0_0}\""
            )
        );
    }

    #[test]
    fn tells_a_foreign_plugin_json_from_an_unsupported_version() {
        let error = rejected(
            &json!({ "$schema": "https://example.com/other.json", "name": "demo" }).to_string(),
        );
        assert!(error.contains("not an Agent Plugins manifest"));
    }

    #[test]
    fn rejects_a_missing_schema() {
        rejected(&json!({ "name": "demo" }).to_string());
    }

    #[test]
    fn rejects_invalid_names() {
        let long = "a".repeat(65);
        for name in [
            "My-Plugin",
            "-start",
            "end-",
            "has--double",
            "too.many..dots",
            "",
            long.as_str(),
        ] {
            assert!(!is_valid_plugin_name(&json!(name)), "{name}");
            rejected(&json!({ "$schema": PLUGIN_SCHEMA_1_0_0, "name": name }).to_string());
        }
    }

    #[test]
    fn accepts_valid_names() {
        for name in ["my-plugin", "acme.tools", "lint3r", "a"] {
            assert!(is_valid_plugin_name(&json!(name)), "{name}");
        }
    }

    #[test]
    fn reports_unknown_top_level_fields_but_still_loads() {
        let (_, diagnostics) = ok(
            &manifest("demo", json!({ "hooks": "./hooks", "commands": [] })),
            "demo",
        );
        assert_eq!(
            diagnostics,
            vec!["ignoring unknown plugin.json field(s): commands, hooks"]
        );
    }

    #[test]
    fn reports_a_non_object_extensions_field_but_still_loads() {
        let (_, diagnostics) = ok(&manifest("demo", json!({ "extensions": "nope" })), "demo");
        assert_eq!(
            diagnostics,
            vec!["ignoring \"extensions\": expected an object"]
        );
    }

    #[test]
    fn never_validates_the_contents_of_an_extension_namespace() {
        let (_, diagnostics) = ok(
            &manifest(
                "demo",
                json!({ "extensions": { "com.example.client": { "anything": [1, 2] } } }),
            ),
            "demo",
        );
        assert!(diagnostics.is_empty());
    }

    #[test]
    fn accepts_loose_metadata() {
        ok(
            &manifest(
                "demo",
                json!({ "version": "release-2026-07", "license": "whatever" }),
            ),
            "demo",
        );
    }

    #[test]
    fn rejects_metadata_of_the_wrong_type() {
        assert_eq!(
            rejected(&manifest("demo", json!({ "version": 12 }))),
            "plugin.json \"version\" must be a string"
        );
        assert_eq!(
            rejected(&manifest("demo", json!({ "keywords": "not-an-array" }))),
            "plugin.json \"keywords\" must be an array of strings"
        );
        assert_eq!(
            rejected(&manifest("demo", json!({ "author": "someone" }))),
            "plugin.json \"author\" must be an object"
        );
    }

    #[test]
    fn notes_a_manifest_name_that_differs_from_the_directory_name() {
        let (_, diagnostics) = ok(&manifest("other-name", json!({})), "demo");
        assert_eq!(
            diagnostics,
            vec!["manifest name \"other-name\" differs from directory name \"demo\""]
        );
    }

    #[test]
    fn rejects_a_manifest_that_is_not_a_json_object() {
        assert_eq!(rejected("[]"), "plugin.json must contain a JSON object");
        assert_eq!(
            rejected("\"a string\""),
            "plugin.json must contain a JSON object"
        );
    }

    #[test]
    fn names_the_parse_error_of_invalid_json() {
        assert!(rejected("{ not json").starts_with("plugin.json is not valid JSON ("));
    }
}
