/**
 * Prism Plugin Catalog
 *
 * Discovers Prism Plugins — this runtime's own extension format — installed
 * under the persistent Prism plugins dir:
 *
 *   <DATA>/prism-plugins/<id>/
 *   ├── prism-plugin.json   — required; `apiVersion` + `name`
 *   ├── web/page.tsx        — optional; the page shown in the web UI
 *   ├── server/index.ts     — optional; routes, tools and jobs
 *   └── public/             — optional; static files served read-only
 *
 * Installation is out of band, as it is for skills and Agent Plugins: drop a
 * folder in and it appears, delete it and it is gone. Unlike those two, a change
 * here restarts the runtime, because a plugin's server module and its tools load
 * once per process.
 *
 * Failures are graduated. A malformed manifest rejects only that plugin; a
 * `web` path of the wrong kind disables only the page. Nothing here throws — the
 * catalog feeds every system-prompt build, so one bad plugin degrades the
 * listing rather than failing every turn.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../../logger';
import { resolvePrismPluginsDir } from '../../lib/data-dir';
import { MANIFEST_FILENAME, SUPPORTED_API_VERSIONS } from './types';
import type { PrismPluginManifest } from './types';

/** The closed set of top-level manifest fields. */
const MANIFEST_FIELDS = new Set(['apiVersion', 'name', 'version', 'description', 'icon']);

/** Same shape as an Agent Plugin name: 1–64 chars, lowercase, no `--` or `..`. */
const PLUGIN_NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** A manifest is metadata; there is no reason for one to be large. */
const MAX_MANIFEST_BYTES = 256 * 1024;

/**
 * Bounds on the per-plugin walk. A plugin is a handful of source files, so
 * these are generous — they exist so a plugin that symlinks a large tree into
 * itself cannot make every prompt build walk it.
 */
const FINGERPRINT_MAX_DEPTH = 8;
const FINGERPRINT_MAX_ENTRIES = 2000;

/**
 * Per-file ceiling on what the revision hashes. Above it the file's size and
 * mtime stand in — a plugin source is kilobytes, and something larger is an
 * asset rather than code.
 */
const HASH_MAX_BYTES = 2 * 1024 * 1024;

/** Directory names never worth fingerprinting or bundling. */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.DS_Store']);

export interface PrismPluginEntry {
  /** Directory name under the Prism plugins dir — the stable local id. */
  id: string;
  /** Manifest `name`. Display only; `id` is what addresses the plugin. */
  name: string;
  version?: string;
  description?: string;
  icon?: string;
  /** Absolute path to the plugin root. */
  dir: string;
  /** Absolute path to the page entry, when the plugin ships one. */
  pageEntry?: string;
  /** Absolute path to the server entry, when the plugin ships one. */
  serverEntry?: string;
  /** Absolute path to `<dir>/public`, when it exists and is a directory. */
  publicDir?: string;
  /**
   * Fingerprint of this plugin's own files. Changes on any edit inside the
   * plugin, and is what the built page's URL carries so a browser cannot serve
   * a stale module from cache.
   */
  revision: string;
  /**
   * Fingerprint of the half that lives in the runtime's memory: the manifest
   * and `server/`. Only a change here needs a fresh process — a page lives in
   * the browser and a `public/` file is read from disk on request.
   */
  serverRevision: string;
  /** Non-fatal problems worth surfacing (ignored fields, unreadable components). */
  diagnostics: string[];
}

/** Recognized entry filenames, in the order they are tried. */
const PAGE_ENTRIES = ['page.tsx', 'page.jsx', 'page.ts', 'page.js'];
const SERVER_ENTRIES = ['index.ts', 'index.js', 'index.mjs'];

interface CachedScan {
  key: string;
  entries: PrismPluginEntry[];
}

class PrismPluginCatalogService {
  private cache: CachedScan | null = null;

  /**
   * Every installed Prism plugin, in directory-name order. Cheap to call
   * repeatedly: it rescans only when something on disk changed.
   */
  getPlugins(): PrismPluginEntry[] {
    const dir = resolvePrismPluginsDir();
    const key = fingerprintTree(dir);
    if (key === null) {
      this.cache = { key: '', entries: [] };
      return [];
    }
    if (this.cache && this.cache.key === key) return this.cache.entries;
    const entries = scan(dir);
    this.cache = { key, entries };
    return entries;
  }

  /** Look up an installed plugin by its directory id. */
  find(id: string): PrismPluginEntry | undefined {
    return this.getPlugins().find((p) => p.id === id);
  }

  /**
   * One revision over every installed plugin, from the *contents* of their
   * files.
   *
   * Content rather than timestamps, because this is what decides whether the
   * runtime restarts. A rewrite with identical bytes is common — a tool that
   * writes a file twice, a checkout, a test harness re-seeding a fixture — and
   * each one moves an mtime while changing nothing. Paying for a restart on
   * that is worse than paying to read a few kilobytes.
   */
  revision(): string {
    const dir = resolvePrismPluginsDir();
    const names = pluginNames(dir);
    if (names === null) return 'none';
    return digest(names.map((name) => `${name}[${contentHash(path.join(dir, name))}]`).join('||'));
  }

  /**
   * One revision over the half of every plugin that a restart exists to reload.
   *
   * A page edit does not appear here. The page is built to a file the browser
   * fetches by URL, so replacing it needs no new process — and a restart that
   * was not needed is a restart that can interrupt the agent writing the very
   * plugin it is reloading.
   */
  serverRevision(): string {
    const dir = resolvePrismPluginsDir();
    const names = pluginNames(dir);
    if (names === null) return 'none';
    return digest(
      names
        .map((name) => `${name}[${contentHash(path.join(dir, name), isServerHalf)}]`)
        .join('||'),
    );
  }

  /** Force a rescan on the next `getPlugins()` call. */
  invalidate(): void {
    this.cache = null;
  }
}

export const prismPluginCatalogService = new PrismPluginCatalogService();

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function digest(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * `statSync` for a path, guaranteed not to throw. `throwIfNoEntry: false`
 * suppresses only a *missing* entry — a symlink loop (ELOOP) or a permission
 * error still throws, and this runs on every prompt build.
 */
function componentStat(p: string): fs.Stats | 'unreadable' | undefined {
  try {
    return fs.statSync(p, { throwIfNoEntry: false });
  } catch {
    return 'unreadable';
  }
}


/**
 * A digest of one plugin's file contents, keyed by relative path.
 *
 * This is the plugin's `revision`: it keys the build output, rides the page's
 * module URL, and is what the watcher compares before restarting the runtime.
 */
function contentHash(dir: string, keep?: (rel: string) => boolean): string {
  const hash = crypto.createHash('sha256');
  for (const [rel, entry] of walk(dir)) {
    if (keep && !keep(rel)) continue;
    hash.update(rel);
    hash.update('\u0000');
    hash.update(entry);
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * Whether a path inside a plugin belongs to the half the runtime holds in
 * memory. The manifest counts: it names the plugin and gates whether it loads
 * at all.
 */
function isServerHalf(rel: string): boolean {
  return rel === MANIFEST_FILENAME || rel === 'server/' || rel.startsWith('server/');
}

/**
 * A cheap fingerprint of one plugin, from each file's mtime and size.
 *
 * Feeds the scan cache only, where a false positive costs one rescan. Any
 * content change moves an mtime, so this triggers at least as often as the
 * content hash — which is what lets the precise answer be computed on a rescan
 * rather than on every prompt build.
 */
function fingerprintPlugin(dir: string): string {
  const parts: string[] = [];
  for (const [rel, entry] of walk(dir, 'stamp')) {
    parts.push(`${rel}:${entry}`);
  }
  return parts.join('|');
}

/**
 * Walk a plugin's files in sorted order, yielding each relative path with
 * either its content (the default) or its mtime and size.
 *
 * Symlinks are resolved: what matters is the content that will be bundled, not
 * the link's own timestamps.
 */
function walk(dir: string, mode: 'content' | 'stamp' = 'content'): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let budget = FINGERPRINT_MAX_ENTRIES;

  const visit = (current: string, rel: string, depth: number): void => {
    if (depth > FINGERPRINT_MAX_DEPTH || budget <= 0) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      out.push([rel, 'x']);
      return;
    }
    for (const d of dirents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (budget-- <= 0) return;
      if (IGNORED_DIRS.has(d.name)) continue;
      const child = path.join(current, d.name);
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const st = componentStat(child);
      if (st === 'unreadable' || !st) {
        out.push([childRel, 'x']);
        continue;
      }
      if (st.isDirectory()) {
        out.push([`${childRel}/`, '']);
        visit(child, childRel, depth + 1);
        continue;
      }
      if (mode === 'stamp' || st.size > HASH_MAX_BYTES) {
        out.push([childRel, `${st.mtimeMs}:${st.size}`]);
        continue;
      }
      try {
        out.push([childRel, fs.readFileSync(child, 'utf8')]);
      } catch {
        out.push([childRel, `unreadable:${st.size}`]);
      }
    }
  };

  visit(dir, '', 0);
  return out;
}

/**
 * The plugin directory names, or `null` when there is no plugins dir.
 *
 * Skips what the runtime itself writes into that directory — the authoring
 * manual and the emitted types — which would otherwise change the revision on
 * every boot and restart the runtime forever.
 */
function pluginNames(pluginsDir: string): string[] | null {
  try {
    return fs
      .readdirSync(pluginsDir)
      .filter((name) => !name.startsWith('.') && name !== 'AUTHORING.md')
      .sort();
  } catch {
    return null;
  }
}

/** A cheap fingerprint of the whole tree, or `null` when there is no plugins dir. */
function fingerprintTree(pluginsDir: string): string | null {
  const names = pluginNames(pluginsDir);
  if (names === null) return null;
  return names
    .map((name) => `${name}[${fingerprintPlugin(path.join(pluginsDir, name))}]`)
    .join('||');
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function scan(pluginsDir: string): PrismPluginEntry[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const ids = dirents
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => d.name)
    .filter((name) => !name.startsWith('.'))
    .sort();

  const entries: PrismPluginEntry[] = [];
  for (const id of ids) {
    const entry = loadPlugin(pluginsDir, id);
    if (entry) entries.push(entry);
  }
  return entries;
}

function loadPlugin(pluginsDir: string, id: string): PrismPluginEntry | null {
  const dir = path.join(pluginsDir, id);
  const manifestPath = path.join(dir, MANIFEST_FILENAME);

  let raw: string;
  try {
    // lstat the final component so a symlinked manifest is rejected — that
    // would let a plugin present a manifest from outside its own root. A
    // symlinked plugin *directory* stays fine.
    const st = fs.lstatSync(manifestPath);
    if (st.isSymbolicLink()) {
      logger.warn('[PrismPlugins] skipping "%s": %s is a symlink', id, MANIFEST_FILENAME);
      return null;
    }
    if (!st.isFile()) return null;
    if (st.size > MAX_MANIFEST_BYTES) {
      logger.warn('[PrismPlugins] skipping "%s": %s is larger than 256 KiB', id, MANIFEST_FILENAME);
      return null;
    }
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    // No manifest — not a plugin directory. Silent: the dir may be anything.
    return null;
  }

  if (!isValidPluginName(id)) {
    logger.warn(
      '[PrismPlugins] skipping "%s": directory name is not a valid plugin id (lowercase letters, digits, - and .)',
      id,
    );
    return null;
  }

  const result = validateManifest(raw);
  if (!result.ok) {
    logger.warn('[PrismPlugins] skipping "%s": %s', id, result.error);
    return null;
  }

  const diagnostics = [...result.diagnostics];
  if (result.manifest.name !== id) {
    diagnostics.push(`manifest name "${result.manifest.name}" differs from directory name "${id}"`);
  }

  const entry: PrismPluginEntry = {
    id,
    name: result.manifest.name,
    version: result.manifest.version,
    description: result.manifest.description,
    icon: result.manifest.icon,
    dir,
    revision: contentHash(dir),
    serverRevision: contentHash(dir, isServerHalf),
    diagnostics,
  };

  entry.pageEntry = resolveEntry(dir, 'web', PAGE_ENTRIES, 'page', diagnostics);
  entry.serverEntry = resolveEntry(dir, 'server', SERVER_ENTRIES, 'server', diagnostics);

  const publicPath = path.join(dir, 'public');
  const publicStat = componentStat(publicPath);
  if (publicStat === 'unreadable') {
    diagnostics.push('public cannot be read — no static files served');
  } else if (publicStat) {
    if (publicStat.isDirectory()) entry.publicDir = publicPath;
    else diagnostics.push('public exists but is not a directory — no static files served');
  }

  if (!entry.pageEntry && !entry.serverEntry) {
    diagnostics.push(
      `no web/${PAGE_ENTRIES[0]} and no server/${SERVER_ENTRIES[0]} — the plugin contributes nothing`,
    );
  }

  for (const d of diagnostics) logger.warn('[PrismPlugins] "%s": %s', id, d);
  return entry;
}

/**
 * Find a component's entry file inside `<dir>/<sub>`. Absent is normal — both
 * components are optional. A wrong-kind path or an unreadable one disables that
 * component alone and says so.
 */
function resolveEntry(
  dir: string,
  sub: string,
  candidates: readonly string[],
  label: string,
  diagnostics: string[],
): string | undefined {
  const subPath = path.join(dir, sub);
  const st = componentStat(subPath);
  if (st === 'unreadable') {
    diagnostics.push(`${sub} cannot be read — no ${label} loaded`);
    return undefined;
  }
  if (!st) return undefined;
  if (!st.isDirectory()) {
    diagnostics.push(`${sub} exists but is not a directory — no ${label} loaded`);
    return undefined;
  }
  for (const candidate of candidates) {
    const entry = path.join(subPath, candidate);
    const entryStat = componentStat(entry);
    if (entryStat && entryStat !== 'unreadable' && entryStat.isFile()) return entry;
  }
  diagnostics.push(`${sub}/ has no ${candidates.join(' or ')} — no ${label} loaded`);
  return undefined;
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

type ValidationResult =
  | { ok: true; manifest: PrismPluginManifest; diagnostics: string[] }
  | { ok: false; error: string };

function isValidPluginName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 64 && PLUGIN_NAME_RE.test(name);
}

/**
 * Parse and validate a `prism-plugin.json`.
 *
 * Two classes of problem. An unknown top-level field is reported and ignored,
 * so a manifest written for a later runtime still loads what this one
 * understands. Everything else is fatal for that plugin.
 */
function validateManifest(raw: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'unknown parse error';
    return { ok: false, error: `${MANIFEST_FILENAME} is not valid JSON (${msg})` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `${MANIFEST_FILENAME} must contain a JSON object` };
  }

  const raw_ = parsed as Record<string, unknown>;
  const diagnostics: string[] = [];

  const apiVersion = raw_.apiVersion;
  if (apiVersion === undefined) {
    return { ok: false, error: `${MANIFEST_FILENAME} is missing "apiVersion"` };
  }
  if (typeof apiVersion !== 'number' || !SUPPORTED_API_VERSIONS.includes(apiVersion as 1)) {
    return {
      ok: false,
      error: `apiVersion ${JSON.stringify(apiVersion)} is not supported (this runtime implements ${SUPPORTED_API_VERSIONS.join(', ')})`,
    };
  }

  if (!isValidPluginName(raw_.name)) {
    return {
      ok: false,
      error:
        '"name" must be 1–64 characters of lowercase letters, digits, "-" or ".", and may not contain "--" or ".."',
    };
  }

  // Optional metadata is type-checked and never interpreted: a version string
  // that is not semver must not reject a plugin that otherwise works.
  for (const field of ['version', 'description', 'icon'] as const) {
    if (raw_[field] !== undefined && typeof raw_[field] !== 'string') {
      return { ok: false, error: `"${field}" must be a string when present` };
    }
  }

  const unknown = Object.keys(raw_)
    .filter((k) => !MANIFEST_FIELDS.has(k))
    .sort();
  if (unknown.length > 0) {
    diagnostics.push(`ignoring unknown ${MANIFEST_FILENAME} field(s): ${unknown.join(', ')}`);
  }

  return {
    ok: true,
    manifest: {
      apiVersion: 1,
      name: raw_.name,
      version: raw_.version as string | undefined,
      description: raw_.description as string | undefined,
      icon: raw_.icon as string | undefined,
    },
    diagnostics,
  };
}

export const __test = { validateManifest, isValidPluginName, fingerprintPlugin, contentHash, isServerHalf };
