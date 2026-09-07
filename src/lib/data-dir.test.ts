import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveDataDir,
  resolveSkillsDir,
  resolvePluginsDir,
  resolvePluginDataDir,
  resolveMediaDir,
  ensureDataDirs,
  ensureSymlink,
} from './data-dir';

const ENV_KEYS = ['PRISM_DATA_DIR', 'PRISM_SKILLS_DIR', 'PRISM_PLUGINS_DIR'] as const;
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

describe('resolveSkillsDir / resolveMediaDir', () => {
  it('derive from the data dir', () => {
    process.env.PRISM_DATA_DIR = tmp;
    expect(resolveSkillsDir()).toBe(path.join(tmp, 'skills'));
    expect(resolveMediaDir()).toBe(path.join(tmp, 'media'));
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
  it('creates the skills, plugins, media and tool-output dirs', () => {
    process.env.PRISM_DATA_DIR = tmp;
    const r = ensureDataDirs();

    expect(r.fellBackFrom).toBeNull();
    expect(r.dataDir).toBe(path.resolve(tmp));
    expect(r.skillsDir).toBe(path.join(tmp, 'skills'));
    expect(r.pluginsDir).toBe(path.join(tmp, 'plugins'));
    expect(r.mediaDir).toBe(path.join(tmp, 'media'));
    expect(r.toolOutputDir).toBe(path.join(tmp, 'tool-outputs'));
    for (const dir of [r.skillsDir, r.pluginsDir, r.mediaDir, r.toolOutputDir]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
  });
});

describe('ensureSymlink', () => {
  it('creates the link and reports it in place', () => {
    const target = path.join(tmp, 'target');
    const link = path.join(tmp, 'link');
    fs.mkdirSync(target);

    expect(ensureSymlink(target, link)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
  });

  it('is idempotent — a second run keeps the link', () => {
    const target = path.join(tmp, 'target');
    const link = path.join(tmp, 'link');
    fs.mkdirSync(target);

    ensureSymlink(target, link);
    expect(ensureSymlink(target, link)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
  });

  it('does not clobber a populated real directory at the link path', () => {
    const target = path.join(tmp, 'target');
    const link = path.join(tmp, 'link');
    fs.mkdirSync(target);
    fs.mkdirSync(link);
    fs.writeFileSync(path.join(link, 'keep.txt'), 'x');

    expect(ensureSymlink(target, link)).toBe(false);
    // The pre-existing content survives — we never delete a dir we didn't make.
    expect(fs.existsSync(path.join(link, 'keep.txt'))).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
  });
});
