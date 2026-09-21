import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { skillCatalogService, __test } from '../skill-catalog.service';
import { pluginCatalogService, PLUGIN_SCHEMA_1_0_0 } from '../plugin-catalog.service';

let tmp: string;
let skillsDir: string;
let pluginsDir: string;
let savedSkillsDir: string | undefined;
let savedPluginsDir: string | undefined;

function writeSkill(dirName: string, content: string): void {
  const dir = path.join(skillsDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

/** Install a plugin that contributes one skill. */
function writePluginSkill(pluginId: string, dirName: string, content: string): void {
  const root = path.join(pluginsDir, pluginId);
  fs.mkdirSync(path.join(root, 'skills', dirName), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'plugin.json'),
    JSON.stringify({ $schema: PLUGIN_SCHEMA_1_0_0, name: pluginId }),
  );
  fs.writeFileSync(path.join(root, 'skills', dirName, 'SKILL.md'), content);
}

beforeEach(() => {
  savedSkillsDir = process.env.PRISM_SKILLS_DIR;
  savedPluginsDir = process.env.PRISM_PLUGINS_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-skills-test-'));
  skillsDir = path.join(tmp, 'skills');
  pluginsDir = path.join(tmp, 'plugins');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  process.env.PRISM_SKILLS_DIR = skillsDir;
  // Pin the plugins dir too, or the catalog would read whatever the developer
  // happens to have installed under ~/.prism/plugins.
  process.env.PRISM_PLUGINS_DIR = pluginsDir;
  skillCatalogService.invalidate();
  pluginCatalogService.invalidate();
});

afterEach(() => {
  if (savedSkillsDir === undefined) delete process.env.PRISM_SKILLS_DIR;
  else process.env.PRISM_SKILLS_DIR = savedSkillsDir;
  if (savedPluginsDir === undefined) delete process.env.PRISM_PLUGINS_DIR;
  else process.env.PRISM_PLUGINS_DIR = savedPluginsDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SkillCatalogService.getCatalog', () => {
  it('lists a well-formed skill (name + description, no body)', async () => {
    writeSkill(
      'pdf-processing',
      `---\nname: pdf-processing\ndescription: Extract text from PDFs.\n---\n\nDo the thing.\n`,
    );
    skillCatalogService.invalidate();
    const catalog = await skillCatalogService.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      name: 'pdf-processing',
      dirName: 'pdf-processing',
      description: 'Extract text from PDFs.',
    });
    // Catalog carries no body — only metadata.
    expect(catalog[0]).not.toHaveProperty('body');
  });

  it('tolerates an unquoted colon in the description', async () => {
    writeSkill(
      'colon',
      `---\nname: colon\ndescription: Use when X: then do Y.\n---\n\nbody\n`,
    );
    skillCatalogService.invalidate();
    const [entry] = await skillCatalogService.getCatalog();
    expect(entry.description).toBe('Use when X: then do Y.');
  });

  it('skips a skill missing name or description', async () => {
    writeSkill('no-desc', `---\nname: no-desc\n---\n\nbody\n`);
    writeSkill('no-name', `---\ndescription: orphan\n---\n\nbody\n`);
    writeSkill('ok', `---\nname: ok\ndescription: fine\n---\n\nbody\n`);
    skillCatalogService.invalidate();
    const names = (await skillCatalogService.getCatalog()).map((s) => s.name);
    expect(names).toEqual(['ok']);
  });

  it('returns an empty catalog when no skills are installed', async () => {
    skillCatalogService.invalidate();
    expect(await skillCatalogService.getCatalog()).toEqual([]);
  });

  it('returns an empty catalog when the skills dir is absent', async () => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    skillCatalogService.invalidate();
    expect(await skillCatalogService.getCatalog()).toEqual([]);
  });

  it('skips a skill whose SKILL.md is a symlink (no reading arbitrary files)', async () => {
    const secret = path.join(tmp, 'secret.md');
    fs.writeFileSync(secret, `---\nname: evil\ndescription: leaked\n---\nsecret body\n`);
    const dir = path.join(skillsDir, 'evil');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(secret, path.join(dir, 'SKILL.md'));
    // A normal skill alongside it still loads.
    writeSkill('ok', `---\nname: ok\ndescription: fine\n---\nbody\n`);
    skillCatalogService.invalidate();
    const names = (await skillCatalogService.getCatalog()).map((s) => s.name);
    expect(names).toEqual(['ok']);
  });

  it('keeps the first (by sorted dir name) on a name collision', async () => {
    writeSkill('a-dir', `---\nname: dup\ndescription: from a\n---\nbody\n`);
    writeSkill('b-dir', `---\nname: dup\ndescription: from b\n---\nbody\n`);
    skillCatalogService.invalidate();
    const catalog = await skillCatalogService.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ dirName: 'a-dir', description: 'from a' });
  });
});

describe('SkillCatalogService.find / getSkillBody', () => {
  beforeEach(() => {
    writeSkill(
      'greet',
      `---\nname: greet\ndescription: say hi\n---\n\n# Greet\n\nSay hello to the user.\n`,
    );
    skillCatalogService.invalidate();
  });

  it('find is case-insensitive on the skill name', async () => {
    expect((await skillCatalogService.find('GREET'))?.name).toBe('greet');
    expect(await skillCatalogService.find('nope')).toBeUndefined();
  });

  it('getSkillBody returns the body with frontmatter stripped', async () => {
    const found = await skillCatalogService.getSkillBody('greet');
    expect(found).not.toBeNull();
    expect(found!.body).toBe('# Greet\n\nSay hello to the user.');
    expect(found!.body).not.toContain('name: greet');
  });

  it('getSkillBody returns null for an unknown skill', async () => {
    expect(await skillCatalogService.getSkillBody('missing')).toBeNull();
  });
});

describe('SkillCatalogService plugin skills', () => {
  it('merges a plugin skills/ dir into the catalog, tagged with its plugin', async () => {
    writePluginSkill('demo', 'summarize', `---\nname: summarize\ndescription: Summarize.\n---\nbody\n`);
    skillCatalogService.invalidate();
    pluginCatalogService.invalidate();

    const catalog = await skillCatalogService.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      name: 'summarize',
      source: 'plugin',
      pluginId: 'demo',
    });
  });

  it('leaves pluginId unset on skills that did not come from a plugin', async () => {
    writeSkill('plain', `---\nname: plain\ndescription: p\n---\nbody\n`);
    skillCatalogService.invalidate();

    expect(await skillCatalogService.find('plain')).not.toHaveProperty('pluginId');
  });

  it('loads a plugin skill body through the same progressive-disclosure path', async () => {
    writePluginSkill('demo', 'summarize', `---\nname: summarize\ndescription: s\n---\n# Sum\n\nDo it.\n`);
    skillCatalogService.invalidate();
    pluginCatalogService.invalidate();

    const found = await skillCatalogService.getSkillBody('summarize');
    expect(found?.entry.pluginId).toBe('demo');
    expect(found?.body).toBe('# Sum\n\nDo it.');
  });

  it('ignores a plugin whose manifest is invalid', async () => {
    writePluginSkill('broken', 'ghost', `---\nname: ghost\ndescription: g\n---\nbody\n`);
    // Replace the good manifest with one targeting a version we do not implement.
    fs.writeFileSync(
      path.join(pluginsDir, 'broken', 'plugin.json'),
      JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/9.9.9/plugin.schema.json', name: 'broken' }),
    );
    skillCatalogService.invalidate();
    pluginCatalogService.invalidate();

    expect(await skillCatalogService.getCatalog()).toEqual([]);
  });

  it('resolves a clash between two plugins by plugin id order', async () => {
    writePluginSkill('zeta', 'dup', `---\nname: dup\ndescription: from zeta\n---\nbody\n`);
    writePluginSkill('alpha', 'dup', `---\nname: dup\ndescription: from alpha\n---\nbody\n`);
    skillCatalogService.invalidate();
    pluginCatalogService.invalidate();

    expect(await skillCatalogService.find('dup')).toMatchObject({
      pluginId: 'alpha',
      description: 'from alpha',
    });
  });
});

describe('SkillCatalogService workspace skills', () => {
  // Build a fake repo with .claude/skills and .agents/skills under `tmp`.
  let workspaceRoot: string;

  function writeWorkspaceSkill(sub: '.claude' | '.agents', dirName: string, content: string): void {
    const dir = path.join(workspaceRoot, sub, 'skills', dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  }

  beforeEach(() => {
    workspaceRoot = path.join(tmp, 'repo');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    skillCatalogService.invalidate();
  });

  it('merges workspace (.claude + .agents) with global, tagging source', async () => {
    writeSkill('global-only', `---\nname: global-only\ndescription: g\n---\nbody\n`);
    writeWorkspaceSkill('.claude', 'repo-claude', `---\nname: repo-claude\ndescription: c\n---\nbody\n`);
    writeWorkspaceSkill('.agents', 'repo-agents', `---\nname: repo-agents\ndescription: a\n---\nbody\n`);
    skillCatalogService.invalidate();

    const catalog = await skillCatalogService.getCatalog(workspaceRoot);
    const bySource = Object.fromEntries(catalog.map((s) => [s.name, s.source]));
    expect(bySource).toEqual({
      'repo-claude': 'workspace',
      'repo-agents': 'workspace',
      'global-only': 'global',
    });
  });

  it('workspace overrides global on a name collision', async () => {
    writeSkill('dup', `---\nname: dup\ndescription: from global\n---\nbody\n`);
    writeWorkspaceSkill('.claude', 'dup', `---\nname: dup\ndescription: from workspace\n---\nbody\n`);
    skillCatalogService.invalidate();

    const entry = await skillCatalogService.find('dup', workspaceRoot);
    expect(entry).toMatchObject({ source: 'workspace', description: 'from workspace' });
    // Without a workspaceRoot, the global one is returned.
    expect(await skillCatalogService.find('dup')).toMatchObject({ source: 'global', description: 'from global' });
  });

  it('.claude wins over .agents on a name collision', async () => {
    writeWorkspaceSkill('.claude', 'dup', `---\nname: dup\ndescription: from claude\n---\nbody\n`);
    writeWorkspaceSkill('.agents', 'dup', `---\nname: dup\ndescription: from agents\n---\nbody\n`);
    skillCatalogService.invalidate();

    expect(await skillCatalogService.find('dup', workspaceRoot)).toMatchObject({ description: 'from claude' });
  });

  it('plugin skills lose to both workspace and global on a name collision', async () => {
    writePluginSkill('demo', 'dup', `---\nname: dup\ndescription: from plugin\n---\nbody\n`);
    writeSkill('dup', `---\nname: dup\ndescription: from global\n---\nbody\n`);
    writeWorkspaceSkill('.claude', 'dup', `---\nname: dup\ndescription: from workspace\n---\nbody\n`);
    skillCatalogService.invalidate();
    pluginCatalogService.invalidate();

    expect(await skillCatalogService.find('dup', workspaceRoot)).toMatchObject({
      source: 'workspace',
      description: 'from workspace',
    });
    // Even with no workspace in play, the user's own global skill still wins.
    expect(await skillCatalogService.find('dup')).toMatchObject({
      source: 'global',
      description: 'from global',
    });
  });

  it('getSkillBody resolves a workspace skill body', async () => {
    writeWorkspaceSkill('.claude', 'repo-skill', `---\nname: repo-skill\ndescription: c\n---\n# Repo\n\nDo repo things.\n`);
    skillCatalogService.invalidate();

    const found = await skillCatalogService.getSkillBody('repo-skill', workspaceRoot);
    expect(found?.entry.source).toBe('workspace');
    expect(found?.body).toBe('# Repo\n\nDo repo things.');
    // Not visible without the workspaceRoot.
    expect(await skillCatalogService.getSkillBody('repo-skill')).toBeNull();
  });

  it('missing workspace skill dirs fall back to global only', async () => {
    writeSkill('global-only', `---\nname: global-only\ndescription: g\n---\nbody\n`);
    skillCatalogService.invalidate();
    // workspaceRoot has no .claude/skills or .agents/skills.
    const catalog = await skillCatalogService.getCatalog(workspaceRoot);
    expect(catalog.map((s) => s.name)).toEqual(['global-only']);
    expect(catalog[0].source).toBe('global');
  });
});

describe('frontmatter parsing helpers', () => {
  it('parses simple and quoted values', async () => {
    expect(__test.parseFrontmatter(`---\nname: foo\ndescription: "a: b"\n---\nx`)).toEqual({
      name: 'foo',
      description: 'a: b',
    });
  });

  it('folds a block-scalar description', async () => {
    const fm = __test.parseFrontmatter(
      `---\nname: foo\ndescription: |\n  line one\n  line two\n---\nbody`,
    );
    expect(fm.description).toBe('line one line two');
  });

  it('ignores nested (indented) keys', async () => {
    const fm = __test.parseFrontmatter(
      `---\nname: foo\ndescription: d\nmetadata:\n  name: nested\n---\nbody`,
    );
    expect(fm.name).toBe('foo');
  });

  it('stripFrontmatter returns the original text when there is no frontmatter', async () => {
    expect(__test.stripFrontmatter('just a body')).toBe('just a body');
  });
});
