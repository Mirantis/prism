import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveDataDir,
  resolveSkillsDir,
  resolvePluginsDir,
  resolvePluginDataDir,
  resolveClaudeConfigDir,
  ensureDataDirs,
} from './data-dir';

const ENV_KEYS = [
  'PRISM_DATA_DIR',
  'PRISM_SKILLS_DIR',
  'PRISM_PLUGINS_DIR',
  'CLAUDE_CONFIG_DIR',
] as const;
let saved: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-datadir-test-'));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveDataDir', () => {
  it('honors PRISM_DATA_DIR over everything else', () => {
    process.env.PRISM_DATA_DIR = tmp;
    expect(resolveDataDir()).toBe(path.resolve(tmp));
  });

  it('falls back to ~/.prism when PRISM_DATA_DIR is unset', () => {
    // The container image sets PRISM_DATA_DIR=/data; with it unset (dev, SEA
    // binary) the resolver uses the home dir. The beforeEach cleared the env.
    expect(resolveDataDir()).toBe(path.join(os.homedir(), '.prism'));
  });
});

describe('resolveSkillsDir / resolveClaudeConfigDir', () => {
  it('derive from the data dir', () => {
    process.env.PRISM_DATA_DIR = tmp;
    expect(resolveSkillsDir()).toBe(path.join(tmp, 'skills'));
    expect(resolveClaudeConfigDir()).toBe(path.join(tmp, '.claude'));
  });

  it('honors PRISM_SKILLS_DIR override', () => {
    process.env.PRISM_DATA_DIR = tmp;
    const custom = path.join(tmp, 'elsewhere');
    process.env.PRISM_SKILLS_DIR = custom;
    expect(resolveSkillsDir()).toBe(custom);
  });
});

describe('resolvePluginsDir / resolvePluginDataDir', () => {
  it('derive from the data dir', () => {
    process.env.PRISM_DATA_DIR = tmp;
    expect(resolvePluginsDir()).toBe(path.join(tmp, 'plugins'));
  });

  it('honors PRISM_PLUGINS_DIR override', () => {
    process.env.PRISM_DATA_DIR = tmp;
    const custom = path.join(tmp, 'elsewhere');
    process.env.PRISM_PLUGINS_DIR = custom;
    expect(resolvePluginsDir()).toBe(custom);
  });

  it('keeps plugin data outside the plugin dir so it survives a re-drop', () => {
    process.env.PRISM_DATA_DIR = tmp;
    const dataDir = resolvePluginDataDir('demo');
    expect(dataDir).toBe(path.join(tmp, 'plugin-data', 'demo'));
    expect(dataDir.startsWith(resolvePluginsDir())).toBe(false);
  });

  it('never escapes the data dir when given a path-shaped id', () => {
    process.env.PRISM_DATA_DIR = tmp;
    expect(resolvePluginDataDir('../../etc')).toBe(path.join(tmp, 'plugin-data', 'etc'));
  });
});

describe('ensureDataDirs', () => {
  it('creates the skills + claude dirs, symlinks skills, and sets CLAUDE_CONFIG_DIR', () => {
    process.env.PRISM_DATA_DIR = tmp;
    const r = ensureDataDirs();

    expect(r.fellBackFrom).toBeNull();
    expect(r.skillsDir).toBe(path.join(tmp, 'skills'));
    expect(r.pluginsDir).toBe(path.join(tmp, 'plugins'));
    expect(fs.statSync(r.skillsDir).isDirectory()).toBe(true);
    expect(fs.statSync(r.pluginsDir).isDirectory()).toBe(true);
    expect(fs.statSync(r.claudeConfigDir).isDirectory()).toBe(true);

    // Only skills are exposed to Claude Code — its plugin layout differs from
    // the Agent Plugins one, so we deliberately do not link plugins across.
    expect(fs.existsSync(path.join(r.claudeConfigDir, 'plugins'))).toBe(false);

    // The claude config dir's skills child is a symlink to the canonical dir.
    const link = path.join(r.claudeConfigDir, 'skills');
    expect(r.symlinkOk).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(r.skillsDir));

    expect(process.env.CLAUDE_CONFIG_DIR).toBe(r.claudeConfigDir);
  });

  it('is idempotent — a second run keeps the symlink', () => {
    process.env.PRISM_DATA_DIR = tmp;
    ensureDataDirs();
    const r = ensureDataDirs();
    const link = path.join(r.claudeConfigDir, 'skills');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(r.skillsDir));
  });

  it('does not clobber a populated real directory at the symlink path', () => {
    process.env.PRISM_DATA_DIR = tmp;
    // Pre-create <claude>/skills as a real dir with content.
    const claudeSkills = path.join(tmp, '.claude', 'skills');
    fs.mkdirSync(claudeSkills, { recursive: true });
    fs.writeFileSync(path.join(claudeSkills, 'keep.txt'), 'x');

    const r = ensureDataDirs();
    expect(r.symlinkOk).toBe(false);
    // The pre-existing content survives — we never delete a dir we didn't make.
    expect(fs.existsSync(path.join(claudeSkills, 'keep.txt'))).toBe(true);
    expect(fs.lstatSync(claudeSkills).isSymbolicLink()).toBe(false);
  });
});
