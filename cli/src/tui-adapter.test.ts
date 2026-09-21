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

// The envelope tests drive the adapter's inbound routing without a socket: this
// fake stands in for WsClient and hands us its event bus.
const { lastClient } = vi.hoisted(() => {
  const ref: { current: { events: { on: (e: string, fn: (...a: unknown[]) => void) => void; emit: (e: string, ...a: unknown[]) => void }; sent: unknown[] } | null } = {
    current: null,
  };
  return { lastClient: ref };
});

vi.mock('./ws-client.js', () => {
  class TinyEmitter {
    private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    on(event: string, fn: (...a: unknown[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }
    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
  }
  class FakeWsClient {
    events = new TinyEmitter();
    sent: unknown[] = [];
    constructor(_opts: unknown) {
      lastClient.current = this as never;
    }
    send(message: unknown) {
      this.sent.push(message);
    }
    close() {}
  }
  return { WsClient: FakeWsClient };
});

import { signInRequestIn, tuiAdapterService, TuiStatus } from './tui-adapter.js';

describe('TuiAdapter.startNewSession', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /threads with the launch cwd and returns the new thread id', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ threadId: 'thread-new' }),
    } as unknown as Response);

    const threadId = await tuiAdapterService.startNewSession();

    expect(fetchMock).toHaveBeenCalledWith('http://example.test:3003/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: process.cwd() }),
    });
    expect(threadId).toBe('thread-new');
  });

  it('returns undefined on a non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);

    await expect(tuiAdapterService.startNewSession()).resolves.toBeUndefined();
  });

  it('resolves to undefined without throwing when the runtime is unreachable', async () => {
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

    expect(fetchMock).toHaveBeenCalledWith(
      'http://example.test:3003/messages?limit=50',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('pins the request to a specific thread when threadId is given', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] } as unknown as Response);

    await tuiAdapterService.loadHistory({ userId: 'u1', agentId: 'a1', threadId: 'thread-x' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://example.test:3003/messages?limit=50&threadId=thread-x',
      { signal: expect.any(AbortSignal) },
    );
  });
});

describe('TuiAdapter inbound envelopes', () => {
  let statuses: Array<{ status: TuiStatus; detail?: string }>;
  let threads: string[];

  const emit = (type: string, payload?: unknown) =>
    lastClient.current!.events.emit('envelope', { type, payload });

  beforeEach(() => {
    tuiAdapterService.markConnected('u1');
    statuses = [];
    threads = [];
    tuiAdapterService.events.on('status', (status, detail) => statuses.push({ status, detail }));
    tuiAdapterService.events.on('thread', (threadId) => threads.push(threadId));
  });

  afterEach(() => {
    tuiAdapterService.events.removeAllListeners();
    tuiAdapterService.markDisconnected();
  });

  const agentMessage = {
    id: 'msg-1',
    threadId: 'thread-1',
    role: 'AGENT',
    content: 'working on it',
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: null,
    createdAt: new Date().toISOString(),
  };

  it('does not go idle when an agent reply lands mid-turn', () => {
    // A turn publishes each text step as it arrives, and a steered exchange runs
    // another turn after that — so a reply is not evidence the work is over.
    // Clearing here used to drop the spinner and the "esc to stop" hint while the
    // agent was still going.
    emit('status', { processing: true });
    emit('chat', agentMessage);

    expect(statuses.map((s) => s.status)).toEqual(['thinking']);
  });

  it('still delivers the message itself', () => {
    const seen: string[] = [];
    tuiAdapterService.events.on('message', (m) => seen.push(m.content));

    emit('chat', agentMessage);

    expect(seen).toEqual(['working on it']);
  });

  it('goes idle only when the runtime says the turn is done', () => {
    emit('status', { processing: true });
    emit('status', { processing: false });

    expect(statuses.map((s) => s.status)).toEqual(['thinking', 'idle']);
  });

  it('ignores a connect handshake that carries no processing flag', () => {
    // `{ connected: true }` arrives once, at connection. Treating it as idle would
    // clear the spinner mid-turn if it were ever re-sent.
    emit('status', { processing: true });
    emit('status', { connected: true });

    expect(statuses.map((s) => s.status)).toEqual(['thinking']);
  });

  it('surfaces an error envelope as the error status', () => {
    emit('error', { error: 'boom' });

    expect(statuses).toEqual([{ status: 'error', detail: 'boom' }]);
  });

  it('adopts the thread id the runtime names', () => {
    // Backstop: a message sent without a threadId cannot be steered into the
    // running turn, so learn the id when startNewSession() did not give us one.
    emit('thread', { threadId: 'thread-42', title: 'Migration plan' });

    expect(threads).toEqual(['thread-42']);
  });

  it('ignores a thread envelope with no usable id', () => {
    emit('thread', { title: 'no id here' });
    emit('thread', { threadId: '' });

    expect(threads).toEqual([]);
  });

  describe('compaction envelopes', () => {
    it('emits a validated compaction event', () => {
      const seen: unknown[] = [];
      tuiAdapterService.events.on('compaction', (e) => seen.push(e));

      emit('compaction', {
        threadId: 'thread-1',
        status: 'completed',
        trigger: 'manual',
        tokensBefore: 190_000,
        tokensAfter: 1_200,
        messagesCompacted: 12,
      });

      expect(seen).toEqual([
        {
          threadId: 'thread-1',
          status: 'completed',
          trigger: 'manual',
          tokensBefore: 190_000,
          tokensAfter: 1_200,
          messagesCompacted: 12,
          error: undefined,
        },
      ]);
    });

    it('accepts the skipped status and its detail', () => {
      const seen: unknown[] = [];
      tuiAdapterService.events.on('compaction', (e) => seen.push(e));

      emit('compaction', {
        threadId: 'thread-1',
        status: 'skipped',
        trigger: 'manual',
        detail: 'Nothing to compact yet.',
      });

      expect(seen).toEqual([
        expect.objectContaining({ status: 'skipped', detail: 'Nothing to compact yet.' }),
      ]);
    });

    it('drops malformed frames — a bad frame must not toggle an indicator it cannot clear', () => {
      const seen: unknown[] = [];
      tuiAdapterService.events.on('compaction', (e) => seen.push(e));

      emit('compaction', { threadId: 'thread-1' }); // no status/trigger
      emit('compaction', { threadId: 'thread-1', status: 'running', trigger: 'manual' });
      emit('compaction', { status: 'started', trigger: 'auto' }); // no threadId

      expect(seen).toEqual([]);
    });
  });
});

describe('TuiAdapter.listSessions context usage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function respond(rows: unknown[]) {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => rows } as unknown as Response);
  }

  const row = {
    id: 'thread-a',
    title: 'Refactor',
    updatedAt: '2026-07-29T10:00:00.000Z',
    workspaceRoot: null,
    branch: null,
  };

  it('time-boxes the /threads fetch so --resume cannot hang before the picker renders', async () => {
    respond([]);

    await tuiAdapterService.listSessions();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://example.test:3003/threads',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('carries a thread snapshot through so a resumed session shows a percentage', async () => {
    const contextUsage = {
      threadId: 'thread-a',
      modelId: 'us.anthropic.claude-opus-5',
      usedTokens: 300_000,
      windowTokens: 1_000_000,
      usedPercent: 30,
    };
    respond([{ ...row, contextUsage }]);

    const sessions = await tuiAdapterService.listSessions();

    expect(sessions[0]?.contextUsage).toEqual(contextUsage);
  });

  it('nulls the snapshot for a thread that has not run a turn', async () => {
    respond([{ ...row, contextUsage: null }]);

    const sessions = await tuiAdapterService.listSessions();

    expect(sessions[0]?.contextUsage).toBeNull();
  });

  it('nulls a partial snapshot rather than rendering NaN', async () => {
    // A runtime mid-rollout (or a proxy that drops fields) must not produce
    // "context NaN%" in the status bar.
    respond([{ ...row, contextUsage: { threadId: 'thread-a', usedPercent: 30 } }]);

    const sessions = await tuiAdapterService.listSessions();

    expect(sessions[0]?.contextUsage).toBeNull();
  });

  it('nulls the snapshot when an older runtime omits the field entirely', async () => {
    respond([row]);

    const sessions = await tuiAdapterService.listSessions();

    expect(sessions[0]).toMatchObject({ id: 'thread-a', contextUsage: null });
  });
});

describe('the sign-in in a message', () => {
  const help = {
    type: 'computer_help',
    id: 'help-1',
    reason: 'Sign in to the mail',
    credentials: true,
    site: 'https://mail.example.com',
    status: 'waiting',
  };

  it('is the one help request this session answers', () => {
    expect(signInRequestIn([help])).toEqual({
      id: 'help-1',
      reason: 'Sign in to the mail',
      site: 'https://mail.example.com',
    });
  });

  it('carries the thread it belongs to, so another conversation does not open the panel', () => {
    const seen: { id: string; threadId?: string }[] = [];
    tuiAdapterService.events.on('signIn', (request) => void seen.push(request));

    lastClient.current?.events.emit('envelope', {
      type: 'chat',
      payload: {
        id: 'm1',
        threadId: 'thread-b',
        role: 'AGENT',
        content: 'Sign in to the mail',
        createdAt: new Date().toISOString(),
        blocks: [help],
      },
    });

    expect(seen).toEqual([
      expect.objectContaining({ id: 'help-1', threadId: 'thread-b' }),
    ]);
  });

  it('passes over a request of any other kind, and one already answered', () => {
    expect(signInRequestIn([{ ...help, credentials: undefined }])).toBeNull();
    expect(signInRequestIn([{ ...help, status: 'continued' }])).toBeNull();
    expect(signInRequestIn(null)).toBeNull();
    expect(signInRequestIn([null, 'text'])).toBeNull();
  });
});
