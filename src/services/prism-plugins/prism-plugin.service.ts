/**
 * Prism Plugins — the one owner of a plugin's life in this process.
 *
 * At boot it scans the plugins dir, builds each plugin's page and server, calls
 * each server factory once, and schedules whatever jobs they declared. From then
 * on it watches for a change and restarts the runtime when it sees one.
 *
 * A restart rather than a reload, because a server module's factory runs once:
 * calling it again would leave the first call's timers and open handles behind,
 * and the tools block the model sees would change between turns of one
 * conversation. A fresh process is the only state that is honestly clean.
 *
 * Nothing here knows about WebSockets. A change is announced on `events`
 * (`'changed'`), and the gateway subscribes and broadcasts — the same shape the
 * updater uses.
 */

import { EventEmitter } from 'node:events';
import fs from 'fs';
import path from 'path';
import type { Tool } from 'ai';
import { logger } from '../../logger';
import { resolvePrismPluginsDir } from '../../lib/data-dir';
import { trackEvent } from '../../lib/telemetry';
import { respawnGate, restartInstruction } from '../../lib/runtime-restart';
import { PRISM_PLUGIN_GUIDE, PRISM_PLUGIN_TYPES } from '../../prompts/prism-plugin-guide';
import { buildPlugin } from './build';
import { prismPluginCatalogService } from './catalog.service';
import { buildPluginContext } from './context';
import { prismPluginJobRunner } from './jobs';
import { loadPluginServer } from './loader';
import { PrismPluginWatcher } from './watcher';
import type { PrismPluginEntry } from './catalog.service';
import type { PrismPluginRoute } from './types';

/** Written into the plugins dir at boot so the agent can read it on demand. */
const GUIDE_FILENAME = 'AUTHORING.md';
const TYPES_DIR = '.types';
const TYPES_FILENAME = 'prism-plugin.d.ts';

/**
 * How long a pending restart waits for the runtime to go idle before going
 * ahead. A plugin change is something a person just made and expects to see, so
 * an indefinite wait behind a long meeting is the wrong answer — but so is
 * cutting off a model turn that is mid-answer.
 */
const RESTART_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const RESTART_IDLE_POLL_MS = 2_000;

/**
 * Announced on `events` as `'changed'`.
 *
 * `reloaded` — a page changed and was rebuilt; the clients refetch and nothing
 * restarts. `restarting` — a plugin's server half changed and the process is
 * ending to load it. `restart-required` — the same, but nothing would bring
 * this process back, so it keeps running and the user is told.
 */
export interface PrismPluginChangeEvent {
  status: 'reloaded' | 'restarting' | 'restart-required';
  revision: string;
  /** Present on `restart-required`: what the user has to do. */
  instruction?: string;
}

/** One plugin, as the clients and the system prompt see it. */
export interface PrismPluginSummary {
  id: string;
  name: string;
  version?: string;
  description?: string;
  icon?: string;
  revision: string;
  /** Whether the plugin has a page to render. */
  hasPage: boolean;
  /** Route count, so a page-less plugin still reads as contributing something. */
  routes: number;
  tools: number;
  jobs: number;
  /** Manifest diagnostics, build failures and load failures, merged. */
  diagnostics: string[];
}

interface Loaded {
  entry: PrismPluginEntry;
  pagePath?: string;
  routes: PrismPluginRoute[];
  tools: Record<string, Tool>;
  jobCount: number;
  diagnostics: string[];
}

class PrismPluginService {
  readonly events = new EventEmitter();

  private loaded: Loaded[] = [];
  private tools: Record<string, Tool> = {};
  private watcher: PrismPluginWatcher | null = null;
  private ready = false;
  private restarting = false;
  /** The server-half revision this process loaded, for comparison on a change. */
  private loadedServerRevision = '';

  /**
   * Scan, build and load every installed plugin. Called once from the startup
   * sequence, after the agent is resolved — a plugin's context reads agent
   * data, so the row has to exist first.
   */
  async initialize(userId: string): Promise<void> {
    writeAuthoringFiles(resolvePrismPluginsDir());

    const entries = prismPluginCatalogService.getPlugins();
    const loaded: Loaded[] = [];

    for (const entry of entries) {
      const record = await this.loadOne(entry);
      loaded.push(record);
      trackEvent('prism plugin loaded', userId, {
        plugin_id: entry.id,
        status: record.diagnostics.length > 0 ? 'failed' : 'ok',
        has_page: String(Boolean(record.pagePath)),
        has_server: String(Boolean(entry.serverEntry)),
        routes: String(record.routes.length),
        tools: String(Object.keys(record.tools).length),
        jobs: String(record.jobCount),
      });
    }

    this.loaded = loaded;
    this.tools = mergeTools(loaded);
    this.loadedServerRevision = prismPluginCatalogService.serverRevision();
    this.ready = true;

    logger.info(
      '[PrismPlugins] plugins dir: %s (%d loaded, %d tools, %d jobs)',
      resolvePrismPluginsDir(),
      loaded.length,
      Object.keys(this.tools).length,
      prismPluginJobRunner.count(),
    );
  }

  /** Build one plugin, load its server, schedule its jobs. Never throws. */
  private async loadOne(entry: PrismPluginEntry): Promise<Loaded> {
    const diagnostics = [...entry.diagnostics];
    const record: Loaded = {
      entry,
      routes: [],
      tools: {},
      jobCount: 0,
      diagnostics,
    };

    const built = await buildPlugin(entry);
    diagnostics.push(...built.errors);
    record.pagePath = built.pagePath;

    if (!built.serverPath) return record;

    const ctx = buildPluginContext(entry.id, entry.dir);
    const server = await loadPluginServer(built.serverPath, ctx);
    diagnostics.push(...server.errors);
    record.routes = server.routes;
    record.tools = server.tools;

    const jobErrors = prismPluginJobRunner.start(entry.id, server.jobs);
    diagnostics.push(...jobErrors);
    record.jobCount = server.jobs.length - jobErrors.length;

    return record;
  }

  /**
   * Start watching for a change. Separate from `initialize()` so a test can
   * load plugins without arming a restart.
   */
  startWatching(): void {
    if (this.watcher) return;
    this.watcher = new PrismPluginWatcher((revision) => void this.onChange(revision));
    this.watcher.start();
  }

  /**
   * A plugin was added, changed or removed.
   *
   * A page change is rebuilt and announced, and that is all: the page is a file
   * the browser fetches by URL, so nothing in this process holds a stale copy.
   * Only the server half — the manifest and `server/` — needs a fresh process,
   * and only then is a restart the right answer.
   *
   * The distinction is what keeps the agent's own editing loop working. It
   * writes a plugin file at a time, and a restart on the first of them ends the
   * turn that was going to write the rest.
   */
  private async onChange(revision: string): Promise<void> {
    if (this.restarting) return;

    const serverRevision = prismPluginCatalogService.serverRevision();
    if (serverRevision === this.loadedServerRevision) {
      await this.reloadPages(revision);
      return;
    }

    this.restarting = true;
    const gate = respawnGate();

    if (!gate.respawns) {
      const instruction = restartInstruction(gate.reason!);
      // Ending the process here would take the agent down and leave it down,
      // which is worse than a plugin that has not loaded yet.
      logger.warn(
        '[PrismPlugins] a plugin server changed (revision %s) but nothing would restart this process (%s). %s',
        revision,
        gate.reason,
        instruction,
      );
      trackEvent('prism plugin restart', null, {
        revision,
        outcome: 'required',
        reason: gate.reason!,
        plugins: String(this.loaded.length),
      });
      this.events.emit('changed', {
        status: 'restart-required',
        revision,
        instruction,
      } satisfies PrismPluginChangeEvent);
      return;
    }

    logger.info('[PrismPlugins] a plugin server changed (revision %s) — restarting', revision);
    this.events.emit('changed', { status: 'restarting', revision } satisfies PrismPluginChangeEvent);

    // Imported here rather than at the top: the idle check reaches the shell
    // tool modules, and the WebSocket gateway imports this service — those
    // modules have no business in that import graph. A runtime that never
    // restarts never loads them.
    const { isRuntimeIdle } = await import('../../lib/runtime-idle');

    const startedAt = Date.now();
    while (Date.now() - startedAt < RESTART_IDLE_TIMEOUT_MS) {
      if (await isRuntimeIdle()) break;
      await sleep(RESTART_IDLE_POLL_MS);
    }
    const deferredMs = Date.now() - startedAt;
    if (deferredMs >= RESTART_IDLE_TIMEOUT_MS) {
      logger.warn(
        '[PrismPlugins] the runtime stayed busy for %ds — restarting anyway',
        Math.round(deferredMs / 1000),
      );
    }

    trackEvent('prism plugin restart', null, {
      revision,
      outcome: 'restarted',
      deferred_ms: String(deferredMs),
      plugins: String(this.loaded.length),
    });

    // SIGTERM rather than exit, so the graceful path runs: plugin MCP children
    // closed instead of orphaned, a live meeting left rather than frozen in the
    // room, Slack disconnected and telemetry flushed. The delay lets the
    // announcement above reach the clients first.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
  }

  /**
   * Rebuild the pages of the plugins already loaded, and announce it.
   *
   * Only their page state moves. Routes, tools and jobs belong to server
   * modules this process imported once, and a plugin appearing or disappearing
   * changes the server revision, so it never reaches here.
   */
  private async reloadPages(revision: string): Promise<void> {
    for (const record of this.loaded) {
      const entry = prismPluginCatalogService.find(record.entry.id);
      if (!entry) continue;
      const built = await buildPlugin(entry);
      record.entry = entry;
      record.pagePath = built.pagePath;
      // The manifest cannot have changed (that is a server-half change), so the
      // only diagnostics that can move are the page's own.
      record.diagnostics = [...entry.diagnostics, ...built.errors];
    }

    logger.info('[PrismPlugins] a plugin page changed (revision %s) — rebuilt', revision);
    this.events.emit('changed', { status: 'reloaded', revision } satisfies PrismPluginChangeEvent);
  }

  /** The absolute path the system prompt points the agent at. */
  guidePath(): string {
    return path.join(resolvePrismPluginsDir(), GUIDE_FILENAME);
  }

  /** Whether `initialize()` has finished. The route answers 503 until it has. */
  isReady(): boolean {
    return this.ready;
  }

  /** Every loaded plugin, in catalog order. */
  list(): PrismPluginSummary[] {
    return this.loaded.map((l) => ({
      id: l.entry.id,
      name: l.entry.name,
      version: l.entry.version,
      description: l.entry.description,
      icon: l.entry.icon,
      revision: l.entry.revision,
      hasPage: Boolean(l.pagePath),
      routes: l.routes.length,
      tools: Object.keys(l.tools).length,
      jobs: l.jobCount,
      diagnostics: l.diagnostics,
    }));
  }

  /** The built page module's path, for the route that serves it. */
  pagePath(id: string): string | undefined {
    return this.loaded.find((l) => l.entry.id === id)?.pagePath;
  }

  /** A plugin's `public/` directory, for the static route. */
  publicDir(id: string): string | undefined {
    return this.loaded.find((l) => l.entry.id === id)?.entry.publicDir;
  }

  /** A plugin's declared routes, for the API dispatcher. */
  routes(id: string): PrismPluginRoute[] | undefined {
    return this.loaded.find((l) => l.entry.id === id)?.routes;
  }

  /**
   * Every plugin tool, keyed by the name the model sees. Collected once at boot,
   * so the tools block stays byte-identical from turn to turn and the provider's
   * prompt cache holds.
   */
  getTools(): Record<string, Tool> {
    return this.tools;
  }

  /** Stop the watcher and every scheduled job. */
  shutdown(): void {
    this.watcher?.stop();
    this.watcher = null;
    prismPluginJobRunner.stopAll();
  }

  /** Tests only: forget everything loaded. */
  reset(): void {
    this.shutdown();
    this.loaded = [];
    this.tools = {};
    this.ready = false;
    this.restarting = false;
    this.loadedServerRevision = '';
    prismPluginCatalogService.invalidate();
  }
}

/**
 * Merge every plugin's tools into one record. A collision can only come from
 * `toModelToolName` truncating two long names to the same string, which the
 * digest suffix makes vanishingly unlikely — but the merged key order is part of
 * the prompt-cache prefix, so a silent overwrite would be worse than a warning.
 */
function mergeTools(loaded: Loaded[]): Record<string, Tool> {
  const merged: Record<string, Tool> = {};
  for (const record of loaded) {
    for (const [name, tool] of Object.entries(record.tools)) {
      if (name in merged) {
        logger.warn(
          '[PrismPlugins] "%s" declares a tool whose model name "%s" is already taken — dropping it',
          record.entry.id,
          name,
        );
        continue;
      }
      merged[name] = tool;
    }
  }
  return merged;
}

/**
 * Write the authoring manual and the type declarations into the plugins dir.
 *
 * Generated on every boot rather than shipped as files, so the manual can never
 * describe a runtime other than the one running, and so the path exists on every
 * install shape — the container image does not copy `docs/`, and the SEA binary
 * has no repository at all.
 *
 * **Only when the content differs**, which matters because they land inside a
 * watched directory. `npm run dev` has tsx watch the plugins dir so a plugin
 * edit restarts the runtime, and an unconditional write moved these two files'
 * mtimes on every boot: boot, write, restart, boot, about once a second for as
 * long as the dev loop ran.
 */
export function writeAuthoringFiles(dir: string): void {
  try {
    fs.mkdirSync(path.join(dir, TYPES_DIR), { recursive: true });
    writeIfChanged(path.join(dir, GUIDE_FILENAME), PRISM_PLUGIN_GUIDE);
    writeIfChanged(path.join(dir, TYPES_DIR, TYPES_FILENAME), PRISM_PLUGIN_TYPES);
  } catch (error: unknown) {
    // A plugin still loads without either file; the agent just has to be told
    // the contract in the prompt instead of reading it.
    logger.warn({ err: error }, '[PrismPlugins] could not write the authoring files');
  }
}

/**
 * Write a file only when its content differs, so a rewrite with identical bytes
 * leaves the mtime alone. Whatever watches the directory then sees a change only
 * when something changed.
 */
function writeIfChanged(target: string, content: string): void {
  try {
    if (fs.readFileSync(target, 'utf8') === content) return;
  } catch {
    // Absent or unreadable — write it.
  }
  fs.writeFileSync(target, content);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}


export const prismPluginService = new PrismPluginService();
export const __test = { mergeTools, writeIfChanged };
