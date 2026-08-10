/**
 * Plugin Catalog Tests
 *
 * Covers discovery of Agent Plugins bundles on disk and the manifest validation
 * rules from the Agent Plugins 1.0.0 spec — in particular the split between
 * problems that reject a plugin and problems that are merely reported.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pluginCatalogService, PLUGIN_SCHEMA_1_0_0, __test } from '../plugin-catalog.service';

let tmp: string;
let pluginsDir: string;
let savedPluginsDir: string | undefined;

/** Write a plugin directory with the given manifest text. */
function writePlugin(id: string, manifest: string): string {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), manifest);
  return dir;
}

/** A minimal valid manifest for the given name. */
function manifest(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ $schema: PLUGIN_SCHEMA_1_0_0, name, ...extra });
}

beforeEach(() => {
  savedPluginsDir = process.env.PRISM_PLUGINS_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugins-test-'));
  pluginsDir = path.join(tmp, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  process.env.PRISM_PLUGINS_DIR = pluginsDir;
  pluginCatalogService.invalidate();
});

afterEach(() => {
  if (savedPluginsDir === undefined) delete process.env.PRISM_PLUGINS_DIR;
  else process.env.PRISM_PLUGINS_DIR = savedPluginsDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('PluginCatalogService.getPlugins', () => {
  it('loads a minimal plugin with only the two required manifest fields', () => {
    writePlugin('demo', manifest('demo'));
    pluginCatalogService.invalidate();

    const plugins = pluginCatalogService.getPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ id: 'demo', name: 'demo', diagnostics: [] });
    // Neither component type is present, which is valid.
    expect(plugins[0].skillsDir).toBeUndefined();
    expect(plugins[0].mcpConfigPath).toBeUndefined();
  });

  it('records the fixed component locations when they exist', () => {
    const dir = writePlugin('demo', manifest('demo', { version: '1.2.0', description: 'A demo' }));
    fs.mkdirSync(path.join(dir, 'skills', 'greet'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp.json'), '{}');
    pluginCatalogService.invalidate();

    const [plugin] = pluginCatalogService.getPlugins();
    expect(plugin.version).toBe('1.2.0');
    expect(plugin.description).toBe('A demo');
    expect(plugin.skillsDir).toBe(path.join(dir, 'skills'));
    expect(plugin.mcpConfigPath).toBe(path.join(dir, 'mcp.json'));
  });

  it('returns plugins in directory-name order', () => {
    writePlugin('zeta', manifest('zeta'));
    writePlugin('alpha', manifest('alpha'));
    pluginCatalogService.invalidate();

    expect(pluginCatalogService.getPlugins().map((p) => p.id)).toEqual(['alpha', 'zeta']);
  });

  it('skips a directory with no plugin.json', () => {
    fs.mkdirSync(path.join(pluginsDir, 'not-a-plugin'), { recursive: true });
    pluginCatalogService.invalidate();

    expect(pluginCatalogService.getPlugins()).toEqual([]);
  });

  it('skips a malformed plugin without affecting its siblings', () => {
    writePlugin('broken', '{ not json');
    writePlugin('good', manifest('good'));
    pluginCatalogService.invalidate();

    expect(pluginCatalogService.getPlugins().map((p) => p.id)).toEqual(['good']);
  });

  it('disables only the skills component when skills is not a directory', () => {
    const dir = writePlugin('demo', manifest('demo'));
    fs.writeFileSync(path.join(dir, 'skills'), 'oops');
    fs.writeFileSync(path.join(dir, 'mcp.json'), '{}');
    pluginCatalogService.invalidate();

    const [plugin] = pluginCatalogService.getPlugins();
    expect(plugin.skillsDir).toBeUndefined();
    // The other component type is unaffected.
    expect(plugin.mcpConfigPath).toBe(path.join(dir, 'mcp.json'));
    expect(plugin.diagnostics.join()).toContain('skills exists but is not a directory');
  });

  it('survives a component that cannot even be stat-ed, disabling only that component', () => {
    // A self-referential symlink makes stat throw ELOOP — which
    // `throwIfNoEntry: false` does NOT suppress. getPlugins() feeds every
    // system-prompt build, so it must degrade this plugin, not throw.
    const dir = writePlugin('demo', manifest('demo'));
    fs.symlinkSync('skills', path.join(dir, 'skills'));
    fs.writeFileSync(path.join(dir, 'mcp.json'), '{}');
    pluginCatalogService.invalidate();

    const plugins = pluginCatalogService.getPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].skillsDir).toBeUndefined();
    // The other component type is unaffected.
    expect(plugins[0].mcpConfigPath).toBe(path.join(dir, 'mcp.json'));
    expect(plugins[0].diagnostics.join()).toContain('skills cannot be read');
  });

  it('rescans when the plugins dir changes', () => {
    writePlugin('one', manifest('one'));
    pluginCatalogService.invalidate();
    expect(pluginCatalogService.getPlugins()).toHaveLength(1);

    writePlugin('two', manifest('two'));
    pluginCatalogService.invalidate();
    expect(pluginCatalogService.getPlugins()).toHaveLength(2);
  });

  it('notices a plugin corrected in place, without touching the plugins dir', () => {
    // A directory's mtime moves only when an *immediate* child changes, so
    // keying the cache on the plugins dir alone would see a plugin appear or
    // vanish but never see one edited — which is exactly the fix-it-and-retry
    // loop an author is in.
    writePlugin('demo', '{ not json');
    expect(pluginCatalogService.getPlugins()).toEqual([]);

    // Correct the manifest in place. Nothing about `plugins/` itself changes.
    fs.writeFileSync(path.join(pluginsDir, 'demo', 'plugin.json'), manifest('demo'));

    expect(pluginCatalogService.getPlugins().map((p) => p.id)).toEqual(['demo']);
  });

  it('notices an mcp.json added to an already-loaded plugin', () => {
    const dir = writePlugin('demo', manifest('demo'));
    expect(pluginCatalogService.getPlugins()[0].mcpConfigPath).toBeUndefined();

    fs.writeFileSync(path.join(dir, 'mcp.json'), '{}');

    expect(pluginCatalogService.getPlugins()[0].mcpConfigPath).toBe(path.join(dir, 'mcp.json'));
  });

  it('is empty when the plugins dir does not exist', () => {
    process.env.PRISM_PLUGINS_DIR = path.join(tmp, 'absent');
    pluginCatalogService.invalidate();

    expect(pluginCatalogService.getPlugins()).toEqual([]);
  });
});

describe('PluginCatalogService.find', () => {
  it('looks a plugin up by its directory id', () => {
    writePlugin('demo', manifest('demo'));
    pluginCatalogService.invalidate();

    expect(pluginCatalogService.find('demo')?.name).toBe('demo');
    expect(pluginCatalogService.find('missing')).toBeUndefined();
  });
});

describe('manifest validation', () => {
  const ok = (raw: string, id = 'demo') => __test.validateManifest(raw, id);

  it('accepts the minimal manifest', () => {
    const result = ok(manifest('demo'));
    expect(result.ok).toBe(true);
  });

  it('rejects a manifest targeting an Agent Plugins version we do not implement', () => {
    const result = ok(
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json',
        name: 'demo',
      }),
    );
    expect(result.ok).toBe(false);
    // The message must name the declared version — spec SHOULD-level reporting.
    if (!result.ok) {
      expect(result.error).toContain('unsupported Agent Plugins version');
      expect(result.error).toContain('2.0.0');
    }
  });

  it('distinguishes a foreign plugin.json from an unsupported version', () => {
    const result = ok(JSON.stringify({ $schema: 'https://example.com/other.json', name: 'demo' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not an Agent Plugins manifest');
  });

  it('rejects a missing $schema', () => {
    const result = ok(JSON.stringify({ name: 'demo' }));
    expect(result.ok).toBe(false);
  });

  it.each([
    ['My-Plugin', 'uppercase'],
    ['-start', 'leading hyphen'],
    ['end-', 'trailing hyphen'],
    ['has--double', 'consecutive hyphens'],
    ['too.many..dots', 'consecutive dots'],
    ['', 'empty'],
    ['a'.repeat(65), 'longer than 64 chars'],
  ])('rejects the name %j (%s)', (name) => {
    expect(__test.isValidPluginName(name)).toBe(false);
    expect(ok(JSON.stringify({ $schema: PLUGIN_SCHEMA_1_0_0, name })).ok).toBe(false);
  });

  it.each([['my-plugin'], ['acme.tools'], ['lint3r'], ['a']])('accepts the name %j', (name) => {
    expect(__test.isValidPluginName(name)).toBe(true);
  });

  it('reports unknown top-level fields but still loads the plugin', () => {
    const result = ok(manifest('demo', { hooks: './hooks', commands: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Sorted, so the message is stable.
      expect(result.diagnostics.join()).toContain('commands, hooks');
    }
  });

  it('reports a non-object extensions field but still loads the plugin', () => {
    const result = ok(manifest('demo', { extensions: 'nope' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagnostics.join()).toContain('ignoring "extensions"');
  });

  it('never validates the contents of an extension namespace', () => {
    const result = ok(
      manifest('demo', { extensions: { 'com.example.client': { anything: [1, 2] } } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagnostics).toEqual([]);
  });

  it('accepts loose metadata — a non-semver version is not a rejection', () => {
    const result = ok(manifest('demo', { version: 'release-2026-07', license: 'whatever' }));
    expect(result.ok).toBe(true);
  });

  it('rejects metadata of the wrong type', () => {
    expect(ok(manifest('demo', { version: 12 })).ok).toBe(false);
    expect(ok(manifest('demo', { keywords: 'not-an-array' })).ok).toBe(false);
    expect(ok(manifest('demo', { author: 'someone' })).ok).toBe(false);
  });

  it('notes when the manifest name differs from the directory name', () => {
    const result = ok(manifest('other-name'), 'demo');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagnostics.join()).toContain('differs from directory name');
  });

  it('rejects a manifest that is not a JSON object', () => {
    expect(ok('[]').ok).toBe(false);
    expect(ok('"a string"').ok).toBe(false);
  });
});
