/**
 * Builds a Prism plugin's two halves with esbuild.
 *
 *   web/page.tsx     → <build>/page.js     ESM for the browser, host-bound
 *   server/index.ts   → <build>/server.mjs  ESM for this process
 *
 * Both are bundles, so a plugin may split itself across files and import from
 * its own directory. Neither may pull an npm package: nothing installs
 * dependencies for a plugin, so an unresolved bare import is a build error
 * naming the import rather than a module-not-found at load time.
 *
 * Output is keyed by the plugin's revision. A build whose stamp already matches
 * is skipped, so an unchanged plugin costs one file read at boot.
 */

import { build as esbuild } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { logger } from '../../logger';
import { resolvePrismPluginBuildDir } from '../../lib/data-dir';
import { HOST_SPECIFIER, prismPluginHostShim } from './host-shim';
import type { PrismPluginEntry } from './catalog.service';

export const PAGE_OUTPUT = 'page.js';
export const SERVER_OUTPUT = 'server.mjs';

/** Records which revision the files on disk were built from. */
const STAMP = 'revision';

export interface PrismPluginBuildResult {
  /** Absolute path to the built page module, when the plugin ships a page. */
  pagePath?: string;
  /** Absolute path to the built server module, when the plugin ships one. */
  serverPath?: string;
  /** Build failures, one per component. Empty when everything built. */
  errors: string[];
}

/**
 * Build one plugin. Never throws: a build failure is a string on `errors`, and
 * the plugin still appears in the UI with the message on its page — a plugin
 * whose page will not compile is the normal state while the agent is writing
 * it, and the message is how it finds out what to fix.
 */
export async function buildPlugin(entry: PrismPluginEntry): Promise<PrismPluginBuildResult> {
  const outDir = resolvePrismPluginBuildDir(entry.id);
  const result: PrismPluginBuildResult = { errors: [] };

  const pageOut = path.join(outDir, PAGE_OUTPUT);
  const serverOut = path.join(outDir, SERVER_OUTPUT);

  if (isFresh(outDir, entry.revision)) {
    if (entry.pageEntry && fs.existsSync(pageOut)) result.pagePath = pageOut;
    if (entry.serverEntry && fs.existsSync(serverOut)) result.serverPath = serverOut;
    // A stamp matching the revision means these outputs came from these sources,
    // so anything the stamp claims but disk lacks is a build that needs redoing.
    const pageOk = !entry.pageEntry || result.pagePath;
    const serverOk = !entry.serverEntry || result.serverPath;
    if (pageOk && serverOk) return result;
  }

  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (error: unknown) {
    result.errors.push(`could not create the build directory: ${message(error)}`);
    return result;
  }

  // The stamp is cleared first: a crash between here and the write must not
  // leave a stamp claiming outputs that were never rebuilt.
  clearStamp(outDir);

  if (entry.pageEntry) {
    const error = await buildPage(entry.id, entry.pageEntry, pageOut);
    if (error) result.errors.push(`web: ${error}`);
    else result.pagePath = pageOut;
  }

  if (entry.serverEntry) {
    const error = await buildServer(entry.serverEntry, serverOut);
    if (error) result.errors.push(`server: ${error}`);
    else result.serverPath = serverOut;
  }

  if (result.errors.length === 0) writeStamp(outDir, entry.revision);
  return result;
}

/**
 * The page. `jsxImportSource` points the automatic JSX transform at the host
 * shim, which is what removes the need for a `react` shim at all — esbuild
 * emits `import { jsx } from '@prism/plugin/jsx-runtime'` and the shim answers
 * it. `platform: 'browser'` so nothing node-shaped resolves.
 */
async function buildPage(
  pluginId: string,
  entry: string,
  outfile: string,
): Promise<string | null> {
  try {
    const out = await esbuild({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: HOST_SPECIFIER,
      plugins: [prismPluginHostShim(pluginId)],
      // A page is served over the same connection as the SPA and read by a
      // person debugging it, so it stays unminified with a source map beside it.
      minify: false,
      sourcemap: 'inline',
      logLevel: 'silent',
      // A plugin has no node_modules of its own. Anything bare that the host
      // shim did not answer is a mistake worth a build error.
      packages: 'bundle',
    });
    return warningsOnly(out.warnings, entry);
  } catch (error: unknown) {
    return message(error);
  }
}

/**
 * The server. Node builtins stay external — they are present at runtime — but
 * npm packages do not, for the same reason as the page: nothing installs them.
 */
async function buildServer(entry: string, outfile: string): Promise<string | null> {
  try {
    const out = await esbuild({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      external: ['node:*'],
      minify: false,
      sourcemap: 'inline',
      logLevel: 'silent',
      packages: 'bundle',
    });
    return warningsOnly(out.warnings, entry);
  } catch (error: unknown) {
    return message(error);
  }
}

/**
 * esbuild resolves a bare node builtin written without the `node:` prefix by
 * marking it external and warning, which would otherwise produce a module that
 * fails at import time instead of at build time.
 */
function warningsOnly(
  warnings: Array<{ text: string }>,
  entry: string,
): string | null {
  for (const w of warnings) logger.warn('[PrismPlugins] %s: %s', path.basename(entry), w.text);
  return null;
}

function message(error: unknown): string {
  if (error && typeof error === 'object' && 'errors' in error) {
    const errors = (error as { errors?: Array<{ text?: string; location?: { file?: string; line?: number } }> })
      .errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors
        .slice(0, 5)
        .map((e) => {
          const where = e.location?.file
            ? ` (${path.basename(e.location.file)}:${e.location.line ?? 0})`
            : '';
          return `${e.text ?? 'build failed'}${where}`;
        })
        .join('; ');
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function stampPath(outDir: string): string {
  return path.join(outDir, STAMP);
}

function isFresh(outDir: string, revision: string): boolean {
  try {
    return fs.readFileSync(stampPath(outDir), 'utf8').trim() === revision;
  } catch {
    return false;
  }
}

function writeStamp(outDir: string, revision: string): void {
  try {
    fs.writeFileSync(stampPath(outDir), revision);
  } catch (error: unknown) {
    // A missing stamp costs a rebuild next boot, nothing more.
    logger.warn('[PrismPlugins] could not write the build stamp: %s', message(error));
  }
}

function clearStamp(outDir: string): void {
  try {
    fs.rmSync(stampPath(outDir), { force: true });
  } catch {
    // Same as above: a stale stamp is a wasted rebuild, not a failure.
  }
}
