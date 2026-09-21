/**
 * Skill Catalog Service
 *
 * Discovers Agent Skills (the open standard at agentskills.io) and exposes them
 * to the prism agent loop with progressive disclosure:
 *   - the CATALOG holds only each skill's `name` + `description` (cheap; goes
 *     into the system prompt so the model knows what's available);
 *   - the full SKILL.md BODY is read on demand via `getSkillBody()` (the `skill`
 *     tool / manual trigger), never up front.
 *
 * Skills come from three kinds of source, in precedence order:
 *   1. WORKSPACE — the repo the CLI was started in: `<workspaceRoot>/.claude/skills`
 *      then `<workspaceRoot>/.agents/skills` (only when a workspaceRoot is given).
 *   2. GLOBAL — the persistent `<DATA>/skills` dir (always).
 *   3. PLUGIN — the `skills/` dir of each installed Agent Plugin (always).
 * On a name collision the higher-precedence source wins (workspace over global,
 * `.claude` over `.agents`), matching Claude Code's project > personal model.
 * Plugins rank last deliberately: a plugin can contribute a skill but can never
 * shadow one the user installed themselves.
 *
 * A skill is a folder under a skills dir containing a `SKILL.md` with YAML
 * frontmatter. Only `name` and `description` are required by the standard.
 * Parsing is deliberately lenient (see `parseFrontmatter`) so one malformed
 * skill never breaks the catalog. Each scanned directory is cached and refreshed
 * when its mtime changes, so a skill the user drops in appears without a restart.
 */

import { getExecutionEnvironment } from '../lib/execution-environments/get-execution-environment';
import type { DirEntry } from '../lib/execution-environments/execution-environment';
import path from 'path';
import { logger } from '../logger';
import { pluginCatalogService } from './plugin-catalog.service';

/** The filesystem a command sees: the skill tool hands out paths for the shell. */
function files() {
  return getExecutionEnvironment().files;
}

/** Where a skill was discovered. */
export type SkillSource = 'workspace' | 'global' | 'plugin';

export interface SkillEntry {
  /** Frontmatter `name` — the authoritative key used to invoke the skill. */
  name: string;
  /** On-disk folder name (may differ from `name`). */
  dirName: string;
  description: string;
  /** Absolute path to the skill bundle directory. */
  dir: string;
  /** Absolute path to the bundle's SKILL.md. */
  skillMdPath: string;
  /** Whether this skill came from the workspace repo, the global dir, or a plugin. */
  source: SkillSource;
  /** The contributing plugin's id — set only when `source` is `'plugin'`. */
  pluginId?: string;
}

interface CachedDir {
  mtimeMs: number;
  entries: SkillEntry[];
}

/** A directory to scan, paired with the source label its skills get. */
interface SkillRoot {
  dir: string;
  source: SkillSource;
  /** Set for plugin roots so each entry can name its contributing plugin. */
  pluginId?: string;
}

/** Generous cap on how much of SKILL.md we read just to extract frontmatter. */
const FRONTMATTER_READ_LIMIT = 16 * 1024;

class SkillCatalogService {
  // Per-directory cache so the global dir stays cached across turns while each
  // workspace dir caches independently by path.
  private cache = new Map<string, CachedDir>();

  /**
   * The directories to scan, in precedence order: workspace first (when a
   * workspaceRoot is given), then the global dir, then each installed plugin's
   * `skills/`. `.claude/skills` ranks above `.agents/skills` so the
   * Claude-native location wins a name clash, and plugin roots come last so a
   * plugin never shadows a skill the user installed.
   */
  private async roots(workspaceRoot?: string): Promise<SkillRoot[]> {
    const roots: SkillRoot[] = [];
    const trimmed = workspaceRoot?.trim();
    if (trimmed) {
      const ws = path.resolve(trimmed);
      roots.push({ dir: path.join(ws, '.claude', 'skills'), source: 'workspace' });
      roots.push({ dir: path.join(ws, '.agents', 'skills'), source: 'workspace' });
    }
    roots.push({ dir: getExecutionEnvironment().paths().skillsDir, source: 'global' });
    // Plugins are enumerated in id order, so a clash between two plugins
    // resolves the same way on every boot.
    for (const plugin of await pluginCatalogService.getPlugins()) {
      if (plugin.skillsDir) {
        roots.push({ dir: plugin.skillsDir, source: 'plugin', pluginId: plugin.id });
      }
    }
    return roots;
  }

  /**
   * Merged skill catalog (name + description). Cheap to call repeatedly: each
   * directory re-scans only when its mtime changes, otherwise its cached entries
   * are reused after a single `stat`. Across directories, the first occurrence
   * of a name wins (workspace over global, `.claude` over `.agents`).
   */
  async getCatalog(workspaceRoot?: string): Promise<SkillEntry[]> {
    const byName = new Map<string, SkillEntry>();
    for (const root of await this.roots(workspaceRoot)) {
      for (const entry of await this.scanCached(root)) {
        const key = entry.name.toLowerCase();
        if (!byName.has(key)) byName.set(key, entry);
      }
    }
    return [...byName.values()];
  }

  /** Force a rescan of every directory on the next `getCatalog()` call. */
  invalidate(): void {
    this.cache.clear();
  }

  /** Look up a skill by its frontmatter name (case-insensitive). */
  async find(name: string, workspaceRoot?: string): Promise<SkillEntry | undefined> {
    const key = name.trim().toLowerCase();
    return (await this.getCatalog(workspaceRoot)).find((s) => s.name.toLowerCase() === key);
  }

  /**
   * Read a skill's full SKILL.md body (frontmatter stripped), fresh from disk —
   * so an in-place edit to the body is always reflected. Returns null when the
   * named skill isn't installed.
   */
  async getSkillBody(
    name: string,
    workspaceRoot?: string,
  ): Promise<{ entry: SkillEntry; body: string } | null> {
    const entry = await this.find(name, workspaceRoot);
    if (!entry) return null;
    const raw = await files().readText(entry.skillMdPath);
    return { entry, body: stripFrontmatter(raw) };
  }

  /** Scan one root, reusing the cached entries when its mtime is unchanged. */
  private async scanCached(root: SkillRoot): Promise<SkillEntry[]> {
    let mtimeMs: number;
    try {
      mtimeMs = (await files().stat(root.dir)).mtimeMs;
    } catch {
      // Directory doesn't exist (e.g. a repo with no .agents/skills) — empty.
      this.cache.set(root.dir, { mtimeMs: -1, entries: [] });
      return [];
    }
    const cached = this.cache.get(root.dir);
    if (cached && cached.mtimeMs === mtimeMs) return cached.entries;
    const entries = await this.scan(root);
    this.cache.set(root.dir, { mtimeMs, entries });
    return entries;
  }

  private async scan(root: SkillRoot): Promise<SkillEntry[]> {
    const { dir, source } = root;
    let dirents: DirEntry[];
    try {
      dirents = await files().readDir(dir);
    } catch {
      return [];
    }
    // Deterministic order: sort folder names; first one wins on a name clash.
    const subdirs = dirents
      .filter((d) => d.isDirectory || d.isSymbolicLink)
      .map((d) => d.name)
      .sort();

    const byName = new Map<string, SkillEntry>();
    for (const dirName of subdirs) {
      const bundleDir = path.join(dir, dirName);
      const skillMdPath = path.join(bundleDir, 'SKILL.md');

      let head: string;
      try {
        // lstat the final component so a SKILL.md that is itself a symlink is
        // rejected — that would let a bundle read an arbitrary file outside the
        // skills dir. A symlinked *bundle directory* is still fine (lstat
        // traverses the intermediate dir symlink and sees a real SKILL.md).
        const st = await files().lstat(skillMdPath);
        if (st.isSymbolicLink) {
          logger.warn('[Skills] skipping "%s": SKILL.md is a symlink', dirName);
          continue;
        }
        if (!st.isFile) continue;
        head = await files().readText(skillMdPath, {
          maxBytes: Math.min(FRONTMATTER_READ_LIMIT, st.size),
        });
      } catch {
        continue; // no SKILL.md → not a skill bundle
      }

      const fm = parseFrontmatter(head);
      if (!fm.name || !fm.description) {
        logger.warn('[Skills] skipping "%s": SKILL.md missing name/description', dirName);
        continue;
      }
      const key = fm.name.toLowerCase();
      if (byName.has(key)) {
        logger.warn(
          '[Skills] duplicate skill name "%s" (dir %s) — keeping the first by sort order',
          fm.name,
          dirName,
        );
        continue;
      }
      byName.set(key, {
        name: fm.name,
        dirName,
        description: fm.description,
        dir: bundleDir,
        skillMdPath,
        source,
        ...(root.pluginId ? { pluginId: root.pluginId } : {}),
      });
    }
    return [...byName.values()];
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (lenient)
// ---------------------------------------------------------------------------

interface Frontmatter {
  name?: string;
  description?: string;
}

/** The text between the first pair of `---` fences, or '' when absent. */
function extractFrontmatterBlock(raw: string): string {
  const text = raw.replace(/^\uFEFF/, '');
  const m = /^\s*---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(text);
  return m ? m[1] : '';
}

/**
 * Pull only `name` and `description` out of the frontmatter, splitting each
 * top-level line on its FIRST colon. This tolerates the common spec gotcha of
 * an unquoted colon inside `description` (e.g. `description: Use when X: do Y`),
 * which a strict YAML parser would reject. Surrounding quotes are stripped and
 * simple `|`/`>` block scalars are folded into a single line.
 */
function parseFrontmatter(raw: string): Frontmatter {
  const block = extractFrontmatterBlock(raw);
  if (!block) return {};
  const lines = block.split('\n');
  const out: Frontmatter = {};
  for (let i = 0; i < lines.length; i++) {
    // Only top-level keys (no leading indentation) — skips nested maps.
    const m = /^([A-Za-z][\w-]*)\s*:\s?(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key !== 'name' && key !== 'description') continue;
    let value = m[2];
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '' || /^\s+\S/.test(lines[j])) {
          collected.push(lines[j].trim());
        } else break;
      }
      value = collected.join(' ');
    }
    out[key] = unquote(value.trim());
  }
  return out;
}

function unquote(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/** Return SKILL.md content with the leading frontmatter block removed. */
function stripFrontmatter(raw: string): string {
  const text = raw.replace(/^\uFEFF/, '');
  const m = /^\s*---\s*\n[\s\S]*?\n---\s*(?:\n|$)/.exec(text);
  return m ? text.slice(m[0].length).trim() : text.trim();
}

export const skillCatalogService = new SkillCatalogService();

// Exported for unit tests.
export const __test = { parseFrontmatter, stripFrontmatter };
