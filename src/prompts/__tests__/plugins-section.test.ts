/**
 * `# Plugins` system-prompt section tests.
 *
 * Reads real directories rather than mocking the catalogs — the section's whole
 * job is to describe what is on disk, so a fixture on disk is the honest input.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __test } from '../context-builder';
import { pluginCatalogService, PLUGIN_SCHEMA_1_0_0 } from '../../services/plugin-catalog.service';
import { skillCatalogService } from '../../services/skill-catalog.service';

let tmp: string;
let pluginsDir: string;
let skillsDir: string;
let savedDataDir: string | undefined;
let savedSkillsDir: string | undefined;
let savedPluginsDir: string | undefined;

interface PluginFixture {
  version?: string;
  description?: string;
  skill?: string;
  mcp?: boolean;
}

function writePlugin(id: string, fixture: PluginFixture = {}): void {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      $schema: PLUGIN_SCHEMA_1_0_0,
      name: id,
      ...(fixture.version ? { version: fixture.version } : {}),
      ...(fixture.description ? { description: fixture.description } : {}),
    }),
  );
  if (fixture.skill) {
    const skillDir = path.join(dir, 'skills', fixture.skill);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${fixture.skill}\ndescription: Does ${fixture.skill}.\n---\nbody\n`,
    );
  }
  if (fixture.mcp) fs.writeFileSync(path.join(dir, 'mcp.json'), '{}');
}

function section(): string {
  pluginCatalogService.invalidate();
  skillCatalogService.invalidate();
  return __test.buildPluginsSection();
}

beforeEach(() => {
  savedDataDir = process.env.PRISM_DATA_DIR;
  savedSkillsDir = process.env.PRISM_SKILLS_DIR;
  savedPluginsDir = process.env.PRISM_PLUGINS_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugins-section-'));
  pluginsDir = path.join(tmp, 'plugins');
  skillsDir = path.join(tmp, 'skills');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  process.env.PRISM_DATA_DIR = tmp;
  process.env.PRISM_SKILLS_DIR = skillsDir;
  process.env.PRISM_PLUGINS_DIR = pluginsDir;
  pluginCatalogService.invalidate();
  skillCatalogService.invalidate();
});

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('PRISM_DATA_DIR', savedDataDir);
  restore('PRISM_SKILLS_DIR', savedSkillsDir);
  restore('PRISM_PLUGINS_DIR', savedPluginsDir);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('buildPluginsSection', () => {
  it('collapses to one sentence when nothing is installed', () => {
    const out = section();
    expect(out).toContain('# Plugins');
    expect(out).toContain('No Agent Plugins are installed');
    // Most installs have no plugins; they must not pay for a full section.
    expect(out.split('\n\n')).toHaveLength(2);
  });

  it('always names the plugins directory, so the agent can install one itself', () => {
    expect(section()).toContain(pluginsDir);
    writePlugin('demo');
    expect(section()).toContain(pluginsDir);
  });

  it('lists each plugin with its version and description', () => {
    writePlugin('acme-deploy', { version: '1.2.0', description: 'Deploy helpers.' });
    expect(section()).toContain('- **acme-deploy** v1.2.0 — Deploy helpers.');
  });

  it('omits the version and description when the manifest has none', () => {
    writePlugin('bare');
    const out = section();
    expect(out).toContain('- **bare**');
    expect(out).not.toContain('bare** v');
    expect(out).not.toContain('bare** —');
  });

  it('names the skills a plugin contributed', () => {
    writePlugin('notes', { skill: 'summarize' });
    expect(section()).toContain('skills: summarize');
  });

  it('does not credit a plugin for a skill that lost a name clash', () => {
    // A global skill of the same name wins, so the plugin's copy is not
    // available and claiming it here would be a lie.
    writePlugin('notes', { skill: 'summarize' });
    const globalSkill = path.join(skillsDir, 'summarize');
    fs.mkdirSync(globalSkill, { recursive: true });
    fs.writeFileSync(
      path.join(globalSkill, 'SKILL.md'),
      '---\nname: summarize\ndescription: Mine.\n---\nbody\n',
    );

    const out = section();
    expect(out).toContain('- **notes**');
    expect(out).not.toContain('skills: summarize');
  });

  it('points at a plugin tool prefix only when it declares MCP servers', () => {
    writePlugin('withmcp', { mcp: true });
    writePlugin('nomcp', { skill: 'thing' });
    const out = section();
    expect(out).toContain('tools prefixed `withmcp__`');
    expect(out).not.toContain('tools prefixed `nomcp__`');
  });

  it('explains the tool naming scheme, which the tool set itself cannot', () => {
    writePlugin('demo', { mcp: true });
    expect(section()).toContain('`<plugin>__<server>__<tool>`');
  });

  it('does not repeat the skill descriptions already in the Skills section', () => {
    writePlugin('notes', { skill: 'summarize' });
    // The name is enough to correlate the two sections; the description is not
    // worth paying for twice.
    expect(section()).not.toContain('Does summarize.');
  });

  it('lists plugins in id order', () => {
    writePlugin('zeta');
    writePlugin('alpha');
    const out = section();
    expect(out.indexOf('**alpha**')).toBeLessThan(out.indexOf('**zeta**'));
  });

  it('caps the listing and reports the remainder', () => {
    for (let i = 0; i < 55; i++) writePlugin(`p${String(i).padStart(3, '0')}`);
    const out = section();
    expect(out).toContain('(+5 more installed.)');
  });
});
