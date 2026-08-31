import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';

// Mock the singleton adapter before importing App. `vi.mock` is hoisted to
// the top of the file, so the stub has to be declared via `vi.hoisted()` —
// which itself runs before module imports, so we require EventEmitter
// inline rather than importing it at the top of this file.
const { adapterStub, apiStub } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  return {
    adapterStub: {
      events: new EventEmitter(),
      markConnected: vi.fn(),
      markDisconnected: vi.fn(),
      loadHistory: vi.fn().mockResolvedValue([]),
      startNewSession: vi.fn().mockResolvedValue(undefined),
      listSessions: vi.fn().mockResolvedValue([]),
      submitUserMessage: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn(),
    },
    // Panels reach for the apiClient singleton on mount (SchedulesPanel calls
    // listCronTasks, ConfigPanel calls getDetails), so stub it to keep the
    // smoke tests hermetic — no real fetch leaves the process.
    apiStub: {
      listCronTasks: vi.fn().mockResolvedValue([]),
      getDetails: vi.fn().mockResolvedValue({}),
      createGoal: vi.fn().mockResolvedValue({ objective: 'x', maxTurns: 100 }),
      getThreadGoal: vi.fn().mockResolvedValue(null),
      uploadAttachment: vi.fn().mockResolvedValue({
        id: 'att-1',
        filename: 'report.txt',
        mediaType: 'text/plain',
        sizeBytes: 2048,
        category: 'text',
      }),
      deleteAttachment: vi.fn().mockResolvedValue({ success: true }),
    },
  };
});

vi.mock('./tui-adapter.js', () => ({
  tuiAdapterService: adapterStub,
}));

vi.mock('./api-client.js', () => ({
  apiClient: apiStub,
  // Re-export ApiError so the panels' `instanceof ApiError` checks compile.
  ApiError: class ApiError extends Error {},
}));

import { App } from './App.js';

const baseProps = {
  userId: 'local',
  agent: { id: 'remote', name: 'Prism' },
  modelId: 'us.anthropic.claude-opus-4-7',
};

describe('App', () => {
  beforeEach(() => {
    adapterStub.events.removeAllListeners();
    adapterStub.markConnected.mockClear();
    adapterStub.markDisconnected.mockClear();
    adapterStub.loadHistory.mockClear();
    adapterStub.loadHistory.mockResolvedValue([]);
    adapterStub.startNewSession.mockClear();
    adapterStub.listSessions.mockClear();
    adapterStub.submitUserMessage.mockClear();
    apiStub.listCronTasks.mockClear();
    apiStub.getDetails.mockClear();
    apiStub.createGoal.mockClear();
    apiStub.getThreadGoal.mockClear();
    apiStub.uploadAttachment.mockClear();
    apiStub.deleteAttachment.mockClear();
    adapterStub.cancel.mockClear();
  });

  it('renders the header, input box, and status bar on mount', () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    const frame = lastFrame() ?? '';
    // Header: "chat with <agentName>" hint
    expect(frame).toContain('chat with Prism');
    // Input box: ›-prefixed prompt
    expect(frame).toContain('›');
    // StatusBar: prettified model id
    expect(frame).toContain('Opus 4.7');
    unmount();
  });

  it('marks the adapter connected with the userId on mount', () => {
    const { unmount } = render(<App {...baseProps} userId="alice" />);
    expect(adapterStub.markConnected).toHaveBeenCalledWith('alice');
    unmount();
  });

  describe('context indicator wiring', () => {
    // The gap these close: StatusBar and the adapter's frame coercion were each
    // covered in isolation, but nothing exercised adapter event -> App state ->
    // StatusBar. A bug anywhere in that seam (missed subscription, an over-eager
    // threadId filter) would have shipped invisible, and the PTY e2e that would
    // have caught it can't run on every dev machine.
    const usage = (overrides: Record<string, unknown> = {}) => ({
      threadId: 'thread-1',
      modelId: 'us.anthropic.claude-opus-5',
      usedTokens: 580_000,
      windowTokens: 1_000_000,
      usedPercent: 58,
      ...overrides,
    });

    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };

    it('shows no percentage until a frame arrives', () => {
      const { lastFrame, unmount } = render(<App {...baseProps} />);
      expect(lastFrame() ?? '').not.toContain('context');
      unmount();
    });

    it('renders a context frame from the adapter in the status bar', async () => {
      const { lastFrame, unmount } = render(<App {...baseProps} />);
      await flush();

      adapterStub.events.emit('contextUsage', usage());
      await flush();

      expect(lastFrame() ?? '').toContain('| context 58%');
      unmount();
    });

    it('accepts the first frames before the session thread id is known', async () => {
      // startNewSession resolves asynchronously, so activeThreadId is undefined
      // for the first moments of a launch. Strict equality there would drop the
      // opening turn's readings entirely.
      adapterStub.startNewSession.mockResolvedValueOnce(undefined);
      const { lastFrame, unmount } = render(<App {...baseProps} />);

      adapterStub.events.emit('contextUsage', usage({ threadId: 'whatever', usedPercent: 12 }));
      await flush();

      expect(lastFrame() ?? '').toContain('| context 12%');
      unmount();
    });

    it('ignores a frame for a different thread once the thread is known', async () => {
      adapterStub.startNewSession.mockResolvedValueOnce('thread-mine');
      const { lastFrame, unmount } = render(<App {...baseProps} />);
      await flush();
      await flush();

      adapterStub.events.emit('contextUsage', usage({ threadId: 'thread-mine', usedPercent: 40 }));
      await flush();
      expect(lastFrame() ?? '').toContain('| context 40%');

      // An off-screen heartbeat/cron/goal turn broadcasts for its own thread and
      // must not overwrite the reading for the one on screen.
      adapterStub.events.emit('contextUsage', usage({ threadId: 'thread-other', usedPercent: 99 }));
      await flush();
      expect(lastFrame() ?? '').toContain('| context 40%');
      expect(lastFrame() ?? '').not.toContain('99%');
      unmount();
    });

    it('prefers the model the runtime reports over the local settings copy', async () => {
      const { lastFrame, unmount } = render(<App {...baseProps} />);
      await flush();

      adapterStub.events.emit('contextUsage', usage({ modelId: 'us.anthropic.claude-haiku-4-5' }));
      await flush();

      const frame = lastFrame() ?? '';
      expect(frame).toContain('Haiku 4.5');
      expect(frame).not.toContain('Opus 4.7');
      unmount();
    });
  });

  it('starts a fresh conversation thread on mount', () => {
    const { unmount } = render(<App {...baseProps} />);
    expect(adapterStub.startNewSession).toHaveBeenCalledTimes(1);
    // Clean slate: no history replay on open.
    expect(adapterStub.loadHistory).not.toHaveBeenCalled();
    unmount();
  });

  it('shows the in-flight row while status is "thinking"', async () => {
    const { lastFrame, unmount } = render(<App {...baseProps} />);
    // Flip status; App listens on the adapter event bus.
    adapterStub.events.emit('status', 'thinking');
    // Let React flush.
    await new Promise((r) => setImmediate(r));
    expect(lastFrame() ?? '').toContain('thinking');
    unmount();
  });

  it('keeps the composer live while thinking, so typing still lands in it', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    try {
      adapterStub.events.emit('status', 'thinking');
      await new Promise((r) => setImmediate(r));

      stdin.write('wait, not that');
      await new Promise((r) => setImmediate(r));

      // The draft is visible in the composer even though a turn is running.
      expect(lastFrame() ?? '').toContain('wait, not that');
    } finally {
      unmount();
    }
  });

  it('sends a message typed while the agent is responding', async () => {
    // The whole point of the mid-turn composer: Enter hands the message to the
    // runtime, which folds it into the turn already running on the thread.
    const { stdin, unmount } = render(<App {...baseProps} />);
    try {
      adapterStub.events.emit('status', 'thinking');
      await new Promise((r) => setImmediate(r));

      stdin.write('actually, skip the tests');
      await new Promise((r) => setImmediate(r));
      stdin.write('\r');
      await new Promise((r) => setImmediate(r));

      expect(adapterStub.submitUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'actually, skip the tests' }),
      );
    } finally {
      unmount();
    }
  });

  it('does not leak an "o" into the draft on the first Ctrl+O of a session', async () => {
    // Ink dispatches useInput handlers child-before-parent, so the composer sees
    // a chord before App does. Our vendored TextInput ignores every Ctrl chord
    // (components/TextInput.tsx); ink-text-input only filtered Ctrl+C, which put
    // a literal 'o' in the value — and this is a *fresh* mount, the case no
    // remount can mask.
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    try {
      stdin.write('\x0f'); // Ctrl+O
      await new Promise((r) => setImmediate(r));
      stdin.write('hi');
      await new Promise((r) => setImmediate(r));

      const frame = lastFrame() ?? '';
      expect(frame).toContain('hi');
      // Neither the leaked character nor a swallowed first keystroke.
      expect(frame).not.toContain('ohi');
      expect(frame).not.toContain('oi');
    } finally {
      unmount();
    }
  });

  // ink holds a lone trailing ESC for ~20ms (pendingInputFlushDelayMilliseconds)
  // to disambiguate it from a multi-byte escape sequence before emitting it as
  // a standalone Escape keypress. Wait past that window, then let React commit.
  const pressEscape = async (stdin: { write: (data: string) => void }) => {
    stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 60));
    await new Promise((r) => setImmediate(r));
  };

  it('cancels the in-flight turn and shows a marker when Escape is pressed while thinking', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    try {
      adapterStub.events.emit('status', 'thinking');
      await new Promise((r) => setImmediate(r));
      expect(lastFrame() ?? '').toContain('thinking');

      await pressEscape(stdin);

      expect(adapterStub.cancel).toHaveBeenCalled();
      expect(lastFrame() ?? '').toContain('Response stopped');
    } finally {
      unmount();
    }
  });

  it('ignores Escape when the agent is idle (nothing to cancel)', async () => {
    const { stdin, unmount } = render(<App {...baseProps} />);
    try {
      await pressEscape(stdin); // Escape while idle
      expect(adapterStub.cancel).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('hides the status bar when hideStatusBar is true', () => {
    const { lastFrame, unmount } = render(<App {...baseProps} hideStatusBar />);
    expect(lastFrame() ?? '').not.toContain('Opus 4.7');
    unmount();
  });

  it('opens the schedules panel when /schedules is submitted', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    // Type the command, let ink-text-input commit the value into App state,
    // then submit with a carriage return. Splitting the writes (with a flush
    // between) mirrors real typing and ensures onSubmit sees the full value.
    stdin.write('/schedules');
    await flush();
    // The popup is open, so the first Enter accepts "/schedules " into the
    // composer (as Tab does) and the second one runs it.
    stdin.write('\r');
    await flush();
    stdin.write('\r');
    // Let the command's async run() resolve and React flush, then let the
    // panel's mount fetch (listCronTasks) settle into the ready frame.
    await flush();
    await flush();
    await flush();
    const frame = lastFrame() ?? '';
    // Panel header replaces the chat surface.
    expect(frame).toContain('Schedules');
    expect(apiStub.listCronTasks).toHaveBeenCalled();
    unmount();
  });

  it('Enter accepts the highlighted command instead of sending or running it', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    stdin.write('/');
    await flush();
    stdin.write('\x1B[B'); // Down → second row, /schedules
    await flush();
    stdin.write('\r');
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('/schedules '); // accepted into the composer
    expect(frame).not.toContain('/copy'); // popup closed (it listed /copy)
    expect(adapterStub.submitUserMessage).not.toHaveBeenCalled(); // nothing sent
    expect(apiStub.listCronTasks).not.toHaveBeenCalled(); // nothing run
    unmount();
  });

  it('/goal works on a fresh session with no prior message (thread pinned from startup)', async () => {
    // The fresh-launch session creates a thread server-side; the CLI pins its
    // id so /goal has a thread immediately, without sending a message first.
    adapterStub.startNewSession.mockResolvedValueOnce('thread-startup');
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    await flush(); // let startNewSession().then(pin) settle
    await flush();
    stdin.write('/goal make the tests pass');
    await flush();
    stdin.write('\r');
    await flush();
    await flush();
    expect(apiStub.createGoal).toHaveBeenCalledWith({
      threadId: 'thread-startup',
      objective: 'make the tests pass',
    });
    expect(lastFrame() ?? '').not.toContain('Start a conversation');
    unmount();
  });

  // Command-history recall. /copy is a clean probe: it isn't echoed as a user
  // message, and its result ("No message to copy yet.") doesn't contain the
  // command text — so "/copy" in a frame means it's sitting in the input.
  const submitCopy = async (
    stdin: { write: (data: string) => void },
    flush: () => Promise<unknown>,
  ) => {
    stdin.write('/copy');
    await flush();
    // The popup is open, so the first Enter accepts "/copy " into the composer
    // (as Tab does) and the second one runs it.
    stdin.write('\r');
    await flush();
    stdin.write('\r');
    await flush();
    await flush();
  };

  it('recalls the last submission when Up is pressed on an empty input', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    await submitCopy(stdin, flush);
    expect(lastFrame() ?? '').not.toContain('/copy');

    stdin.write('\x1B[A'); // Up
    await flush();
    expect(lastFrame() ?? '').toContain('/copy');
    unmount();
  });

  it('leaves a half-typed draft untouched when Up is pressed', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    await submitCopy(stdin, flush);

    stdin.write('draft'); // non-empty input, not browsing history
    await flush();
    stdin.write('\x1B[A'); // Up — must be ignored so the draft survives
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('draft');
    expect(frame).not.toContain('/copy');
    unmount();
  });

  it('clears the input when Down goes past the newest entry', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    // A plain chat message (not a slash command) so recall doesn't open the
    // command popup, which would otherwise capture the Down key.
    stdin.write('gamma-msg');
    await flush();
    stdin.write('\r');
    await flush();

    stdin.write('\x1B[A'); // Up → recall into the input
    await flush();
    expect(count(lastFrame() ?? '', 'gamma-msg')).toBe(2); // message list + input

    stdin.write('\x1B[B'); // Down → past the newest, clears the input
    await flush();
    expect(count(lastFrame() ?? '', 'gamma-msg')).toBe(1); // message list only
    unmount();
  });

  it('walks back through multiple entries with repeated Up', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    for (const msg of ['alpha-msg', 'beta-msg']) {
      stdin.write(msg);
      await flush();
      stdin.write('\r');
      await flush();
    }
    stdin.write('\x1B[A'); // Up → newest (beta-msg)
    await flush();
    stdin.write('\x1B[A'); // Up → older (alpha-msg)
    await flush();
    // alpha-msg now appears twice: once in the message list, once in the input.
    expect(count(lastFrame() ?? '', 'alpha-msg')).toBeGreaterThanOrEqual(2);
    unmount();
  });

  // ---- /attach staging flow ----

  const flushAll = async (n = 4) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };

  const attachFile = async (stdin: { write: (data: string) => void }) => {
    stdin.write('/attach /tmp/report.txt');
    await flushAll();
    stdin.write('\r');
    await flushAll();
  };

  it('/attach uploads the file and renders the staged chip line', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    await attachFile(stdin);

    expect(apiStub.uploadAttachment).toHaveBeenCalledWith('/tmp/report.txt');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('📎 report.txt (2.0 KB)');
    expect(frame).toContain('/detach to remove');
    unmount();
  });

  it('the next message carries the staged attachmentIds and clears the chips', async () => {
    const { lastFrame, stdin, unmount } = render(<App {...baseProps} />);
    await attachFile(stdin);

    stdin.write('summarize this');
    await flushAll();
    stdin.write('\r');
    await flushAll();

    expect(adapterStub.submitUserMessage).toHaveBeenCalledWith({
      userId: 'local',
      agentId: 'remote',
      text: 'summarize this',
      attachmentIds: ['att-1'],
    });
    // Chips line is gone; the optimistic user row shows the 📎 suffix instead.
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('/detach to remove');
    expect(frame).toContain('· 📎 report.txt (2.0 KB)');
    unmount();
  });

  it('a bare Enter with staged files sends a file-only message', async () => {
    const { stdin, unmount } = render(<App {...baseProps} />);
    await attachFile(stdin);

    stdin.write('\r'); // empty input, staged file present
    await flushAll();

    expect(adapterStub.submitUserMessage).toHaveBeenCalledWith({
      userId: 'local',
      agentId: 'remote',
      text: '',
      attachmentIds: ['att-1'],
    });
    unmount();
  });

  it('a bare Enter with nothing staged sends nothing', async () => {
    const { stdin, unmount } = render(<App {...baseProps} />);
    stdin.write('\r');
    await flushAll();
    expect(adapterStub.submitUserMessage).not.toHaveBeenCalled();
    unmount();
  });

  // ---- --resume flow ----

  const resumeSessions = [
    {
      id: 'thread-alpha',
      title: null,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      workspaceRoot: '/home/me/.claude/worktrees/ability-to-cancel',
      branch: 'worktree/ability-to-cancel',
      contextUsage: {
        threadId: 'thread-alpha',
        modelId: 'us.anthropic.claude-opus-5',
        usedTokens: 300_000,
        windowTokens: 1_000_000,
        usedPercent: 30,
      },
    },
    {
      id: 'thread-beta',
      title: null,
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
      workspaceRoot: null,
      branch: null,
      contextUsage: null,
    },
  ];
  const resumeProps = { ...baseProps, resume: { sessions: resumeSessions, cwd: '/home/me/cwd' } };

  it('shows the resume picker first and does NOT start a fresh session', () => {
    const { lastFrame, unmount } = render(<App {...resumeProps} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Resume session (1 of 2)');
    expect(frame).toContain('/home/me/cwd');
    expect(frame).toContain('ability-to-cancel (worktree/ability-to-cancel)');
    // Picker owns the screen — the chat surface isn't rendered yet.
    expect(frame).not.toContain('chat with Prism');
    expect(adapterStub.startNewSession).not.toHaveBeenCalled();
    unmount();
  });

  it('resumes the highlighted thread on Enter, replays its history, and pins sends to it', async () => {
    adapterStub.loadHistory.mockResolvedValueOnce([
      {
        id: 'm1',
        threadId: 'thread-alpha',
        role: 'AGENT',
        content: 'earlier reply',
        triggeredBy: 'USER_INPUT',
        toolCalls: null,
        blocks: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    const { lastFrame, stdin, unmount } = render(<App {...resumeProps} />);
    /**
     * Let Ink settle. Two sequential state updates (the resolved session thread,
     * then a context frame) need more than one macrotask to reach a frame, so
     * settle a few times rather than guessing one is enough.
     */
    const flush = async (times = 3) => {
      for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
    };
    stdin.write('\r'); // Enter selects the first (highlighted) session
    await flush();
    await flush();

    // History replay is pinned to the picked thread — no resume endpoint, no
    // server-side "latest" mutation.
    expect(adapterStub.loadHistory).toHaveBeenCalledWith({
      userId: 'local',
      agentId: 'remote',
      threadId: 'thread-alpha',
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('chat with Prism'); // chat surface now showing
    expect(frame).toContain('earlier reply'); // replayed history

    // A subsequent send carries the resumed thread id explicitly.
    stdin.write('continue please');
    await flush();
    stdin.write('\r');
    await flush();
    expect(adapterStub.submitUserMessage).toHaveBeenCalledWith({
      userId: 'local',
      agentId: 'remote',
      text: 'continue please',
      threadId: 'thread-alpha',
      attachmentIds: [],
    });
    unmount();
  });

  it('dismisses the picker without resuming anything when Escape is pressed', async () => {
    // Escape triggers a clean shutdown (the e2e asserts the actual exit code 0);
    // here we verify the picker is dismissed and no history was loaded.
    const { lastFrame, stdin, unmount } = render(<App {...resumeProps} />);
    await pressEscape(stdin);
    expect(adapterStub.loadHistory).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').not.toContain('Resume session');
    unmount();
  });
});
