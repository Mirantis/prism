/**
 * Prism Plugin Build Tests
 *
 * Real esbuild runs over fixture sources. What matters here is that a page is
 * bound to the host rather than to its own React, that an import the host
 * already provides is a build error naming the host import, and that a failing
 * build degrades to a message instead of a throw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildPlugin } from '../build';
import { prismPluginCatalogService } from '../catalog.service';
import type { PrismPluginEntry } from '../catalog.service';

let tmp: string;
let pluginsDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedDataDir = process.env.PRISM_DATA_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-build-test-'));
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

/** Write a plugin and return the catalog entry the builder takes. */
function plugin(id: string, files: { page?: string; server?: string; extra?: Record<string, string> }): PrismPluginEntry {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prism-plugin.json'), JSON.stringify({ apiVersion: 1, name: id }));
  if (files.page) {
    fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'web', 'page.tsx'), files.page);
  }
  if (files.server) {
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'index.ts'), files.server);
  }
  for (const [rel, body] of Object.entries(files.extra ?? {})) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  prismPluginCatalogService.invalidate();
  const entry = prismPluginCatalogService.find(id);
  if (!entry) throw new Error(`fixture ${id} was not discovered`);
  return entry;
}

const PAGE = `import host from '@prism/plugin';
const { ui } = host;
export default function Page() {
  return <ui.Card>hello</ui.Card>;
}
`;

describe('building a page', () => {
  it('binds it to the host and emits no React of its own', async () => {
    const entry = plugin('costs', { page: PAGE });
    const result = await buildPlugin(entry);

    expect(result.errors).toEqual([]);
    expect(result.pagePath).toBeDefined();

    const built = fs.readFileSync(result.pagePath!, 'utf8');
    // The plugin's own id, written in at build time rather than read from
    // whichever host the SPA installed last.
    expect(built).toContain('host.forPlugin("costs")');
    expect(built).toContain('globalThis.__PRISM_PLUGIN_HOST__');
    // The JSX transform resolved through the shim, so nothing pulled React in.
    expect(built).not.toMatch(/node_modules[/\\]react[/\\]/);
  });

  it('bundles a file the page imports from its own directory', async () => {
    const entry = plugin('costs', {
      page: `import host from '@prism/plugin';
import { LABEL } from './label';
export default function Page() { return <host.ui.Card>{LABEL}</host.ui.Card>; }
`,
      extra: { 'web/label.ts': `export const LABEL = 'from a sibling file';` },
    });

    const result = await buildPlugin(entry);
    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(result.pagePath!, 'utf8')).toContain('from a sibling file');
  });

  // The binding is used in each fixture on purpose. TSX elides an import whose
  // binding is never referenced, so an unused one is dropped before anything
  // tries to resolve it.
  it.each([
    ['react', 'React and its hooks'],
    ['react-dom', 'the SPA owns rendering'],
    ['@tanstack/react-query', '`useQuery`'],
    ['lucide-react', '<Icon name'],
  ])('refuses a direct import of %s and says what to write instead', async (specifier, advice) => {
    const entry = plugin('costs', {
      page: `import x from '${specifier}';\nexport default function Page() { return String(x); }\n`,
    });
    const result = await buildPlugin(entry);

    expect(result.pagePath).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(specifier);
    expect(result.errors[0]).toContain(advice);
    expect(result.errors[0]).toContain("@prism/plugin");
  });

  it('refuses an npm package, since nothing installs one for a plugin', async () => {
    const entry = plugin('costs', {
      page: `import _ from 'lodash';\nexport default function Page() { return String(_); }\n`,
    });
    const result = await buildPlugin(entry);
    expect(result.pagePath).toBeUndefined();
    expect(result.errors[0]).toContain('lodash');
  });

  it('turns a syntax error into a message rather than a throw', async () => {
    const entry = plugin('costs', { page: `export default function Page() { return <div>; }\n` });
    const result = await buildPlugin(entry);

    expect(result.pagePath).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^web: /);
    // The message names the file and line, which is what an author needs.
    expect(result.errors[0]).toContain('page.tsx');
  });
});

describe('building a server', () => {
  it('builds an importable module', async () => {
    const entry = plugin('costs', {
      server: `export default function plugin() {
  return { routes: [{ method: 'GET', path: '/x', handler: () => ({ ok: true }) }] };
}
`,
    });
    const result = await buildPlugin(entry);
    expect(result.errors).toEqual([]);
    expect(result.serverPath).toBeDefined();
    expect(fs.readFileSync(result.serverPath!, 'utf8')).toContain('plugin');
  });

  it('keeps node builtins external', async () => {
    const entry = plugin('costs', {
      server: `import { readFileSync } from 'node:fs';
export default function plugin() {
  return { routes: [{ method: 'GET', path: '/x', handler: () => String(typeof readFileSync) }] };
}
`,
    });
    const result = await buildPlugin(entry);
    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(result.serverPath!, 'utf8')).toContain('node:fs');
  });

  it('erases the type-only import of the emitted declarations', async () => {
    const entry = plugin('costs', {
      server: `import type { PrismPlugin } from '../../.types/prism-plugin';
export default function plugin(): PrismPlugin { return {}; }
`,
    });
    const result = await buildPlugin(entry);
    // Nothing has to resolve `.types/` at runtime, so the file need not exist.
    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(result.serverPath!, 'utf8')).not.toContain('.types/prism-plugin');
  });

  it('reports a page failure and a server failure separately', async () => {
    const entry = plugin('costs', {
      page: `export default function Page() { return <div>; }\n`,
      server: `export default function plugin( { }\n`,
    });
    const result = await buildPlugin(entry);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.some((e) => e.startsWith('web: '))).toBe(true);
    expect(result.errors.some((e) => e.startsWith('server: '))).toBe(true);
  });
});

describe('the build stamp', () => {
  it('skips a rebuild when the revision has not moved', async () => {
    const entry = plugin('costs', { page: PAGE });
    const first = await buildPlugin(entry);
    const mtime = fs.statSync(first.pagePath!).mtimeMs;

    const second = await buildPlugin(entry);
    expect(second.errors).toEqual([]);
    expect(fs.statSync(second.pagePath!).mtimeMs).toBe(mtime);
  });

  it('rebuilds when the revision moves', async () => {
    const entry = plugin('costs', { page: PAGE });
    await buildPlugin(entry);

    fs.writeFileSync(
      path.join(pluginsDir, 'costs', 'web', 'page.tsx'),
      PAGE.replace('hello', 'goodbye'),
    );
    prismPluginCatalogService.invalidate();
    const changed = prismPluginCatalogService.find('costs')!;
    expect(changed.revision).not.toBe(entry.revision);

    const result = await buildPlugin(changed);
    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(result.pagePath!, 'utf8')).toContain('goodbye');
  });

  it('leaves no stamp behind after a failed build, so the next boot retries', async () => {
    const entry = plugin('costs', { page: `export default function Page() { return <div>; }\n` });
    await buildPlugin(entry);
    const stamp = path.join(tmp, 'prism-plugin-build', 'costs', 'revision');
    expect(fs.existsSync(stamp)).toBe(false);
  });
});

describe('a plugin with neither half', () => {
  it('builds nothing and reports nothing', async () => {
    const entry = plugin('hollow', {});
    const result = await buildPlugin(entry);
    expect(result).toEqual({ errors: [] });
  });
});
