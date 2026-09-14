/**
 * Server-half Revision Tests
 *
 * A restart exists to reload the half of a plugin that lives in this process.
 * A page does not: it is built to a file the browser fetches by URL. Telling
 * the two apart is what keeps the agent's editing loop working — it writes a
 * plugin one file at a time, and a restart on the first of them ends the turn
 * that was going to write the rest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { prismPluginCatalogService, __test } from '../catalog.service';

let tmp: string;
let pluginsDir: string;
let savedDataDir: string | undefined;

function writePlugin(id: string): string {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'prism-plugin.json'),
    JSON.stringify({ apiVersion: 1, name: id }),
  );
  fs.writeFileSync(path.join(dir, 'web', 'page.tsx'), 'export default () => null;');
  fs.writeFileSync(path.join(dir, 'server', 'index.ts'), 'export default () => ({});');
  fs.writeFileSync(path.join(dir, 'public', 'note.txt'), 'hello');
  return dir;
}

beforeEach(() => {
  savedDataDir = process.env.PRISM_DATA_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-server-rev-'));
  process.env.PRISM_DATA_DIR = tmp;
  pluginsDir = path.join(tmp, 'prism-plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  prismPluginCatalogService.invalidate();
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PRISM_DATA_DIR;
  else process.env.PRISM_DATA_DIR = savedDataDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('what counts as the server half', () => {
  const { isServerHalf } = __test;

  it.each(['prism-plugin.json', 'server/', 'server/index.ts', 'server/lib/query.ts'])(
    'counts %s',
    (rel) => {
      expect(isServerHalf(rel)).toBe(true);
    },
  );

  it.each(['web/', 'web/page.tsx', 'web/parts/table.tsx', 'public/', 'public/note.txt'])(
    'does not count %s',
    (rel) => {
      expect(isServerHalf(rel)).toBe(false);
    },
  );
});

describe('the server revision', () => {
  it('does not move when only the page changes', () => {
    const dir = writePlugin('costs');
    const before = prismPluginCatalogService.serverRevision();

    fs.writeFileSync(path.join(dir, 'web', 'page.tsx'), 'export default () => null; // edited');

    expect(prismPluginCatalogService.serverRevision()).toBe(before);
    // The whole-plugin revision does move, so the page's module URL changes and
    // the browser cannot serve the old bundle.
    prismPluginCatalogService.invalidate();
    expect(prismPluginCatalogService.revision()).not.toBe(before);
  });

  it('does not move when a page file is added', () => {
    const dir = writePlugin('costs');
    const before = prismPluginCatalogService.serverRevision();
    fs.writeFileSync(path.join(dir, 'web', 'table.tsx'), 'export const T = 1;');
    expect(prismPluginCatalogService.serverRevision()).toBe(before);
  });

  it('does not move when a public file changes', () => {
    const dir = writePlugin('costs');
    const before = prismPluginCatalogService.serverRevision();
    fs.writeFileSync(path.join(dir, 'public', 'note.txt'), 'goodbye');
    expect(prismPluginCatalogService.serverRevision()).toBe(before);
  });

  it('moves when the server changes', () => {
    const dir = writePlugin('costs');
    const before = prismPluginCatalogService.serverRevision();
    fs.writeFileSync(path.join(dir, 'server', 'index.ts'), 'export default () => ({ routes: [] });');
    expect(prismPluginCatalogService.serverRevision()).not.toBe(before);
  });

  it('moves when a file the server imports changes', () => {
    const dir = writePlugin('costs');
    const before = prismPluginCatalogService.serverRevision();
    fs.writeFileSync(path.join(dir, 'server', 'query.ts'), 'export const Q = 1;');
    expect(prismPluginCatalogService.serverRevision()).not.toBe(before);
  });

  it('moves when the manifest changes', () => {
    const dir = writePlugin('costs');
    const before = prismPluginCatalogService.serverRevision();
    fs.writeFileSync(
      path.join(dir, 'prism-plugin.json'),
      JSON.stringify({ apiVersion: 1, name: 'costs', description: 'now described' }),
    );
    expect(prismPluginCatalogService.serverRevision()).not.toBe(before);
  });

  it('moves when a plugin is added, even a page-only one', () => {
    writePlugin('costs');
    const before = prismPluginCatalogService.serverRevision();

    // Its manifest is new, so the runtime has to load it — a page-only plugin
    // still needs the process to know it exists.
    const dir = path.join(pluginsDir, 'notes');
    fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'prism-plugin.json'),
      JSON.stringify({ apiVersion: 1, name: 'notes' }),
    );
    fs.writeFileSync(path.join(dir, 'web', 'page.tsx'), 'export default () => null;');

    expect(prismPluginCatalogService.serverRevision()).not.toBe(before);
  });

  it('moves when a plugin is removed', () => {
    writePlugin('costs');
    writePlugin('notes');
    const before = prismPluginCatalogService.serverRevision();
    fs.rmSync(path.join(pluginsDir, 'notes'), { recursive: true, force: true });
    expect(prismPluginCatalogService.serverRevision()).not.toBe(before);
  });

  it('is on each entry as well as the aggregate', () => {
    writePlugin('costs');
    prismPluginCatalogService.invalidate();
    const [entry] = prismPluginCatalogService.getPlugins();
    expect(entry.serverRevision).toMatch(/^[0-9a-f]{12}$/);
    expect(entry.serverRevision).not.toBe(entry.revision);
  });
});
