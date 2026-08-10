import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockListSkills,
  mockListPlugins,
  mockRunSkill,
  mockCreateGoal,
  mockGetThreadGoal,
  mockListGoals,
  mockStopGoal,
  mockPauseGoal,
  mockResumeGoal,
  mockCompactThread,
} = vi.hoisted(() => ({
  mockListSkills: vi.fn(),
  mockListPlugins: vi.fn(),
  mockRunSkill: vi.fn(),
  mockCreateGoal: vi.fn(),
  mockGetThreadGoal: vi.fn(),
  mockListGoals: vi.fn(),
  mockStopGoal: vi.fn(),
  mockPauseGoal: vi.fn(),
  mockResumeGoal: vi.fn(),
  mockCompactThread: vi.fn(),
}));

vi.mock('@/api/runtime-client', () => ({
  runtimeApi: {
    listSkills: mockListSkills,
    listPlugins: mockListPlugins,
    runSkill: mockRunSkill,
    createGoal: mockCreateGoal,
    getThreadGoal: mockGetThreadGoal,
    listGoals: mockListGoals,
    stopGoal: mockStopGoal,
    pauseGoal: mockPauseGoal,
    resumeGoal: mockResumeGoal,
    compactThread: mockCompactThread,
  },
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
    // Markdown, not indented plain text: the chat renders a system message
    // through the same markdown pipeline as a reply, so single newlines in a
    // plain-text list would collapse into one run-on line.
    expect(out).toContain('- **repo-skill** — From the repo. _(workspace)_');
    expect(out).toContain('- **echo-marker** — Reply with a marker.');
    expect(out).not.toContain('echo-marker** — Reply with a marker. _(workspace)_');
  });

  it('labels a plugin-contributed skill with its plugin', async () => {
    mockListSkills.mockResolvedValue([
      { name: 'summarize', description: 'Summarize.', dirName: 'summarize', source: 'plugin', pluginId: 'demo' },
    ]);
    const out = await cmd('/skills').run({ args: [], rawArgs: '', threadId: 't1' });
    expect(out).toContain('- **summarize** — Summarize. _(plugin: demo)_');
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

describe('/compact command', () => {
  it('fires the compaction and stays quiet — progress arrives over the WS', async () => {
    mockCompactThread.mockResolvedValue({ threadId: 't1' });
    const out = await cmd('/compact').run({ args: [], rawArgs: '', threadId: 't1' });
    expect(mockCompactThread).toHaveBeenCalledWith('t1');
    expect(out).toBe('');
  });

  it('requires an active thread', async () => {
    const out = await cmd('/compact').run({ args: [], rawArgs: '' });
    expect(mockCompactThread).not.toHaveBeenCalled();
    expect(out).toBe('No active conversation to compact.');
  });

  it('surfaces the runtime reason (e.g. the 409 nothing-to-compact)', async () => {
    mockCompactThread.mockRejectedValue(new ApiError('Nothing to compact yet.'));
    const out = await cmd('/compact').run({ args: [], rawArgs: '', threadId: 't1' });
    expect(out).toBe('Nothing to compact yet.');
  });
});

describe('/goal command', () => {
  const sampleGoal = {
    id: 'g1',
    threadId: 't1',
    objective: 'make the tests pass',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 12,
    turnCount: 3,
    maxTurns: 100,
    stallCount: 0,
    lastReason: 'In progress.',
    originChannel: 'websocket',
    originChannelId: null,
    createdAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:00.000Z',
    completedAt: null,
  };

  it('sets a new goal from a free-text objective', async () => {
    mockCreateGoal.mockResolvedValue({ ...sampleGoal, objective: 'ship it' });
    const out = await cmd('/goal').run({ args: ['ship', 'it'], rawArgs: 'ship it', threadId: 't1' });
    expect(mockCreateGoal).toHaveBeenCalledWith({ threadId: 't1', objective: 'ship it' });
    expect(out).toContain('Goal set');
    expect(out).toContain('ship it');
  });

  it('treats a multi-word input starting with a reserved word as an objective', async () => {
    mockCreateGoal.mockResolvedValue({ ...sampleGoal, objective: 'stop the flakiness' });
    const out = await cmd('/goal').run({ args: ['stop', 'the', 'flakiness'], rawArgs: 'stop the flakiness', threadId: 't1' });
    expect(mockCreateGoal).toHaveBeenCalledTimes(1);
    expect(mockStopGoal).not.toHaveBeenCalled();
    expect(out).toContain('Goal set');
  });

  it('shows status for the active goal when called with no args', async () => {
    mockGetThreadGoal.mockResolvedValue(sampleGoal);
    const out = await cmd('/goal').run({ args: [], rawArgs: '', threadId: 't1' });
    expect(mockGetThreadGoal).toHaveBeenCalledWith('t1');
    expect(out).toContain('make the tests pass');
    expect(out).toContain('3/100');
  });

  it('reports when there is no active goal', async () => {
    mockGetThreadGoal.mockResolvedValue(null);
    const out = await cmd('/goal').run({ args: [], rawArgs: '', threadId: 't1' });
    expect(out).toContain('No active goal');
  });

  it('stop resolves the thread goal then stops it', async () => {
    mockGetThreadGoal.mockResolvedValue(sampleGoal);
    mockStopGoal.mockResolvedValue({ ...sampleGoal, status: 'stopped' });
    const out = await cmd('/goal').run({ args: ['stop'], rawArgs: 'stop', threadId: 't1' });
    expect(mockGetThreadGoal).toHaveBeenCalledWith('t1');
    expect(mockStopGoal).toHaveBeenCalledWith('g1');
    expect(out).toContain('Goal stopped');
  });

  it('list calls listGoals', async () => {
    mockListGoals.mockResolvedValue([sampleGoal]);
    const out = await cmd('/goal').run({ args: ['list'], rawArgs: 'list', threadId: 't1' });
    expect(mockListGoals).toHaveBeenCalledTimes(1);
    expect(out).toContain('make the tests pass');
  });

  it('refuses to set a goal before a conversation exists', async () => {
    const out = await cmd('/goal').run({ args: ['do', 'stuff'], rawArgs: 'do stuff', threadId: undefined });
    expect(mockCreateGoal).not.toHaveBeenCalled();
    expect(out).toContain('Start a conversation');
  });

  it('surfaces an ApiError message', async () => {
    mockCreateGoal.mockRejectedValue(new ApiError('boom'));
    const out = await cmd('/goal').run({ args: ['do', 'it'], rawArgs: 'do it', threadId: 't1' });
    expect(out).toBe('boom');
  });
});

describe('/help', () => {
  it('lists every registered command', async () => {
    const out = await cmd('/help').run({ args: [], rawArgs: '' });
    for (const c of COMMANDS) expect(out).toContain(c.name);
  });
});

describe('/plugins command', () => {
  it('lists each plugin as its own entry with what it contributes', async () => {
    mockListPlugins.mockResolvedValue([
      {
        id: 'demo',
        name: 'demo',
        version: '1.2.0',
        description: 'A demo plugin.',
        skills: ['summarize'],
        mcpServers: ['probe'],
        diagnostics: [],
      },
    ]);
    const out = await cmd('/plugins').run({ args: [], rawArgs: '' });
    // One markdown list item per plugin, contributions nested beneath it — the
    // point of the format is that plugins don't run together into one sentence.
    expect(out).toContain('- **demo** `v1.2.0` — A demo plugin.');
    expect(out).toContain('    - Skills: `summarize`');
    expect(out).toContain('    - MCP servers: `probe`');
  });

  it('surfaces load diagnostics so a half-broken plugin is visible', async () => {
    mockListPlugins.mockResolvedValue([
      {
        id: 'demo',
        name: 'demo',
        skills: [],
        mcpServers: [],
        diagnostics: ['mcp.json is invalid — no MCP servers loaded'],
      },
    ]);
    const out = await cmd('/plugins').run({ args: [], rawArgs: '' });
    expect(out).toContain('    - **Problem:** mcp.json is invalid');
    expect(out).toContain('    - Contributes nothing');
  });

  it('reports when no plugins are installed', async () => {
    mockListPlugins.mockResolvedValue([]);
    const out = await cmd('/plugins').run({ args: [], rawArgs: '' });
    expect(out).toMatch(/no plugins installed/i);
  });
});
