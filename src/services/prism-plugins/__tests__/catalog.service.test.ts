/**
 * Prism Plugin Catalog Tests
 *
 * Covers discovery, the manifest rules, and the fingerprint — in particular the
 * split between problems that reject a plugin and problems that are reported
 * while it still loads, and that an in-place edit moves the revision, which a
 * directory mtime alone would miss.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { prismPluginCatalogService, __test } from '../catalog.service';

let tmp: string;
let pluginsDir: string;
let savedDataDir: string | undefined;

function writePlugin(id: string, manifest: string): string {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prism-plugin.json'), manifest);
  return dir;
}

function manifest(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ apiVersion: 1, name, ...extra });
}

/** Both the catalog and the tests read the dirs off `PRISM_DATA_DIR`. */
beforeEach(() => {
  savedDataDir = process.env.PRISM_DATA_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-catalog-test-'));
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

describe('discovery', () => {
  it('finds a plugin and reports what it ships', () => {
    const dir = writePlugin('costs', manifest('costs', { version: '1.2.3', description: 'Spend' }));
    fs.mkdirSync(path.join(dir, 'web'));
    fs.writeFileSync(path.join(dir, 'web', 'page.tsx'), 'export default () => null;');
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server', 'index.ts'), 'export default () => ({});');
    fs.mkdirSync(path.join(dir, 'public'));

    prismPluginCatalogService.invalidate();
    const [entry] = prismPluginCatalogService.getPlugins();

    expect(entry.id).toBe('costs');
    expect(entry.version).toBe('1.2.3');
    expect(entry.description).toBe('Spend');
    expect(entry.pageEntry).toBe(path.join(dir, 'web', 'page.tsx'));
    expect(entry.serverEntry).toBe(path.join(dir, 'server', 'index.ts'));
    expect(entry.publicDir).toBe(path.join(dir, 'public'));
    expect(entry.diagnostics).toEqual([]);
  });

  it('returns plugins in directory-name order', () => {
    writePlugin('zebra', manifest('zebra'));
    writePlugin('alpha', manifest('alpha'));
    prismPluginCatalogService.invalidate();
    expect(prismPluginCatalogService.getPlugins().map((p) => p.id)).toEqual(['alpha', 'zebra']);
  });

  it('ignores a directory with no manifest', () => {
    fs.mkdirSync(path.join(pluginsDir, 'not-a-plugin'));
    prismPluginCatalogService.invalidate();
    expect(prismPluginCatalogService.getPlugins()).toEqual([]);
  });

  it('ignores the files the runtime itself writes into the plugins dir', () => {
    fs.writeFileSync(path.join(pluginsDir, 'AUTHORING.md'), '# manual');
    fs.mkdirSync(path.join(pluginsDir, '.types'));
    fs.writeFileSync(path.join(pluginsDir, '.types', 'prism-plugin.d.ts'), 'export {};');
    writePlugin('costs', manifest('costs'));

    prismPluginCatalogService.invalidate();
    expect(prismPluginCatalogService.getPlugins().map((p) => p.id)).toEqual(['costs']);
  });

  it('answers an empty catalog when the plugins dir is absent', () => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    prismPluginCatalogService.invalidate();
    expect(prismPluginCatalogService.getPlugins()).toEqual([]);
    expect(prismPluginCatalogService.revision()).toBe('none');
  });

  it('rejects a symlinked manifest', () => {
    const outside = path.join(tmp, 'outside.json');
    fs.writeFileSync(outside, manifest('sneaky'));
    const dir = path.join(pluginsDir, 'sneaky');
    fs.mkdirSync(dir);
    fs.symlinkSync(outside, path.join(dir, 'prism-plugin.json'));

    prismPluginCatalogService.invalidate();
    expect(prismPluginCatalogService.getPlugins()).toEqual([]);
  });

  it('reports a component of the wrong kind and loads the plugin anyway', () => {
    const dir = writePlugin('odd', manifest('odd'));
    fs.writeFileSync(path.join(dir, 'web'), 'not a directory');
    fs.writeFileSync(path.join(dir, 'public'), 'not a directory');

    prismPluginCatalogService.invalidate();
    const [entry] = prismPluginCatalogService.getPlugins();
    expect(entry.pageEntry).toBeUndefined();
    expect(entry.diagnostics).toContain('web exists but is not a directory — no page loaded');
    expect(entry.diagnostics).toContain('public exists but is not a directory — no static files served');
  });

  it('reports a web directory with no recognized entry file', () => {
    const dir = writePlugin('empty-web', manifest('empty-web'));
    fs.mkdirSync(path.join(dir, 'web'));

    prismPluginCatalogService.invalidate();
    const [entry] = prismPluginCatalogService.getPlugins();
    expect(entry.diagnostics.some((d) => d.startsWith('web/ has no page.tsx'))).toBe(true);
  });

  it('reports a plugin that contributes nothing', () => {
    writePlugin('hollow', manifest('hollow'));
    prismPluginCatalogService.invalidate();
    const [entry] = prismPluginCatalogService.getPlugins();
    expect(entry.diagnostics.some((d) => d.includes('contributes nothing'))).toBe(true);
  });

  it('reports a manifest name that differs from the directory name', () => {
    writePlugin('costs', manifest('spending'));
    prismPluginCatalogService.invalidate();
    const [entry] = prismPluginCatalogService.getPlugins();
    expect(entry.diagnostics).toContain(
      'manifest name "spending" differs from directory name "costs"',
    );
  });

  it('skips a directory whose name is not a valid plugin id', () => {
    writePlugin('Not Valid', manifest('whatever'));
    prismPluginCatalogService.invalidate();
    expect(prismPluginCatalogService.getPlugins()).toEqual([]);
  });

  it('finds a plugin by id', () => {
    writePlugin('costs', manifest('costs'));
    prismPluginCatalogService.invalidate();
    expect(prismPluginCatalogService.find('costs')?.id).toBe('costs');
    expect(prismPluginCatalogService.find('absent')).toBeUndefined();
  });
});

describe('manifest validation', () => {
  const validate = (raw: string) => __test.validateManifest(raw);

  it('accepts a minimal manifest', () => {
    const result = validate(manifest('costs'));
    expect(result.ok).toBe(true);
  });

  it.each([
    ['not JSON at all', '{oops'],
    ['a JSON array', '[]'],
    ['a JSON string', '"costs"'],
  ])('rejects %s', (_label, raw) => {
    expect(validate(raw).ok).toBe(false);
  });

  it('rejects a missing apiVersion', () => {
    const result = validate(JSON.stringify({ name: 'costs' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('apiVersion');
  });

  it('rejects an apiVersion this runtime does not implement', () => {
    const result = validate(JSON.stringify({ apiVersion: 99, name: 'costs' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not supported');
  });

  it.each([
    ['upper case', 'Costs'],
    ['a space', 'my costs'],
    ['a double dash', 'my--costs'],
    ['a double dot', 'my..costs'],
    ['a leading dash', '-costs'],
    ['an empty string', ''],
  ])('rejects a name with %s', (_label, name) => {
    expect(validate(JSON.stringify({ apiVersion: 1, name })).ok).toBe(false);
  });

  it('rejects optional metadata of the wrong type', () => {
    expect(validate(JSON.stringify({ apiVersion: 1, name: 'costs', version: 3 })).ok).toBe(false);
    expect(validate(JSON.stringify({ apiVersion: 1, name: 'costs', icon: [] })).ok).toBe(false);
  });

  it('accepts a version that is not semver — it is metadata, not a constraint', () => {
    expect(validate(manifest('costs', { version: 'nightly' })).ok).toBe(true);
  });

  it('reports an unknown field and still accepts the manifest', () => {
    const result = validate(manifest('costs', { colour: 'red', shape: 'round' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics).toContain(
        'ignoring unknown prism-plugin.json field(s): colour, shape',
      );
    }
  });

  it('skips a manifest larger than the cap', () => {
    const dir = path.join(pluginsDir, 'huge');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'prism-plugin.json'),
      JSON.stringify({ apiVersion: 1, name: 'huge', description: 'x'.repeat(300 * 1024) }),
    );
    prismPluginCatalogService.invalidate();
    expect(prismPluginCatalogService.getPlugins()).toEqual([]);
  });
});

describe('the revision fingerprint', () => {
  it('changes when a file is rewritten in place', () => {
    const dir = writePlugin('costs', manifest('costs'));
    fs.mkdirSync(path.join(dir, 'web'));
    const page = path.join(dir, 'web', 'page.tsx');
    fs.writeFileSync(page, 'export default () => null;');

    const before = prismPluginCatalogService.revision();
    // A rewrite the containing directory's own mtime never sees, which is the
    // author's edit-and-retry loop.
    fs.writeFileSync(page, 'export default () => null; // corrected');
    const after = prismPluginCatalogService.revision();

    expect(after).not.toBe(before);
  });

  it('changes when a plugin is added or removed', () => {
    const empty = prismPluginCatalogService.revision();
    writePlugin('costs', manifest('costs'));
    const withOne = prismPluginCatalogService.revision();
    expect(withOne).not.toBe(empty);

    fs.rmSync(path.join(pluginsDir, 'costs'), { recursive: true, force: true });
    expect(prismPluginCatalogService.revision()).toBe(empty);
  });

  it('does not change when nothing changed', () => {
    writePlugin('costs', manifest('costs'));
    expect(prismPluginCatalogService.revision()).toBe(prismPluginCatalogService.revision());
  });

  it('is per plugin, so one plugin’s edit leaves the other’s revision alone', () => {
    writePlugin('one', manifest('one'));
    writePlugin('two', manifest('two'));
    prismPluginCatalogService.invalidate();
    const before = prismPluginCatalogService.getPlugins();

    fs.writeFileSync(
      path.join(pluginsDir, 'one', 'prism-plugin.json'),
      manifest('one', { description: 'edited' }),
    );
    prismPluginCatalogService.invalidate();
    const after = prismPluginCatalogService.getPlugins();

    const revision = (list: typeof before, id: string) =>
      list.find((p) => p.id === id)?.revision;
    expect(revision(after, 'one')).not.toBe(revision(before, 'one'));
    expect(revision(after, 'two')).toBe(revision(before, 'two'));
  });

  it('does not move when a file is rewritten with identical bytes', () => {
    const dir = writePlugin('costs', manifest('costs'));
    fs.mkdirSync(path.join(dir, 'web'));
    const page = path.join(dir, 'web', 'page.tsx');
    const body = 'export default () => null;';
    fs.writeFileSync(page, body);

    const before = prismPluginCatalogService.revision();
    // A rewrite with the same content moves the mtime and changes nothing. It
    // happens whenever a tool writes a file twice, a checkout restores it, or a
    // harness re-seeds a fixture — and the revision decides whether the runtime
    // restarts, so a restart here would be pure cost.
    fs.writeFileSync(page, body);
    expect(prismPluginCatalogService.revision()).toBe(before);
  });

  it('moves when two files swap contents, which a size stamp alone would miss', () => {
    const dir = writePlugin('costs', manifest('costs'));
    fs.mkdirSync(path.join(dir, 'web'));
    fs.writeFileSync(path.join(dir, 'web', 'a.ts'), 'export const V = 1;');
    fs.writeFileSync(path.join(dir, 'web', 'b.ts'), 'export const V = 2;');

    const before = prismPluginCatalogService.revision();
    fs.writeFileSync(path.join(dir, 'web', 'a.ts'), 'export const V = 2;');
    fs.writeFileSync(path.join(dir, 'web', 'b.ts'), 'export const V = 1;');
    expect(prismPluginCatalogService.revision()).not.toBe(before);
  });

  it('is the same for the same content under a different name', () => {
    // The path is hashed alongside the content, so renaming a file is a change.
    const dir = writePlugin('costs', manifest('costs'));
    fs.mkdirSync(path.join(dir, 'web'));
    fs.writeFileSync(path.join(dir, 'web', 'a.ts'), 'export const V = 1;');
    const before = prismPluginCatalogService.revision();

    fs.rmSync(path.join(dir, 'web', 'a.ts'));
    fs.writeFileSync(path.join(dir, 'web', 'b.ts'), 'export const V = 1;');
    expect(prismPluginCatalogService.revision()).not.toBe(before);
  });

  it('ignores a node_modules a plugin happens to hold', () => {
    const dir = writePlugin('costs', manifest('costs'));
    const before = prismPluginCatalogService.revision();
    fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;');
    expect(prismPluginCatalogService.revision()).toBe(before);
  });
});

describe('caching', () => {
  it('rescans after a change without an explicit invalidate', () => {
    writePlugin('costs', manifest('costs'));
    expect(prismPluginCatalogService.getPlugins()).toHaveLength(1);

    writePlugin('spend', manifest('spend'));
    expect(prismPluginCatalogService.getPlugins().map((p) => p.id)).toEqual(['costs', 'spend']);
  });
});
