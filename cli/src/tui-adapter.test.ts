import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// loadConfig() is read once at TuiAdapter construction time to derive the base
// URL. Stub it (trailing slash to prove it gets stripped) and provide
// wsUrlFromHttpUrl, which the constructor also calls.
vi.mock('./config.js', () => ({
  loadConfig: () => ({
    agentName: 'Test',
    modelId: 'test-model',
    hideCursor: false,
    hideStatusBar: false,
    httpUrl: 'http://example.test:3003/',
  }),
  wsUrlFromHttpUrl: (u: string) => u.replace(/\/$/, '').replace(/^http/, 'ws') + '/api/ws',
}));

import { tuiAdapterService } from './tui-adapter.js';

describe('TuiAdapter.startNewSession', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /threads with the launch cwd as workspaceRoot', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);

    await tuiAdapterService.startNewSession();

    expect(fetchMock).toHaveBeenCalledWith('http://example.test:3003/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: process.cwd() }),
    });
  });

  it('resolves without throwing when the runtime is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(tuiAdapterService.startNewSession()).resolves.toBeUndefined();
  });
});

describe('TuiAdapter.loadHistory', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /messages with just a limit when no threadId is given', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] } as unknown as Response);

    await tuiAdapterService.loadHistory({ userId: 'u1', agentId: 'a1' });

    expect(fetchMock).toHaveBeenCalledWith('http://example.test:3003/messages?limit=50');
  });

  it('pins the request to a specific thread when threadId is given', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] } as unknown as Response);

    await tuiAdapterService.loadHistory({ userId: 'u1', agentId: 'a1', threadId: 'thread-x' });

    expect(fetchMock).toHaveBeenCalledWith('http://example.test:3003/messages?limit=50&threadId=thread-x');
  });
});
