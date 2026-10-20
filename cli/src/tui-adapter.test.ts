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

// These tests drive the adapter's routing without a socket: this fake stands in
// for WsClient, hands us its event bus and records what the adapter asks of it.
type FakeClient = {
  events: import('events').EventEmitter;
  sent: unknown[];
  cancelled: string[];
};
const { lastClient } = vi.hoisted(() => ({ lastClient: { current: null as FakeClient | null } }));

vi.mock('./ws-client.js', async () => {
  const { EventEmitter } = await import('events');
  class FakeWsClient {
    events = new EventEmitter();
    sent: unknown[] = [];
    cancelled: string[] = [];
    constructor(_opts: unknown) {
      lastClient.current = this;
    }
    send(message: unknown) {
      this.sent.push(message);
    }
    cancel(threadId: string) {
      this.cancelled.push(threadId);
      return true;
    }
    close() {}
  }
  return { WsClient: FakeWsClient };
});

import { endedSignInIn, signInRequestIn, tuiAdapterService, TuiMessage } from './tui-adapter.js';

const MINE = 'thread-mine';
const OTHER = 'thread-other';

function storedMessage(overrides: Partial<TuiMessage> = {}) {
  return {
    id: 'msg-1',
    threadId: MINE,
    role: 'AGENT',
    content: 'working on it',
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: null,
    isCompacted: false,
    createdAt: '2026-09-27T08:38:53.843Z',
    attachments: null,
    senderName: null,
    ...overrides,
  };
}

function welcome(overrides: { resumed?: boolean; turns?: unknown[]; id?: string | null } = {}) {
  return {
    protocol: 2,
    streamId: 'stream-1',
    seq: 1,
    resumed: overrides.resumed ?? false,
    you: { id: overrides.id ?? null, name: overrides.id ?? null },
    snapshot: { turns: overrides.turns ?? [] },
  };
}

let seq = 1;
function emitEvent(type: string, payload: unknown) {
  seq += 1;
  lastClient.current!.events.emit('event', { type, seq, payload });
}

/** A fetch that answers `GET /messages` with these rows, and `POST /threads` with MINE. */
function stubRuntime(history: unknown[] = []) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ threadId: MINE }) };
    return { ok: true, status: 200, json: async () => history };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  seq = 1;
  tuiAdapterService.markConnected('u1');
});

afterEach(() => {
  tuiAdapterService.events.removeAllListeners();
  tuiAdapterService.markDisconnected();
  vi.unstubAllGlobals();
});

describe('TuiAdapter.startNewSession', () => {
  it('POSTs to /threads with the launch cwd and returns the new thread id', async () => {
    const fetchMock = stubRuntime();

    const threadId = await tuiAdapterService.startNewSession();

    expect(fetchMock).toHaveBeenCalledWith('http://example.test:3003/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: process.cwd() }),
    });
    expect(threadId).toBe(MINE);
  });

  it('returns undefined on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(tuiAdapterService.startNewSession()).resolves.toBeUndefined();
  });

  it('resolves to undefined without throwing when the runtime is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(tuiAdapterService.startNewSession()).resolves.toBeUndefined();
  });
});

describe('TuiAdapter.openConversation', () => {
  /** A runtime whose `GET /agents/me` names this thread mode, and whose `GET /threads` lists one conversation. */
  function stubAgent(threadMode: string | undefined) {
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith('/agents/me')) return { ok: true, status: 200, json: async () => ({ agentId: 'a1', threadMode }) };
      if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ threadId: MINE }) };
      if (url.endsWith('/threads')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: OTHER, title: 'The conversation', updatedAt: '2026-10-20T08:00:00.000Z', contextUsage: null }],
        };
      }
      return { ok: true, status: 200, json: async () => [storedMessage({ threadId: OTHER, content: 'last week' })] };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('starts a fresh conversation when the agent keeps many', async () => {
    const fetchMock = stubAgent('multi');

    await expect(tuiAdapterService.openConversation()).resolves.toBe(MINE);
    expect(fetchMock).toHaveBeenCalledWith('http://example.test:3003/threads', expect.objectContaining({ method: 'POST' }));
  });

  it('starts a fresh conversation on a runtime that does not say', async () => {
    stubAgent(undefined);

    await expect(tuiAdapterService.openConversation()).resolves.toBe(MINE);
  });

  it('opens the one conversation with its history when the agent keeps one', async () => {
    const fetchMock = stubAgent('single');
    const histories: TuiMessage[][] = [];
    tuiAdapterService.events.on('history', (h) => histories.push(h));

    await expect(tuiAdapterService.openConversation()).resolves.toBe(OTHER);

    expect(fetchMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'POST' }));
    expect(histories.map((h) => h.map((m) => m.content))).toEqual([['last week']]);
  });

  it('is asked again while the runtime does not answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(tuiAdapterService.openConversation()).resolves.toBeUndefined();
  });
});

describe('TuiAdapter sending', () => {
  it('names the session thread on every message', async () => {
    stubRuntime();
    await tuiAdapterService.startNewSession();

    tuiAdapterService.submitUserMessage({ id: 'uuid-1', text: 'hi', attachmentIds: ['att-1'] });

    expect(lastClient.current!.sent).toEqual([
      { id: 'uuid-1', threadId: MINE, content: 'hi', attachmentIds: ['att-1'] },
    ]);
  });

  it('holds a message submitted before the thread exists, and sends it once it does', async () => {
    tuiAdapterService.submitUserMessage({ id: 'uuid-1', text: 'too early', attachmentIds: [] });
    expect(lastClient.current!.sent).toEqual([]);

    stubRuntime();
    await tuiAdapterService.startNewSession();

    expect(lastClient.current!.sent).toEqual([
      { id: 'uuid-1', threadId: MINE, content: 'too early', attachmentIds: [] },
    ]);
  });

  it("cancels the session thread's work, and cannot before there is one", async () => {
    expect(tuiAdapterService.cancel()).toBe(false);

    stubRuntime();
    await tuiAdapterService.startNewSession();

    expect(tuiAdapterService.cancel()).toBe(true);
    expect(lastClient.current!.cancelled).toEqual([MINE]);
  });

  it('passes on a refused message', () => {
    const failures: unknown[] = [];
    tuiAdapterService.events.on('sendFailed', (f) => failures.push(f));
    const failure = { messageId: 'uuid-1', code: 'unknown_thread', message: 'There is no such conversation.' };

    lastClient.current!.events.emit('sendFailed', failure);

    expect(failures).toEqual([failure]);
  });
});

describe('TuiAdapter history', () => {
  it('loads the resumed thread with GET /messages', async () => {
    const fetchMock = stubRuntime([storedMessage({ content: 'earlier reply' })]);
    const histories: TuiMessage[][] = [];
    tuiAdapterService.events.on('history', (h) => histories.push(h));

    await tuiAdapterService.resumeThread(MINE);

    expect(fetchMock).toHaveBeenCalledWith(
      `http://example.test:3003/messages?limit=50&threadId=${MINE}`,
      { signal: expect.any(AbortSignal) },
    );
    expect(histories.map((h) => h.map((m) => m.content))).toEqual([['earlier reply']]);
  });

  it('reloads after a welcome that could not resume, and applies what arrived meanwhile after it', async () => {
    stubRuntime();
    await tuiAdapterService.startNewSession();
    const order: string[] = [];
    tuiAdapterService.events.on('history', () => order.push('history'));
    tuiAdapterService.events.on('message', (m) => order.push(`message ${m.id}`));

    lastClient.current!.events.emit('welcome', welcome({ resumed: false }));
    emitEvent('message', storedMessage({ id: 'msg-live' }));
    expect(order).toEqual([]);
    await flush();

    expect(order).toEqual(['history', 'message msg-live']);
  });

  it('keeps the screen when history cannot be reloaded, and says so', async () => {
    stubRuntime();
    await tuiAdapterService.startNewSession();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const histories: unknown[] = [];
    const statuses: unknown[] = [];
    tuiAdapterService.events.on('history', (h) => histories.push(h));
    tuiAdapterService.events.on('status', (s, d) => statuses.push([s, d]));

    lastClient.current!.events.emit('welcome', welcome({ resumed: false }));
    await flush();

    expect(histories).toEqual([]);
    expect(statuses).toContainEqual(['error', 'could not reload the conversation']);
  });

  it('does not reload after a welcome that resumed', async () => {
    const fetchMock = stubRuntime();
    await tuiAdapterService.startNewSession();
    fetchMock.mockClear();

    lastClient.current!.events.emit('welcome', welcome({ resumed: true }));
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reloads when a compaction of this thread completes', async () => {
    const fetchMock = stubRuntime();
    await tuiAdapterService.startNewSession();
    fetchMock.mockClear();

    emitEvent('compaction', { threadId: MINE, status: 'completed', trigger: 'auto', messagesCompacted: 4 });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      `http://example.test:3003/messages?limit=50&threadId=${MINE}`,
      { signal: expect.any(AbortSignal) },
    );
  });
});

describe('TuiAdapter inbound events', () => {
  beforeEach(async () => {
    stubRuntime();
    await tuiAdapterService.startNewSession();
  });

  it('reports the connection and who the runtime says it is', () => {
    const statuses: unknown[] = [];
    const names: unknown[] = [];
    tuiAdapterService.events.on('status', (s) => statuses.push(s));
    tuiAdapterService.events.on('welcome', (you) => names.push(you.id));

    lastClient.current!.events.emit('welcome', welcome({ resumed: true, id: 'grace@example.com' }));

    expect(statuses).toEqual(['idle']);
    expect(names).toEqual(['grace@example.com']);
  });

  it("takes this thread's state from the welcome snapshot", () => {
    const turns: unknown[] = [];
    tuiAdapterService.events.on('turn', (t) => turns.push(t));

    lastClient.current!.events.emit(
      'welcome',
      welcome({ resumed: true, turns: [{ threadId: OTHER, state: 'running' }, { threadId: MINE, state: 'queued' }] }),
    );
    lastClient.current!.events.emit('welcome', welcome({ resumed: true, turns: [{ threadId: OTHER, state: 'running' }] }));

    expect(turns).toEqual([
      { threadId: MINE, state: 'queued' },
      { threadId: MINE, state: 'idle' },
    ]);
  });

  it('knows the state of a thread resumed after the welcome', async () => {
    const turns: unknown[] = [];
    tuiAdapterService.events.on('turn', (t) => turns.push(t));
    lastClient.current!.events.emit('welcome', welcome({ resumed: true, turns: [{ threadId: OTHER, state: 'queued' }] }));
    emitEvent('turn', { threadId: OTHER, state: 'running' });
    turns.length = 0;

    await tuiAdapterService.resumeThread(OTHER);

    expect(turns).toEqual([{ threadId: OTHER, state: 'running' }]);
  });

  it('passes on messages of every role, with who sent them', () => {
    const seen: TuiMessage[] = [];
    tuiAdapterService.events.on('message', (m) => seen.push(m));

    emitEvent('message', storedMessage({ id: 'u1', role: 'USER', content: 'hi', senderId: 'ada@example.com', senderName: 'ada@example.com' }));
    emitEvent('message', storedMessage({ id: 'a1' }));

    expect(seen.map((m) => [m.role, m.senderId, m.senderName])).toEqual([
      ['USER', 'ada@example.com', 'ada@example.com'],
      ['AGENT', null, null],
    ]);
  });

  it('ends a turn only at idle: a reply mid-turn is not the end', () => {
    const turns: unknown[] = [];
    tuiAdapterService.events.on('turn', (t) => turns.push(t));

    emitEvent('turn', { threadId: MINE, state: 'running' });
    emitEvent('message', storedMessage());
    emitEvent('turn', { threadId: MINE, state: 'idle', outcome: 'completed' });

    expect(turns).toEqual([
      { threadId: MINE, state: 'running' },
      { threadId: MINE, state: 'idle', outcome: 'completed' },
    ]);
  });

  it('ignores every event of another conversation', () => {
    const seen: string[] = [];
    for (const name of ['message', 'turn', 'contextUsage', 'compaction', 'signIn', 'signInEnded'] as const) {
      tuiAdapterService.events.on(name, () => seen.push(name));
    }

    emitEvent('message', storedMessage({ threadId: OTHER }));
    emitEvent('turn', { threadId: OTHER, state: 'running' });
    emitEvent('context', { threadId: OTHER, modelId: 'm', usedTokens: 1, windowTokens: 10, usedPercent: 10 });
    emitEvent('compaction', { threadId: OTHER, status: 'started', trigger: 'auto' });
    emitEvent('message', storedMessage({
      threadId: OTHER,
      blocks: [{ type: 'computer_help', id: 'h', reason: 'r', credentials: true, status: 'waiting' }],
    }));
    emitEvent('message', storedMessage({
      threadId: OTHER,
      blocks: [{ type: 'computer_help', id: 'h', reason: 'r', credentials: true, status: 'continued' }],
    }));

    expect(seen).toEqual([]);
  });

  it("passes on this thread's context usage", () => {
    const seen: unknown[] = [];
    tuiAdapterService.events.on('contextUsage', (u) => seen.push(u));
    const usage = { threadId: MINE, modelId: 'us.anthropic.claude-opus-4-7', usedTokens: 12922, windowTokens: 1000000, usedPercent: 1 };

    emitEvent('context', usage);

    expect(seen).toEqual([usage]);
  });

  it('says the CLI needs an update when the runtime refuses its protocol', () => {
    const notices: string[] = [];
    const statuses: unknown[] = [];
    tuiAdapterService.events.on('unsupported', (n) => notices.push(n));
    tuiAdapterService.events.on('status', (s, d) => statuses.push([s, d]));

    lastClient.current!.events.emit('unsupported', 'protocol unsupported');

    expect(notices).toEqual([expect.stringContaining('Update prism-cli')]);
    expect(statuses).toEqual([['error', 'update prism-cli']]);
  });

  describe('compaction events', () => {
    it('emits a validated compaction event', () => {
      const seen: unknown[] = [];
      tuiAdapterService.events.on('compaction', (e) => seen.push(e));

      emitEvent('compaction', {
        threadId: MINE,
        status: 'started',
        trigger: 'manual',
        tokensBefore: 190_000,
      });

      expect(seen).toEqual([
        {
          threadId: MINE,
          status: 'started',
          trigger: 'manual',
          tokensBefore: 190_000,
          tokensAfter: null,
          messagesCompacted: undefined,
          error: undefined,
          detail: undefined,
        },
      ]);
    });

    it('accepts the skipped status and its detail', () => {
      const seen: unknown[] = [];
      tuiAdapterService.events.on('compaction', (e) => seen.push(e));

      emitEvent('compaction', {
        threadId: MINE,
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

      emitEvent('compaction', { threadId: MINE }); // no status/trigger
      emitEvent('compaction', { threadId: MINE, status: 'running', trigger: 'manual' });
      emitEvent('compaction', { status: 'started', trigger: 'auto' }); // no threadId

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

  it("opens for this session's conversation", async () => {
    stubRuntime();
    await tuiAdapterService.startNewSession();
    const seen: { id: string; threadId?: string }[] = [];
    tuiAdapterService.events.on('signIn', (request) => void seen.push(request));

    emitEvent('message', storedMessage({ content: 'Sign in to the mail', blocks: [help] }));

    expect(seen).toEqual([expect.objectContaining({ id: 'help-1', threadId: MINE })]);
  });

  it('passes over a request of any other kind, and one already answered', () => {
    expect(signInRequestIn([{ ...help, credentials: undefined }])).toBeNull();
    expect(signInRequestIn([{ ...help, status: 'continued' }])).toBeNull();
    expect(signInRequestIn(null)).toBeNull();
    expect(signInRequestIn([null, 'text'])).toBeNull();
  });

  it('ends when the request comes back answered or dismissed, wherever that happened', async () => {
    stubRuntime();
    await tuiAdapterService.startNewSession();
    const ended: string[] = [];
    tuiAdapterService.events.on('signInEnded', (id) => void ended.push(id));

    emitEvent('message', storedMessage({ content: 'Sign in to the mail', blocks: [help] }));
    emitEvent('message', storedMessage({ content: 'Sign in to the mail', blocks: [{ ...help, status: 'continued' }] }));

    expect(ended).toEqual(['help-1']);
    expect(endedSignInIn([{ ...help, status: 'dismissed' }])).toBe('help-1');
    expect(endedSignInIn([{ ...help, credentials: undefined, status: 'dismissed' }])).toBeNull();
    expect(endedSignInIn([help])).toBeNull();
  });

  it('is asked for or ended by a reloaded history, as by a live message', async () => {
    const fetchMock = stubRuntime();
    await tuiAdapterService.startNewSession();
    const seen: string[] = [];
    tuiAdapterService.events.on('signIn', (request) => void seen.push(`signIn ${request.id}`));
    tuiAdapterService.events.on('signInEnded', (id) => void seen.push(`signInEnded ${id}`));
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        storedMessage({ id: 'm1', blocks: [{ ...help, status: 'continued' }] }),
        storedMessage({ id: 'm2', blocks: [{ ...help, id: 'help-2' }] }),
      ],
    });

    lastClient.current!.events.emit('welcome', welcome({ resumed: false }));
    await flush();

    expect(seen).toEqual(['signInEnded help-1', 'signIn help-2']);
  });
});
