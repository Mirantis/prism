import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockListSkills, mockRunSkill } = vi.hoisted(() => ({
  mockListSkills: vi.fn(),
  mockRunSkill: vi.fn(),
}));

vi.mock('@/api/runtime-client', () => ({
  runtimeApi: { listSkills: mockListSkills, runSkill: mockRunSkill },
}));

import { ApiError } from '@/api/errors';
import {
  COMMANDS,
  findExact,
  filterByPrefix,
  isSlashMode,
  parseCommandLine,
} from './commands';

function cmd(name: string) {
  const found = findExact(name);
  if (!found) throw new Error(`command ${name} not registered`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseCommandLine', () => {
  it('splits a multi-arg line, preserving the raw remainder', () => {
    expect(parseCommandLine('/skills run my-skill')).toEqual({
      headWord: '/skills',
      args: ['run', 'my-skill'],
      rawArgs: 'run my-skill',
    });
  });

  it('handles a bare command with no args', () => {
    expect(parseCommandLine('/skills')).toEqual({ headWord: '/skills', args: [], rawArgs: '' });
  });
});

describe('isSlashMode', () => {
  it('is true for a leading slash with no space', () => {
    expect(isSlashMode('/')).toBe(true);
    expect(isSlashMode('/sk')).toBe(true);
  });
  it('is false once a space is typed or no leading slash', () => {
    expect(isSlashMode('/skills ')).toBe(false);
    expect(isSlashMode('hello')).toBe(false);
  });
});

describe('filterByPrefix', () => {
  it('lists all commands for "/"', () => {
    expect(filterByPrefix('/').map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
  });
  it('filters by prefix', () => {
    expect(filterByPrefix('/sk').map((c) => c.name)).toEqual(['/skills']);
  });
  it('returns nothing for a non-slash prefix', () => {
    expect(filterByPrefix('sk')).toEqual([]);
  });
});

describe('/skills command', () => {
  it('lists available skills, passing the active thread, labeling workspace ones', async () => {
    mockListSkills.mockResolvedValue([
      { name: 'repo-skill', description: 'From the repo.', dirName: 'repo-skill', source: 'workspace' },
      { name: 'echo-marker', description: 'Reply with a marker.', dirName: 'echo-marker', source: 'global' },
    ]);
    const out = await cmd('/skills').run({ args: [], rawArgs: '', threadId: 't1' });
    expect(mockListSkills).toHaveBeenCalledWith('t1');
    expect(out).toContain('repo-skill — From the repo. (workspace)');
    expect(out).toContain('echo-marker — Reply with a marker.');
    expect(out).not.toContain('echo-marker — Reply with a marker. (workspace)');
  });

  it('list subcommand also lists', async () => {
    mockListSkills.mockResolvedValue([
      { name: 'echo-marker', description: 'Reply with a marker.', dirName: 'echo-marker', source: 'global' },
    ]);
    const out = await cmd('/skills').run({ args: ['list'], rawArgs: 'list' });
    expect(out).toContain('echo-marker');
  });

  it('reports when no skills are available', async () => {
    mockListSkills.mockResolvedValue([]);
    const out = await cmd('/skills').run({ args: [], rawArgs: '' });
    expect(out).toMatch(/no skills available/i);
  });

  it('run forwards the name and the active thread id', async () => {
    mockRunSkill.mockResolvedValue({ threadId: 't1', skill: 'echo-marker' });
    const out = await cmd('/skills').run({ args: ['run', 'echo-marker'], rawArgs: 'run echo-marker', threadId: 't1' });
    expect(mockRunSkill).toHaveBeenCalledWith('echo-marker', 't1');
    expect(out).toContain('echo-marker');
  });

  it('run without a name returns usage and makes no call', async () => {
    const out = await cmd('/skills').run({ args: ['run'], rawArgs: 'run' });
    expect(mockRunSkill).not.toHaveBeenCalled();
    expect(out).toMatch(/usage/i);
  });

  it('surfaces an ApiError message (e.g. unknown skill 404)', async () => {
    mockRunSkill.mockRejectedValue(new ApiError('No available skill named "nope".'));
    const out = await cmd('/skills').run({ args: ['run', 'nope'], rawArgs: 'run nope' });
    expect(out).toContain('No available skill named');
  });
});

describe('/help', () => {
  it('lists every registered command', async () => {
    const out = await cmd('/help').run({ args: [], rawArgs: '' });
    for (const c of COMMANDS) expect(out).toContain(c.name);
  });
});
