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
        todo!()
    }

    /// Merged skill catalog (name + description). Cheap to call repeatedly: each
    /// directory re-scans only when its mtime changes, otherwise its cached entries
    /// are reused after a single `stat`. Across directories, the first occurrence
    /// of a name wins (workspace over global, `.claude` over `.agents`); names
    /// compare case-insensitively.
    pub async fn get_catalog(&self, workspace_root: Option<&str>) -> Vec<SkillEntry> {
        todo!()
    }

    /// Force a rescan of every directory on the next `get_catalog()` call.
    pub fn invalidate(&self) {
        self.cache.lock().clear();
    }

    /// Look up a skill by its frontmatter name (case-insensitive).
    pub async fn find(&self, name: &str, workspace_root: Option<&str>) -> Option<SkillEntry> {
        let key = name.trim().to_lowercase();
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
        todo!()
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
        todo!()
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
                if next.trim().is_empty() || INDENTED_LINE_RE.is_match(next) {
                    collected.push(next.trim());
                } else {
                    break;
                }
            }
            value = collected.join(" ");
        }
        let value = unquote(value.trim()).to_string();
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
        Some(m) => text[m.end()..].trim().to_string(),
        None => text.trim().to_string(),
    }
}

pub static SKILL_CATALOG_SERVICE: LazyLock<SkillCatalogService> =
    LazyLock::new(SkillCatalogService::new);
