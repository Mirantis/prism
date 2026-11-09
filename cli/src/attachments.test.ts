import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  latestTurnAttachments,
  expandPath,
  formatFileSize,
  listPathSuggestions,
} from './attachments.js';

describe('formatFileSize', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('expandPath', () => {
  it('expands a bare ~ and ~/ prefix to the home directory', () => {
    expect(expandPath('~')).toBe(os.homedir());
    expect(expandPath('~/notes.txt')).toBe(path.join(os.homedir(), 'notes.txt'));
  });

  it('leaves other paths untouched', () => {
    expect(expandPath('/tmp/x')).toBe('/tmp/x');
    expect(expandPath('rel/x')).toBe('rel/x');
    // '~user' style is not supported — passed through as-is.
    expect(expandPath('~other/x')).toBe('~other/x');
  });
});

describe('listPathSuggestions', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-attach-test-'));
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'alpha.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'beta.md'), 'b');
    fs.writeFileSync(path.join(dir, '.hidden'), 'h');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists directory contents with dirs first and trailing slash', () => {
    const got = listPathSuggestions('', dir);
    expect(got.map((s) => s.display)).toEqual(['data/', 'docs/', 'alpha.txt', 'beta.md']);
    expect(got[0].isDirectory).toBe(true);
  });

  it('filters by basename prefix', () => {
    const got = listPathSuggestions('al', dir);
    expect(got.map((s) => s.display)).toEqual(['alpha.txt']);
  });

  it('hides dotfiles unless the prefix starts with a dot', () => {
    expect(listPathSuggestions('', dir).map((s) => s.display)).not.toContain('.hidden');
    expect(listPathSuggestions('.', dir).map((s) => s.display)).toContain('.hidden');
  });

  it('preserves the typed dirPart verbatim in insert', () => {
    const got = listPathSuggestions('docs/', dir);
    // docs/ is empty — suggest nothing, but the mechanism matters for parents:
    const parent = listPathSuggestions('data/../al', dir);
    expect(parent.map((s) => s.insert)).toEqual(['data/../alpha.txt']);
  });

  it('returns [] for a nonexistent directory', () => {
    expect(listPathSuggestions('nope/x', dir)).toEqual([]);
  });

  it('returns [] when the dir part is a file', () => {
    expect(listPathSuggestions('alpha.txt/x', dir)).toEqual([]);
  });
});

describe('latestTurnAttachments', () => {
  const file = (id: string) => ({ id, filename: `${id}.bin`, mediaType: 'application/octet-stream', sizeBytes: 1, category: 'other' });

  it("offers the files of every message of the latest turn: a verbose step's chart and the last reply's CSV", () => {
    const messages = [
      { role: 'USER' },
      { role: 'AGENT', attachments: [file('old')] },
      { role: 'USER' },
      { role: 'AGENT', attachments: [{ ...file('chart'), inline: true }] },
      { role: 'AGENT', attachments: [] },
      { role: 'AGENT', attachments: [file('csv')] },
    ];
    expect(latestTurnAttachments(messages).map((a) => a.id)).toEqual(['chart', 'csv']);
  });

  it('falls back to the last turn that delivered files when the newest shared none', () => {
    const messages = [
      { role: 'USER' },
      { role: 'AGENT', attachments: [file('a')] },
      { role: 'AGENT', attachments: [file('b')] },
      { role: 'USER' },
      { role: 'AGENT', attachments: null },
    ];
    expect(latestTurnAttachments(messages).map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('offers the newest autonomous run alone: each goal or scheduled message is a run of its own', () => {
    const messages = [
      { role: 'USER' },
      { role: 'AGENT', triggeredBy: 'USER_INPUT', attachments: [file('chat')] },
      { role: 'AGENT', triggeredBy: 'GOAL', attachments: [file('run1')] },
      { role: 'AGENT', triggeredBy: 'GOAL', attachments: [file('run2')] },
    ];
    expect(latestTurnAttachments(messages).map((a) => a.id)).toEqual(['run2']);
  });

  it("stops a chat turn's files at an autonomous run's message", () => {
    const messages = [
      { role: 'USER' },
      { role: 'AGENT', triggeredBy: 'CRON_TASK', attachments: [file('cron')] },
      { role: 'AGENT', triggeredBy: 'USER_INPUT', attachments: [file('chart')] },
      { role: 'AGENT', triggeredBy: 'USER_INPUT', attachments: [file('csv')] },
    ];
    expect(latestTurnAttachments(messages).map((a) => a.id)).toEqual(['chart', 'csv']);
  });

  it('offers nothing when no agent message has files', () => {
    expect(latestTurnAttachments([{ role: 'USER' }, { role: 'AGENT' }])).toEqual([]);
  });
});
