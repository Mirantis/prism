import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { skillCatalogService, __test } from '../skill-catalog.service';

let tmp: string;
let skillsDir: string;
let savedSkillsDir: string | undefined;

function writeSkill(dirName: string, content: string): void {
  const dir = path.join(skillsDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

beforeEach(() => {
  savedSkillsDir = process.env.PRISM_SKILLS_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-skills-test-'));
  skillsDir = path.join(tmp, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  process.env.PRISM_SKILLS_DIR = skillsDir;
  skillCatalogService.invalidate();
});

afterEach(() => {
  if (savedSkillsDir === undefined) delete process.env.PRISM_SKILLS_DIR;
  else process.env.PRISM_SKILLS_DIR = savedSkillsDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SkillCatalogService.getCatalog', () => {
  it('lists a well-formed skill (name + description, no body)', () => {
    writeSkill(
      'pdf-processing',
      `---\nname: pdf-processing\ndescription: Extract text from PDFs.\n---\n\nDo the thing.\n`,
    );
    skillCatalogService.invalidate();
    const catalog = skillCatalogService.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      name: 'pdf-processing',
      dirName: 'pdf-processing',
      description: 'Extract text from PDFs.',
    });
    // Catalog carries no body — only metadata.
    expect(catalog[0]).not.toHaveProperty('body');
  });

  it('tolerates an unquoted colon in the description', () => {
    writeSkill(
      'colon',
      `---\nname: colon\ndescription: Use when X: then do Y.\n---\n\nbody\n`,
    );
    skillCatalogService.invalidate();
    const [entry] = skillCatalogService.getCatalog();
    expect(entry.description).toBe('Use when X: then do Y.');
  });

  it('skips a skill missing name or description', () => {
    writeSkill('no-desc', `---\nname: no-desc\n---\n\nbody\n`);
    writeSkill('no-name', `---\ndescription: orphan\n---\n\nbody\n`);
    writeSkill('ok', `---\nname: ok\ndescription: fine\n---\n\nbody\n`);
    skillCatalogService.invalidate();
    const names = skillCatalogService.getCatalog().map((s) => s.name);
    expect(names).toEqual(['ok']);
  });

  it('returns an empty catalog when no skills are installed', () => {
    skillCatalogService.invalidate();
    expect(skillCatalogService.getCatalog()).toEqual([]);
  });

  it('returns an empty catalog when the skills dir is absent', () => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    skillCatalogService.invalidate();
    expect(skillCatalogService.getCatalog()).toEqual([]);
  });

  it('skips a skill whose SKILL.md is a symlink (no reading arbitrary files)', () => {
    const secret = path.join(tmp, 'secret.md');
    fs.writeFileSync(secret, `---\nname: evil\ndescription: leaked\n---\nsecret body\n`);
    const dir = path.join(skillsDir, 'evil');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(secret, path.join(dir, 'SKILL.md'));
    // A normal skill alongside it still loads.
    writeSkill('ok', `---\nname: ok\ndescription: fine\n---\nbody\n`);
    skillCatalogService.invalidate();
    const names = skillCatalogService.getCatalog().map((s) => s.name);
    expect(names).toEqual(['ok']);
  });

  it('keeps the first (by sorted dir name) on a name collision', () => {
    writeSkill('a-dir', `---\nname: dup\ndescription: from a\n---\nbody\n`);
    writeSkill('b-dir', `---\nname: dup\ndescription: from b\n---\nbody\n`);
    skillCatalogService.invalidate();
    const catalog = skillCatalogService.getCatalog();
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

  it('find is case-insensitive on the skill name', () => {
    expect(skillCatalogService.find('GREET')?.name).toBe('greet');
    expect(skillCatalogService.find('nope')).toBeUndefined();
  });

  it('getSkillBody returns the body with frontmatter stripped', () => {
    const found = skillCatalogService.getSkillBody('greet');
    expect(found).not.toBeNull();
    expect(found!.body).toBe('# Greet\n\nSay hello to the user.');
    expect(found!.body).not.toContain('name: greet');
  });

  it('getSkillBody returns null for an unknown skill', () => {
    expect(skillCatalogService.getSkillBody('missing')).toBeNull();
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

  it('merges workspace (.claude + .agents) with global, tagging source', () => {
    writeSkill('global-only', `---\nname: global-only\ndescription: g\n---\nbody\n`);
    writeWorkspaceSkill('.claude', 'repo-claude', `---\nname: repo-claude\ndescription: c\n---\nbody\n`);
    writeWorkspaceSkill('.agents', 'repo-agents', `---\nname: repo-agents\ndescription: a\n---\nbody\n`);
    skillCatalogService.invalidate();

    const catalog = skillCatalogService.getCatalog(workspaceRoot);
    const bySource = Object.fromEntries(catalog.map((s) => [s.name, s.source]));
    expect(bySource).toEqual({
      'repo-claude': 'workspace',
      'repo-agents': 'workspace',
      'global-only': 'global',
    });
  });

  it('workspace overrides global on a name collision', () => {
    writeSkill('dup', `---\nname: dup\ndescription: from global\n---\nbody\n`);
    writeWorkspaceSkill('.claude', 'dup', `---\nname: dup\ndescription: from workspace\n---\nbody\n`);
    skillCatalogService.invalidate();

    const entry = skillCatalogService.find('dup', workspaceRoot);
    expect(entry).toMatchObject({ source: 'workspace', description: 'from workspace' });
    // Without a workspaceRoot, the global one is returned.
    expect(skillCatalogService.find('dup')).toMatchObject({ source: 'global', description: 'from global' });
  });

  it('.claude wins over .agents on a name collision', () => {
    writeWorkspaceSkill('.claude', 'dup', `---\nname: dup\ndescription: from claude\n---\nbody\n`);
    writeWorkspaceSkill('.agents', 'dup', `---\nname: dup\ndescription: from agents\n---\nbody\n`);
    skillCatalogService.invalidate();

    expect(skillCatalogService.find('dup', workspaceRoot)).toMatchObject({ description: 'from claude' });
  });

  it('getSkillBody resolves a workspace skill body', () => {
    writeWorkspaceSkill('.claude', 'repo-skill', `---\nname: repo-skill\ndescription: c\n---\n# Repo\n\nDo repo things.\n`);
    skillCatalogService.invalidate();

    const found = skillCatalogService.getSkillBody('repo-skill', workspaceRoot);
    expect(found?.entry.source).toBe('workspace');
    expect(found?.body).toBe('# Repo\n\nDo repo things.');
    // Not visible without the workspaceRoot.
    expect(skillCatalogService.getSkillBody('repo-skill')).toBeNull();
  });

  it('missing workspace skill dirs fall back to global only', () => {
    writeSkill('global-only', `---\nname: global-only\ndescription: g\n---\nbody\n`);
    skillCatalogService.invalidate();
    // workspaceRoot has no .claude/skills or .agents/skills.
    const catalog = skillCatalogService.getCatalog(workspaceRoot);
    expect(catalog.map((s) => s.name)).toEqual(['global-only']);
    expect(catalog[0].source).toBe('global');
  });
});

describe('frontmatter parsing helpers', () => {
  it('parses simple and quoted values', () => {
    expect(__test.parseFrontmatter(`---\nname: foo\ndescription: "a: b"\n---\nx`)).toEqual({
      name: 'foo',
      description: 'a: b',
    });
  });

  it('folds a block-scalar description', () => {
    const fm = __test.parseFrontmatter(
      `---\nname: foo\ndescription: |\n  line one\n  line two\n---\nbody`,
    );
    expect(fm.description).toBe('line one line two');
  });

  it('ignores nested (indented) keys', () => {
    const fm = __test.parseFrontmatter(
      `---\nname: foo\ndescription: d\nmetadata:\n  name: nested\n---\nbody`,
    );
    expect(fm.name).toBe('foo');
  });

  it('stripFrontmatter returns the original text when there is no frontmatter', () => {
    expect(__test.stripFrontmatter('just a body')).toBe('just a body');
  });
});
