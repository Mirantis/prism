/**
 * `# Prism Plugins` Section Tests
 *
 * The section has to collapse to a sentence when nothing is installed — most
 * installs have none and should not pay for more than knowing the feature
 * exists — and it has to name the authoring manual's path, which is the whole
 * reason the contract is a file rather than prompt text.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PrismPluginSummary } from '../../services/prism-plugins/prism-plugin.service';

let tmp: string;
let savedDataDir: string | undefined;
let plugins: PrismPluginSummary[] = [];

vi.mock('../../services/prism-plugins/prism-plugin.service', () => ({
  prismPluginService: {
    list: () => plugins,
    guidePath: () => path.join(process.env.PRISM_DATA_DIR ?? '', 'prism-plugins', 'AUTHORING.md'),
  },
}));

const { __test } = await import('../context-builder');

function summary(over: Partial<PrismPluginSummary> = {}): PrismPluginSummary {
  return {
    id: 'costs',
    name: 'costs',
    revision: 'abc123',
    hasPage: true,
    routes: 0,
    tools: 0,
    jobs: 0,
    diagnostics: [],
    ...over,
  };
}

beforeEach(() => {
  savedDataDir = process.env.PRISM_DATA_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugins-section-'));
  process.env.PRISM_DATA_DIR = tmp;
  plugins = [];
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PRISM_DATA_DIR;
  else process.env.PRISM_DATA_DIR = savedDataDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('with nothing installed', () => {
  it('collapses to one sentence and still names both paths', () => {
    const section = __test.buildPrismPluginsSection();
    expect(section).toContain('# Prism Plugins');
    expect(section).toContain('None are installed');
    expect(section).toContain(path.join(tmp, 'prism-plugins'));
    expect(section).toContain('AUTHORING.md');
    // Short enough that an install with no plugins is not paying for a listing.
    expect(section.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(0);
  });
});

describe('with plugins installed', () => {
  it('lists each one and what it contributes', () => {
    plugins = [
      summary({ id: 'costs', version: '1.0.0', description: 'Spend', routes: 3, tools: 1, jobs: 1 }),
      summary({ id: 'notes', hasPage: true }),
    ];
    const section = __test.buildPrismPluginsSection();

    expect(section).toContain('- **costs** v1.0.0 — Spend');
    expect(section).toContain('page');
    expect(section).toContain('3 route(s)');
    expect(section).toContain('tools prefixed `costs__`');
    expect(section).toContain('1 job(s)');
    expect(section).toContain('- **notes**');
  });

  it('names a plugin with problems, so the agent knows to look', () => {
    plugins = [summary({ diagnostics: ['web: broken', 'server: also broken'] })];
    const section = __test.buildPrismPluginsSection();
    expect(section).toContain('2 problem(s)');
  });

  it('explains the tool naming scheme, which the tools block cannot', () => {
    plugins = [summary({ tools: 2 })];
    const section = __test.buildPrismPluginsSection();
    expect(section).toContain('`<plugin>__<tool>`');
  });

  it('tells the agent to read the manual before writing a plugin', () => {
    plugins = [summary()];
    const section = __test.buildPrismPluginsSection();
    expect(section).toContain('starts by reading');
    expect(section).toContain(path.join(tmp, 'prism-plugins', 'AUTHORING.md'));
  });

  it('says a change restarts the runtime', () => {
    plugins = [summary()];
    expect(__test.buildPrismPluginsSection()).toContain('restarts the runtime');
  });

  it('caps the listing and says how many are left', () => {
    plugins = Array.from({ length: 55 }, (_, i) => summary({ id: `p${i}`, name: `p${i}` }));
    const section = __test.buildPrismPluginsSection();
    expect(section.split('\n').filter((l) => l.startsWith('- **'))).toHaveLength(50);
    expect(section).toContain('(+5 more loaded.)');
  });

  it('is stable between calls, so the cached prompt prefix stays byte-identical', () => {
    plugins = [summary({ routes: 2, tools: 1 })];
    expect(__test.buildPrismPluginsSection()).toBe(__test.buildPrismPluginsSection());
  });
});
