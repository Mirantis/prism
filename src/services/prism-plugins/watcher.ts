/**
 * Watches the Prism plugins directory and reports a real change.
 *
 * Two mechanisms, because neither is enough alone. `fs.watch` is what makes an
 * edit felt within a second, but a recursive watch does not survive every
 * filesystem a data volume can be — a bind mount, a network share — and it
 * reports nothing at all when the directory it was given is later replaced. So a
 * slow poll runs underneath it, which is the same mtime comparison every other
 * catalog in this runtime already relies on.
 *
 * Both paths end at the same place: recompute the fingerprint, and report only
 * when it differs. An editor writing a file emits several events for one save,
 * and a fingerprint that has not moved is not a change.
 */

import fs from 'fs';
import { logger } from '../../logger';
import { resolvePrismPluginsDir } from '../../lib/data-dir';
import { prismPluginCatalogService } from './catalog.service';

/**
 * Long enough for an editor's write-truncate-rename sequence and for a coding
 * agent writing several files in a row to settle into one report, short enough
 * that a person saving a file does not wait on it.
 */
const DEBOUNCE_MS = 750;

/** The backstop cadence. Cheap: one stat per file in a handful of small dirs. */
const POLL_MS = 30_000;

export class PrismPluginWatcher {
  private watcher: fs.FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private lastRevision: string;
  private stopped = false;

  constructor(private readonly onChange: (revision: string) => void) {
    this.lastRevision = prismPluginCatalogService.revision();
  }

  start(): void {
    const dir = resolvePrismPluginsDir();

    try {
      this.watcher = fs.watch(dir, { recursive: true }, () => this.schedule());
      // A watch error is not fatal — the poll still covers it — so the watcher
      // is dropped and the reason logged once.
      this.watcher.on('error', (error) => {
        logger.warn({ err: error }, '[PrismPlugins] the directory watch failed — polling instead');
        this.closeWatcher();
      });
    } catch (error: unknown) {
      logger.warn(
        { err: error },
        '[PrismPlugins] could not watch the plugins directory — polling instead',
      );
    }

    this.poll = setInterval(() => this.check(), POLL_MS);
    this.poll.unref();
  }

  /** Collapse a burst of filesystem events into one check. */
  private schedule(): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.check();
    }, DEBOUNCE_MS);
    this.debounce.unref();
  }

  private check(): void {
    if (this.stopped) return;
    const revision = prismPluginCatalogService.revision();
    if (revision === this.lastRevision) return;
    this.lastRevision = revision;
    // Reported once per change. Whoever handles it decides what to do — this
    // class knows nothing about restarting.
    this.onChange(revision);
  }

  private closeWatcher(): void {
    try {
      this.watcher?.close();
    } catch {
      // Already closed, or never opened.
    }
    this.watcher = null;
  }

  stop(): void {
    this.stopped = true;
    this.closeWatcher();
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }
}
