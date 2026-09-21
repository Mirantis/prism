/**
 * Plugin Catalog Service
 *
 * Discovers Agent Plugins (the open standard at agent-plugins.org) installed
 * under the persistent plugins dir. A plugin is a directory holding a
 * `plugin.json` manifest plus, optionally, the two component types v1.0.0
 * defines:
 *
 *   <DATA>/plugins/<id>/
 *   ├── plugin.json   — required; `$schema` + `name`
 *   ├── skills/       — optional; each immediate child with a SKILL.md is a skill
 *   └── mcp.json      — optional; MCP servers
 *
 * Installation is deliberately out of band, exactly as it is for skills: drop a
 * folder in and it appears; delete it and it is gone. Each scan is cached on the
 * plugins dir's mtime so that costs one `stat` per turn.
 *
 * Failures are graduated, per spec §11.3. A malformed manifest rejects only that
 * plugin; a `skills` path that isn't a directory disables only that component
 * type. Nothing here ever throws — a bad plugin is skipped with a warning and
 * recorded on `diagnostics` so the management API can attribute it.
 */

import path from 'path';
import { logger } from '../logger';
import { resolvePluginsDir } from '../lib/data-dir';
import { getExecutionEnvironment } from '../lib/execution-environments/get-execution-environment';
import type { DirEntry, FileStat } from '../lib/execution-environments/execution-environment';

/** The filesystem a command sees: the agent installs a plugin by writing there. */
function files() {
  return getExecutionEnvironment().files;
}

/** The one Agent Plugins manifest schema this runtime implements. */
export const PLUGIN_SCHEMA_1_0_0 = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

/**
 * Recognized manifest schemas. Spec §5.2 requires an exact-string match against
 * a local list and forbids fetching the schema while loading, so supporting a
 * future version is a one-line addition here.
 */
const SUPPORTED_PLUGIN_SCHEMAS: readonly string[] = [PLUGIN_SCHEMA_1_0_0];

/** Marks a manifest as *ours but the wrong version*, rather than not ours at all. */
const PLUGIN_SCHEMA_PREFIX = 'https://agent-plugins.org/schemas/';

/** The closed set of top-level manifest fields (spec §5.3–5.4). */
const MANIFEST_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);

/** Spec §5.5: 1–64 chars, lowercase alphanumeric plus `-`/`.`, no `--` or `..`. */
const PLUGIN_NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** A manifest is metadata; there is no reason for one to be large. */
const MAX_MANIFEST_BYTES = 256 * 1024;

export interface PluginEntry {
  /** Directory name under the plugins dir — the stable local id. */
  id: string;
  /** Manifest `name`. Display only; `id` is what addresses the plugin. */
  name: string;
  version?: string;
  description?: string;
  /** Absolute path to the plugin root. */
  dir: string;
  /** Absolute path to `<dir>/skills`, when it exists and is a directory. */
  skillsDir?: string;
  /** Absolute path to `<dir>/mcp.json`, when it exists and is a regular file. */
  mcpConfigPath?: string;
  /** Non-fatal problems worth surfacing (ignored fields, unreadable components). */
  diagnostics: string[];
}

interface CachedScan {
  key: string;
  entries: PluginEntry[];
}

class PluginCatalogService {
  private cache: CachedScan | null = null;

  /**
   * Every installed plugin, in directory-name order. Cheap to call repeatedly:
   * rescans only when something on disk changed, so a plugin dropped in — or
   * corrected in place — appears without a restart.
   */
  async getPlugins(): Promise<PluginEntry[]> {
    const dir = resolvePluginsDir();
    const key = await cacheKey(dir);
    if (key === null) {
      // No plugins dir (e.g. PRISM_PLUGINS_DIR points somewhere absent).
      this.cache = { key: '', entries: [] };
      return [];
    }
    if (this.cache && this.cache.key === key) return this.cache.entries;
    const entries = await scan(dir);
    this.cache = { key, entries };
    return entries;
  }

  /** Look up an installed plugin by its directory id. */
  async find(id: string): Promise<PluginEntry | undefined> {
    return (await this.getPlugins()).find((p) => p.id === id);
  }

  /** Force a rescan on the next `getPlugins()` call. */
  invalidate(): void {
    this.cache = null;
  }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * A fingerprint of the plugins tree, or `null` when there is no plugins dir.
 *
 * Keying on the plugins dir's mtime alone sees a plugin appear or vanish but
 * never one edited in place, because a directory's mtime moves only when an
 * immediate child is added, removed or renamed — **not** when an existing child
 * is rewritten. That is precisely the fix-it-and-retry loop an author is in:
 * `/plugins` says "plugin.json is not valid JSON", they correct the file, and
 * nothing about `plugins/` or `plugins/<id>/` has changed.
 *
 * So the manifest and `mcp.json` are fingerprinted directly, by mtime *and*
 * size — the same pair `plugin-mcp.service.ts` uses, and size is what saves it
 * when two writes land inside one filesystem timestamp tick. The directory's
 * own mtime still covers a `skills/` dir appearing.
 */
async function cacheKey(pluginsDir: string): Promise<string | null> {
  let names: string[];
  let rootMtime: number;
  try {
    rootMtime = (await files().stat(pluginsDir)).mtimeMs;
    names = (await files().readDir(pluginsDir)).map((entry) => entry.name).sort();
  } catch {
    return null;
  }

  // Guarded: a path that is missing, or present but unreadable, stamps the same
  // — either way there is nothing here to fingerprint, and this runs on every
  // prompt build.
  const stamp = async (p: string): Promise<string> => {
    try {
      const st = await files().stat(p);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '-';
    }
  };

  const parts = [String(rootMtime)];
  for (const name of names) {
    const dir = path.join(pluginsDir, name);
    parts.push(
      `${name}:${await stamp(dir)}:${await stamp(path.join(dir, 'plugin.json'))}:${await stamp(path.join(dir, 'mcp.json'))}`,
    );
  }
  return parts.join('|');
}

async function scan(pluginsDir: string): Promise<PluginEntry[]> {
  let dirents: DirEntry[];
  try {
    dirents = await files().readDir(pluginsDir);
  } catch {
    return [];
  }

  // Sorted so the resulting skill roots — and downstream, the MCP tool block —
  // are in a deterministic order across restarts.
  const ids = dirents
    .filter((d) => d.isDirectory || d.isSymbolicLink)
    .map((d) => d.name)
    .sort();

  const entries: PluginEntry[] = [];
  for (const id of ids) {
    const entry = await loadPlugin(pluginsDir, id);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function loadPlugin(pluginsDir: string, id: string): Promise<PluginEntry | null> {
  const dir = path.join(pluginsDir, id);
  const manifestPath = path.join(dir, 'plugin.json');

  let raw: string;
  try {
    // lstat the final component so a symlinked plugin.json is rejected — that
    // would let a bundle present a manifest from outside its own root. A
    // symlinked plugin *directory* stays fine.
    const st = await files().lstat(manifestPath);
    if (st.isSymbolicLink) {
      logger.warn('[Plugins] skipping "%s": plugin.json is a symlink', id);
      return null;
    }
    if (!st.isFile) return null;
    if (st.size > MAX_MANIFEST_BYTES) {
      logger.warn('[Plugins] skipping "%s": plugin.json is larger than 256 KiB', id);
      return null;
    }
    raw = await files().readText(manifestPath);
  } catch {
    // No plugin.json — not a plugin directory. Silent: the dir may be anything.
    return null;
  }

  const result = validateManifest(raw, id);
  if (!result.ok) {
    logger.warn('[Plugins] skipping "%s": %s', id, result.error);
    return null;
  }

  const diagnostics = [...result.diagnostics];
  const entry: PluginEntry = {
    id,
    name: result.manifest.name,
    version: result.manifest.version,
    description: result.manifest.description,
    dir,
    diagnostics,
  };

  // Components live at fixed locations (spec §6.1); the manifest cannot move
  // them. A location of the wrong kind disables that component type only.
  const present = await componentNames(dir);

  const skillsPath = path.join(dir, 'skills');
  const skillsStat = present.has('skills') ? await componentStat(skillsPath) : undefined;
  if (skillsStat === 'unreadable') {
    diagnostics.push('skills cannot be read — no skills loaded');
  } else if (skillsStat) {
    if (skillsStat.isDirectory) entry.skillsDir = skillsPath;
    else diagnostics.push('skills exists but is not a directory — no skills loaded');
  }

  const mcpPath = path.join(dir, 'mcp.json');
  const mcpStat = present.has('mcp.json') ? await componentStat(mcpPath) : undefined;
  if (mcpStat === 'unreadable') {
    diagnostics.push('mcp.json cannot be read — no MCP servers loaded');
  } else if (mcpStat) {
    if (mcpStat.isFile) entry.mcpConfigPath = mcpPath;
    else diagnostics.push('mcp.json exists but is not a regular file — no MCP servers loaded');
  }

  for (const d of diagnostics) logger.warn('[Plugins] "%s": %s', id, d);
  return entry;
}

/**
 * What a plugin directory holds, so a component that is simply absent is told
 * apart from one that is present but unreadable. An empty set for a directory
 * that cannot be listed: every component then reads as absent, which is the
 * same outcome as the plugin having none.
 */
async function componentNames(dir: string): Promise<Set<string>> {
  try {
    return new Set((await files().readDir(dir)).map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

/**
 * `stat` for a component location, guaranteed not to throw. This scan's
 * contract is that one broken plugin degrades the catalog, never crashes it:
 * `getPlugins()` feeds every system-prompt build, so an uncaught throw here
 * would fail every turn. Follows symlinks, so a symlinked `skills` directory
 * still counts as one.
 */
async function componentStat(p: string): Promise<FileStat | 'unreadable'> {
  try {
    return await files().stat(p);
  } catch {
    return 'unreadable';
  }
}

// ---------------------------------------------------------------------------
// Manifest validation (spec §5)
// ---------------------------------------------------------------------------

interface Manifest {
  name: string;
  version?: string;
  description?: string;
}

type ValidationResult =
  | { ok: true; manifest: Manifest; diagnostics: string[] }
  | { ok: false; error: string };

function isValidPluginName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 64 && PLUGIN_NAME_RE.test(name);
}

/**
 * Parse and validate a `plugin.json` against Agent Plugins 1.0.0.
 *
 * Two classes of problem, per spec §5.2. An unknown top-level field or a
 * non-object `extensions` is reported and ignored — the plugin still loads.
 * Everything else is fatal for that plugin.
 */
function validateManifest(raw: string, id: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, error: `plugin.json is not valid JSON (${msg})` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'plugin.json must contain a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  const diagnostics: string[] = [];

  // `$schema` selects the rules to validate by; it is never fetched (spec §5.2).
  const schema = obj.$schema;
  if (typeof schema !== 'string' || !SUPPORTED_PLUGIN_SCHEMAS.includes(schema)) {
    // Distinguish "an Agent Plugin targeting a version we don't implement" from
    // "not an Agent Plugins manifest at all" — different problems, different fixes.
    if (typeof schema === 'string' && schema.startsWith(PLUGIN_SCHEMA_PREFIX)) {
      return {
        ok: false,
        error:
          `unsupported Agent Plugins version — plugin.json declares "${schema}", ` +
          `this runtime implements "${PLUGIN_SCHEMA_1_0_0}"`,
      };
    }
    return {
      ok: false,
      error: `plugin.json is not an Agent Plugins manifest (expected $schema "${PLUGIN_SCHEMA_1_0_0}")`,
    };
  }

  if (!isValidPluginName(obj.name)) {
    return {
      ok: false,
      error:
        'plugin.json "name" must be 1-64 characters of lowercase letters, digits, ' +
        '"-" or ".", starting and ending alphanumeric, with no "--" or ".."',
    };
  }

  // Optional metadata is loosely validated on purpose (spec §5.4): a `version`
  // that isn't semver or a `license` that isn't SPDX must not reject a plugin.
  // Only the declared *type* is enforced.
  for (const field of ['version', 'description', 'homepage', 'repository', 'license']) {
    if (obj[field] !== undefined && typeof obj[field] !== 'string') {
      return { ok: false, error: `plugin.json "${field}" must be a string` };
    }
  }
  if (obj.keywords !== undefined) {
    if (!Array.isArray(obj.keywords) || obj.keywords.some((k) => typeof k !== 'string')) {
      return { ok: false, error: 'plugin.json "keywords" must be an array of strings' };
    }
  }
  if (obj.author !== undefined) {
    if (typeof obj.author !== 'object' || obj.author === null || Array.isArray(obj.author)) {
      return { ok: false, error: 'plugin.json "author" must be an object' };
    }
  }

  // Non-fatal: reported so a typo is diagnosable rather than silently dropped.
  if (obj.extensions !== undefined) {
    if (
      typeof obj.extensions !== 'object' ||
      obj.extensions === null ||
      Array.isArray(obj.extensions)
    ) {
      diagnostics.push('ignoring "extensions": expected an object');
    }
    // Contents are never validated — a namespace we don't implement is ignored
    // wholesale (spec §8.1), which is what keeps a plugin portable across clients.
  }

  const unknown = Object.keys(obj).filter((k) => !MANIFEST_FIELDS.has(k));
  if (unknown.length > 0) {
    diagnostics.push(`ignoring unknown plugin.json field(s): ${unknown.sort().join(', ')}`);
  }

  if (obj.name !== id) {
    // Not a problem — `id` addresses the plugin, `name` is display — but a
    // mismatch is worth surfacing since most authors expect them to agree.
    diagnostics.push(`manifest name "${String(obj.name)}" differs from directory name "${id}"`);
  }

  return {
    ok: true,
    manifest: {
      name: obj.name,
      version: obj.version as string | undefined,
      description: obj.description as string | undefined,
    },
    diagnostics,
  };
}

export const pluginCatalogService = new PluginCatalogService();

// Exported for unit tests.
export const __test = { validateManifest, isValidPluginName };
