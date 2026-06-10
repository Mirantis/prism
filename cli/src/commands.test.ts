import { describe, it, expect, vi } from 'vitest';

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
    getHeartbeatStatus: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    triggerHeartbeat: vi.fn(),
    setHeartbeatInterval: vi.fn(),
    listCronTasks: vi.fn(),
    createCronTask: vi.fn(),
    deleteCronTask: vi.fn(),
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
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
