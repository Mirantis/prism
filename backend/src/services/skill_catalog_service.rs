//! Skill Catalog Service
//!
//! Discovers Agent Skills (the open standard at agentskills.io) and exposes them
//! to the prism agent loop with progressive disclosure:
//!   - the CATALOG holds only each skill's `name` + `description` (cheap; goes
//!     into the system prompt so the model knows what's available);
//!   - the full SKILL.md BODY is read on demand via `get_skill_body()` (the `skill`
//!     tool / manual trigger), never up front.
//!
//! Skills come from three kinds of source, in precedence order:
//!   1. WORKSPACE — the repo the CLI was started in: `<workspaceRoot>/.claude/skills`
//!      then `<workspaceRoot>/.agents/skills` (only when a workspaceRoot is given).
//!   2. GLOBAL — the persistent `<DATA>/skills` dir (always).
//!   3. PLUGIN — the `skills/` dir of each installed Agent Plugin (always).
//!
//! On a name collision the higher-precedence source wins (workspace over global,
//! `.claude` over `.agents`), matching Claude Code's project > personal model.
//! Plugins rank last deliberately: a plugin can contribute a skill but can never
//! shadow one the user installed themselves.
//!
//! A skill is a folder under a skills dir containing a `SKILL.md` with YAML
//! frontmatter. Only `name` and `description` are required by the standard.
//! Parsing is deliberately lenient (see `parse_frontmatter`) so one malformed
//! skill never breaks the catalog. Each scanned directory is cached and refreshed
//! when its mtime changes, so a skill the user drops in appears without a restart.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::lib::execution_environments::execution_environment::{DirEntry, ExecutionFiles};
use crate::lib::execution_environments::get_execution_environment::{
    files_for, get_execution_environment,
};
use crate::log_warn;
use crate::services::plugin_catalog_service::PLUGIN_CATALOG_SERVICE;
use crate::support::js;
use indexmap::IndexMap;

/// The filesystem holding a path. A thread rooted in a host repository has its
/// workspace skills on the host even when the deployment runs in a container.
fn files(dir: &str) -> Arc<dyn ExecutionFiles> {
    files_for(dir)
}

/// Where a skill was discovered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    Workspace,
    Global,
    Plugin,
}

impl SkillSource {
    pub fn as_str(self) -> &'static str {
        match self {
            SkillSource::Workspace => "workspace",
            SkillSource::Global => "global",
            SkillSource::Plugin => "plugin",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    /// Frontmatter `name` — the authoritative key used to invoke the skill.
    pub name: String,
    /// On-disk folder name (may differ from `name`).
    pub dir_name: String,
    pub description: String,
    /// Absolute path to the skill bundle directory.
    pub dir: String,
    /// Absolute path to the bundle's SKILL.md.
    pub skill_md_path: String,
    /// Whether this skill came from the workspace repo, the global dir, or a plugin.
    pub source: SkillSource,
    /// The contributing plugin's id — set only when `source` is `Plugin`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

/// A skill and its SKILL.md body with the frontmatter removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBody {
    pub entry: SkillEntry,
    pub body: String,
}

#[derive(Debug, Clone)]
struct CachedDir {
    /// `-1` for a directory that does not exist.
    mtime_ms: f64,
    entries: Vec<SkillEntry>,
}

/// A directory to scan, paired with the source label its skills get.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillRoot {
    dir: String,
    source: SkillSource,
    /// Set for plugin roots so each entry can name its contributing plugin.
    plugin_id: Option<String>,
}

/// Generous cap on how much of SKILL.md we read just to extract frontmatter.
const FRONTMATTER_READ_LIMIT: usize = 16 * 1024;

pub struct SkillCatalogService {
    /// Per-directory cache so the global dir stays cached across turns while each
    /// workspace dir caches independently by path.
    cache: Mutex<HashMap<String, CachedDir>>,
}

impl SkillCatalogService {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The directories to scan, in precedence order: workspace first (when a
    /// workspace root is given, trimmed and resolved), then the global dir, then
    /// each installed plugin's `skills/`. `.claude/skills` ranks above
    /// `.agents/skills` so the Claude-native location wins a name clash, and
    /// plugin roots come last so a plugin never shadows a skill the user
    /// installed. Plugins are enumerated in id order, so a clash between two
    /// plugins resolves the same way on every boot.
    async fn roots(&self, workspace_root: Option<&str>) -> Vec<SkillRoot> {
        let mut roots = Vec::new();
        let trimmed = workspace_root.map(js::trim).filter(|t| !t.is_empty());
        if let Some(trimmed) = trimmed {
            let ws = resolve_path(trimmed);
            roots.push(SkillRoot {
                dir: join(&ws, ".claude/skills"),
                source: SkillSource::Workspace,
                plugin_id: None,
            });
            roots.push(SkillRoot {
                dir: join(&ws, ".agents/skills"),
                source: SkillSource::Workspace,
                plugin_id: None,
            });
        }
        roots.push(SkillRoot {
            dir: get_execution_environment().paths().skills_dir,
            source: SkillSource::Global,
            plugin_id: None,
        });
        for plugin in PLUGIN_CATALOG_SERVICE.get_plugins().await {
            if let Some(skills_dir) = plugin.skills_dir {
                roots.push(SkillRoot {
                    dir: skills_dir,
                    source: SkillSource::Plugin,
                    plugin_id: Some(plugin.id),
                });
            }
        }
        roots
    }

    /// Merged skill catalog (name + description). Cheap to call repeatedly: each
    /// directory re-scans only when its mtime changes, otherwise its cached entries
    /// are reused after a single `stat`. Across directories, the first occurrence
    /// of a name wins (workspace over global, `.claude` over `.agents`); names
    /// compare case-insensitively.
    pub async fn get_catalog(&self, workspace_root: Option<&str>) -> Vec<SkillEntry> {
        let mut by_name: IndexMap<String, SkillEntry> = IndexMap::new();
        for root in self.roots(workspace_root).await {
            for entry in self.scan_cached(&root).await {
                let key = entry.name.to_lowercase();
                if !by_name.contains_key(&key) {
                    by_name.insert(key, entry);
                }
            }
        }
        by_name.into_values().collect()
    }

    /// Force a rescan of every directory on the next `get_catalog()` call.
    pub fn invalidate(&self) {
        self.cache.lock().clear();
    }

    /// Look up a skill by its frontmatter name (case-insensitive).
    pub async fn find(&self, name: &str, workspace_root: Option<&str>) -> Option<SkillEntry> {
        let key = js::trim(name).to_lowercase();
        self.get_catalog(workspace_root)
            .await
            .into_iter()
            .find(|s| s.name.to_lowercase() == key)
    }

    /// Read a skill's full SKILL.md body (frontmatter stripped), fresh from disk —
    /// so an in-place edit to the body is always reflected. Returns `None` when the
    /// named skill isn't installed; fails when SKILL.md cannot be read.
    pub async fn get_skill_body(
        &self,
        name: &str,
        workspace_root: Option<&str>,
    ) -> anyhow::Result<Option<SkillBody>> {
        let Some(entry) = self.find(name, workspace_root).await else {
            return Ok(None);
        };
        let raw = files(&entry.skill_md_path)
            .read_text(&entry.skill_md_path, None)
            .await?;
        Ok(Some(SkillBody {
            entry,
            body: strip_frontmatter(&raw),
        }))
    }

    /// Scan one root, reusing the cached entries when its mtime is unchanged. A
    /// directory that doesn't exist (e.g. a repo with no `.agents/skills`) caches
    /// `{ mtime_ms: -1, entries: [] }` and scans as empty.
    async fn scan_cached(&self, root: &SkillRoot) -> Vec<SkillEntry> {
        let mtime_ms = match files(&root.dir).stat(&root.dir).await {
            Ok(st) => st.mtime_ms,
            Err(_) => {
                self.cache.lock().insert(
                    root.dir.clone(),
                    CachedDir {
                        mtime_ms: -1.0,
                        entries: Vec::new(),
                    },
                );
                return Vec::new();
            }
        };
        if let Some(cached) = self
            .cache
            .lock()
            .get(&root.dir)
            .filter(|c| c.mtime_ms == mtime_ms)
        {
            return cached.entries.clone();
        }
        let entries = self.scan(root).await;
        self.cache.lock().insert(
            root.dir.clone(),
            CachedDir {
                mtime_ms,
                entries: entries.clone(),
            },
        );
        entries
    }

    /// Scan one root: directories and symlinks, sorted by folder name; the first
    /// one wins on a name clash.
    ///
    /// SKILL.md is `lstat`ed so one that is itself a symlink is rejected (warn
    /// `[Skills] skipping "<dir>": SKILL.md is a symlink`) — that would let a
    /// bundle read an arbitrary file outside the skills dir. A symlinked *bundle
    /// directory* is still fine. Only `min(FRONTMATTER_READ_LIMIT, size)` bytes are
    /// read. A bundle without `name` or `description` warns `[Skills] skipping
    /// "<dir>": SKILL.md missing name/description`; a duplicate name warns
    /// `[Skills] duplicate skill name "<name>" (dir <dir>) — keeping the first by
    /// sort order`.
    async fn scan(&self, root: &SkillRoot) -> Vec<SkillEntry> {
        let dir = &root.dir;
        let dirents: Vec<DirEntry> = match files(dir).read_dir(dir).await {
            Ok(dirents) => dirents,
            Err(_) => return Vec::new(),
        };
        let mut subdirs: Vec<String> = dirents
            .into_iter()
            .filter(|d| d.is_directory || d.is_symbolic_link)
            .map(|d| d.name)
            .collect();
        subdirs.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));

        let mut by_name: IndexMap<String, SkillEntry> = IndexMap::new();
        for dir_name in subdirs {
            let bundle_dir = join(dir, &dir_name);
            let skill_md_path = join(&bundle_dir, "SKILL.md");
            let skill_files = files(&skill_md_path);

            // lstat the final component so a SKILL.md that is itself a symlink is
            // rejected — that would let a bundle read an arbitrary file outside the
            // skills dir. A symlinked *bundle directory* is still fine (lstat
            // traverses the intermediate dir symlink and sees a real SKILL.md).
            // No SKILL.md is not a skill bundle.
            let Ok(st) = skill_files.lstat(&skill_md_path).await else {
                continue;
            };
            if st.is_symbolic_link {
                log_warn!("[Skills] skipping \"{}\": SKILL.md is a symlink", dir_name);
                continue;
            }
            if !st.is_file {
                continue;
            }
            let max_bytes = FRONTMATTER_READ_LIMIT.min(st.size as usize);
            let Ok(head) = skill_files.read_text(&skill_md_path, Some(max_bytes)).await else {
                continue;
            };

            let fm = parse_frontmatter(&head);
            let (Some(name), Some(description)) = (
                fm.name.filter(|n| !n.is_empty()),
                fm.description.filter(|d| !d.is_empty()),
            ) else {
                log_warn!(
                    "[Skills] skipping \"{}\": SKILL.md missing name/description",
                    dir_name
                );
                continue;
            };
            let key = name.to_lowercase();
            if by_name.contains_key(&key) {
                log_warn!(
                    "[Skills] duplicate skill name \"{}\" (dir {}) — keeping the first by sort order",
                    name,
                    dir_name
                );
                continue;
            }
            by_name.insert(
                key,
                SkillEntry {
                    name,
                    dir_name,
                    description,
                    dir: bundle_dir,
                    skill_md_path,
                    source: root.source,
                    plugin_id: root.plugin_id.clone().filter(|id| !id.is_empty()),
                },
            );
        }
        by_name.into_values().collect()
    }
}

impl Default for SkillCatalogService {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (lenient)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
}

static FRONTMATTER_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*---\s*\n([\s\S]*?)\n---\s*(?:\n|$)").unwrap());

/// A top-level `key: value` line. `.` in JavaScript stops at `\r`, ` ` and
/// ` ` as well as `\n`, so the value class excludes them too.
static FRONTMATTER_LINE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("^([A-Za-z][A-Za-z0-9_-]*)\\s*:\\s?([^\\n\\r\\u{2028}\\u{2029}]*)$").unwrap()
});

static INDENTED_LINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s+\S").unwrap());

/// `path.resolve(path)`: against the process cwd, with `.` and `..` removed.
fn resolve_path(path: &str) -> String {
    let mut joined = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
    joined.push(path);
    let mut out = std::path::PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

/// `path.join(dir, rest)` for a relative `rest`.
fn join(dir: &str, rest: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), rest)
}

/// The text after a leading byte-order mark.
fn strip_bom(raw: &str) -> &str {
    raw.strip_prefix('\u{FEFF}').unwrap_or(raw)
}

/// The text between the first pair of `---` fences, or `""` when absent.
fn extract_frontmatter_block(raw: &str) -> String {
    let text = strip_bom(raw);
    FRONTMATTER_BLOCK_RE
        .captures(text)
        .map(|caps| caps[1].to_string())
        .unwrap_or_default()
}

/// Pull only `name` and `description` out of the frontmatter, splitting each
/// top-level line on its FIRST colon. This tolerates the common spec gotcha of
/// an unquoted colon inside `description` (e.g. `description: Use when X: do Y`),
/// which a strict YAML parser would reject. Surrounding quotes are stripped and
/// simple `|`/`>` block scalars are folded into a single line.
fn parse_frontmatter(raw: &str) -> Frontmatter {
    let block = extract_frontmatter_block(raw);
    if block.is_empty() {
        return Frontmatter::default();
    }
    let lines: Vec<&str> = block.split('\n').collect();
    let mut out = Frontmatter::default();
    for (i, line) in lines.iter().enumerate() {
        // Only top-level keys (no leading indentation) — skips nested maps.
        let Some(caps) = FRONTMATTER_LINE_RE.captures(line) else {
            continue;
        };
        let key = caps[1].to_lowercase();
        if key != "name" && key != "description" {
            continue;
        }
        let mut value = caps[2].to_string();
        if value == "|" || value == ">" || value == "|-" || value == ">-" {
            let mut collected: Vec<&str> = Vec::new();
            for next in &lines[i + 1..] {
                if js::trim(next).is_empty() || INDENTED_LINE_RE.is_match(next) {
                    collected.push(js::trim(next));
                } else {
                    break;
                }
            }
            value = collected.join(" ");
        }
        let value = unquote(js::trim(&value)).to_string();
        if key == "name" {
            out.name = Some(value);
        } else {
            out.description = Some(value);
        }
    }
    out
}

fn unquote(v: &str) -> &str {
    if v.chars().count() >= 2 {
        let first = v.chars().next();
        let last = v.chars().last();
        if (first == Some('"') && last == Some('"')) || (first == Some('\'') && last == Some('\''))
        {
            return &v[1..v.len() - 1];
        }
    }
    v
}

/// Return SKILL.md content with the leading frontmatter block removed.
fn strip_frontmatter(raw: &str) -> String {
    let text = strip_bom(raw);
    static BLOCK_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*---\s*\n[\s\S]*?\n---\s*(?:\n|$)").unwrap());
    match BLOCK_RE.find(text) {
        Some(m) => js::trim(&text[m.end()..]).to_string(),
        None => js::trim(text).to_string(),
    }
}

pub static SKILL_CATALOG_SERVICE: LazyLock<SkillCatalogService> =
    LazyLock::new(SkillCatalogService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::plugin_catalog_service::test_support::{TestDataDir, manifest};
    use serde_json::json;
    use serial_test::serial;

    struct Fixture {
        data: TestDataDir,
        workspace_root: String,
    }

    impl Fixture {
        fn new() -> Self {
            let data = TestDataDir::new();
            std::fs::create_dir_all(&data.skills_dir).unwrap();
            let workspace_root = format!("{}/repo", data.base());
            std::fs::create_dir_all(&workspace_root).unwrap();
            SKILL_CATALOG_SERVICE.invalidate();
            Fixture {
                data,
                workspace_root,
            }
        }

        fn write_skill(&self, dir_name: &str, content: &str) {
            let dir = format!("{}/{dir_name}", self.data.skills_dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(format!("{dir}/SKILL.md"), content).unwrap();
            SKILL_CATALOG_SERVICE.invalidate();
        }

        /// A plugin that contributes one skill.
        fn write_plugin_skill(&self, plugin_id: &str, dir_name: &str, content: &str) {
            let root = self
                .data
                .write_plugin(plugin_id, &manifest(plugin_id, json!({})));
            std::fs::create_dir_all(format!("{root}/skills/{dir_name}")).unwrap();
            std::fs::write(format!("{root}/skills/{dir_name}/SKILL.md"), content).unwrap();
            SKILL_CATALOG_SERVICE.invalidate();
            PLUGIN_CATALOG_SERVICE.invalidate();
        }

        fn write_workspace_skill(&self, sub: &str, dir_name: &str, content: &str) {
            let dir = format!("{}/{sub}/skills/{dir_name}", self.workspace_root);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(format!("{dir}/SKILL.md"), content).unwrap();
            SKILL_CATALOG_SERVICE.invalidate();
        }

        fn ws(&self) -> Option<&str> {
            Some(self.workspace_root.as_str())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            SKILL_CATALOG_SERVICE.invalidate();
        }
    }

    fn skill(name: &str, description: &str, body: &str) -> String {
        format!("---\nname: {name}\ndescription: {description}\n---\n{body}")
    }

    fn names(catalog: &[SkillEntry]) -> Vec<&str> {
        catalog.iter().map(|s| s.name.as_str()).collect()
    }

    #[tokio::test]
    #[serial]
    async fn lists_a_well_formed_skill_with_name_and_description() {
        let fx = Fixture::new();
        fx.write_skill(
            "pdf-processing",
            "---\nname: pdf-processing\ndescription: Extract text from PDFs.\n---\n\nDo the thing.\n",
        );

        let catalog = SKILL_CATALOG_SERVICE.get_catalog(None).await;

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "pdf-processing");
        assert_eq!(catalog[0].dir_name, "pdf-processing");
        assert_eq!(catalog[0].description, "Extract text from PDFs.");
        assert_eq!(catalog[0].source, SkillSource::Global);
        assert_eq!(
            serde_json::to_value(&catalog[0]).unwrap().get("pluginId"),
            None
        );
    }

    #[tokio::test]
    #[serial]
    async fn tolerates_an_unquoted_colon_in_the_description() {
        let fx = Fixture::new();
        fx.write_skill(
            "colon",
            &skill("colon", "Use when X: then do Y.", "\nbody\n"),
        );

        let catalog = SKILL_CATALOG_SERVICE.get_catalog(None).await;

        assert_eq!(catalog[0].description, "Use when X: then do Y.");
    }

    #[tokio::test]
    #[serial]
    async fn skips_a_skill_missing_name_or_description() {
        let fx = Fixture::new();
        fx.write_skill("no-desc", "---\nname: no-desc\n---\n\nbody\n");
        fx.write_skill("no-name", "---\ndescription: orphan\n---\n\nbody\n");
        fx.write_skill("ok", &skill("ok", "fine", "\nbody\n"));

        assert_eq!(
            names(&SKILL_CATALOG_SERVICE.get_catalog(None).await),
            vec!["ok"]
        );
    }

    #[tokio::test]
    #[serial]
    async fn is_empty_when_no_skills_are_installed_or_the_dir_is_absent() {
        let fx = Fixture::new();
        assert!(SKILL_CATALOG_SERVICE.get_catalog(None).await.is_empty());

        std::fs::remove_dir_all(&fx.data.skills_dir).unwrap();
        SKILL_CATALOG_SERVICE.invalidate();
        assert!(SKILL_CATALOG_SERVICE.get_catalog(None).await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial]
    async fn skips_a_skill_whose_skill_md_is_a_symlink() {
        let fx = Fixture::new();
        let secret = format!("{}/secret.md", fx.data.base());
        std::fs::write(&secret, skill("evil", "leaked", "secret body\n")).unwrap();
        let dir = format!("{}/evil", fx.data.skills_dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&secret, format!("{dir}/SKILL.md")).unwrap();
        fx.write_skill("ok", &skill("ok", "fine", "body\n"));

        assert_eq!(
            names(&SKILL_CATALOG_SERVICE.get_catalog(None).await),
            vec!["ok"]
        );
    }

    #[tokio::test]
    #[serial]
    async fn keeps_the_first_by_sorted_dir_name_on_a_name_collision() {
        let fx = Fixture::new();
        fx.write_skill("a-dir", &skill("dup", "from a", "body\n"));
        fx.write_skill("b-dir", &skill("dup", "from b", "body\n"));

        let catalog = SKILL_CATALOG_SERVICE.get_catalog(None).await;

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].dir_name, "a-dir");
        assert_eq!(catalog[0].description, "from a");
    }

    #[tokio::test]
    #[serial]
    async fn finds_a_skill_case_insensitively_and_reads_its_body() {
        let fx = Fixture::new();
        fx.write_skill(
            "greet",
            &skill("greet", "say hi", "\n# Greet\n\nSay hello to the user.\n"),
        );

        assert_eq!(
            SKILL_CATALOG_SERVICE
                .find("GREET", None)
                .await
                .map(|s| s.name),
            Some("greet".to_string())
        );
        assert_eq!(SKILL_CATALOG_SERVICE.find("nope", None).await, None);

        let found = SKILL_CATALOG_SERVICE
            .get_skill_body("greet", None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.body, "# Greet\n\nSay hello to the user.");
        assert!(
            SKILL_CATALOG_SERVICE
                .get_skill_body("missing", None)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    #[serial]
    async fn merges_a_plugin_skills_dir_tagged_with_its_plugin() {
        let fx = Fixture::new();
        fx.write_plugin_skill(
            "demo",
            "summarize",
            &skill("summarize", "Summarize.", "body\n"),
        );

        let catalog = SKILL_CATALOG_SERVICE.get_catalog(None).await;

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "summarize");
        assert_eq!(catalog[0].source, SkillSource::Plugin);
        assert_eq!(catalog[0].plugin_id.as_deref(), Some("demo"));
    }

    #[tokio::test]
    #[serial]
    async fn loads_a_plugin_skill_body() {
        let fx = Fixture::new();
        fx.write_plugin_skill(
            "demo",
            "summarize",
            &skill("summarize", "s", "# Sum\n\nDo it.\n"),
        );

        let found = SKILL_CATALOG_SERVICE
            .get_skill_body("summarize", None)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(found.entry.plugin_id.as_deref(), Some("demo"));
        assert_eq!(found.body, "# Sum\n\nDo it.");
    }

    #[tokio::test]
    #[serial]
    async fn ignores_a_plugin_whose_manifest_is_invalid() {
        let fx = Fixture::new();
        fx.write_plugin_skill("broken", "ghost", &skill("ghost", "g", "body\n"));
        std::fs::write(
            format!("{}/broken/plugin.json", fx.data.plugins_dir),
            json!({
                "$schema": "https://agent-plugins.org/schemas/9.9.9/plugin.schema.json",
                "name": "broken",
            })
            .to_string(),
        )
        .unwrap();
        PLUGIN_CATALOG_SERVICE.invalidate();

        assert!(SKILL_CATALOG_SERVICE.get_catalog(None).await.is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn resolves_a_clash_between_two_plugins_by_plugin_id_order() {
        let fx = Fixture::new();
        fx.write_plugin_skill("zeta", "dup", &skill("dup", "from zeta", "body\n"));
        fx.write_plugin_skill("alpha", "dup", &skill("dup", "from alpha", "body\n"));

        let found = SKILL_CATALOG_SERVICE.find("dup", None).await.unwrap();

        assert_eq!(found.plugin_id.as_deref(), Some("alpha"));
        assert_eq!(found.description, "from alpha");
    }

    #[tokio::test]
    #[serial]
    async fn merges_workspace_skills_with_global_ones_tagging_the_source() {
        let fx = Fixture::new();
        fx.write_skill("global-only", &skill("global-only", "g", "body\n"));
        fx.write_workspace_skill(
            ".claude",
            "repo-claude",
            &skill("repo-claude", "c", "body\n"),
        );
        fx.write_workspace_skill(
            ".agents",
            "repo-agents",
            &skill("repo-agents", "a", "body\n"),
        );

        let catalog = SKILL_CATALOG_SERVICE.get_catalog(fx.ws()).await;
        let by_source: Vec<(&str, SkillSource)> = catalog
            .iter()
            .map(|s| (s.name.as_str(), s.source))
            .collect();

        assert_eq!(
            by_source,
            vec![
                ("repo-claude", SkillSource::Workspace),
                ("repo-agents", SkillSource::Workspace),
                ("global-only", SkillSource::Global),
            ]
        );
    }

    #[tokio::test]
    #[serial]
    async fn prefers_workspace_then_claude_then_global_then_plugins_on_a_name_collision() {
        let fx = Fixture::new();
        fx.write_plugin_skill("demo", "dup", &skill("dup", "from plugin", "body\n"));
        fx.write_skill("dup", &skill("dup", "from global", "body\n"));
        fx.write_workspace_skill(".agents", "dup", &skill("dup", "from agents", "body\n"));
        fx.write_workspace_skill(".claude", "dup", &skill("dup", "from claude", "body\n"));

        let found = SKILL_CATALOG_SERVICE.find("dup", fx.ws()).await.unwrap();
        assert_eq!(
            (found.source, found.description.as_str()),
            (SkillSource::Workspace, "from claude")
        );

        let found = SKILL_CATALOG_SERVICE.find("dup", None).await.unwrap();
        assert_eq!(
            (found.source, found.description.as_str()),
            (SkillSource::Global, "from global")
        );
    }

    #[tokio::test]
    #[serial]
    async fn reads_a_workspace_skill_body_only_with_its_workspace() {
        let fx = Fixture::new();
        fx.write_workspace_skill(
            ".claude",
            "repo-skill",
            &skill("repo-skill", "c", "# Repo\n\nDo repo things.\n"),
        );

        let found = SKILL_CATALOG_SERVICE
            .get_skill_body("repo-skill", fx.ws())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.entry.source, SkillSource::Workspace);
        assert_eq!(found.body, "# Repo\n\nDo repo things.");
        assert!(
            SKILL_CATALOG_SERVICE
                .get_skill_body("repo-skill", None)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    #[serial]
    async fn falls_back_to_global_skills_when_the_workspace_has_none() {
        let fx = Fixture::new();
        fx.write_skill("global-only", &skill("global-only", "g", "body\n"));

        let catalog = SKILL_CATALOG_SERVICE.get_catalog(fx.ws()).await;

        assert_eq!(names(&catalog), vec!["global-only"]);
        assert_eq!(catalog[0].source, SkillSource::Global);
    }

    #[test]
    fn parses_simple_and_quoted_values() {
        assert_eq!(
            parse_frontmatter("---\nname: foo\ndescription: \"a: b\"\n---\nx"),
            Frontmatter {
                name: Some("foo".into()),
                description: Some("a: b".into()),
            }
        );
    }

    #[test]
    fn folds_a_block_scalar_description() {
        let fm =
            parse_frontmatter("---\nname: foo\ndescription: |\n  line one\n  line two\n---\nbody");
        assert_eq!(fm.description.as_deref(), Some("line one line two"));
    }

    #[test]
    fn ignores_nested_keys() {
        let fm = parse_frontmatter(
            "---\nname: foo\ndescription: d\nmetadata:\n  name: nested\n---\nbody",
        );
        assert_eq!(fm.name.as_deref(), Some("foo"));
    }

    #[test]
    fn strips_nothing_from_text_without_frontmatter() {
        assert_eq!(strip_frontmatter("just a body"), "just a body");
    }
}
