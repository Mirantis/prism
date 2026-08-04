import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  COMMANDS,
  CommandContext,
  PanelId,
  findExact,
  filterByPrefix,
  parseCommandLine,
  parseInterval,
} from './commands.js';
import { ApiClient, ApiError } from './api-client.js';

/**
 * Build a stub ApiClient where every method is a `vi.fn()`. Callers override
 * the methods they exercise with concrete resolved values.
 */
function stubApi(): { [K in keyof ApiClient]: ReturnType<typeof vi.fn> } {
  return {
    getMe: vi.fn(),
    getDetails: vi.fn(),
    setName: vi.fn(),
    getModel: vi.fn(),
    setModel: vi.fn(),
    getHeartbeatModel: vi.fn(),
    setHeartbeatModel: vi.fn(),
    getCronModel: vi.fn(),
    setCronModel: vi.fn(),
    getHeartbeatStatus: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    triggerHeartbeat: vi.fn(),
    setHeartbeatInterval: vi.fn(),
    listCronTasks: vi.fn(),
    createCronTask: vi.fn(),
    deleteCronTask: vi.fn(),
    createGoal: vi.fn(),
    getThreadGoal: vi.fn(),
    listGoals: vi.fn(),
    stopGoal: vi.fn(),
    pauseGoal: vi.fn(),
    resumeGoal: vi.fn(),
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    downloadAttachment: vi.fn(),
    listSkills: vi.fn(),
    runSkill: vi.fn(),
    compactThread: vi.fn(),
  };
}

/** Assemble a CommandContext from overrides, defaulting the noisy fields. */
function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    lastMessageContent: null,
    requestShutdown: vi.fn(),
    args: [],
    rawArgs: '',
    openPanel: vi.fn(),
    api: stubApi() as unknown as ApiClient,
    threadId: 'thread-1',
    recentAttachments: [],
    stagedAttachments: [],
    stageAttachment: vi.fn(),
    clearStagedAttachments: vi.fn(),
    ...overrides,
  };
}

/** Fetch a command by name or fail loudly if it's missing from COMMANDS. */
function cmd(name: string) {
  const found = findExact(name);
  if (!found) throw new Error(`command ${name} not registered`);
  return found;
}

describe('parseInterval', () => {
  it.each([
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['1m', 60_000],
    ['168h', 604_800_000],
  ])('parses %s -> %d', (token, expected) => {
    expect(parseInterval(token)).toBe(expected);
  });

  it.each([
    ['0m'], // below the 1-minute floor
    ['30s'], // unsupported unit
    ['99999h'], // above the 7-day ceiling
    ['abc'], // not numeric
    [''], // empty
    ['5'], // missing unit
    ['m'], // missing number
  ])('rejects %s -> null', (token) => {
    expect(parseInterval(token)).toBeNull();
  });

  it('is case-insensitive on the unit', () => {
    expect(parseInterval('5M')).toBe(300_000);
    expect(parseInterval('2H')).toBe(7_200_000);
  });
});

describe('parseCommandLine', () => {
  it('splits a multi-arg line', () => {
    expect(parseCommandLine('/heartbeat every 5m')).toEqual({
      headWord: '/heartbeat',
      args: ['every', '5m'],
      rawArgs: 'every 5m',
    });
  });

  it('preserves inner spaces in rawArgs', () => {
    const result = parseCommandLine('/rename My Agent');
    expect(result.headWord).toBe('/rename');
    expect(result.rawArgs).toBe('My Agent');
    expect(result.args).toEqual(['My', 'Agent']);
  });

  it('returns empty args for a bare command', () => {
    expect(parseCommandLine('/help')).toEqual({
      headWord: '/help',
      args: [],
      rawArgs: '',
    });
  });

  it('treats trailing whitespace as no args', () => {
    expect(parseCommandLine('/exit   ')).toEqual({
      headWord: '/exit',
      args: [],
      rawArgs: '',
    });
  });
});

describe('/goal routing', () => {
  const sampleGoal = {
    id: 'g1',
    threadId: 'thread-1',
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
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    completedAt: null,
  };

  it('sets a new goal from a free-text objective', async () => {
    const api = stubApi();
    api.createGoal.mockResolvedValue({ ...sampleGoal, objective: 'ship it', maxTurns: 100 });
    const out = await cmd('/goal').run(
      makeCtx({ args: ['ship', 'it'], rawArgs: 'ship it', api: api as unknown as ApiClient }),
    );
    expect(api.createGoal).toHaveBeenCalledWith({ threadId: 'thread-1', objective: 'ship it' });
    expect(out).toContain('Goal set');
    expect(out).toContain('ship it');
  });

  it('treats a multi-word input starting with a reserved word as an objective', async () => {
    const api = stubApi();
    api.createGoal.mockResolvedValue({ ...sampleGoal, objective: 'stop the flakiness' });
    const out = await cmd('/goal').run(
      makeCtx({ args: ['stop', 'the', 'flakiness'], rawArgs: 'stop the flakiness', api: api as unknown as ApiClient }),
    );
    expect(api.createGoal).toHaveBeenCalledTimes(1);
    expect(api.stopGoal).not.toHaveBeenCalled();
    expect(out).toContain('Goal set');
  });

  it('shows status for the active goal when called with no args', async () => {
    const api = stubApi();
    api.getThreadGoal.mockResolvedValue(sampleGoal);
    const out = await cmd('/goal').run(makeCtx({ args: [], rawArgs: '', api: api as unknown as ApiClient }));
    expect(api.getThreadGoal).toHaveBeenCalledWith('thread-1');
    expect(out).toContain('make the tests pass');
    expect(out).toContain('3/100');
  });

  it('reports when there is no active goal', async () => {
    const api = stubApi();
    api.getThreadGoal.mockResolvedValue(null);
    const out = await cmd('/goal').run(makeCtx({ args: [], rawArgs: '', api: api as unknown as ApiClient }));
    expect(out).toContain('No active goal');
  });

  it('stop resolves the thread goal then stops it', async () => {
    const api = stubApi();
    api.getThreadGoal.mockResolvedValue(sampleGoal);
    api.stopGoal.mockResolvedValue({ ...sampleGoal, status: 'stopped' });
    const out = await cmd('/goal').run(
      makeCtx({ args: ['stop'], rawArgs: 'stop', api: api as unknown as ApiClient }),
    );
    expect(api.getThreadGoal).toHaveBeenCalledWith('thread-1');
    expect(api.stopGoal).toHaveBeenCalledWith('g1');
    expect(out).toContain('Goal stopped');
  });

  it('list calls listGoals', async () => {
    const api = stubApi();
    api.listGoals.mockResolvedValue([sampleGoal]);
    const out = await cmd('/goal').run(
      makeCtx({ args: ['list'], rawArgs: 'list', api: api as unknown as ApiClient }),
    );
    expect(api.listGoals).toHaveBeenCalledTimes(1);
    expect(out).toContain('make the tests pass');
  });

  it('refuses to set a goal before a conversation exists', async () => {
    const api = stubApi();
    const out = await cmd('/goal').run(
      makeCtx({ args: ['do', 'stuff'], rawArgs: 'do stuff', threadId: null, api: api as unknown as ApiClient }),
    );
    expect(api.createGoal).not.toHaveBeenCalled();
    expect(out).toContain('Start a conversation');
  });
});

describe('/heartbeat routing', () => {
  it('status calls getHeartbeatStatus and formats a readable line', async () => {
    const api = stubApi();
    api.getHeartbeatStatus.mockResolvedValue({
      isActive: true,
      lastRun: '2026-06-03T00:00:00.000Z',
      isRunning: false,
      consecutiveErrors: 0,
      intervalMs: 300_000,
    });
    const out = await cmd('/heartbeat').run(
      makeCtx({ args: ['status'], api: api as unknown as ApiClient }),
    );
    expect(api.getHeartbeatStatus).toHaveBeenCalledTimes(1);
    expect(out).toContain('active: true');
    expect(out).toContain('300000ms');
  });

  it('start calls getDetails THEN startHeartbeat', async () => {
    const api = stubApi();
    const details = { id: 'a1', name: 'Prism' };
    api.getDetails.mockResolvedValue(details);
    api.startHeartbeat.mockResolvedValue({ success: true, message: 'started' });
    const out = await cmd('/heartbeat').run(
      makeCtx({ args: ['start'], api: api as unknown as ApiClient }),
    );
    expect(api.getDetails).toHaveBeenCalledTimes(1);
    expect(api.startHeartbeat).toHaveBeenCalledWith(details);
    expect(api.getDetails.mock.invocationCallOrder[0]).toBeLessThan(
      api.startHeartbeat.mock.invocationCallOrder[0],
    );
    expect(out).toBe('started');
  });

  it('stop calls stopHeartbeat', async () => {
    const api = stubApi();
    api.stopHeartbeat.mockResolvedValue({ success: true, message: 'stopped' });
    const out = await cmd('/heartbeat').run(
      makeCtx({ args: ['stop'], api: api as unknown as ApiClient }),
    );
    expect(api.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(out).toBe('stopped');
  });

  it('trigger calls triggerHeartbeat', async () => {
    const api = stubApi();
    api.triggerHeartbeat.mockResolvedValue({ success: true, result: {} });
    const out = await cmd('/heartbeat').run(
      makeCtx({ args: ['trigger'], api: api as unknown as ApiClient }),
    );
    expect(api.triggerHeartbeat).toHaveBeenCalledTimes(1);
    expect(out).toContain('triggered');
  });

  it('every 5m calls setHeartbeatInterval(300000)', async () => {
    const api = stubApi();
    api.setHeartbeatInterval.mockResolvedValue({
      isActive: true,
      lastRun: null,
      isRunning: false,
      consecutiveErrors: 0,
      intervalMs: 300_000,
    });
    await cmd('/heartbeat').run(
      makeCtx({ args: ['every', '5m'], api: api as unknown as ApiClient }),
    );
    expect(api.setHeartbeatInterval).toHaveBeenCalledWith(300_000);
  });

  it('every with a bad token returns usage and makes no call', async () => {
    const api = stubApi();
    const out = await cmd('/heartbeat').run(
      makeCtx({ args: ['every', '30s'], api: api as unknown as ApiClient }),
    );
    expect(api.setHeartbeatInterval).not.toHaveBeenCalled();
    expect(out).toBe('Use Nm or Nh, e.g. /heartbeat every 5m');
  });

  it('unknown subcommand returns a usage string', async () => {
    const api = stubApi();
    const out = await cmd('/heartbeat').run(
      makeCtx({ args: ['wat'], api: api as unknown as ApiClient }),
    );
    expect(out).toContain('Usage:');
    expect(api.getHeartbeatStatus).not.toHaveBeenCalled();
  });

  it('surfaces ApiError.message instead of throwing', async () => {
    const api = stubApi();
    api.getHeartbeatStatus.mockRejectedValue(new ApiError('boom', 500));
    const out = await cmd('/heartbeat').run(
      makeCtx({ args: ['status'], api: api as unknown as ApiClient }),
    );
    expect(out).toBe('boom');
  });
});

describe('/rename validation', () => {
  it('empty name returns an error and makes no api call', async () => {
    const api = stubApi();
    const out = await cmd('/rename').run(
      makeCtx({ rawArgs: '', api: api as unknown as ApiClient }),
    );
    expect(api.setName).not.toHaveBeenCalled();
    expect(out).toMatch(/usage/i);
  });

  it('a 65-character name returns an error and makes no api call', async () => {
    const api = stubApi();
    const long = 'x'.repeat(65);
    const out = await cmd('/rename').run(
      makeCtx({ rawArgs: long, api: api as unknown as ApiClient }),
    );
    expect(api.setName).not.toHaveBeenCalled();
    expect(out).toMatch(/too long/i);
  });

  it('a valid name calls setName and confirms', async () => {
    const api = stubApi();
    api.setName.mockResolvedValue({ name: 'My Agent' });
    const out = await cmd('/rename').run(
      makeCtx({ rawArgs: 'My Agent', api: api as unknown as ApiClient }),
    );
    expect(api.setName).toHaveBeenCalledWith('My Agent');
    expect(out).toBe('Renamed to "My Agent".');
  });

  it('surfaces ApiError.message', async () => {
    const api = stubApi();
    api.setName.mockRejectedValue(new ApiError('name taken', 409));
    const out = await cmd('/rename').run(
      makeCtx({ rawArgs: 'Dup', api: api as unknown as ApiClient }),
    );
    expect(out).toBe('name taken');
  });
});

describe('/model', () => {
  it('reset calls setModel(null)', async () => {
    const api = stubApi();
    api.setModel.mockResolvedValue({ model: null });
    const out = await cmd('/model').run(
      makeCtx({ args: ['reset'], api: api as unknown as ApiClient }),
    );
    expect(api.setModel).toHaveBeenCalledWith(null);
    expect(out).toContain('default');
  });

  it('foo calls setModel("foo")', async () => {
    const api = stubApi();
    api.setModel.mockResolvedValue({ model: 'foo' });
    const out = await cmd('/model').run(
      makeCtx({ args: ['foo'], api: api as unknown as ApiClient }),
    );
    expect(api.setModel).toHaveBeenCalledWith('foo');
    expect(out).toContain('foo');
  });

  it('missing arg returns usage and makes no call', async () => {
    const api = stubApi();
    const out = await cmd('/model').run(
      makeCtx({ args: [], api: api as unknown as ApiClient }),
    );
    expect(api.setModel).not.toHaveBeenCalled();
    expect(out).toMatch(/usage/i);
  });
});

describe('/skills', () => {
  it('lists available skills with descriptions, passing the active thread, labeling workspace ones', async () => {
    const api = stubApi();
    api.listSkills.mockResolvedValue([
      { name: 'repo-skill', description: 'From the repo.', dirName: 'repo-skill', source: 'workspace' },
      { name: 'echo-marker', description: 'Reply with a marker.', dirName: 'echo-marker', source: 'global' },
    ]);
    const out = await cmd('/skills').run(
      makeCtx({ args: [], threadId: 't1', api: api as unknown as ApiClient }),
    );
    // The active thread is forwarded so the runtime includes repo skills.
    expect(api.listSkills).toHaveBeenCalledWith('t1');
    expect(out).toContain('repo-skill — From the repo. (workspace)');
    expect(out).toContain('echo-marker — Reply with a marker.');
    // Global skills are not labeled (workspace)
    expect(out).not.toContain('echo-marker — Reply with a marker. (workspace)');
  });

  it('list subcommand also lists', async () => {
    const api = stubApi();
    api.listSkills.mockResolvedValue([
      { name: 'echo-marker', description: 'Reply with a marker.', dirName: 'echo-marker', source: 'global' },
    ]);
    const out = await cmd('/skills').run(
      makeCtx({ args: ['list'], api: api as unknown as ApiClient }),
    );
    expect(out).toContain('echo-marker');
  });

  it('reports when no skills are available', async () => {
    const api = stubApi();
    api.listSkills.mockResolvedValue([]);
    const out = await cmd('/skills').run(makeCtx({ args: [], api: api as unknown as ApiClient }));
    expect(out).toMatch(/no skills available/i);
  });

  it('run forwards the name and the active thread id', async () => {
    const api = stubApi();
    api.runSkill.mockResolvedValue({ threadId: 't1', skill: 'echo-marker' });
    const out = await cmd('/skills').run(
      makeCtx({ args: ['run', 'echo-marker'], threadId: 't1', api: api as unknown as ApiClient }),
    );
    expect(api.runSkill).toHaveBeenCalledWith('echo-marker', 't1');
    expect(out).toContain('echo-marker');
  });

  it('run without a name returns usage and makes no call', async () => {
    const api = stubApi();
    const out = await cmd('/skills').run(
      makeCtx({ args: ['run'], api: api as unknown as ApiClient }),
    );
    expect(api.runSkill).not.toHaveBeenCalled();
    expect(out).toMatch(/usage/i);
  });

  it('surfaces an ApiError message (e.g. unknown skill 404)', async () => {
    const api = stubApi();
    api.runSkill.mockRejectedValue(new ApiError('No available skill named "nope".', 404));
    const out = await cmd('/skills').run(
      makeCtx({ args: ['run', 'nope'], api: api as unknown as ApiClient }),
    );
    expect(out).toContain('No available skill named');
  });
});

describe('/compact', () => {
  it('fires the compaction and stays quiet — progress arrives over the WS', async () => {
    const api = stubApi();
    api.compactThread.mockResolvedValue({ threadId: 't1' });
    const out = await cmd('/compact').run(
      makeCtx({ threadId: 't1', api: api as unknown as ApiClient }),
    );
    expect(api.compactThread).toHaveBeenCalledWith('t1');
    expect(out).toBe('');
  });

  it('requires an active thread', async () => {
    const api = stubApi();
    const out = await cmd('/compact').run(
      makeCtx({ threadId: null, api: api as unknown as ApiClient }),
    );
    expect(api.compactThread).not.toHaveBeenCalled();
    expect(out).toBe('No active conversation to compact.');
  });

  it('surfaces the runtime reason (e.g. the 409 nothing-to-compact)', async () => {
    const api = stubApi();
    api.compactThread.mockRejectedValue(new ApiError('Nothing to compact yet.', 409));
    const out = await cmd('/compact').run(
      makeCtx({ threadId: 't1', api: api as unknown as ApiClient }),
    );
    expect(out).toBe('Nothing to compact yet.');
  });
});

describe('/heartbeat-model', () => {
  it('reset calls setHeartbeatModel(null) and mentions the main model', async () => {
    const api = stubApi();
    api.setHeartbeatModel.mockResolvedValue({ model: null, effective: 'main-model' });
    const out = await cmd('/heartbeat-model').run(
      makeCtx({ args: ['reset'], api: api as unknown as ApiClient }),
    );
    expect(api.setHeartbeatModel).toHaveBeenCalledWith(null);
    expect(out).toContain('main-model');
  });

  it('foo calls setHeartbeatModel("foo")', async () => {
    const api = stubApi();
    api.setHeartbeatModel.mockResolvedValue({ model: 'foo', effective: 'foo' });
    const out = await cmd('/heartbeat-model').run(
      makeCtx({ args: ['foo'], api: api as unknown as ApiClient }),
    );
    expect(api.setHeartbeatModel).toHaveBeenCalledWith('foo');
    expect(out).toContain('foo');
  });

  it('missing arg returns usage and makes no call', async () => {
    const api = stubApi();
    const out = await cmd('/heartbeat-model').run(
      makeCtx({ args: [], api: api as unknown as ApiClient }),
    );
    expect(api.setHeartbeatModel).not.toHaveBeenCalled();
    expect(out).toMatch(/usage/i);
  });
});

describe('/cron-model', () => {
  it('reset calls setCronModel(null) and mentions the main model', async () => {
    const api = stubApi();
    api.setCronModel.mockResolvedValue({ model: null, effective: 'main-model' });
    const out = await cmd('/cron-model').run(
      makeCtx({ args: ['reset'], api: api as unknown as ApiClient }),
    );
    expect(api.setCronModel).toHaveBeenCalledWith(null);
    expect(out).toContain('main-model');
  });

  it('foo calls setCronModel("foo")', async () => {
    const api = stubApi();
    api.setCronModel.mockResolvedValue({ model: 'foo', effective: 'foo' });
    const out = await cmd('/cron-model').run(
      makeCtx({ args: ['foo'], api: api as unknown as ApiClient }),
    );
    expect(api.setCronModel).toHaveBeenCalledWith('foo');
    expect(out).toContain('foo');
  });

  it('missing arg returns usage and makes no call', async () => {
    const api = stubApi();
    const out = await cmd('/cron-model').run(
      makeCtx({ args: [], api: api as unknown as ApiClient }),
    );
    expect(api.setCronModel).not.toHaveBeenCalled();
    expect(out).toMatch(/usage/i);
  });
});

describe('/schedules and /config open panels', () => {
  it('/schedules opens the schedules panel and returns empty', async () => {
    const openPanel = vi.fn<(id: PanelId) => void>();
    const out = await cmd('/schedules').run(makeCtx({ openPanel }));
    expect(openPanel).toHaveBeenCalledWith('schedules');
    expect(out).toBe('');
  });

  it('/config opens the config panel and returns empty', async () => {
    const openPanel = vi.fn<(id: PanelId) => void>();
    const out = await cmd('/config').run(makeCtx({ openPanel }));
    expect(openPanel).toHaveBeenCalledWith('config');
    expect(out).toBe('');
  });
});

describe('/help', () => {
  it('lists every registered command name', async () => {
    const out = await cmd('/help').run(makeCtx());
    for (const c of COMMANDS) {
      expect(out).toContain(c.name);
    }
    // /help itself is included.
    expect(out).toContain('/help');
  });
});

describe('/copy and /exit regression', () => {
  it('/copy with no message reports nothing to copy', async () => {
    const out = await cmd('/copy').run(makeCtx({ lastMessageContent: null }));
    expect(out).toBe('No message to copy yet.');
  });

  it('/exit calls requestShutdown', async () => {
    const requestShutdown = vi.fn();
    const out = await cmd('/exit').run(makeCtx({ requestShutdown }));
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(out).toContain('Shutting down');
  });
});

describe('command lookup helpers', () => {
  it('findExact returns the matching command', () => {
    expect(findExact('/heartbeat')?.name).toBe('/heartbeat');
    expect(findExact('/nope')).toBeUndefined();
  });

  it('filterByPrefix matches the leading slash and prefix', () => {
    const names = filterByPrefix('/he').map((c) => c.name);
    expect(names).toContain('/heartbeat');
    expect(names).toContain('/help');
    expect(filterByPrefix('he')).toEqual([]);
  });
});

describe('/attach', () => {
  const meta = {
    id: 'att-1',
    filename: 'notes.txt',
    mediaType: 'text/plain',
    sizeBytes: 2048,
    category: 'text',
  };

  it('with no args and nothing staged shows usage', async () => {
    const out = await cmd('/attach').run(makeCtx());
    expect(out).toContain('Usage: /attach <path>');
  });

  it('with no args lists staged files', async () => {
    const out = await cmd('/attach').run(makeCtx({ stagedAttachments: [meta] }));
    expect(out).toContain('notes.txt');
    expect(out).toContain('2.0 KB');
  });

  it('uploads, stages, and confirms', async () => {
    const api = stubApi();
    api.uploadAttachment.mockResolvedValue(meta);
    const stageAttachment = vi.fn();
    const out = await cmd('/attach').run(
      makeCtx({
        api: api as unknown as ApiClient,
        rawArgs: '/tmp/notes.txt',
        stageAttachment,
      }),
    );
    expect(api.uploadAttachment).toHaveBeenCalledWith('/tmp/notes.txt');
    expect(stageAttachment).toHaveBeenCalledWith(meta);
    expect(out).toContain('Staged');
    expect(out).toContain('notes.txt');
  });

  it('resolves relative paths against cwd and expands ~', async () => {
    const api = stubApi();
    api.uploadAttachment.mockResolvedValue(meta);
    await cmd('/attach').run(
      makeCtx({ api: api as unknown as ApiClient, rawArgs: 'sub/notes.txt' }),
    );
    const arg = api.uploadAttachment.mock.calls[0][0] as string;
    expect(arg).toBe(`${process.cwd()}/sub/notes.txt`);

    api.uploadAttachment.mockClear();
    await cmd('/attach').run(
      makeCtx({ api: api as unknown as ApiClient, rawArgs: '~/notes.txt' }),
    );
    const homeArg = api.uploadAttachment.mock.calls[0][0] as string;
    expect(homeArg.startsWith('/')).toBe(true);
    expect(homeArg).not.toContain('~');
  });

  it('preserves inner spaces in the path (rawArgs)', async () => {
    const api = stubApi();
    api.uploadAttachment.mockResolvedValue(meta);
    await cmd('/attach').run(
      makeCtx({ api: api as unknown as ApiClient, rawArgs: 'My Notes/todo.txt' }),
    );
    expect(api.uploadAttachment).toHaveBeenCalledWith(`${process.cwd()}/My Notes/todo.txt`);
  });

  it('surfaces upload errors as the returned message', async () => {
    const api = stubApi();
    api.uploadAttachment.mockRejectedValue(new Error('File not found: /tmp/missing'));
    const out = await cmd('/attach').run(
      makeCtx({ api: api as unknown as ApiClient, rawArgs: '/tmp/missing' }),
    );
    expect(out).toContain('File not found');
  });

  it('surfaces server ApiError messages (e.g. too large)', async () => {
    const api = stubApi();
    api.uploadAttachment.mockRejectedValue(
      new ApiError('Upload rejected: File too large (max 10 MB)', 400),
    );
    const out = await cmd('/attach').run(
      makeCtx({ api: api as unknown as ApiClient, rawArgs: '/tmp/big.bin' }),
    );
    expect(out).toContain('File too large');
  });

  it('refuses to stage past the 100-file per-message limit without uploading', async () => {
    const api = stubApi();
    const staged = Array.from({ length: 100 }, (_, i) => ({ ...meta, id: `a${i}` }));
    const out = await cmd('/attach').run(
      makeCtx({ api: api as unknown as ApiClient, rawArgs: '/tmp/one-too-many.txt', stagedAttachments: staged }),
    );
    expect(out).toContain('100-file limit');
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });
});

describe('/detach', () => {
  const meta = (id: string) => ({
    id,
    filename: `${id}.txt`,
    mediaType: 'text/plain',
    sizeBytes: 10,
    category: 'text',
  });

  it('reports when nothing is staged', async () => {
    const out = await cmd('/detach').run(makeCtx());
    expect(out).toBe('No files staged.');
  });

  it('deletes each staged file server-side and clears staging', async () => {
    const api = stubApi();
    api.deleteAttachment.mockResolvedValue({ success: true });
    const clearStagedAttachments = vi.fn();
    const out = await cmd('/detach').run(
      makeCtx({
        api: api as unknown as ApiClient,
        stagedAttachments: [meta('a'), meta('b')],
        clearStagedAttachments,
      }),
    );
    expect(api.deleteAttachment).toHaveBeenCalledWith('a');
    expect(api.deleteAttachment).toHaveBeenCalledWith('b');
    expect(clearStagedAttachments).toHaveBeenCalledTimes(1);
    expect(out).toContain('Removed 2');
  });

  it('still clears staging when a server delete fails (janitor covers it)', async () => {
    const api = stubApi();
    api.deleteAttachment.mockRejectedValue(new ApiError('boom', 500));
    const clearStagedAttachments = vi.fn();
    const out = await cmd('/detach').run(
      makeCtx({
        api: api as unknown as ApiClient,
        stagedAttachments: [meta('a')],
        clearStagedAttachments,
      }),
    );
    expect(clearStagedAttachments).toHaveBeenCalledTimes(1);
    expect(out).toContain('Removed 1');
  });
});

describe('/save', () => {
  const meta = (id: string, filename = `${id}.txt`) => ({
    id,
    filename,
    mediaType: 'text/plain',
    sizeBytes: 10,
    category: 'text',
  });

  const tmpDirs: string[] = [];
  function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'save-cmd-test-'));
    tmpDirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('reports when the agent has shared no files', async () => {
    const out = await cmd('/save').run(makeCtx({ recentAttachments: [] }));
    expect(out).toContain('No files');
  });

  it('saves all recent attachments into a directory, preserving names', async () => {
    const dir = tmpDir();
    const api = stubApi();
    api.downloadAttachment.mockResolvedValue(Buffer.from('hello'));
    const out = await cmd('/save').run(
      makeCtx({
        api: api as unknown as ApiClient,
        recentAttachments: [meta('a', 'report.csv'), meta('b', 'chart.png')],
        rawArgs: dir,
      }),
    );
    expect(api.downloadAttachment).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(dir, 'report.csv'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(dir, 'chart.png'), 'utf8')).toBe('hello');
    expect(out).toContain('Saved 2 file(s)');
  });

  it('writes a single file to an explicit destination path', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'renamed.csv');
    const api = stubApi();
    api.downloadAttachment.mockResolvedValue(Buffer.from('data'));
    const out = await cmd('/save').run(
      makeCtx({
        api: api as unknown as ApiClient,
        recentAttachments: [meta('a', 'report.csv')],
        rawArgs: dest,
      }),
    );
    expect(fs.readFileSync(dest, 'utf8')).toBe('data');
    expect(out).toContain('Saved 1 file(s)');
  });

  it('creates a new directory for multiple files named by a non-existent path', async () => {
    const dir = tmpDir();
    const newDir = path.join(dir, 'exports');
    const api = stubApi();
    api.downloadAttachment.mockResolvedValue(Buffer.from('x'));
    const out = await cmd('/save').run(
      makeCtx({
        api: api as unknown as ApiClient,
        recentAttachments: [meta('a', 'one.csv'), meta('b', 'two.csv')],
        rawArgs: newDir,
      }),
    );
    expect(fs.readFileSync(path.join(newDir, 'one.csv'), 'utf8')).toBe('x');
    expect(fs.readFileSync(path.join(newDir, 'two.csv'), 'utf8')).toBe('x');
    expect(out).toContain('Saved 2 file(s)');
  });

  it('refuses an existing-file destination when multiple files are pending', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'one.txt');
    fs.writeFileSync(dest, 'already here');
    const api = stubApi();
    const out = await cmd('/save').run(
      makeCtx({
        api: api as unknown as ApiClient,
        recentAttachments: [meta('a'), meta('b')],
        rawArgs: dest,
      }),
    );
    expect(out).toMatch(/existing file/i);
    expect(api.downloadAttachment).not.toHaveBeenCalled();
  });

  it('surfaces a download failure', async () => {
    const dir = tmpDir();
    const api = stubApi();
    api.downloadAttachment.mockRejectedValue(new ApiError('not found', 404));
    const out = await cmd('/save').run(
      makeCtx({
        api: api as unknown as ApiClient,
        recentAttachments: [meta('a')],
        rawArgs: dir,
      }),
    );
    expect(out).toMatch(/failed to save/i);
  });
});
